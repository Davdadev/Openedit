/**
 * Rhythm tools: detect_beats, fit_music, snap_to_beats, build_montage, add_jl_cuts, speed_ramp.
 * Plans are immutable: every change saves a NEW planId; when the standalone timeline holds the
 * plan that was changed, it is re-timed in place (captions / markers / zooms / b-roll follow).
 */
import { readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describeBeats, detectBeats } from "../engine/beats.js";
import { autoSplits, normalizeSplits, splitCounts } from "../engine/jl.js";
import { probe, resolveMediaPath } from "../engine/media.js";
import {
  MONTAGE_STYLES,
  type MontageStyle,
  bestMusicShift,
  fitMusic,
  planJoins,
  planMontage,
  renderFittedMusic,
  saveMontage,
  shotInterest,
  snapPlanToBeats,
} from "../engine/music.js";
import { paths } from "../engine/paths.js";
import { editDuration } from "../engine/remap.js";
import { renderMontage } from "../engine/render.js";
import { type MusicUnder, beatsOnTimeline, formatRhythm, measureCuts, rhythmStats, rhythmWarnings } from "../engine/review-rhythm.js";
import { RAMP_CURVES, rampSanity, retimingProblems } from "../engine/speed.js";
import { activeHost, getHost, StandaloneHost } from "../hosts/index.js";
import type { CutPlan, SplitEdit, SpeedRamp, Transcript } from "../hosts/types.js";
import { loadPlan, savePlan, type StoredPlan } from "./plans.js";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string | object): Result => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }] });
function safe<A>(fn: (a: A) => Promise<Result>): (a: A) => Promise<Result> {
  return async (a: A) => {
    try {
      return await fn(a);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  };
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const home = (p: string) => resolve(p.replace(/^~(?=\/)/, process.env.HOME ?? "~"));

function transcriptOf(stored: StoredPlan): Transcript | undefined {
  if (!stored.transcriptPath) return undefined;
  try {
    return JSON.parse(readFileSync(stored.transcriptPath, "utf8")) as Transcript;
  } catch {
    return undefined;
  }
}

/** Save the changed plan; re-time the standalone timeline when it holds the old plan. */
async function commit(old: StoredPlan, plan: CutPlan, change: Record<string, unknown>): Promise<{ id: string; timeline: string }> {
  const stored = savePlan(plan, { ...old.options, ...change, from: old.id }, old.transcriptPath);
  const sa = getHost("standalone") as StandaloneHost;
  const proj = sa.getProject();
  let timeline = "";
  if (proj.plan && resolve(proj.plan.source) === resolve(old.plan.source) && JSON.stringify(proj.plan.keep) === JSON.stringify(old.plan.keep)) {
    const r = sa.retime(plan);
    timeline = `Standalone timeline updated in place (${r.moved} captions/markers/zooms/clips moved${r.dropped ? `, ${r.dropped} dropped` : ""}).`;
  } else {
    const host = await activeHost();
    timeline =
      host.name === "standalone"
        ? `Call apply_cuts {planId: "${stored.id}"} to put it on the timeline.`
        : `In ${host.name}, apply_cuts builds straight cuts at full speed (the bridge does not do split edits / ramps); use export_timeline {planId: "${stored.id}", format: "fcp7"} (Premiere, Resolve) or "fcpxml" (Final Cut, Resolve) to get them.`;
  }
  return { id: stored.id, timeline };
}

/** Music under the standalone timeline (audio placements), as edit-time beats. */
async function musicOnTimeline(plan: CutPlan): Promise<{ beats: number[]; downbeats: number[]; tempo: number; source: string } | undefined> {
  const sa = getHost("standalone") as StandaloneHost;
  const proj = sa.getProject();
  if (!proj.plan || resolve(proj.plan.source) !== resolve(plan.source)) return undefined;
  const m = proj.placements.find((p) => /\.(mp3|wav|m4a|aac|flac|ogg|opus|aif|aiff)$/i.test(p.path));
  if (!m) return undefined;
  const a = await detectBeats(m.path);
  const off = m.at - (m.sourceIn ?? 0);
  return { beats: a.beats.map((b) => b + off), downbeats: a.downbeats.map((b) => b + off), tempo: a.tempo, source: m.path };
}

export function registerRhythmTools(server: McpServer): void {
  server.registerTool(
    "detect_beats",
    {
      description:
        "Analyse a music track: tempo (BPM), beats, downbeats (bar lines), meter, sections (intro / build / drop / breakdown / outro with energy 0..1), drops, an energy curve and where the song resolves (final downbeat, end of ring-out). Local, cached. Use before cutting to music.",
      inputSchema: {
        path: z.string().describe("Music file"),
        meter: z.number().int().min(2).max(7).optional().describe("Force beats per bar (default: detect 4 or 3)"),
        list: z.boolean().optional().describe("Also return every beat / downbeat time (default: first 32 beats)"),
      },
    },
    safe(async ({ path, meter, list }) => {
      const a = await detectBeats(resolveMediaPath(path), { meter });
      return text(
        `${describeBeats(a)}\n` +
          `energy (0..1 every ${a.energy.hop}s): ${a.energy.values.join(" ")}\n` +
          `downbeats: ${(list ? a.downbeats : a.downbeats.slice(0, 16)).join(", ")}${!list && a.downbeats.length > 16 ? " …" : ""}\n` +
          `beats: ${(list ? a.beats : a.beats.slice(0, 32)).join(", ")}${!list && a.beats.length > 32 ? " …" : ""}`,
      );
    }),
  );

  server.registerTool(
    "fit_music",
    {
      description:
        "Edit a song to an exact length on its bar lines (whole phrases removed or repeated, ~30 ms crossfade just before the downbeat) so it ENDS ON ITS OWN ENDING instead of a random fade. Writes the fitted track (.m4a, exact length). place: true also lays it under the standalone timeline, ducked under speech.",
      inputSchema: {
        music: z.string(),
        duration: z.number().positive().optional().describe("Target seconds (default: the standalone timeline's edit length)"),
        output: z.string().optional(),
        place: z.boolean().optional().describe("Place on the timeline at 0 (default true when duration was omitted)"),
        gainDb: z.number().optional().describe("Music gain when placed, default -16 under dialogue"),
        duckDb: z.number().min(0).max(30).optional().describe("Duck under speech by ~N dB when placed, default 10"),
        energetic: z.boolean().optional().describe("Prefer the song's high-energy material (montage, hype). Default false"),
      },
    },
    safe(async (a) => {
      const sa = getHost("standalone") as StandaloneHost;
      const proj = sa.getProject();
      const target = a.duration ?? (proj.plan ? editDuration(proj.plan) : undefined);
      if (!target) throw new Error("Give duration (no standalone timeline to measure)");
      const music = resolveMediaPath(a.music);
      const an = await detectBeats(music);
      const fps = proj.info?.fps ?? 30;
      const fit = fitMusic(an, target, { fps, energyWeight: a.energetic ? 2 : 0 });
      const output = a.output ? home(a.output) : join(paths.renders(), `${basename(music, extname(music))}-fit-${target.toFixed(2)}s.m4a`);
      await renderFittedMusic(fit, output);
      const real = (await probe(output)).duration;
      let placed = "";
      if (a.place ?? a.duration === undefined) {
        const host = await activeHost();
        await host.placeClips([{ path: output, at: 0, track: 2, gainDb: a.gainDb ?? -16, ...({ duckDb: a.duckDb ?? 10 } as object) }]);
        placed = `\nPlaced at 0 on A2 in ${host.name} (gain ${a.gainDb ?? -16} dB, ducked ${a.duckDb ?? 10} dB under speech).`;
      }
      return text(
        `Fitted ${basename(music)} (${an.tempo} BPM, ${an.duration}s) to ${r2(target)}s -> ${output} (${r2(real)}s)\n` +
          `segments: ${fit.segments.map((s) => `${s.in}–${s.out}`).join(" + ")}\n${fit.notes.join("\n")}\n` +
          `final downbeat (resolution) at ${fit.endsOn}s of the fitted track.${placed}`,
      );
    }),
  );

  server.registerTool(
    "snap_to_beats",
    {
      description:
        "Move a dialogue edit's cuts onto the beat of the music under it, ONLY inside pauses and by small amounts (default <= 0.15 s), never into a word or back into removed speech; joins that cannot move safely are left alone and listed. Music: the music path (placed at musicAt, from musicIn) or the music already placed on the standalone timeline. slideMusic finds the music offset (within one beat) that lines up the most cuts first. Returns a NEW planId.",
      inputSchema: {
        planId: z.string(),
        music: z.string().optional(),
        musicAt: z.number().optional().describe("Edit time the music starts at (default 0)"),
        musicIn: z.number().min(0).optional().describe("Source time in the music at musicAt (default 0)"),
        grid: z.enum(["beats", "downbeats"]).optional().describe("Snap to every beat (default) or bar lines only"),
        maxShift: z.number().min(0).max(0.5).optional().describe("Largest move per cut (s), default 0.15"),
        slideMusic: z.boolean().optional(),
      },
    },
    safe(async (a) => {
      const stored = loadPlan(a.planId);
      let beats: number[];
      let downbeats: number[];
      let src: string;
      let tempo: number;
      if (a.music) {
        const an = await detectBeats(resolveMediaPath(a.music));
        const off = (a.musicAt ?? 0) - (a.musicIn ?? 0);
        beats = an.beats.map((b) => b + off);
        downbeats = an.downbeats.map((b) => b + off);
        src = an.path;
        tempo = an.tempo;
      } else {
        const m = await musicOnTimeline(stored.plan);
        if (!m) throw new Error("Give music (no music placed on the standalone timeline for this plan)");
        ({ beats, downbeats, source: src, tempo } = m);
      }
      const info = await probe(stored.plan.source);
      const fps = info.fps ?? 30;
      let grid = a.grid === "downbeats" ? downbeats : beats;
      let shift = 0;
      if (a.slideMusic) {
        shift = bestMusicShift(planJoins(stored.plan), grid, Math.max(0.04, 1 / fps), 60 / tempo);
        grid = grid.map((b) => b + shift);
      }
      const { plan, report } = snapPlanToBeats(stored.plan, grid, { transcript: transcriptOf(stored), maxShift: a.maxShift, fps });
      report.musicShift = shift;
      const c = await commit(stored, plan, { snappedTo: src, musicAt: (a.musicAt ?? 0) + shift });
      return text(
        `planId: ${c.id}\n${report.moved.length} of ${report.joins} cuts moved onto the beat; aligned ${Math.round(report.alignedBefore * 100)}% -> ${Math.round(report.alignedAfter * 100)}%` +
          `${shift ? `\nmusic slid by ${shift}s: place it at ${r2((a.musicAt ?? 0) + shift)}s` : ""}\n` +
          report.moved.map((m) => `- join ${m.index}: ${m.from}s -> ${m.to}s (${m.shift > 0 ? "+" : ""}${Math.round(m.shift * 1000)} ms, ${m.how})`).join("\n") +
          (report.skipped.length ? `\nleft alone:\n${report.skipped.map((s) => `- join ${s.index}: ${s.reason}`).join("\n")}` : "") +
          `\n${c.timeline}`,
      );
    }),
  );

  server.registerTool(
    "build_montage",
    {
      description:
        "Assemble a montage cut to music: fits the song to the length on its bar lines (ending on its own resolution), cuts on the chosen grid (on-beat | every-2-beats | downbeats | phrase = 4 bars), adaptively finer in drops and looser in quiet sections, always cutting on section changes; shots taken in the given order, windows chosen by motion/sharpness when the shot analysis is available (never straddling a cut inside a clip), else the middle. Renders to `output` when given.",
      inputSchema: {
        clips: z.array(z.union([z.string(), z.object({ path: z.string(), in: z.number().min(0).optional(), out: z.number().min(0).optional() })])).min(1),
        music: z.string(),
        style: z.enum(MONTAGE_STYLES as [MontageStyle, ...MontageStyle[]]).optional().describe("Default downbeats"),
        duration: z.number().positive().optional().describe("Target seconds (default ~2 bars per clip, max the song)"),
        adaptive: z.boolean().optional().describe("Vary cut rate with the music's energy (default true)"),
        output: z.string().optional().describe("Render the montage here (mp4)"),
        fps: z.number().positive().optional().describe("Default: first clip's rate, else 30"),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        natSoundDb: z.number().max(0).optional().describe("Mix each shot's own sound under the music at this gain (default off)"),
        quality: z.enum(["draft", "final"]).optional(),
      },
    },
    safe(async (a) => {
      const music = resolveMediaPath(a.music);
      const an = await detectBeats(music);
      const clips = [];
      for (const c of a.clips) {
        const path = resolveMediaPath(typeof c === "string" ? c : c.path);
        const info = await probe(path);
        clips.push({ path, duration: info.duration || 3, ...(typeof c === "object" ? { in: c.in, out: c.out } : {}) });
      }
      const first = await probe(clips[0].path);
      const fps = a.fps ?? (first.fps && first.fps < 120 ? first.fps : 30);
      const style = (a.style ?? "downbeats") as MontageStyle;
      const bar = (60 / an.tempo) * an.meter;
      const target = a.duration ?? Math.min(an.ending.tailEnd, Math.max(10, clips.length * 2 * bar));
      const fit = fitMusic(an, target, { fps, energyWeight: 2 });
      const interest = await shotInterest(clips.map((c) => c.path));
      const m = saveMontage(planMontage(clips, fit, style, { fps, adaptive: a.adaptive, interest: interest.fn, meter: an.meter }));
      const mu = { beats: fit.beats, downbeats: fit.downbeats, tempo: an.tempo, source: music };
      let rendered = "";
      if (a.output) {
        const r = await renderMontage(m, home(a.output), { width: a.width, height: a.height, natSoundDb: a.natSoundDb, loudnorm: true, quality: a.quality });
        const real = await measureCuts(r.output).catch(() => []);
        rendered = `\nRendered ${r.output} (${r.width}x${r.height}, ${r2(r.duration)}s in ${r.seconds}s). Cuts found in the render: ${formatRhythm(rhythmStats(real, { music: mu, fps }))}. Run review_edit on it.`;
      }
      const st = rhythmStats(m.cuts, { music: mu, fps });
      const warn = rhythmWarnings(st);
      return text(
        `montageId: ${m.id}\n${an.tempo} BPM ${an.meter}/4, style ${style}, ${r2(m.duration)}s, ${interest.note}\nmusic: ${fit.notes.join("; ") || "used as is"}\n${m.notes.join("\n")}\n${formatRhythm(st)}\n` +
          m.shots.map((s) => `- ${s.at.toFixed(2)}s +${s.duration.toFixed(2)}s ${basename(s.path)} @${s.in}s (${s.pick})`).join("\n") +
          (warn.length ? `\nWARNINGS:\n${warn.map((w) => `- ${w}`).join("\n")}` : "") +
          rendered,
      );
    }),
  );

  server.registerTool(
    "add_jl_cuts",
    {
      description:
        "Add split edits to a plan: J (next shot's sound starts BEFORE its picture) and L (previous sound carries on OVER the next picture), `seconds` typically 0.3-1.5 (single camera: <= 0.5). joins[].index is the 0-based join between kept segment i and i+1. auto: conservative choices for a single-camera dialogue edit (breath pre-laps at sentence boundaries, sound leading at topic transitions). roll 'audio' (default) moves the sound edit, 'video' moves the picture edit. Sync is kept; the duration does not change. Standalone renders them; export_timeline fcp7/fcpxml carries them; Premiere/Resolve bridges get straight cuts. Returns a NEW planId.",
      inputSchema: {
        planId: z.string(),
        joins: z.array(z.object({ index: z.number().int().min(0), type: z.enum(["J", "L"]), seconds: z.number().positive().max(4), roll: z.enum(["audio", "video"]).optional() })).optional(),
        auto: z.boolean().optional(),
        clear: z.boolean().optional().describe("Remove existing split edits first"),
      },
    },
    safe(async (a) => {
      const stored = loadPlan(a.planId);
      const info = await probe(stored.plan.source);
      const why: string[] = [];
      const wanted: SplitEdit[] = a.clear ? [] : [...(stored.plan.splits ?? [])];
      if (a.auto) {
        const auto = autoSplits(stored.plan, transcriptOf(stored));
        for (const s of auto) why.push(`join ${s.index}: ${s.type} ${s.seconds}s — ${s.why}`);
        wanted.push(...auto.map(({ why: _w, ...s }) => s));
        if (!auto.length) why.push(transcriptOf(stored) ? "auto: no join where a split edit clearly helps (that is fine on a single camera)" : "auto needs the plan's transcript");
      }
      wanted.push(...((a.joins ?? []) as SplitEdit[]));
      const { splits, notes } = normalizeSplits(stored.plan, wanted, { sourceDuration: info.duration });
      const plan: CutPlan = { ...stored.plan, splits };
      const c = await commit(stored, plan, { splits });
      const n = splitCounts(plan);
      return text(`planId: ${c.id}\n${n.J} J-cuts, ${n.L} L-cuts\n${[...why, ...notes].map((x) => `- ${x}`).join("\n")}\n${c.timeline}`);
    }),
  );

  const rampSchema = z.object({
    start: z.number().min(0).describe("SOURCE seconds"),
    end: z.number().min(0),
    speed: z.number().min(0.05).max(16).optional(),
    from: z.number().min(0.05).max(16).optional(),
    to: z.number().min(0.05).max(16).optional(),
    curve: z.enum(RAMP_CURVES as [string, ...string[]]).optional(),
    reverse: z.boolean().optional(),
    quality: z.enum(["frames", "blend", "optical"]).optional(),
    audio: z.enum(["mute", "pitch"]).optional(),
  });

  server.registerTool(
    "speed_ramp",
    {
      description:
        "Speed ramps, slow motion, freeze frames and reverse on a plan (ranges in SOURCE seconds, inside kept segments). A ramp is constant `speed` or eased from `from` to `to` (curve linear | ease-in | ease-out | ease-in-out). Slow motion quality: frames (duplicate), blend, optical (motion-interpolated, slow to render). Audio over a ramp: mute (default; lay music/SFX) or pitch (time-stretched, pitch kept). Captions, markers, zooms and b-roll after a ramp are moved to stay on their picture. Returns a NEW planId.",
      inputSchema: {
        planId: z.string(),
        ramps: z.array(rampSchema).optional(),
        freezes: z.array(z.object({ at: z.number().min(0).describe("SOURCE seconds"), duration: z.number().positive().max(10) })).optional(),
        clear: z.boolean().optional().describe("Remove existing ramps / freezes first"),
      },
    },
    safe(async (a) => {
      const stored = loadPlan(a.planId);
      const plan: CutPlan = {
        ...stored.plan,
        ramps: [...(a.clear ? [] : (stored.plan.ramps ?? [])), ...((a.ramps ?? []) as SpeedRamp[])].sort((x, y) => x.start - y.start),
        freezes: [...(a.clear ? [] : (stored.plan.freezes ?? [])), ...(a.freezes ?? [])],
      };
      if (!plan.ramps?.length) delete plan.ramps;
      if (!plan.freezes?.length) delete plan.freezes;
      const problems = retimingProblems(plan);
      if (problems.length) throw new Error(problems.join("; "));
      const fps = (await probe(plan.source)).fps ?? 30;
      const sanity = rampSanity(plan, fps);
      const c = await commit(stored, plan, { ramps: plan.ramps, freezes: plan.freezes });
      return text(
        `planId: ${c.id}\nedit ${r2(editDuration(stored.plan))}s -> ${r2(editDuration(plan))}s; ${sanity.ramps} ramps, ${sanity.freezes} freezes, ${sanity.reverses} reverse; speeds ${sanity.slowest}x–${sanity.fastest}x, max jump ${sanity.maxJump}x` +
          (sanity.warnings.length ? `\nWARNINGS:\n${sanity.warnings.map((w) => `- ${w}`).join("\n")}` : "") +
          `\n${c.timeline}`,
      );
    }),
  );
}

/** Beats of the first music placement on the standalone timeline, on the edit timeline (for review_edit). */
export async function timelineMusic(placements: { path: string; at: number; sourceIn?: number }[]): Promise<MusicUnder | undefined> {
  const m = placements.find((p) => /\.(mp3|wav|m4a|aac|flac|ogg|opus|aif|aiff)$/i.test(p.path));
  if (!m) return undefined;
  try {
    const a = await detectBeats(m.path);
    return { ...beatsOnTimeline(a, m.at, m.sourceIn ?? 0), tempo: a.tempo, source: m.path };
  } catch {
    return undefined;
  }
}
