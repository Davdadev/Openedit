import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CAPTION_STYLES, type CaptionAspect, type CaptionStyle, captionPreset, cuesFromTranscript, defaultCaptionStyle, placeCaptions, toASS, toSRT, toVTT } from "../engine/captions.js";
import { buildCutPlan, summarizePlan } from "../engine/cutplan.js";
import { probe, resolveMediaPath } from "../engine/media.js";
import { installShutdownHandlers } from "../engine/exec.js";
import { paths, sidecarPath } from "../engine/paths.js";
import { editDuration, editSegments } from "../engine/remap.js";
import type { Reframe, ZoomSpec } from "../engine/render.js";
import { INTERCHANGE_EXT, type InterchangeFormat, probeSourceDetails, writeInterchange } from "../engine/interchange.js";
import { detectSilencesDetailed } from "../engine/silence.js";
import { adaptiveLevels, analyzeEnergy, transcriptPauses, unionRanges } from "../engine/vad.js";
import { type ZoomDensity, planZooms, zoomWarnings } from "../engine/zooms.js";
import { formatReview, reviewEdit } from "../engine/review.js";
import { DEFAULT_FILLERS, TIGHTNESS, detectFillers, findRetakes } from "../engine/cutplan.js";
import { WHISPER_MODELS, type WhisperModel, stamp, transcribe, transcriptToText } from "../engine/transcribe.js";
import { activeHost, autoDetect, currentHostName, getHost, setActiveHost, StandaloneHost } from "../hosts/index.js";
import type { CutPlan, Marker, Transcript } from "../hosts/types.js";
import { loadMotion } from "../motion-loader.js";
import { loadPlan, savePlan } from "./plans.js";
import { autoStartStudio, studioUrl } from "../studio/index.js";
import { instrumentServer } from "../studio/instrument.js";
import { registerStudioTools } from "../studio/tools.js";
import { MEDIA_INSTRUCTIONS, registerMediaTools } from "../media/tools.js";
import { registerRhythmTools, timelineMusic } from "./rhythm-tools.js";
import { registerShotTools } from "../engine/analysis/tools.js";
import { GRAPHICS_INSTRUCTIONS, registerGraphicsTools } from "../graphics/tools.js";
import { cutPlanView, registerUi, renderView, statusView, transcriptView, uiMeta } from "../ui/index.js";

export const VERSION = "0.1.0";

type ToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

