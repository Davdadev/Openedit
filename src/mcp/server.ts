import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CAPTION_STYLES, type CaptionStyle, cuesFromTranscript, toASS, toSRT, toVTT } from "../engine/captions.js";
import { buildCutPlan, summarizePlan } from "../engine/cutplan.js";
import { probe, resolveMediaPath } from "../engine/media.js";
import { paths } from "../engine/paths.js";
import { editDuration, editSegments } from "../engine/remap.js";
import type { Reframe, ZoomSpec } from "../engine/render.js";
import { detectSilences } from "../engine/silence.js";
import { WHISPER_MODELS, type WhisperModel, stamp, transcribe, transcriptToText } from "../engine/transcribe.js";
import { activeHost, autoDetect, currentHostName, setActiveHost, StandaloneHost } from "../hosts/index.js";
import type { CutPlan, Marker, Transcript } from "../hosts/types.js";
import { loadMotion } from "../motion-loader.js";
import { loadPlan, savePlan } from "./plans.js";

export const VERSION = "0.1.0";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(t: string | object): ToolResult {
  return { content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }] };
}

/** Wrap a handler so thrown errors come back to Claude as readable tool errors. */
function safe<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (s: number) => stamp(s).slice(1, -1);

const modelSchema = z
  .enum(WHISPER_MODELS as [WhisperModel, ...WhisperModel[]])
  .optional()
  .describe('Whisper model. "base" (default) is fast; "small"/"medium"/"large-v3-turbo" are more accurate but slower. Downloaded on first use.');
const languageSchema = z.string().optional().describe('ISO language code such as "en" or "fr"; default auto-detect.');
const rangeSchema = z.object({
  start: z.number().min(0).describe("Seconds"),
  end: z.number().min(0).describe("Seconds"),
  label: z.string().optional(),
});

/** The media to analyse: explicit path, else the active host's source media. */
async function sourcePath(path?: string): Promise<string> {
  if (path) return resolveMediaPath(path);
  const host = await activeHost();
  const media = await host.getSourceMedia();
  if (!media.length) throw new Error(`No path given and the ${host.name} timeline has no source media. Pass a path.`);
  return media[0];
}

/** Human-readable list of what a plan removes, quoting the transcript where available. */
function describeCuts(plan: CutPlan, transcript?: Transcript, limit = 60): string {
  const words = transcript?.segments.flatMap((s) => s.words) ?? [];
  const lines = plan.cuts.slice(0, limit).map((c) => {
    const said = words
      .filter((w) => (w.start + w.end) / 2 >= c.start && (w.start + w.end) / 2 <= c.end)
      .map((w) => w.text)
      .join(" ");
    const what = c.label ?? (said ? `"${said.length > 70 ? `${said.slice(0, 67)}...` : said}"` : "");
    return `- ${fmt(c.start)}–${fmt(c.end)} (${(c.end - c.start).toFixed(2)}s) ${c.reason}${what ? `: ${what}` : ""}`;
  });
  if (plan.cuts.length > limit) lines.push(`… and ${plan.cuts.length - limit} more`);
  return lines.join("\n");
}

const WORKFLOW = `You are editing video with OpenEdit (local, open-source tools; no uploads).
Standard workflow:
1. editor_status — see which editor is connected (Premiere, Resolve, or standalone ffmpeg). Use select_host to change.
2. transcribe {path} — read the timestamped transcript. Note retakes, rambling, off-topic parts.
3. plan_cuts {path, removeSilences, removeFillers, removeRetakes, manualCuts} — manualCuts are ranges YOU choose from the transcript (e.g. a flubbed sentence, a tangent).
4. show_plan {planId} — review the cuts with the user (quote what gets removed, time saved). Adjust and re-plan if asked. Do not apply without the user's OK on non-trivial edits.
5. apply_cuts {planId} — builds a NEW sequence in the editor (the original is never modified).
6. make_captions {planId, style} — captions timed to the cut edit (styles: clean, bold-pop, minimal).
7. auto_zooms {planId} or add_zooms — punch-ins to hide jump cuts / add emphasis.
8. Optional: place_clips (b-roll, music with duckDb, SFX), render_motion (titles / lower thirds), add_markers.
9. render {output, reframe?: "9:16" for shorts, loudnorm: true} — in standalone mode this produces the final mp4.
All times are seconds. Times for markers, zooms, captions and placements are on the EDITED timeline (after cuts).`;

