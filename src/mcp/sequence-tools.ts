/**
 * build_sequence: render an edit Claude directs shot by shot (ads, promos, product films,
 * trailers, travel, sizzle reels). See src/engine/sequence.ts for the model.
 */
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { analyzeMany, collectVideos, type FootageAnalysis, findShot, type Shot } from "../engine/analysis/analyze.js";
import { shotUsability } from "../engine/analysis/usable.js";
import { composeSheet } from "../engine/analysis/vision.js";
import { resolveMediaPath } from "../engine/media.js";
import { paths } from "../engine/paths.js";
import { describeSpeed, LOOKS, MOVES, renderSequence, type SequenceShotInput, type SequenceSpec, sequenceFrames, TRANSITIONS } from "../engine/sequence.js";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };

const home = (p: string) => resolve(p.replace(/^~(?=\/)/, process.env.HOME ?? "~"));

function safe<A>(fn: (a: A) => Promise<Result>): (a: A) => Promise<Result> {
  return async (a) => {
    try {
      return await fn(a);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  };
}

const shotSchema = z.object({
  shot: z.string().optional().describe('A shot id from analyze_footage, e.g. "MVI_0017#5" (needs `footage`). The window is taken inside that shot.'),
  path: z.string().optional().describe("A video file (instead of `shot`)"),
  in: z.number().min(0).optional().describe("Source in point (s). With `shot`: seconds from the shot's start. Default: centred."),
  duration: z.number().positive().describe("Seconds on the timeline, including any held last frame"),
  speed: z.number().min(0.05).max(16).optional().describe("Constant speed: 0.5 = half-speed slow motion"),
  ramp: z.object({ from: z.number().min(0.05).max(16), to: z.number().min(0.05).max(16), curve: z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]).optional() }).optional().describe("Eased speed change across the shot, e.g. {from:1,to:0.3} to slow into a moment"),
  reverse: z.boolean().optional(),
  holdEnd: z.number().min(0).optional().describe("Freeze the last frame for this many seconds (part of duration)"),
  slowmo: z.enum(["frames", "blend", "optical"]).optional().describe("Frame synthesis below 1x (optical = motion-interpolated, slow to render)"),
  move: z.object({ type: z.enum(MOVES), amount: z.number().min(0.01).max(0.4).optional() }).optional().describe("Camera move added in post; amount = zoom/drift fraction (default 0.08)"),
  transition: z.object({ type: z.enum(TRANSITIONS), duration: z.number().positive().max(3).optional() }).optional().describe("How this shot ENTERS. Default cut."),
  exposure: z.number().min(-3).max(3).optional().describe("Per-shot exposure in stops, to match neighbours"),
  saturation: z.number().min(0).max(3).optional(),
  natSoundDb: z.number().max(12).optional().describe("Keep this shot's own sound at this gain (dB). Omit for silent."),
  note: z.string().optional().describe("Why this shot is here (kept in the saved spec)"),
});

async function loadFootage(footage: string | string[] | undefined): Promise<FootageAnalysis[]> {
  if (!footage) return [];
  const files = Array.isArray(footage) ? footage.map(resolveMediaPath) : collectVideos({ folder: resolveMediaPath(footage) });
  const res = await analyzeMany(files, { noVision: false });
  const { addInsights } = await import("../engine/analysis/insight.js");
  await addInsights(res).catch(() => undefined);
  return res;
}

/** Analysis shots overlapping a source window of a file. */
function shotsUnder(analyses: FootageAnalysis[], file: string, a: number, b: number): Shot[] {
  const abs = resolve(file);
  const an = analyses.find((x) => resolve(x.path) === abs);
  return an ? an.shots.filter((s) => Math.min(s.end, b) - Math.max(s.start, a) > 0.06) : [];
}