/** Attach structuredContent for the inline MCP Apps view (text content stays for text-only hosts). */
function withView(res: ToolResult, data: object | undefined): ToolResult {
  return data ? { ...res, structuredContent: data as Record<string, unknown> } : res;
}

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
6. make_captions {planId, aspect} — captions timed to the cut edit. Pass the aspect you will render; the style defaults by context (clean for 16:9, bold-pop only for 9:16 shorts).
7. auto_zooms {planId} — a few purposeful zooms (mask jump cuts, land real emphasis); add_zooms for your own. Less is more.
8. Optional: place_clips (b-roll, music with duckDb, SFX), render_motion (titles / lower thirds), add_markers.
9. render {output, reframe?: "9:16" for shorts, loudnorm: true} — in standalone mode this produces the final mp4.
10. review_edit {path, planId} after EVERY render: look at the contact sheet and waveform, fix every WARNING (re-plan, re-caption, fewer zooms) and re-render before reporting to the user.
All times are seconds. Times for markers, zooms, captions and placements are on the EDITED timeline (after cuts).`;

export function createServer(): McpServer {
  const server = new McpServer({ name: "openedit", version: VERSION }, { instructions: `${WORKFLOW}\n\n${MEDIA_INSTRUCTIONS}\n\n${GRAPHICS_INSTRUCTIONS}` });
  // OpenEdit Studio: report every tool call (including ones registered later) to the live view.
  instrumentServer(server);

  // ---------- host ----------
  server.registerTool(
    "editor_status",
    {
      description:
        "Show which video editor OpenEdit is driving (premiere, resolve, or standalone ffmpeg), whether it is connected, and the active project/sequence. Call this first.",
      inputSchema: {},
      _meta: uiMeta("status"),
    },
    safe(async () => {
      const name = currentHostName();
      if (!name) {
        const { host, tried } = await autoDetect();
        setActiveHost(host.name);
        const active = await host.status();
        return withView(text({ active, detection: tried }), statusView(active, tried, studioUrl()));
      }
      const active = await (await activeHost()).status();
      return withView(text({ active }), statusView(active, undefined, studioUrl()));
    }),
  );

  server.registerTool(
    "select_host",
    {
      description:
        'Choose the editor to drive: "premiere" (needs the OpenEdit panel open in Premiere Pro), "resolve" (DaVinci Resolve running with scripting enabled), "standalone" (no editor; edits are rendered with ffmpeg), or "auto" to re-detect.',
      inputSchema: { host: z.enum(["auto", "premiere", "resolve", "standalone"]) },
      _meta: uiMeta("status"),
    },
    safe(async ({ host }) => {
      if (host === "auto") {
        const { host: h, tried } = await autoDetect();
        setActiveHost(h.name);
        const active = await h.status();
        return withView(text({ active, detection: tried }), statusView(active, tried, studioUrl()));
      }
      const h = setActiveHost(host);
      const st = await h.status();
      const warning = st.connected ? undefined : `${host} is not connected: ${st.detail ?? ""}`;
      return withView(text({ active: st, ...(warning ? { warning } : {}) }), statusView(st, undefined, studioUrl(), warning));
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
      inputSchema: {
        path: z.string().optional(),
        model: modelSchema,
        language: languageSchema,
        prompt: z
          .string()
          .optional()
          .describe('Whisper initial prompt. Default: a disfluent example so fillers ("um", "uh") are transcribed verbatim. "" for none.'),
      },
      _meta: uiMeta("transcript"),
    },
    safe(async ({ path, model, language, prompt }) => {
      const src = await sourcePath(path);
      const { transcript, jsonPath, cached } = await transcribe(src, { model, language, prompt });
      const words = transcript.segments.reduce((n, s) => n + s.words.length, 0);
      return withView(text(
        `Transcript of ${src} (${transcript.language}, ${r2(transcript.duration)}s, ${words} words${cached ? ", cached" : ""})\n` +
          `Word-level JSON: ${jsonPath}\n\n${transcriptToText(transcript)}`,
      ), transcriptView(src, transcript, jsonPath, cached));
    }),
  );

  server.registerTool(
    "find_silences",
    {
      description:
        "Find silent/dead-air ranges in a file's audio. Without thresholdDb the threshold adapts to the clip's noise floor and speech level (works with room tone; under a music bed prefer plan_cuts, which also uses the transcript's pauses).",
      inputSchema: {
        path: z.string().optional(),
        thresholdDb: z.number().max(0).optional().describe("Fixed silence threshold in dBFS (ffmpeg silencedetect). Omit for adaptive."),
        minDuration: z.number().positive().optional().describe("Minimum silence length in seconds, default 0.5"),
      },
    },
    safe(async ({ path, thresholdDb, minDuration }) => {
      const src = await sourcePath(path);
      const det = await detectSilencesDetailed(src, { thresholdDb, minDuration });
      const s = det.silences;
      const total = s.reduce((a, r) => a + r.end - r.start, 0);
      const how = det.adaptive && det.levels
        ? `adaptive threshold ${det.thresholdDb} dBFS (noise floor ${det.levels.floorDb}, speech ${det.levels.speechDb})`
        : `threshold ${det.thresholdDb} dBFS`;
      return text(
        `${s.length} silences, ${r2(total)}s total, ${how}\n` + s.map((r) => `- ${fmt(r.start)}–${fmt(r.end)} (${(r.end - r.start).toFixed(2)}s)`).join("\n"),
      );
    }),
  );

  // ---------- cutting ----------
  server.registerTool(
    "plan_cuts",
    {
      description:
        "Build a cut plan (which parts of the source to keep) from pauses, filler words (um/uh…), retakes (restarted sentences) and your own manualCuts chosen from the transcript. " +
          "Pauses are SHORTENED to a natural beat (keepPause, ~0.3 s; more at sentence ends), never removed to zero, cut edges never land inside a word and are snapped to the quietest 10 ms, " +
          "and kept pieces shorter than minKeep are merged rather than left as choppy fragments. Ambiguous fillers (like, so, you know, I mean) are only removed when isolated by pauses/commas and only if you list them in fillerWords. " +
          "Nothing is changed in the editor yet: returns a planId and a summary to review with the user, then call apply_cuts.",
      inputSchema: {
        path: z.string().optional(),
        removeSilences: z.boolean().optional().describe("Default true"),
        removeFillers: z.boolean().optional().describe("Default true (needs a transcript; transcribes automatically)"),
        removeRetakes: z.boolean().optional().describe("Default false. Cuts earlier attempts when a sentence is restarted within ~10s."),
        fillerWords: z
          .array(z.string())
          .optional()
          .describe('Override filler list. Default only hesitations (um, uh, erm…). Context words like "like", "so", "you know", "I mean" are removed only where isolated (not "I would like")'),
        tightness: z
          .enum(["loose", "normal", "tight"])
          .optional()
          .describe("Pacing preset: loose (pauses >= 0.9s shortened to 0.45s), normal (>= 0.6s -> 0.32s, default), tight (>= 0.45s -> 0.22s). Explicit values below win."),
        thresholdDb: z.number().max(0).optional().describe("Fixed silence threshold dBFS. Omit for adaptive (measured from the clip)."),
        minSilence: z.number().positive().optional().describe("Shortest pause to shorten, seconds (default from tightness, 0.6)"),
        keepPause: z
          .number()
          .min(0)
          .max(2)
          .optional()
          .describe("Pause left where a longer one is shortened, seconds (default from tightness, 0.32; ~60% after the word, ~40% before the next). 0 removes pauses entirely (not recommended: breathless)"),
        padding: z.number().min(0).max(1).optional().describe("Legacy: fixed symmetric padding around speech at each cut, replaces the keepPause split. Prefer keepPause"),
        minKeep: z.number().min(0).optional().describe("Kept pieces shorter than this are merged with a neighbour, seconds (default from tightness, 0.4)"),
        manualCuts: z.array(rangeSchema).optional().describe("Extra SOURCE-time ranges to remove"),
        model: modelSchema,
        language: languageSchema,
      },
      _meta: uiMeta("cut-plan"),
    },
    safe(async (a) => {
      if (!a.path) {
        const host = await activeHost();
        const media = await host.getSourceMedia();
        // Standalone lists imported b-roll after its one cut source; editors may hold several camera files.
        if (host.name !== "standalone" && media.length > 1) {
          throw new Error(
            `The ${host.name} timeline uses ${media.length} source files and a cut plan covers one source. ` +
              `Call plan_cuts once per source with path set:\n${media.map((m) => `- ${m}`).join("\n")}`,
          );
        }
      }
      const src = await sourcePath(a.path);
      const info = await probe(src);
      const removeSilences = a.removeSilences ?? true;
      const removeFillers = a.removeFillers ?? true;
      const removeRetakes = a.removeRetakes ?? false;
      const tightness = a.tightness ?? "normal";
      const minSilence = a.minSilence ?? TIGHTNESS[tightness].minSilence;
      const model = a.model ?? "base";
      const notes: string[] = [];
      let transcript: Transcript | undefined;
      let transcriptPath: string | undefined;
      if (!info.hasAudio) {
        // Nothing to listen to: no pauses, fillers or retakes to find. Only manualCuts apply.
        notes.push("no audio stream: pause / filler / retake detection skipped; only manualCuts are applied");
      } else {
        try {
          const t = await transcribe(src, { model, language: a.language });
          transcript = t.transcript;
          transcriptPath = t.jsonPath;
        } catch (e) {
          if (removeFillers || removeRetakes) throw e;
          notes.push(`no transcript (${(e as Error).message}); silences from audio energy only`);
        }
      }
      let silences: { start: number; end: number }[] = [];
      // 10 ms envelope: protects word tails/onsets and lands cut edges on the quietest 10 ms.
      let fine: Awaited<ReturnType<typeof analyzeEnergy>> | undefined;
      let fineLevels: ReturnType<typeof adaptiveLevels> | undefined;
      if (info.hasAudio) {
        try {
          fine = await analyzeEnergy(src, 0.01);
          fineLevels = adaptiveLevels((await analyzeEnergy(src)).db);
        } catch (e) {
          notes.push(`energy analysis failed (${(e as Error).message.split("\n")[0]}); cut edges not snapped`);
        }
      }
      if (removeSilences && info.hasAudio) {
        const det = await detectSilencesDetailed(src, { thresholdDb: a.thresholdDb, minDuration: minSilence });
        const lv = det.levels;
        notes.push(
          `audio silences: ${det.silences.length} below ${det.thresholdDb} dBFS` +
            (det.adaptive && lv ? ` (adaptive; noise floor ${lv.floorDb}, speech ${lv.speechDb})` : " (fixed threshold)"),
        );
        silences = det.silences;
        if (transcript) {
          const energy = await analyzeEnergy(src);
          const pauses = transcriptPauses(transcript, info.duration, { minDuration: minSilence, energy, levels: lv ?? adaptiveLevels(energy.db) });
          const extra = pauses.filter((p) => !det.silences.some((s) => s.start < p.end && s.end > p.start)).length;
          notes.push(`transcript pauses: ${pauses.length} (${extra} not found by audio level, e.g. under music)`);
          silences = unionRanges([...det.silences, ...pauses]);
        }
      }
      let fillerCount = 0;
      if (transcript) {
        fillerCount = detectFillers(transcript, a.fillerWords ?? DEFAULT_FILLERS).length;
        let msg = `fillers found: ${fillerCount}${removeFillers ? "" : " (not removed)"}`;
        if (!fillerCount && (model === "tiny" || model === "base")) {
          msg += `. whisper ${model} often drops "um/uh"; if the speaker hesitates, re-run with model: "small" or "medium"`;
        }
        notes.push(msg);
      }
      const retakes = transcript ? findRetakes(transcript, { fillerWords: a.fillerWords }) : [];
      const plan = buildCutPlan({
        source: src,
        duration: info.duration,
        silences,
        transcript,
        removeFillers,
        removeRetakes,
        fillerWords: a.fillerWords,
        tightness,
        padding: a.padding,
        keepPause: a.keepPause,
        minKeep: a.minKeep,
        manualCuts: a.manualCuts,
        energy: fine,
        levels: fineLevels,
      });
      notes.push(`pauses shortened to ~${a.keepPause ?? TIGHTNESS[tightness].keepPause}s (not removed)`);
      const options = { ...a, path: src, tightness };
      const stored = savePlan(plan, options, transcriptPath);
      const sum = summarizePlan(plan);
      const retakeText = retakes.length
        ? `\n\n${removeRetakes ? "Retakes cut (check each; the earlier attempt is removed)" : "Possible retakes NOT cut (pass removeRetakes: true, or use manualCuts)"}:\n` +
          retakes
            .map((r) => `- ${fmt(r.cut.start)}–${fmt(r.cut.end)} (${(r.cut.end - r.cut.start).toFixed(1)}s) "${r.attempt}" -> restart "${r.restart}…" [${r.why}]`)
            .join("\n")
        : "";
      return withView(text(
        `planId: ${stored.id}\n` +
          `${r2(sum.originalDuration)}s -> ${r2(sum.editedDuration)}s (saves ${r2(sum.timeSaved)}s, ${sum.percentSaved}%), ${sum.keptSegments} kept segments, tightness ${tightness}\n` +
          `cuts: ${Object.entries(sum.cutsByReason)
            .filter(([, v]) => v.count)
            .map(([k, v]) => `${k} ${v.count} (${r2(v.seconds)}s)`)
            .join(", ") || "none"}\n` +
          `analysis: ${notes.join("; ")}${retakeText}\n\n${describeCuts(plan, transcript, 25)}\n\nReview with the user, then apply_cuts {planId: "${stored.id}"}.`,
      ), await cutPlanView(stored, { transcript }));
    }),
  );

  server.registerTool(
    "show_plan",
    {
      description: "Show every cut in a plan with what was said in it, plus the kept segments, for review before applying.",
      inputSchema: { planId: z.string() },
      _meta: uiMeta("cut-plan"),
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
      return withView(text(
        `Plan ${planId} for ${stored.plan.source}\n${JSON.stringify(sum)}\n\nCuts:\n${describeCuts(stored.plan, transcript, 500)}\n\nKept segments:\n${keeps}`,
      ), await cutPlanView(stored, { transcript }));
    }),
  );

  server.registerTool(
    "apply_cuts",
    {
      description:
        "Apply a cut plan in the active editor. Premiere/Resolve: creates a NEW sequence with only the kept ranges (original untouched). Standalone: sets the timeline that render will export.",
      inputSchema: { planId: z.string(), sequenceName: z.string().optional() },
      _meta: uiMeta("cut-plan"),
    },
    safe(async ({ planId, sequenceName }) => {
      const stored = loadPlan(planId);
      const { plan } = stored;
      const host = await activeHost();
      const res = await host.applyCutPlan(plan, { sequenceName });
      return withView(
        text({ host: host.name, ...res, editedDuration: r2(editDuration(plan)), segments: plan.keep.length }),
        await cutPlanView(stored, { applied: { host: host.name, ...res } }),
      );
    }),
  );

  // ---------- captions ----------
  server.registerTool(
    "make_captions",
    {
      description:
        "Create captions from the transcript and add them to the active editor. Pass planId to time captions to the CUT edit (use the same plan you applied), or path for an uncut file. Writes .srt, .vtt and .ass files. " +
          "Pass `aspect` = the aspect you will render: line length, layout and the default style follow it (16:9 long-form: clean, one line <= 42 chars; 9:16 short-form: bold-pop, <= 3 words). " +
          "Cues break at phrase boundaries (never after 'the', 'in', 'and'… when avoidable, no orphan words), stay 0.9–5 s and aim for <= 17 characters/second. Captions are kept off the speaker's face when face detection is available. " +
          "Styles: clean (sentence case on soft boxes; the professional default), bold-pop (big uppercase, active word highlighted; for vertical shorts), minimal (small, quiet).",
      inputSchema: {
        planId: z.string().optional(),
        path: z.string().optional(),
        aspect: z.enum(["16:9", "9:16", "1:1", "4:5"]).optional().describe("Aspect of the render these captions are for. Default: the source's aspect"),
        style: z
          .enum(CAPTION_STYLES as [CaptionStyle, ...CaptionStyle[]])
          .optional()
          .describe('Default by context: "clean" for 16:9 / long-form, "bold-pop" for 9:16 short-form (<= 3 min). Bold-pop on a calm interview looks cheap.'),
        maxWords: z.number().int().min(1).max(20).optional().describe("Max words per caption (preset: 12 for 16:9, 3 for bold-pop)"),
        maxChars: z.number().int().min(8).max(90).optional().describe("Max characters per caption (all lines)"),
        maxCharsPerLine: z.number().int().min(8).max(60).optional().describe("Max characters per line (preset: 42 for 16:9, 22 for 9:16, 18 for bold-pop)"),
        maxLines: z.number().int().min(1).max(2).optional().describe("Lines per caption (preset: 1 for 16:9 and bold-pop, 2 for 9:16 clean)"),
        avoidFaces: z.boolean().optional().describe("Move captions off the speaker's face (needs macOS face detection). Default true"),
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
      const info = await probe(src);
      const srcAspect: CaptionAspect = info.width && info.height && info.height > info.width ? "9:16" : "16:9";
      const aspect = (a.aspect ?? srcAspect) as CaptionAspect;
      const editLen = plan ? editDuration(plan) : info.duration;
      const baseStyle: CaptionStyle = a.style ?? defaultCaptionStyle(aspect, editLen);
      const preset = captionPreset(aspect, baseStyle);
      const cues = cuesFromTranscript(transcript, {
        ...preset,
        ...(a.maxWords !== undefined ? { maxWords: a.maxWords } : {}),
        ...(a.maxChars !== undefined ? { maxChars: a.maxChars } : {}),
        ...(a.maxCharsPerLine !== undefined ? { maxCharsPerLine: a.maxCharsPerLine } : {}),
        ...(a.maxLines !== undefined ? { maxLines: a.maxLines } : {}),
        plan,
      });
      if (!cues.length) throw new Error("No speech found to caption");
      const notes: string[] = [];
      if (baseStyle === "bold-pop" && aspect === "16:9") notes.push("bold-pop on 16:9 long-form usually reads as cheap; clean is the professional default");
      // Keep captions off faces (uses the reframe face track when available; cached per file).
      let style: string = baseStyle;
      if (a.avoidFaces !== false && info.hasVideo) {
        try {
          const { detectFaces } = await import("../engine/reframe.js");
          const faces = await detectFaces(src);
          const vertical = aspect === "9:16" || aspect === "4:5";
          const place = placeCaptions(faces, baseStyle, vertical);
          if (place.position) style = `${baseStyle}:position=${place.position}`;
          if (place.note) notes.push(place.note);
        } catch (e) {
          notes.push(`face check skipped (${(e as Error).message.split("\n")[0]})`);
        }
      }
      const stem = join(paths.captions(), `${basename(src, extname(src))}-${a.planId ?? "full"}`);
      const srtPath = `${stem}.srt`;
      writeFileSync(srtPath, toSRT(cues));
      writeFileSync(`${stem}.vtt`, toVTT(cues));
      writeFileSync(`${stem}.ass`, toASS(cues, { style, width: info.width, height: info.height }));
      const host = await activeHost();
      // The caption renderer accepts "style:position=…" specs.
      if (host instanceof StandaloneHost) host.setCaptionStyle(style as CaptionStyle);
      const res = await host.addCaptions(cues, { srtPath });
      const preview = cues.slice(0, 8).map((c) => `${fmt(c.start)} ${c.text.replace(/\n/g, " / ")}`).join("\n");
      return text(
        `${res.added} captions added in ${host.name} (style ${style}, for ${aspect}: <= ${preset.maxLines ?? 1} line(s) of ${preset.maxCharsPerLine} chars).` +
          `${notes.length ? `\nNotes: ${notes.join("; ")}` : ""}\nFiles: ${srtPath}, ${stem}.vtt, ${stem}.ass\n\n${preview}${cues.length > 8 ? "\n…" : ""}`,
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
        "A FEW purposeful zooms for a cut edit, the way an editor uses them: (a) a hard change of framing exactly on a jump cut to disguise it (ending on a later cut when possible), " +
          "(b) a push-in that lands a genuinely emphasised moment (a strong claim, a striking number, an exclamation). Sparse by design: long-form <= ~1 per 20 s at density \"normal\", never on adjacent segments or back-to-back. " +
          "Scale defaults to 106/110% (long) or 108/112% (shorts) so 1080p stays sharp. Adds them to the active editor; call apply_cuts again first to clear earlier zooms.",
      inputSchema: {
        planId: z.string(),
        aspect: z.enum(["16:9", "9:16", "1:1", "4:5"]).optional().describe("Aspect you will render: 9:16/4:5 = short-form pacing. Default: the source's aspect"),
        density: z.enum(["subtle", "normal", "energetic"]).optional().describe('How many: subtle (~1/40 s long-form), normal (default, ~1/20 s), energetic (~1/10 s; shorts ~1/4 s)'),
        style: z.enum(["punch", "smooth"]).optional().describe('Emphasis zooms: "smooth" eased push (default for long-form) or "punch" (default for shorts). Jump-cut zooms are always hard.'),
        scale: z.number().min(101).max(200).optional().describe("Emphasis zoom percent, default 110 (long) / 112 (short). Above ~112% a 1080p source looks soft"),
        baseScale: z.number().min(101).max(200).optional().describe("Jump-cut zoom percent, default 106 (long) / 108 (short)"),
        minGap: z.number().positive().optional().describe("Minimum seconds between zoom starts (default from density)"),
        every: z.number().positive().optional().describe("Only for an UNCUT clip without a transcript: one zoom every this many seconds"),
      },
    },
    safe(async ({ planId, aspect, density, style, scale, baseScale, minGap, every }) => {
      const stored = loadPlan(planId);
      let transcript: Transcript | undefined;
      if (stored.transcriptPath) {
        try {
          transcript = JSON.parse(readFileSync(stored.transcriptPath, "utf8")) as Transcript;
        } catch {
          transcript = undefined;
        }
      }
      const info = await probe(stored.plan.source);
      const vertical = aspect ? aspect === "9:16" || aspect === "4:5" : !!(info.width && info.height && info.height > info.width);
      const format = vertical ? "short" : "long";
      const levels = scale || baseScale ? [baseScale ?? (format === "short" ? 108 : 106), scale ?? (format === "short" ? 112 : 110)] : undefined;
      const planned = planZooms(stored.plan, transcript, { style, density: density as ZoomDensity | undefined, format, levels, minGap, every });
      if (!planned.length) return text("No purposeful zoom moments found (no visible jump cuts or strong emphasis). That is fine: do not add zooms for their own sake; use add_zooms only for a moment you can justify.");
      const host = await activeHost();
      const added = await host.addZooms(planned.map(({ kind: _k, text: _t, ...z }) => z as ZoomSpec));
      // Effective upscale: the output shows (source height / zoom) pixels at the output height (same as the source for a crop).
      const warn = zoomWarnings(planned, { sourceHeight: info.height, outputHeight: info.height });
      const hard = planned.filter((z) => !z.ease).length;
      const mins = editDuration(stored.plan) / 60;
      return text(
        `${added} zooms added in ${host.name} (${hard} hard punch-ins on cuts, ${planned.length - hard} eased pushes; ${(planned.length / Math.max(mins, 0.01)).toFixed(1)}/min, ${format}-form ${density ?? "normal"}):\n` +
          planned.map((z) => `- ${fmt(z.start)}–${fmt(z.end)} ${z.scale}% ${z.kind}${z.text ? ` ${z.text.length > 60 ? `${z.text.slice(0, 57)}...` : z.text}` : ""}`).join("\n") +
          (warn.length ? `\nWARNINGS:\n${warn.map((w) => `- ${w}`).join("\n")}` : ""),
      );
    }),
  );

  // ---------- review ----------
  server.registerTool(
    "review_edit",
    {
      description:
        "Review a RENDERED edit like a senior editor. CALL THIS AFTER EVERY render, look at the images, and fix every WARNING (re-plan cuts, re-caption, fewer/smaller zooms, loudnorm) and re-render BEFORE reporting to the user. " +
          "Returns a contact sheet (frames 0.3 s before/after cuts and at regular intervals: check jump cuts, zoom framing, captions over faces, caption line breaks), " +
          "a waveform with joins/zooms marked plus 1 s close-ups of joins (check breaths kept, no clipped word tails), and stats: duration vs plan, cuts/min, shortest keep, pauses at joins, longest remaining pause, " +
          "words cut mid-word, zooms/min, caption reading speed and line quality, LUFS / true peak, clipping, black or frozen frames.",
      inputSchema: {
        path: z.string().describe("The rendered file"),
        planId: z.string().optional().describe("The plan it was rendered from (default: the standalone timeline's plan)"),
      },
    },
    safe(async ({ path, planId }) => {
      const out = resolveMediaPath(path);
      const sa = getHost("standalone") as StandaloneHost;
      const proj = sa.getProject();
      let plan: CutPlan | undefined;
      let transcript: Transcript | undefined;
      if (planId) {
        const stored = loadPlan(planId);
        plan = stored.plan;
        if (stored.transcriptPath) {
          try {
            transcript = JSON.parse(readFileSync(stored.transcriptPath, "utf8")) as Transcript;
          } catch {
            transcript = undefined;
          }
        }
      } else if (proj.plan) plan = proj.plan;
      const same = !!plan && !!proj.plan && proj.plan.source === plan.source && JSON.stringify(proj.plan.keep) === JSON.stringify(plan.keep);
      const r = await reviewEdit(out, {
        plan,
        transcript,
        zooms: same ? proj.zooms : undefined,
        captions: same ? proj.captions : undefined,
        music: same ? await timelineMusic(proj.placements) : undefined,
      });
      const content: ToolResult["content"] = [];
      if (r.sheet) content.push({ type: "image", data: r.sheet.toString("base64"), mimeType: "image/jpeg" });
      if (r.wave) content.push({ type: "image", data: r.wave.toString("base64"), mimeType: "image/png" });
      content.push({
        type: "text",
        text: `${formatReview(r, out)}${r.sheetPath ? `\nContact sheet: ${r.sheetPath}` : ""}${r.wavePath ? `\nWaveform: ${r.wavePath}` : ""}`,
      });
      return { content };
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
        "Export the edited timeline to a file. Standalone: one ffmpeg pass with cuts, subject-aware reframe, zooms, b-roll, music, captions and loudness normalisation. Premiere/Resolve: queues the editor's own export (reframe/burnCaptions/loudnorm/quality are standalone-only). Use quality \"draft\" for quick previews, \"final\" (default) for delivery.",
      inputSchema: {
        output: z.string().describe("Output path, e.g. ~/Movies/final.mp4"),
        reframe: z
          .union([
            z.enum(["9:16", "1:1", "16:9", "4:5"]),
            z.object({
              aspect: z.enum(["9:16", "1:1", "16:9", "4:5"]),
              mode: z.enum(["auto", "center", "manual"]).optional().describe("auto (default) follows the speaker's face; center = static centre crop; manual = static crop at focusX"),
              focusX: z.number().min(0).max(1).optional().describe("Horizontal focus 0 (left) .. 1 (right): manual crop position, and the auto fallback when no face is found"),
              focusY: z.number().min(0).max(1).optional().describe("Vertical focus 0 (top) .. 1 (bottom), for vertical sources cropped wider"),
            }),
          ])
          .optional()
          .describe('Crop to this aspect (9:16 for Shorts/Reels/TikTok). A string means {aspect, mode:"auto"}: the crop follows the speaker\'s face (macOS Vision), smoothed like a camera operator.'),
        burnCaptions: z.boolean().optional().describe("Burn captions into the picture (default true when captions exist)"),
        loudnorm: z.boolean().optional().describe("Normalise loudness to -14 LUFS, true peak under -1.5 dBTP (two-pass for final quality)"),
        quality: z.enum(["draft", "final"]).optional().describe("draft: hardware encode, lighter caption render, single-pass loudness (fast preview). final (default): x264 + two-pass loudness"),
        preset: z.string().optional().describe("Standalone: x264 preset; Premiere: .epr preset path; Resolve: render preset name"),
      },
      _meta: uiMeta("render"),
    },
    safe(async (a) => {
      const host = await activeHost();
      const output = resolve(a.output.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
      if (host instanceof StandaloneHost) {
        const rf = typeof a.reframe === "string" ? { aspect: a.reframe } : a.reframe;
        const r = await host.renderTimeline({
          output,
          burnCaptions: a.burnCaptions,
          loudnorm: a.loudnorm,
          preset: a.preset,
          quality: a.quality,
          reframe: rf?.aspect as Reframe | undefined,
          reframeMode: rf && "mode" in rf ? rf.mode : undefined,
          focusX: rf && "focusX" in rf ? rf.focusX : undefined,
          focusY: rf && "focusY" in rf ? rf.focusY : undefined,
        });
        return withView(
          text({ ...r, duration: r2(r.duration) }),
          await renderView({ kind: "render", output: r.output, host: host.name, warnings: r.warnings, studioUrl: studioUrl() }, probe),
        );
      }
      const r = await host.render({ output, preset: a.preset });
      return withView(
        text(r),
        await renderView({ kind: "render", output: r.output, host: host.name, detail: `Queued in ${host.name}`, studioUrl: studioUrl() }, probe),
      );
    }),
  );

  // ---------- NLE interchange ----------
  server.registerTool(
    "export_timeline",
    {
      description:
        "Write the cut edit as a timeline file any editor can open: fcp7 (Final Cut Pro 7 XML: Premiere Pro File > Import, DaVinci Resolve File > Import > Timeline), " +
        "fcpxml (FCPXML 1.10: Final Cut Pro, Resolve), edl (CMX 3600: any NLE), or srt (captions only). Frame-accurate, linked audio/video, markers, zooms (fcp7/fcpxml) and captions (fcpxml; SRT sidecar otherwise). " +
        "USE THIS when no editor bridge is connected (editor_status shows standalone), when the user edits in Final Cut Pro, free DaVinci Resolve (its external scripting needs Studio) or any other NLE, " +
        "or as a fallback when apply_cuts fails in Premiere/Resolve. Then tell the user the exact import menu path.",
      inputSchema: {
        planId: z.string(),
        format: z.enum(["fcp7", "fcpxml", "edl", "srt"]),
        output: z.string().optional().describe("Output path (default ~/.openedit/renders/<source>-<planId>.<ext>)"),
        name: z.string().optional().describe("Sequence/project name in the editor"),
        captions: z.boolean().optional().describe("Include captions (default true when a transcript exists)"),
        markers: z
          .array(z.object({ time: z.number().min(0), duration: z.number().min(0).optional(), name: z.string(), comment: z.string().optional(), color: z.enum(["red", "green", "blue", "yellow", "purple", "orange", "white"]).optional() }))
          .optional()
          .describe("Edited-timeline markers (default: the standalone timeline's markers for this plan)"),
      },
    },
    safe(async (a) => {
      const stored = loadPlan(a.planId);
      const { plan } = stored;
      const info = await probe(plan.source);
      const source = await probeSourceDetails(plan.source);
      // Reuse what the standalone timeline holds for this exact plan (captions, zooms, markers).
      const sa = getHost("standalone") as StandaloneHost;
      const proj = sa.getProject();
      const same = proj.plan && proj.plan.source === plan.source && JSON.stringify(proj.plan.keep) === JSON.stringify(plan.keep);
      let captions = a.captions === false ? [] : same && proj.captions.length ? proj.captions : [];
      if (a.captions !== false && !captions.length && stored.transcriptPath) {
        try {
          captions = cuesFromTranscript(JSON.parse(readFileSync(stored.transcriptPath, "utf8")) as Transcript, { plan });
        } catch {
          captions = [];
        }
      }
      const format = a.format as InterchangeFormat;
      const ext = INTERCHANGE_EXT[format];
      const output = a.output
        ? resolve(a.output.replace(/^~(?=\/)/, process.env.HOME ?? "~"))
        : join(paths.renders(), `${basename(plan.source, extname(plan.source))}-${a.planId}${ext}`);
      const input = {
        plan,
        info,
        source,
        name: a.name,
        markers: (a.markers as Marker[] | undefined) ?? (same ? proj.markers : []),
        zooms: same ? proj.zooms : [],
        captions,
      };
      writeInterchange(format, input, output);
      let srt: string | undefined;
      if (format !== "srt" && format !== "fcpxml" && captions.length) {
        srt = sidecarPath(output, ".srt");
        writeFileSync(srt, toSRT(captions));
      }
      const how: Record<InterchangeFormat, string> = {
        fcp7: "Premiere Pro: File > Import (choose the .xml). DaVinci Resolve: File > Import > Timeline… (keep 'Automatically import source clips into media pool' on).",
        fcpxml: "Final Cut Pro: File > Import > XML…. DaVinci Resolve: File > Import > Timeline….",
        edl: "Import the EDL in your editor (Resolve: File > Import > Timeline…; Premiere: File > Import) and relink to the source file if asked.",
        srt: "Import the .srt as captions/subtitles in your editor.",
      };
      return text(
        `Wrote ${format} timeline: ${output}
