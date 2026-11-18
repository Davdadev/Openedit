/**
 * MCP tools for shot and scene understanding: analyze_footage, suggest_broll, find_match_cuts,
 * multicam_sync, multicam_edit. Registered from src/mcp/server.ts with registerShotTools(server).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { activeHost, ResolveHost } from "../../hosts/index.js";
import type { CutPlan, MultiTrackEdit, Transcript } from "../../hosts/types.js";
import { loadPlan } from "../../mcp/plans.js";
import { mediaRoot } from "../../media/download.js";
import { findMedia, relevance } from "../../media/search.js";
import { cuesFromTranscript } from "../captions.js";
import { probeSourceDetails } from "../interchange.js";
import { probe, resolveMediaPath } from "../media.js";
import { buildMulticam, type MulticamRules, remapCaptions } from "../multicam.js";
import { paths } from "../paths.js";
import { mapTime } from "../remap.js";
import { renderMultiEdit } from "../render-multi.js";
import { transcribe } from "../transcribe.js";
import { analysisDir, analyzeFile, analyzeMany, collectVideos, type FootageAnalysis, footageSheets, sheetBase, type Shot, shotLine } from "./analyze.js";
import { type BrollProposal, isVisualWord, type Phrase, phrasesFromTranscript, rankBroll } from "./broll.js";
import { writeMultiInterchange } from "./interchange-multi.js";
import { findMatchCuts } from "./matchcuts.js";
import { syncAngles } from "./sync.js";
import { composeSheet, type SheetTile } from "./vision.js";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

function safe<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  };
}
const image = (file: string): Content => ({ type: "image", data: readFileSync(file).toString("base64"), mimeType: "image/jpeg" });
const mmss = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const expand = (p: string) => resolve(p.replace(/^~(?=\/)/, process.env.HOME ?? "~"));

/** Shots from paths / folder, analysing (cached) as needed. */
async function shotsFrom(a: { paths?: string[]; folder?: string }): Promise<FootageAnalysis[]> {
  const files = collectVideos({ paths: a.paths?.map(expand), folder: a.folder ? expand(a.folder) : undefined });
  if (!files.length) throw new Error("No video files found (pass paths or a folder).");
  return analyzeMany(files);
}

// ---------------------------------------------------------------------------
// suggest_broll helpers
// ---------------------------------------------------------------------------

interface StockIdea {
  phrase: Phrase;
  at: number;
  query: string;
  results: { gid: string; title: string; provider: string; license: string; relevance: number; confidence: number; duration?: number; url: string }[];
}