export function registerSequenceTools(server: McpServer): void {
  server.registerTool(
    "build_sequence",
    {
      description:
        "Render an edit you DIRECT shot by shot: the tool for ads, promos, product films, trailers, travel pieces and sizzle reels (anything that is not a talking-head trim or a mechanical beat montage). " +
        "Each shot: which footage (analyze_footage shot id or path + in), how long it plays, how it enters (cut, dissolve, dip-black/white, flash, whip-left/right/up/down, slide, zoom, wipe, circle-open), " +
        "speed (constant, eased ramp, reverse, held last frame), a post camera move (push-in, pull-out, drift) and exposure matching. " +
        "Over the whole piece: a look (natural, punchy, candy, warm-film, cool-clean, moody, bright-airy, mono; or a .cube LUT; grain, vignette, letterbox), titles from graphics_catalog (`graphics`), " +
        "pre-rendered overlays, sound effects at times, and music fitted to the length on its bar lines; loudness-normalised to -14 LUFS. " +
        "Returns a contact sheet (one frame per shot) and warnings (unusable shots, windows that run out of footage). Design the piece first (see the openedit-creative skill): " +
        "vary shot lengths, give hero shots room, sound-design the key moments. Re-call with the edited spec to iterate; review_edit the result.",
      inputSchema: {
        output: z.string().describe("Output .mp4"),
        footage: z.union([z.string(), z.array(z.string())]).optional().describe("Folder or files analysed by analyze_footage, needed for `shot` ids and quality checks"),
        shots: z.array(shotSchema).min(1),
        look: z
          .object({
            preset: z.enum(LOOKS).optional(),
            intensity: z.number().min(0).max(1).optional(),
            lut: z.string().optional().describe(".cube file"),
            grain: z.number().min(0).max(30).optional(),
            vignette: z.number().min(0).max(1).optional(),
            letterbox: z.number().min(1).max(3).optional().describe("e.g. 2.39"),
          })
          .optional(),
        music: z.object({ path: z.string(), gainDb: z.number().optional(), fit: z.boolean().optional().describe("Fit to length on bar lines (default true)"), start: z.number().min(0).optional(), fadeOut: z.number().min(0).optional() }).optional(),
        sfx: z.array(z.object({ path: z.string(), at: z.number().min(0), gainDb: z.number().optional() })).optional().describe("Sound effects at timeline seconds (whooshes on whips, a crunch on the bite, a pop on a title)"),
        graphics: z
          .array(z.object({ template: z.string().describe("graphics_catalog id (OpenEdit or your own templates)"), at: z.number().min(0), duration: z.number().positive(), params: z.record(z.unknown()).optional() }))
          .optional()
          .describe("Titles / end cards rendered from the catalog and composited over the graded picture"),
        overlays: z.array(z.object({ path: z.string(), at: z.number().min(0), duration: z.number().positive().optional() })).optional(),
        fadeIn: z.number().min(0).max(3).optional(),
        fadeOut: z.number().min(0).max(3).optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        fps: z.number().positive().optional(),
        quality: z.enum(["draft", "final"]).optional(),
      },
    },
    safe(async (a) => {
      const analyses = await loadFootage(a.footage);
      const notes: string[] = [];
      const shots: SequenceShotInput[] = a.shots.map((s, k) => {
        const { shot: id, path, in: inPoint, ...rest } = s;
        if (id) {
          const sh = findShot(analyses, id);
          if (!sh) throw new Error(`shot ${k + 1}: "${id}" not found${analyses.length ? "" : " (pass `footage` so shot ids can be resolved)"}`);
          const need = s.duration * Math.max(s.speed ?? 1, s.ramp ? Math.max(s.ramp.from, s.ramp.to) : 1);
          const start = inPoint !== undefined ? sh.start + inPoint : sh.start + Math.max(0, (sh.duration - need) / 2);
          if (need > sh.duration + 0.05) notes.push(`shot ${k + 1} (${id}): needs ${need.toFixed(2)}s but the shot is ${sh.duration.toFixed(2)}s, so it runs into the next source shot`);
          return { ...rest, path: sh.file, in: start };
        }
        if (!path) throw new Error(`shot ${k + 1}: give \`shot\` or \`path\``);
        return { ...rest, path: resolveMediaPath(path), in: inPoint };
      });
      // Titles from the catalog -> alpha overlays.
      const overlays = [...(a.overlays ?? [])];
      if (a.graphics?.length) {
        const { getTemplate } = await import("../graphics/library.js");
        const { renderGraphic } = await import("../graphics/place.js");
        for (const g of a.graphics) {
          const it = getTemplate(g.template);
          const out = await renderGraphic(it, { params: g.params, width: a.width ?? 1920, height: a.height ?? 1080, fps: a.fps ?? 25, duration: g.duration });
          overlays.push({ path: out, at: g.at, duration: g.duration });
        }
      }
      const spec: SequenceSpec = { shots, look: a.look, music: a.music, sfx: a.sfx, overlays, fadeIn: a.fadeIn, fadeOut: a.fadeOut, width: a.width, height: a.height, fps: a.fps };
      const r = await renderSequence(spec, home(a.output), { quality: a.quality });
      // Quality gate over the windows actually used.
      if (analyses.length) {
        r.shots.forEach((s) => {
          const under = shotsUnder(analyses, s.path, s.srcIn, s.srcIn + s.span);
          if (under.length > 1 && !s.reverse) notes.push(`shot ${s.index + 1}: the window crosses a cut inside ${basename(s.path)} (${under.map((x) => x.id).join(" → ")}): a flash of another shot`);
          for (const u of under) {
            const v = shotUsability(u);
            if (v.status === "reject") notes.push(`shot ${s.index + 1}: ${u.id} is unusable (${v.reasons.join("; ")}): replace it`);
            else if (v.status === "caution") notes.push(`shot ${s.index + 1}: ${u.id}: ${v.reasons.join("; ")}`);
          }
        });
      }
      const lens = r.shots.map((s) => s.duration);
      const mean = lens.reduce((x, y) => x + y, 0) / lens.length;
      const cv = Math.sqrt(lens.reduce((x, y) => x + (y - mean) ** 2, 0) / lens.length) / mean;
      if (lens.length >= 6 && cv < 0.15) notes.push(`every shot is ~${mean.toFixed(2)}s (variation ${Math.round(cv * 100)}%): metronome pacing reads as a slideshow. Hold the hero shots, quicken the build.`);
      const frames = await sequenceFrames(r.output, r.shots, join(paths.tmp(), `seq-${Date.now()}`));
      const sheet = await composeSheet(
        r.shots.map((s, i) => ({ file: frames[i], label: `${i + 1}. ${s.at.toFixed(2)}s +${s.duration.toFixed(2)}s`, sub: [basename(s.path), s.transitionIn?.type, s.move?.type !== "none" ? s.move?.type : "", describeSpeed(s)].filter(Boolean).join(" · ") })),
        join(paths.tmp(), `sequence-${Date.now()}.jpg`),
        { cols: Math.min(6, r.shots.length), title: `${basename(r.output)} — ${r.duration}s, ${r.shots.length} shots` },
      );
      const warn = [...r.warnings, ...notes];
      const lines = [
        `Rendered ${r.output} (${r.width}x${r.height}, ${r.duration}s, ${r.shots.length} shots) in ${r.seconds.toFixed(1)}s.`,
        r.loudness ? `Loudness: measured ${r.loudness.measuredI} LUFS, normalised to -14.` : "",
        r.musicNote ?? "",
        `Spec saved: ${r.specPath} (edit and re-run to iterate).`,
        ...r.shots.map((s) => `${s.index + 1}. ${s.at.toFixed(2)}s +${s.duration.toFixed(2)}s ${basename(s.path)} @${s.srcIn.toFixed(2)}s${s.transitionIn ? ` [${s.transitionIn.type} ${s.transitionIn.duration}s]` : ""}${s.move && s.move.type !== "none" ? ` ${s.move.type}` : ""}${describeSpeed(s) ? ` (${describeSpeed(s)})` : ""}${s.note ? ` — ${s.note}` : ""}`),
        warn.length ? `\nWARNINGS:\n${warn.map((w) => `- ${w}`).join("\n")}` : "",
        `\nLook at the sheet: is every frame the subject, on-brand and sharp where it matters? Then run review_edit {path: "${r.output}"}.`,
      ];
      return { content: [{ type: "image", data: readFileSync(sheet).toString("base64"), mimeType: "image/jpeg" }, { type: "text", text: lines.filter(Boolean).join("\n") }] };
    }),
  );
}