` +
          `${plan.keep.length} segments, ${r2(editDuration(plan))}s, ${captions.length} captions, ${input.markers.length} markers, ${input.zooms.length} zooms` +
          `${srt ? `\nCaptions sidecar: ${srt}` : ""}\n\n${how[format]}`,
      );
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
        "Render a motion-graphics template to a video file (.mov with alpha by default) and optionally place it on the timeline at `placeAt` (edited seconds). Size defaults to the timeline's OUTPUT frame (pass `aspect` when you will render 9:16/1:1, or width/height matching the final export) so left/right graphics are not cropped. In standalone mode a placed graphic is re-rendered automatically if the final render uses another aspect.",
      inputSchema: {
        template: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
        output: z.string().optional().describe("Default ~/.openedit/renders/<template>-<time>.mov"),
        aspect: z.enum(["16:9", "9:16", "1:1", "4:5"]).optional().describe("Output aspect the graphic is for (default: the timeline's last render aspect, else the source's)"),
        width: z.number().int().positive().optional().describe("Explicit size; should match the final export frame"),
        height: z.number().int().positive().optional(),
        fps: z.number().positive().optional(),
        duration: z.number().positive().optional(),
        placeAt: z.number().min(0).optional(),
        track: z.number().int().min(2).optional(),
      },
      _meta: uiMeta("render"),
    },
    safe(async (a) => {
      const motion = await loadMotion();
      const output = a.output
        ? resolve(a.output.replace(/^~(?=\/)/, process.env.HOME ?? "~"))
        : join(paths.renders(), `${a.template}-${Date.now()}.mov`);
      // Default the frame to the timeline's output size (standalone knows its source and last aspect).
      const current = await activeHost();
      const outSize =
        current instanceof StandaloneHost && !(a.width && a.height) ? current.outputSize(a.aspect as Reframe | undefined) : undefined;
      const width = a.width ?? outSize?.width;
      const height = a.height ?? outSize?.height;
      const r = await motion.renderTemplate({
        template: a.template,
        params: a.params ?? {},
        output,
        width,
        height,
        fps: a.fps,
        duration: a.duration,
      });
      if (current instanceof StandaloneHost) {
        current.registerMotionRender(r.output, { template: a.template, params: a.params ?? {}, width, height, fps: a.fps, duration: a.duration });
      }
      let placed = "";
      if (a.placeAt !== undefined) {
        const host = current;
        await host.placeClips([{ path: r.output, at: a.placeAt, track: a.track ?? 3 }]);
        placed = ` and placed at ${fmt(a.placeAt)} on V${a.track ?? 3} in ${host.name}`;
      }
      return withView(
        text(`Rendered ${r.output}${placed}`),
        await renderView({ kind: "motion", output: r.output, detail: a.template, placed: placed.trim() || undefined, studioUrl: studioUrl() }, probe),
      );
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
      _meta: uiMeta("render"),
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
      return withView(
        text(`Rendered ${cues.length} captions to ${r.output}${placed}`),
        await renderView(
          { kind: "caption-overlay", output: r.output, detail: `${cues.length} captions · ${a.style ?? "bold-pop"}`, placed: placed.trim() || undefined, studioUrl: studioUrl() },
          probe,
        ),
      );
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

  registerStudioTools(server);
  registerMediaTools(server);
  registerRhythmTools(server);
  registerGraphicsTools(server);
  // Shots & scenes: analyze_footage, suggest_broll, find_match_cuts, multicam_sync, multicam_edit.
  registerShotTools(server);
  // MCP Apps: inline views for hosts that render them (text content is unchanged for others).
  registerUi(server);

  return server;
}

/** Run the MCP server on stdio (stdout is reserved for protocol messages). */
export async function runServer(): Promise<void> {
  const server = createServer();
  await autoStartStudio(VERSION);
  await server.connect(new StdioServerTransport());
  // Client gone or signalled: kill running ffmpeg/whisper/HyperFrames instead of orphaning them.
  installShutdownHandlers();
  process.stderr.write(`openedit MCP server ${VERSION} ready on stdio\n`);
}