export function createServer(): McpServer {
  const server = new McpServer({ name: "openedit", version: VERSION }, { instructions: WORKFLOW });

  // ---------- host ----------
  server.registerTool(
    "editor_status",
    {
      description:
        "Show which video editor OpenEdit is driving (premiere, resolve, or standalone ffmpeg), whether it is connected, and the active project/sequence. Call this first.",
      inputSchema: {},
    },
    safe(async () => {
      const name = currentHostName();
      if (!name) {
        const { host, tried } = await autoDetect();
        setActiveHost(host.name);
        return text({ active: await host.status(), detection: tried });
      }
      return text({ active: await (await activeHost()).status() });
    }),
  );

  server.registerTool(
    "select_host",
    {
      description:
        'Choose the editor to drive: "premiere" (needs the OpenEdit panel open in Premiere Pro), "resolve" (DaVinci Resolve running with scripting enabled), "standalone" (no editor; edits are rendered with ffmpeg), or "auto" to re-detect.',
      inputSchema: { host: z.enum(["auto", "premiere", "resolve", "standalone"]) },
    },
    safe(async ({ host }) => {
      if (host === "auto") {
        const { host: h, tried } = await autoDetect();
        setActiveHost(h.name);
        return text({ active: await h.status(), detection: tried });
      }
      const h = setActiveHost(host);
      const st = await h.status();
      return text({ active: st, ...(st.connected ? {} : { warning: `${host} is not connected: ${st.detail ?? ""}` }) });
    }),
  );

  server.registerTool(
    "get_timeline",
    {
      description: "List the clips, tracks and markers of the active sequence/timeline in the current editor.",
      inputSchema: {},
    },
    safe(async () => text(await (await activeHost()).getTimeline())),
  );

  // ---------- analysis ----------
  server.registerTool(
    "probe_media",
    {
      description: "Get duration, resolution, frame rate and audio/video presence of a media file.",
      inputSchema: { path: z.string().describe("Absolute path to a media file") },
    },
    safe(async ({ path }) => text(await probe(path))),
  );

  server.registerTool(
    "transcribe",
    {
      description:
        "Transcribe speech locally with whisper.cpp (word-level timestamps). Returns the transcript as lines prefixed with [mm:ss.s] start times, plus the path of the full word-level JSON. Cached per file+model. If path is omitted, uses the active timeline's source media.",
      inputSchema: { path: z.string().optional(), model: modelSchema, language: languageSchema },
    },
    safe(async ({ path, model, language }) => {
      const src = await sourcePath(path);
      const { transcript, jsonPath, cached } = await transcribe(src, { model, language });
      const words = transcript.segments.reduce((n, s) => n + s.words.length, 0);
      return text(
        `Transcript of ${src} (${transcript.language}, ${r2(transcript.duration)}s, ${words} words${cached ? ", cached" : ""})\n` +
          `Word-level JSON: ${jsonPath}\n\n${transcriptToText(transcript)}`,
      );
    }),
  );

  server.registerTool(
    "find_silences",
    {
      description: "Find silent/dead-air ranges in a file's audio (ffmpeg silencedetect).",
      inputSchema: {
        path: z.string().optional(),
        thresholdDb: z.number().max(0).optional().describe("Silence threshold in dBFS, default -35. Use -30 for noisy rooms, -45 for very clean audio."),
        minDuration: z.number().positive().optional().describe("Minimum silence length in seconds, default 0.5"),
      },
    },
    safe(async ({ path, thresholdDb, minDuration }) => {
      const src = await sourcePath(path);
      const s = await detectSilences(src, { thresholdDb, minDuration });
      const total = s.reduce((a, r) => a + r.end - r.start, 0);
      return text(
        `${s.length} silences, ${r2(total)}s total\n` + s.map((r) => `- ${fmt(r.start)}–${fmt(r.end)} (${(r.end - r.start).toFixed(2)}s)`).join("\n"),
      );
    }),
  );

  // ---------- cutting ----------
  server.registerTool(
    "plan_cuts",
    {
      description:
        "Build a cut plan (which parts of the source to keep) from silences, filler words (um/uh…), retakes (restarted sentences) and your own manualCuts chosen from the transcript. Nothing is changed in the editor yet: returns a planId and a summary to review with the user, then call apply_cuts.",
      inputSchema: {
        path: z.string().optional(),
        removeSilences: z.boolean().optional().describe("Default true"),
        removeFillers: z.boolean().optional().describe("Default true (needs a transcript; transcribes automatically)"),
        removeRetakes: z.boolean().optional().describe("Default false. Cuts earlier attempts when a sentence is restarted within ~10s."),
        fillerWords: z.array(z.string()).optional().describe('Override filler list, e.g. ["um","uh","you know"]'),
        thresholdDb: z.number().max(0).optional().describe("Silence threshold dBFS (default -35)"),
        minSilence: z.number().positive().optional().describe("Shortest pause to remove, seconds (default 0.5)"),
        padding: z.number().min(0).max(1).optional().describe("Breathing room kept around speech at each cut, seconds (default 0.08)"),
        minKeep: z.number().min(0).optional().describe("Drop kept pieces shorter than this, seconds (default 0.25)"),
        manualCuts: z.array(rangeSchema).optional().describe("Extra SOURCE-time ranges to remove"),
        model: modelSchema,
        language: languageSchema,
      },
    },
    safe(async (a) => {
      const src = await sourcePath(a.path);
      const info = await probe(src);
      const removeSilences = a.removeSilences ?? true;
      const removeFillers = a.removeFillers ?? true;
      const removeRetakes = a.removeRetakes ?? false;
      const silences = removeSilences ? await detectSilences(src, { thresholdDb: a.thresholdDb, minDuration: a.minSilence }) : [];
      let transcript: Transcript | undefined;
      let transcriptPath: string | undefined;
      if (removeFillers || removeRetakes) {
        const t = await transcribe(src, { model: a.model, language: a.language });
        transcript = t.transcript;
        transcriptPath = t.jsonPath;
      }
      const plan = buildCutPlan({
        source: src,
        duration: info.duration,
        silences,
        transcript,
        removeFillers,
        removeRetakes,
        fillerWords: a.fillerWords,
        padding: a.padding,
        minKeep: a.minKeep,
        manualCuts: a.manualCuts,
      });
      const options = { ...a, path: src };
      const stored = savePlan(plan, options, transcriptPath);
      const sum = summarizePlan(plan);
      return text(
        `planId: ${stored.id}\n` +
          `${r2(sum.originalDuration)}s -> ${r2(sum.editedDuration)}s (saves ${r2(sum.timeSaved)}s, ${sum.percentSaved}%), ${sum.keptSegments} kept segments\n` +
          `cuts: ${Object.entries(sum.cutsByReason)
            .filter(([, v]) => v.count)
            .map(([k, v]) => `${k} ${v.count} (${r2(v.seconds)}s)`)
            .join(", ") || "none"}\n\n${describeCuts(plan, transcript, 25)}\n\nReview with the user, then apply_cuts {planId: "${stored.id}"}.`,
      );
    }),
  );

  server.registerTool(
    "show_plan",
    {
      description: "Show every cut in a plan with what was said in it, plus the kept segments, for review before applying.",
      inputSchema: { planId: z.string() },
    },
    safe(async ({ planId }) => {
      const stored = loadPlan(planId);
      let transcript: Transcript | undefined;
      if (stored.transcriptPath) {
        try {
          transcript = JSON.parse(readFileSync(stored.transcriptPath, "utf8")) as Transcript;
        } catch {
          transcript = undefined;
        }
      }
      const sum = summarizePlan(stored.plan);
      const keeps = editSegments(stored.plan)
        .map((s) => `- src ${fmt(s.sourceStart)}–${fmt(s.sourceEnd)} -> edit ${fmt(s.start)}–${fmt(s.end)}`)
        .join("\n");
      return text(
        `Plan ${planId} for ${stored.plan.source}\n${JSON.stringify(sum)}\n\nCuts:\n${describeCuts(stored.plan, transcript, 500)}\n\nKept segments:\n${keeps}`,
      );
    }),
  );

  server.registerTool(
    "apply_cuts",
    {
      description:
        "Apply a cut plan in the active editor. Premiere/Resolve: creates a NEW sequence with only the kept ranges (original untouched). Standalone: sets the timeline that render will export.",
      inputSchema: { planId: z.string(), sequenceName: z.string().optional() },
    },
    safe(async ({ planId, sequenceName }) => {
      const { plan } = loadPlan(planId);
      const host = await activeHost();
      const res = await host.applyCutPlan(plan, { sequenceName });
      return text({ host: host.name, ...res, editedDuration: r2(editDuration(plan)), segments: plan.keep.length });
    }),
  );

  // ---------- captions ----------
  server.registerTool(
    "make_captions",
    {
      description:
        "Create captions from the transcript and add them to the active editor. Pass planId to time captions to the CUT edit (use the same plan you applied), or path for an uncut file. Writes .srt, .vtt and .ass files. Styles: clean (white with outline), bold-pop (big uppercase, active word highlighted), minimal (small boxed).",
      inputSchema: {
        planId: z.string().optional(),
        path: z.string().optional(),
        style: z.enum(CAPTION_STYLES as [CaptionStyle, ...CaptionStyle[]]).optional().describe("Default bold-pop"),
        maxWords: z.number().int().min(1).max(20).optional().describe("Max words per caption (default 6; use 3-4 for shorts)"),
        maxChars: z.number().int().min(8).max(80).optional().describe("Max characters per caption (default 32)"),
        model: modelSchema,
        language: languageSchema,
      },
    },
    safe(async (a) => {
      let plan: CutPlan | undefined;
      let src: string;
      if (a.planId) {
        plan = loadPlan(a.planId).plan;
        src = plan.source;
      } else src = await sourcePath(a.path);
      const { transcript } = await transcribe(src, { model: a.model, language: a.language });
      const cues = cuesFromTranscript(transcript, { maxWords: a.maxWords, maxChars: a.maxChars, plan });
      if (!cues.length) throw new Error("No speech found to caption");
      const style = a.style ?? "bold-pop";
      const info = await probe(src);
      const stem = join(paths.captions(), `${basename(src, extname(src))}-${a.planId ?? "full"}`);
      const srtPath = `${stem}.srt`;
      writeFileSync(srtPath, toSRT(cues));
      writeFileSync(`${stem}.vtt`, toVTT(cues));
      writeFileSync(`${stem}.ass`, toASS(cues, { style, width: info.width, height: info.height }));
      const host = await activeHost();
      if (host instanceof StandaloneHost) host.setCaptionStyle(style);
      const res = await host.addCaptions(cues, { srtPath });
      const preview = cues.slice(0, 8).map((c) => `${fmt(c.start)} ${c.text}`).join("\n");
      return text(
        `${res.added} captions added in ${host.name} (style ${style}).\nFiles: ${srtPath}, ${stem}.vtt, ${stem}.ass\n\n${preview}${cues.length > 8 ? "\n…" : ""}`,
      );
    }),
  );

  // ---------- markers / zooms ----------
  server.registerTool(
    "add_markers",
    {
      description: "Add sequence markers (edited-timeline seconds), e.g. chapter points, highlights, or notes for the user.",
      inputSchema: {
        markers: z.array(
          z.object({
            time: z.number().min(0),
            duration: z.number().min(0).optional(),
            name: z.string(),
            comment: z.string().optional(),
            color: z.enum(["red", "green", "blue", "yellow", "purple", "orange", "white"]).optional(),
          }),
        ),
      },
    },
    safe(async ({ markers }) => {
      const host = await activeHost();
      return text(`${await host.addMarkers(markers as Marker[])} markers added in ${host.name}`);
    }),
  );

  const zoomSchema = z.object({
    start: z.number().min(0).describe("Edited-timeline seconds"),
    end: z.number().min(0),
    scale: z.number().min(100).max(300).describe("Percent, e.g. 115 = 15% punch-in"),
    ease: z.number().min(0).max(2).optional().describe("Ramp seconds (default 0.15; 0 = hard punch-in)"),
  });

  server.registerTool(
    "add_zooms",
    {
      description: "Add zoom/punch-in effects on the main camera over edited-timeline ranges (for emphasis or to hide jump cuts).",
      inputSchema: { zooms: z.array(zoomSchema) },
    },
    safe(async ({ zooms }) => {
      const bad = zooms.find((z) => z.end <= z.start);
      if (bad) throw new Error(`Zoom end must be after start (${bad.start}–${bad.end})`);
      const host = await activeHost();
      return text(`${await host.addZooms(zooms as ZoomSpec[])} zooms added in ${host.name}`);
    }),
  );

  server.registerTool(
    "auto_zooms",
    {
      description:
        "Automatic punch-ins for a cut edit: alternates framing between 100% and `scale` on each kept segment longer than `every` seconds, so jump cuts feel intentional. Adds them to the active editor.",
      inputSchema: {
        planId: z.string(),
        every: z.number().positive().optional().describe("Only segments at least this long (s) get a framing change; default 4"),
        scale: z.number().min(101).max(200).optional().describe("Punch-in percent, default 112"),
      },
    },
    safe(async ({ planId, every, scale }) => {
      const { plan } = loadPlan(planId);
      const minLen = every ?? 4;
      const s = scale ?? 112;
      const zooms: ZoomSpec[] = [];
      let n = 0;
      for (const seg of editSegments(plan)) {
        if (seg.end - seg.start < minLen) continue;
        if (n++ % 2 === 1) zooms.push({ start: r2(seg.start), end: r2(seg.end), scale: s, ease: 0 });
      }
      if (!zooms.length) return text(`No kept segments longer than ${minLen}s; no zooms added. Try a smaller "every".`);
      const host = await activeHost();
      const added = await host.addZooms(zooms);
      return text(`${added} punch-ins at ${s}% added in ${host.name}:\n${zooms.map((z) => `- ${fmt(z.start)}–${fmt(z.end)}`).join("\n")}`);
    }),
  );

  // ---------- media ----------
  server.registerTool(
    "import_media",
    {
      description: "Import media files into the editor's project (bin \"OpenEdit\"). In standalone mode, the first video imported becomes the timeline source.",
      inputSchema: { paths: z.array(z.string()).min(1) },
    },
    safe(async ({ paths: list }) => {
      const abs = list.map((p) => resolveMediaPath(p));
      const host = await activeHost();
      return text(`${await host.importMedia(abs)} files imported in ${host.name}`);
    }),
  );

  server.registerTool(
    "place_clips",
    {
      description:
        "Place clips on the timeline at edited-timeline times: b-roll/images on upper video tracks (track 2+), music and sound effects on audio tracks. Standalone extras: duration (images), duckDb (lower music under speech by ~N dB), loop, fadeOut.",
      inputSchema: {
        clips: z
          .array(
            z.object({
              path: z.string(),
              at: z.number().min(0).describe("Edited-timeline seconds"),
              sourceIn: z.number().min(0).optional(),
              sourceOut: z.number().min(0).optional(),
              track: z.number().int().min(1).optional().describe("1-based track; default 2 (above the main camera)"),
              gainDb: z.number().optional().describe("Audio gain, e.g. -18 for background music"),
              duration: z.number().positive().optional(),
              duckDb: z.number().min(0).max(30).optional(),
              loop: z.boolean().optional(),
              fadeOut: z.number().min(0).optional(),
            }),
          )
          .min(1),
      },
    },
    safe(async ({ clips }) => {
      const host = await activeHost();
      const resolved = clips.map((c) => ({ track: 2, ...c, path: resolveMediaPath(c.path) }));
      return text(`${await host.placeClips(resolved)} clips placed in ${host.name}`);
    }),
  );

  // ---------- render ----------
  server.registerTool(
    "render",
    {
      description:
        "Export the edited timeline to a file. Standalone: one ffmpeg pass with cuts, zooms, b-roll, music, captions, optional vertical reframe and loudness normalisation. Premiere/Resolve: queues the editor's own export (reframe/burnCaptions/loudnorm are standalone-only).",
      inputSchema: {
        output: z.string().describe("Output path, e.g. ~/Movies/final.mp4"),
        reframe: z.enum(["9:16", "1:1", "16:9", "4:5"]).optional().describe("Centre-crop to this aspect (9:16 for Shorts/Reels/TikTok)"),
        burnCaptions: z.boolean().optional().describe("Burn captions into the picture (default true when captions exist)"),
        loudnorm: z.boolean().optional().describe("Normalise loudness to -14 LUFS"),
        preset: z.string().optional().describe("Standalone: x264 preset; Premiere: .epr preset path; Resolve: render preset name"),
      },
    },
    safe(async (a) => {
      const host = await activeHost();
      const output = resolve(a.output.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
      if (host instanceof StandaloneHost) {
        const r = await host.renderTimeline({ ...a, output, reframe: a.reframe as Reframe | undefined });
        return text({ ...r, duration: r2(r.duration) });
      }
      return text(await host.render({ output, preset: a.preset }));
    }),
  );

  // ---------- motion graphics ----------
  server.registerTool(
    "motion_templates",
    {
      description: "List motion-graphics templates (titles, lower thirds, callouts…) and their parameters for render_motion.",
      inputSchema: {},
    },
    safe(async () => text((await loadMotion()).listTemplates())),
  );

  server.registerTool(
    "render_motion",
    {
      description:
        "Render a motion-graphics template to a video file (.mov with alpha by default) and optionally place it on the timeline at `placeAt` (edited seconds).",
      inputSchema: {
        template: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
        output: z.string().optional().describe("Default ~/.openedit/renders/<template>-<time>.mov"),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        fps: z.number().positive().optional(),
        duration: z.number().positive().optional(),
        placeAt: z.number().min(0).optional(),
        track: z.number().int().min(2).optional(),
      },
    },
    safe(async (a) => {
      const motion = await loadMotion();
      const output = a.output
        ? resolve(a.output.replace(/^~(?=\/)/, process.env.HOME ?? "~"))
        : join(paths.renders(), `${a.template}-${Date.now()}.mov`);
      const r = await motion.renderTemplate({
        template: a.template,
        params: a.params ?? {},
        output,
        width: a.width,
        height: a.height,
        fps: a.fps,
        duration: a.duration,
      });
      let placed = "";
      if (a.placeAt !== undefined) {
        const host = await activeHost();
        await host.placeClips([{ path: r.output, at: a.placeAt, track: a.track ?? 3 }]);
        placed = ` and placed at ${fmt(a.placeAt)} on V${a.track ?? 3} in ${host.name}`;
      }
      return text(`Rendered ${r.output}${placed}`);
    }),
  );

  server.registerTool(
    "render_caption_overlay",
    {
      description:
        "Render animated captions as a transparent video overlay (.mov with alpha) that can be placed over the edit in any editor. Use planId to time it to the cut edit.",
      inputSchema: {
        planId: z.string().optional(),
        path: z.string().optional(),
        style: z.string().optional().describe("Caption style, e.g. bold-pop, clean, minimal"),
        maxWords: z.number().int().min(1).max(20).optional(),
        output: z.string().optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        fps: z.number().positive().optional(),
        placeAt: z.number().min(0).optional().describe("Also place the overlay on the timeline at this time (usually 0)"),
        model: modelSchema,
        language: languageSchema,
      },
    },
    safe(async (a) => {
      let plan: CutPlan | undefined;
      let src: string;
      if (a.planId) {
        plan = loadPlan(a.planId).plan;
        src = plan.source;
      } else src = await sourcePath(a.path);
      const info = await probe(src);
      const { transcript } = await transcribe(src, { model: a.model, language: a.language });
      const cues = cuesFromTranscript(transcript, { maxWords: a.maxWords ?? 4, plan });
      const output = a.output
        ? resolve(a.output.replace(/^~(?=\/)/, process.env.HOME ?? "~"))
        : join(paths.renders(), `${basename(src, extname(src))}-captions-${Date.now()}.mov`);
      const r = await (await loadMotion()).renderCaptionOverlay({
        cues,
        style: a.style,
        output,
        width: a.width ?? info.width ?? 1920,
        height: a.height ?? info.height ?? 1080,
        fps: a.fps ?? info.fps ?? 30,
      });
      let placed = "";
      if (a.placeAt !== undefined) {
        const host = await activeHost();
        await host.placeClips([{ path: r.output, at: a.placeAt, track: 4 }]);
        placed = ` and placed on V4 in ${host.name}`;
      }
      return text(`Rendered ${cues.length} captions to ${r.output}${placed}`);
    }),
  );

  // ---------- prompt ----------
  server.registerPrompt(
    "auto_edit",
    {
      description: "Standard OpenEdit workflow: transcribe, plan cuts, review, apply, captions, zooms, render.",
      argsSchema: {
        path: z.string().optional().describe("Media file to edit (omit to use the active timeline)"),
        goal: z.string().optional().describe('e.g. "tight YouTube edit" or "60s vertical short"'),
      },
    },
    ({ path, goal }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `${WORKFLOW}\n\nEdit ${path ? `"${path}"` : "the active timeline's source"}` +
              `${goal ? ` with this goal: ${goal}` : ""}. Start with editor_status and transcribe, propose a cut plan, and ` +
              "show me what will be removed before applying anything.",
          },
        },
      ],
    }),
  );

  return server;
}

/** Run the MCP server on stdio (stdout is reserved for protocol messages). */
export async function runServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write(`openedit MCP server ${VERSION} ready on stdio\n`);
}