async function stockIdeas(proposals: BrollProposal[], minConf: number): Promise<StockIdea[]> {
  const out: StockIdea[] = [];
  const open = proposals.filter((p) => !p.pick && p.keywords.length && p.skipped !== "opening line stays on the speaker").slice(0, 6);
  for (const p of open) {
    // Only words with a picture make a stock query; abstract or sound words fetch slop.
    const visual = p.keywords.filter(isVisualWord);
    if (!visual.length) continue;
    const query = visual.slice(0, 2).join(" ");
    try {
      const r = await findMedia({ query, kind: "video", count: 5, maxDuration: 60, timeoutMs: 12_000 });
      const results = r.results
        .map((x) => {
          const rel = relevance(query, x);
          // Stock is unverified footage: every query term must match, and it never beats a verified library shot.
          const conf = rel.matched === rel.total && rel.total > 0 ? Math.round(Math.min(0.75, rel.score * 0.75) * 1000) / 1000 : Math.round(rel.score * 0.4 * 1000) / 1000;
          return { gid: x.gid, title: x.title, provider: x.provider, license: x.license, relevance: Math.round(rel.score * 100) / 100, confidence: conf, duration: x.duration, url: x.url };
        })
        .filter((x) => x.confidence >= minConf)
        .slice(0, 3);
      if (results.length) out.push({ phrase: p.phrase, at: p.at, query, results });
    } catch {
      /* stock is optional */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export function registerShotTools(server: McpServer): void {
  server.registerTool(
    "analyze_footage",
    {
      description:
        "Look at footage like an editor logging rushes: split files into shots (hard cuts, dissolves, fades) and describe each shot — duration, motion and camera move (static/pan/tilt/zoom/handheld), " +
        "sharpness, exposure, palette, faces and shot size (wide/medium/close-up), Vision labels — and return a labelled CONTACT SHEET image so you can see the shots. " +
        "Call it first on any footage library or multi-clip project, before choosing b-roll (suggest_broll), match cuts (find_match_cuts) or a multicam edit. Results are cached per file (~20x realtime the first time).",
      inputSchema: {
        paths: z.array(z.string()).optional().describe("Video files"),
        folder: z.string().optional().describe("A folder of footage (searched recursively)"),
        force: z.boolean().optional().describe("Re-analyse even when cached"),
        maxShots: z.number().int().min(1).max(500).optional().describe("Shot lines to list (default 120)"),
      },
    },
    safe(async (a) => {
      const files = collectVideos({ paths: a.paths?.map(expand), folder: a.folder ? expand(a.folder) : undefined });
      if (!files.length) throw new Error("No video files found (pass paths or a folder).");
      const t0 = Date.now();
      const res: FootageAnalysis[] = [];
      for (const f of files) res.push(await analyzeFile(f, { force: a.force }));
      const secs = (Date.now() - t0) / 1000;
      const total = res.reduce((s, r) => s + r.duration, 0);
      const sheets = await footageSheets(res, sheetBase(files.length === 1 ? basename(files[0], extname(files[0])) : "footage"), { maxTiles: 96 });
      const shots = res.flatMap((r) => r.shots);
      const max = a.maxShots ?? 120;
      const lines = [
        `${files.length} file${files.length > 1 ? "s" : ""}, ${mmss(total)} of footage, ${shots.length} shots (${secs.toFixed(1)}s${secs > 0.5 ? `, ${(total / secs).toFixed(0)}x realtime incl. cache` : ""}).${res.some((r) => !r.vision) ? " Vision unavailable: no labels/faces." : ""}`,
        ...res.map((r) => `- ${basename(r.path)}: ${r.shots.length} shots, ${r.width}x${r.height} ${r.fps}fps, ${r.duration.toFixed(1)}s`),
        "",
        "Shots (id start–end duration [transition] camera, motion, exposure, faces (size), palette | labels):",
        ...shots.slice(0, max).map(shotLine),
        shots.length > max ? `… ${shots.length - max} more (raise maxShots)` : "",
        "",
        `Contact sheet${sheets.length > 1 ? "s" : ""} (accent bar: red ECU, orange close-up, yellow medium, green wide, blue no faces): ${sheets.join(", ")}`,
        `Analysis cache: ${analysisDir()}`,
      ];
      return { content: [...sheets.slice(0, 2).map(image), { type: "text", text: lines.filter((l) => l !== "").join("\n") }] };
    }),
  );

  server.registerTool(
    "suggest_broll",
    {
      description:
        "Pick b-roll for a talking edit from the user's OWN footage library (and optionally stock): for each spoken phrase that would benefit from a cutaway, rank analysed shots by literal match to the words (Vision labels + file names, lemmas + synonyms), " +
        "visual quality (sharpness, exposure, no strangers' faces talking), motion vs speech energy, 2–5 s duration fit, continuity, and no reuse. Returns proposals with confidence and reasons plus a CONTACT SHEET of the picks: LOOK at it, drop anything that is only vaguely related, " +
        "then call place_clips with the ones you keep (times are on the edited timeline when planId is given). Phrases below minConfidence get no b-roll on purpose (no slop).",
      inputSchema: {
        planId: z.string().optional().describe("Cut plan (times map onto the edited timeline)"),
        path: z.string().optional().describe("Or: the A-roll file (source times)"),
        start: z.number().min(0).optional().describe("With path: only phrases from here (s)"),
        end: z.number().min(0).optional().describe("With path: only phrases up to here (s)"),
        library: z.string().optional().describe("Footage folder to search (default: the OpenEdit media folder)"),
        libraryPaths: z.array(z.string()).optional().describe("Or explicit library files"),
        useStock: z.boolean().optional().describe("Also search free stock for phrases the library cannot cover (proposals need download_media + a look before placing)"),
        minConfidence: z.number().min(0).max(1).optional().describe("Default 0.45"),
        allowFaces: z.boolean().optional().describe("Allow shots with prominent faces (default false)"),
        maxCoverage: z.number().min(0.05).max(1).optional().describe("Max share of the edit covered by b-roll (default 0.4)"),
        track: z.number().int().min(2).optional().describe("Video track for the place_clips payload (default 2)"),
      },
    },
    safe(async (a) => {
      let plan: CutPlan | undefined;
      let transcript: Transcript;
      let aroll: string;
      if (a.planId) {
        const stored = loadPlan(a.planId);
        plan = stored.plan;
        aroll = plan.source;
        if (stored.transcriptPath && existsSync(stored.transcriptPath)) transcript = JSON.parse(readFileSync(stored.transcriptPath, "utf8")) as Transcript;
        else transcript = (await transcribe(aroll)).transcript;
      } else if (a.path) {
        aroll = resolveMediaPath(expand(a.path));
        transcript = (await transcribe(aroll)).transcript;
      } else throw new Error("Pass planId or path.");
      let phrases = phrasesFromTranscript(transcript);
      if (a.start !== undefined || a.end !== undefined) phrases = phrases.filter((p) => p.end > (a.start ?? 0) && p.start < (a.end ?? Infinity));
      if (plan) {
        // Map onto the edited timeline; drop phrases that were cut.
        phrases = phrases.flatMap((p) => {
          const s = mapTime(plan!, p.start);
          const e = mapTime(plan!, p.end);
          if (s === null || e === null || e <= s) return [];
          const words = p.words.flatMap((w) => {
            const ws = mapTime(plan!, w.start);
            const we = mapTime(plan!, w.end);
            return ws === null || we === null ? [] : [{ ...w, start: ws, end: we }];
          });
          return [{ ...p, start: s, end: e, words }];
        });
      }
      const libFiles = collectVideos({
        paths: a.libraryPaths?.map(expand),
        folder: a.libraryPaths?.length && !a.library ? undefined : expand(a.library ?? mediaRoot()),
      }).filter((f) => f !== aroll);
      if (!libFiles.length) throw new Error(`No library footage found${a.library ? ` in ${a.library}` : ` in ${mediaRoot()}`}. Pass library (a folder) or libraryPaths, or useStock.`);
      const lib = await analyzeMany(libFiles);
      let arollPalette: Shot["palette"] | undefined;
      try {
        const ar = await analyzeFile(aroll);
        arollPalette = ar.shots.sort((x, y) => y.duration - x.duration)[0]?.palette;
      } catch {
        arollPalette = undefined;
      }
      const minConf = a.minConfidence ?? 0.45;
      const proposals = rankBroll(phrases, lib.flatMap((r) => r.shots), { minConfidence: minConf, allowFaces: a.allowFaces, maxCoverage: a.maxCoverage, arollPalette });
      const picks = proposals.filter((p) => p.pick);
      const stock = a.useStock ? await stockIdeas(proposals, Math.max(0.5, minConf)) : [];
      // Contact sheet of picks (and the runner-up for each, so you can compare).
      const tiles: SheetTile[] = [];
      for (const p of picks) {
        const c = p.pick!;
        tiles.push({ file: c.shot.reps[Math.floor(c.shot.reps.length / 2)].thumb, label: `@${mmss(p.at)} ${c.confidence.toFixed(2)} ${basename(c.shot.file).slice(0, 26)}`, sub: `"${p.phrase.text.slice(0, 48)}"`, color: c.confidence >= 0.7 ? "#46a758" : "#ffc53d" });
      }
      let sheet: string | undefined;
      if (tiles.length) sheet = await composeSheet(tiles, `${sheetBase("broll")}.jpg`, { cols: Math.min(4, tiles.length), title: `b-roll picks for ${basename(aroll)} (green ≥ 0.7 confidence)` });
      const track = a.track ?? 2;
      const place = picks.map((p) => ({ path: p.pick!.shot.file, at: p.at, sourceIn: p.pick!.sourceIn, sourceOut: Math.round((p.pick!.sourceIn + p.duration) * 1000) / 1000, track }));
      const lines: string[] = [
        `${phrases.length} phrases, ${picks.length} b-roll proposals from ${lib.reduce((s, r) => s + r.shots.length, 0)} library shots (${libFiles.length} files). Minimum confidence ${minConf}.`,
        "",
        ...proposals.map((p) => {
          const head = `@${mmss(p.at)} "${p.phrase.text.length > 80 ? `${p.phrase.text.slice(0, 77)}...` : p.phrase.text}"`;
          if (!p.pick) return `${head}\n   no b-roll: ${p.skipped}${p.alternatives[0] ? ` (best: ${p.alternatives[0].shot.id} ${p.alternatives[0].confidence})` : ""}`;
          const c = p.pick;
          return `${head}\n   PICK ${c.shot.id} [${mmss(c.sourceIn)}–${mmss(c.sourceIn + p.duration)}] hold ${p.duration.toFixed(1)}s, confidence ${c.confidence}: ${c.reasons.join("; ")}` +
            (p.alternatives.length ? `\n   alternatives: ${p.alternatives.map((x) => `${x.shot.id} ${x.confidence}`).join(", ")}` : "");
        }),
      ];
      if (stock.length) {
        lines.push("", "Stock ideas (UNVERIFIED: download_media, analyze_footage and look before placing; credit per license):");
        for (const s of stock) lines.push(`@${mmss(s.at)} "${s.phrase.text.slice(0, 60)}" query "${s.query}": ${s.results.map((r) => `${r.gid} "${r.title.slice(0, 50)}" (${r.license}, conf ${r.confidence})`).join(" | ")}`);
      } else if (a.useStock) lines.push("", "Stock: nothing matched every keyword strongly enough (that is the anti-slop rule working).");
      lines.push("", place.length ? `place_clips payload (edit as you see fit):\n${JSON.stringify(place)}` : "Nothing confident enough to place.");
      if (sheet) lines.push(`Picks sheet: ${sheet}`);
      return { content: [...(sheet ? [image(sheet)] : []), { type: "text", text: lines.join("\n") }] };
    }),
  );

  server.registerTool(
    "find_match_cuts",
    {
      description:
        "Find pairs of shots that rhyme visually (subject in the same place / same shape, movement continuing in the same direction, matching palette, similar subject) and propose match-cut points " +
        "(out frame of A, in frame of B) with a side-by-side image of each pair. Judge them by eye: use one or two per piece, where the idea connects too.",
      inputSchema: {
        paths: z.array(z.string()).optional(),
        folder: z.string().optional(),
        shots: z.array(z.string()).optional().describe("Restrict to these shot ids (from analyze_footage)"),
        top: z.number().int().min(1).max(20).optional().describe("Pairs to return (default 6)"),
        minScore: z.number().min(0).max(1).optional().describe("Default 0.55"),
      },
    },
    safe(async (a) => {
      const res = await shotsFrom(a);
      let shots = res.flatMap((r) => r.shots);
      if (a.shots?.length) shots = shots.filter((s) => a.shots!.includes(s.id));
      const pairs = findMatchCuts(shots, { top: a.top ?? 6, minScore: a.minScore });
      if (!pairs.length) return { content: [{ type: "text", text: `No pair of the ${shots.length} shots rhymes strongly enough (minScore ${a.minScore ?? 0.55}). That is normal: match cuts are rare.` }] };
      const tiles: SheetTile[] = pairs.flatMap((m, i) => [
        { file: m.a.reps[m.a.reps.length - 1].thumb, label: `${i + 1}. OUT ${m.a.id}`, sub: `@${mmss(m.outA)} ${m.kind} ${m.score.toFixed(2)}`, color: "#f76b15" },
        { file: m.b.reps[0].thumb, label: `${i + 1}. IN ${m.b.id}`, sub: `@${mmss(m.inB)} ${m.reasons[0] ?? ""}`, color: "#3e63dd" },
      ]);
      const sheet = await composeSheet(tiles, `${sheetBase("matchcuts")}.jpg`, { cols: 2, title: "Match-cut candidates: A out (left) -> B in (right)" });
      const lines = pairs.map(
        (m, i) =>
          `${i + 1}. ${m.a.id} out @${mmss(m.outA)} -> ${m.b.id} in @${mmss(m.inB)}: ${m.kind} match, score ${m.score} (shape ${m.parts.shape}, edges ${m.parts.edges}, motion ${m.parts.motion}, colour ${m.parts.colour}, content ${m.parts.content})${m.reasons.length ? ` — ${m.reasons.join("; ")}` : ""}`,
      );
      return { content: [image(sheet), { type: "text", text: `${lines.join("\n")}\nSheet: ${sheet}\nCut A a frame or two after the out frame shown and B on the in frame; a sound bridge (J-cut) sells it.` }] };
    }),
  );

  server.registerTool(
    "multicam_sync",
    {
      description:
        "Sync multicam angles by audio (FFT cross-correlation of onset envelopes, refined to the sample; offsets up to maxOffset seconds, drift check). Returns each angle's offset relative to the first angle " +
        "(reference time at which the angle's t=0 happens), confidence and drift.",
      inputSchema: {
        angles: z.array(z.string()).min(2).describe("Angle files; the first is the reference"),
        maxOffset: z.number().positive().optional().describe("Largest offset to search (s), default 600"),
      },
    },
    safe(async (a) => {
      const files = a.angles.map((p) => resolveMediaPath(expand(p)));
      const t0 = Date.now();
      const r = await syncAngles(files, { maxOffset: a.maxOffset });
      const infos = await Promise.all(files.map((f) => probe(f)));
      const fps = infos[0].fps ?? 25;
      const lines = r.map(
        (s, i) =>
          `${i + 1}. ${basename(files[i])}: offset ${s.offset >= 0 ? "+" : ""}${s.offset.toFixed(4)}s (${(s.offset * fps).toFixed(2)} frames @${fps}), confidence ${i ? s.confidence : "ref"}${i ? `, peak ratio ${s.peakRatio}, waveform match ${s.ncc}, overlap ${s.overlap}s` : ""}${s.driftPpm !== undefined ? `, drift ${s.driftPpm} ppm` : ""}${i && s.confidence < 0.3 ? "  LOW CONFIDENCE: check by eye" : ""}`,
      );
      return { content: [{ type: "text", text: `${lines.join("\n")}\n(${((Date.now() - t0) / 1000).toFixed(1)}s)` }] };
    }),
  );

  server.registerTool(
    "multicam_edit",
    {
      description:
        "Build a switched multicam edit: syncs the angles, finds who is speaking (isolated mic levels when the mics are isolated, else faces + mouth movement), then cuts like an editor — open wide, cut to the speaker in the pause before they talk " +
        "(or a beat after when they overlap), minimum shot length, no ping-pong on quick exchanges, listener reactions and wide resets in long answers, size changes on the same speaker at sentence ends. " +
        "Writes the edit (JSON), FCP7 XML + FCPXML, optionally renders it (standalone ffmpeg) with captions remapped to the edit, and imports it as a new timeline in Resolve when Resolve is the active host.",
      inputSchema: {
        angles: z.array(z.string()).min(2).describe("Angle files (first = sync reference)"),
        audioSource: z.number().int().min(0).optional().describe("Index of the angle whose audio is the mix (default 0)"),
        rules: z
          .object({
            minShot: z.number().positive().optional(),
            cutDelay: z.number().min(0).optional(),
            maxCloseRun: z.number().positive().optional(),
            wideHold: z.number().positive().optional(),
            reactionHold: z.number().positive().optional(),
            pingPong: z.number().min(0).optional(),
            varietyAfter: z.number().positive().optional(),
            reactions: z.boolean().optional(),
            openWide: z.number().min(0).optional(),
          })
          .optional(),
        isolatedMics: z.boolean().optional().describe("Force isolated-mic speaker detection on/off (default: detect)"),
        output: z.string().optional().describe("Render to this file (standalone ffmpeg)"),
        quality: z.enum(["draft", "final"]).optional(),
        captions: z.boolean().optional().describe("Transcribe the audio source for sentence-aware cuts and an SRT remapped to the edit (default true)"),
        name: z.string().optional().describe("Timeline name"),
      },
    },
    safe(async (a) => {
      const files = a.angles.map((p) => resolveMediaPath(expand(p)));
      const audioSource = a.audioSource ?? 0;
      if (audioSource >= files.length) throw new Error("audioSource is out of range");
      let transcript: Transcript | undefined;
      if (a.captions !== false) {
        try {
          transcript = (await transcribe(files[audioSource])).transcript;
        } catch {
          transcript = undefined;
        }
      }
      const t0 = Date.now();
      const r = await buildMulticam(files, { audioSource, rules: a.rules as MulticamRules | undefined, transcript, isolatedMics: a.isolatedMics, name: a.name });
      const id = `multicam-${randomBytes(3).toString("hex")}`;
      const dir = join(paths.home(), "multicam");
      mkdirSync(dir, { recursive: true });
      const editPath = join(dir, `${id}.json`);
      writeFileSync(editPath, JSON.stringify({ id, edit: r.edit, angles: r.angles, sync: r.sync, decisions: r.decisions }, null, 1));
      const info = await Promise.all(
        files.map(async (f) => {
          const i = await probe(f);
          const d = await probeSourceDetails(f);
          return { width: i.width, height: i.height, fps: i.fps, hasAudio: i.hasAudio, hasVideo: i.hasVideo, frames: d.frames, audioChannels: d.audioChannels, audioRate: d.audioRate };
        }),
      );
      const base = join(dir, id);
      const fcp7 = writeMultiInterchange("fcp7", { edit: r.edit, info, name: a.name }, `${base}.xml`);
      const fcpxml = writeMultiInterchange("fcpxml", { edit: r.edit, info, name: a.name }, `${base}.fcpxml`);
      const cues = transcript ? remapCaptions(cuesFromTranscript(transcript), r.edit) : [];
      let rendered = "";
      if (a.output) {
        const out = await renderMultiEdit(r.edit, expand(a.output), { quality: a.quality, captions: cues });
        rendered = `\nRendered ${out.output} (${out.duration.toFixed(1)}s, ${out.segments} shots)${out.srt ? `, captions ${out.srt}` : ""}`;
      } else if (cues.length) {
        writeFileSync(`${base}.srt`, (await import("../captions.js")).toSRT(cues));
      }
      let resolveNote = "";
      try {
        const host = await activeHost();
        if (host instanceof ResolveHost) {
          const imp = await host.importTimeline(fcp7, a.name ?? id);
          resolveNote = `\nResolve: imported as new timeline "${imp.sequence}".`;
        }
      } catch (e) {
        resolveNote = `\nResolve import failed: ${(e as Error).message} (File > Import > Timeline… ${fcp7} by hand).`;
      }
      const role = (i: number) => r.angles[i];
      const lines = [
        `Synced ${files.length} angles (${((Date.now() - t0) / 1000).toFixed(1)}s): ${r.sync.map((s, i) => `${i + 1}:${s.offset >= 0 ? "+" : ""}${s.offset.toFixed(3)}s${i ? ` (conf ${s.confidence})` : ""}`).join(", ")}`,
        `Angles: ${r.angles.map((x) => `${x.index + 1} ${basename(files[x.index])} = ${x.role}${x.person !== undefined ? ` on person ${x.person + 1}` : ""} (face ${x.faceH})`).join("; ")}`,
        `Speaker detection: ${r.isolatedMics ? "isolated mics (+ mouths)" : "faces + mouth movement"}.`,
        ...r.warnings.map((w) => `WARNING: ${w}`),
        "",
        `${r.decisions.length} shots:`,
        ...r.decisions.map((d, i) => `${i + 1}. ${mmss(d.start - r.plan.start)}–${mmss(d.end - r.plan.start)} (${(d.end - d.start).toFixed(1)}s) angle ${d.angle + 1} ${role(d.angle)?.role ?? ""}: ${d.why}`),
        "",
        `Edit: ${editPath}\nFCP7 XML (Premiere File > Import; Resolve File > Import > Timeline): ${fcp7}\nFCPXML (Final Cut Pro, Resolve): ${fcpxml}${rendered}${resolveNote}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }),
  );
}

/** Load a saved multicam edit. */
export function loadMultiEdit(id: string): MultiTrackEdit {
  if (!/^multicam-[a-f0-9]+$/.test(id)) throw new Error(`Invalid multicam id ${id}`);
  return (JSON.parse(readFileSync(join(paths.home(), "multicam", `${id}.json`), "utf8")) as { edit: MultiTrackEdit }).edit;
}

