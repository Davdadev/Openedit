import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaptionCue, CutPlan, TimeRange, Transcript, Word } from "../hosts/types.js";
import { FUNCTION_WORDS } from "./captions.js";
import { run } from "./exec.js";
import { probe, resolveMediaPath } from "./media.js";
import { paths } from "./paths.js";
import { type MusicUnder, type RhythmStats, formatRhythm, rhythmStats, rhythmWarnings } from "./review-rhythm.js";
import { editDuration, editSegments, mapTime } from "./remap.js";
import { type EnergyEnvelope, adaptiveLevels, analyzeEnergy, meanDb, smooth, spokenEnd } from "./vad.js";

/**
 * review_edit: look at and listen to a rendered edit like a senior editor would
 * and flag what a professional would not sign off on. The measuring helpers
 * (ffmpeg log parsers, edit statistics, warnings) are pure and unit-tested;
 * reviewEdit runs ffmpeg and builds the contact sheet.
 */

export interface ReviewStandards {
  /** Output format: long-form (16:9 / 1:1) or short-form (vertical). */
  format: "long" | "short";
  minKeep: number;
  /** Kept pause at a join below this is "breathless". */
  minJoinPause: number;
  /** Remaining pause above this is dead air. */
  maxPause: number;
  maxCutsPerMinute: number;
  maxZoomsPerMinute: number;
  maxZoomScale: number;
  maxCps: number;
  minCaptionDuration: number;
  maxCaptionDuration: number;
  maxCharsPerLine: number;
  targetLufs: number;
  maxTruePeak: number;
}

export function standardsFor(format: "long" | "short"): ReviewStandards {
  return {
    format,
    minKeep: 0.4,
    minJoinPause: 0.12,
    maxPause: format === "short" ? 0.9 : 1.5,
    maxCutsPerMinute: format === "short" ? 30 : 12,
    maxZoomsPerMinute: format === "short" ? 9 : 3,
    maxZoomScale: 112,
    maxCps: 17,
    minCaptionDuration: 0.9,
    maxCaptionDuration: 6,
    maxCharsPerLine: format === "short" ? 22 : 42,
    targetLufs: -14,
    maxTruePeak: -1,
  };
}

// ---------------------------------------------------------------- ffmpeg logs

export interface LoudnessStats {
  integrated?: number;
  lra?: number;
  truePeak?: number;
}

/** Parse the Summary block of ffmpeg's ebur128 filter. */
export function parseEbur128(log: string): LoudnessStats {
  const i = log.lastIndexOf("Summary:");
  const tail = i >= 0 ? log.slice(i) : log;
  const num = (re: RegExp) => {
    const m = re.exec(tail);
    return m ? Number(m[1]) : undefined;
  };
  return {
    integrated: num(/I:\s*(-?[\d.]+|-inf)\s*LUFS/),
    lra: num(/LRA:\s*(-?[\d.]+)\s*LU/),
    truePeak: num(/True peak:\s*[\r\n]+\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/),
  };
}

/** Parse blackdetect / freezedetect output into ranges. */
export function parseBlackFreeze(log: string): { black: TimeRange[]; frozen: TimeRange[] } {
  const black: TimeRange[] = [];
  for (const m of log.matchAll(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g)) black.push({ start: Number(m[1]), end: Number(m[2]) });
  const frozen: TimeRange[] = [];
  let open: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const s = /freeze_start:\s*([\d.]+)/.exec(line);
    if (s) open = Number(s[1]);
    const e = /freeze_end:\s*([\d.]+)/.exec(line);
    if (e && open !== null) {
      frozen.push({ start: open, end: Number(e[1]) });
      open = null;
    }
  }
  if (open !== null) frozen.push({ start: open, end: Infinity });
  return { black, frozen };
}

/** Overall sample peak (dBFS) from astats. */
export function parseAstatsPeak(log: string): number | undefined {
  const i = log.lastIndexOf("Overall");
  const m = /Peak level dB:\s*(-?[\d.]+|-inf)/.exec(i >= 0 ? log.slice(i) : log);
  if (!m) return undefined;
  return m[1] === "-inf" ? -Infinity : Number(m[1]);
}

// ---------------------------------------------------------------- edit statistics

export interface EditStats {
  plannedDuration?: number;
  cuts: number;
  cutsPerMinute: number;
  shortestKeep?: { seconds: number; at: number };
  /** Pauses left at each join (edited seconds). */
  joinPauses: { at: number; pause: number }[];
  longestPause?: { seconds: number; at: number };
  /** Words only partly kept (the cut lands inside the word). */
  wordsCut: { word: string; at: number; keptFraction: number }[];
  zooms: number;
  zoomsPerMinute: number;
  maxZoomScale?: number;
  adjacentZooms: number;
  captions: number;
  captionMaxCps?: number;
  captionMinDuration?: number;
  captionMaxDuration?: number;
  captionMaxLine?: number;
  badLineEnds: string[];
  orphanCaptions: number;
}

export interface EditInfo {
  /** Is the rendered audio quiet (pause / music bed only) over edited [a, b]? Refines pause measurements. */
  isQuiet?: (a: number, b: number) => boolean;
  /** Measured silent run (s) around an edited time, from the rendered audio. */
  quietRunAt?: (t: number) => number;
  plan?: Pick<CutPlan, "keep">;
  transcript?: Transcript;
  zooms?: { start: number; end: number; scale: number }[];
  captions?: CaptionCue[];
  /** Duration of the rendered file. */
  duration: number;
}

const wn = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

/** Statistics of an edit (pure). */
export function editStats(info: EditInfo): EditStats {
  const { plan, transcript, duration } = info;
  const minutes = Math.max(duration, 1) / 60;
  const segs = plan ? editSegments(plan) : [];
  const joins = segs.slice(1).map((s) => s.start);
  const stats: EditStats = {
    cuts: joins.length,
    cutsPerMinute: r1(joins.length / minutes),
    joinPauses: [],
    wordsCut: [],
    zooms: info.zooms?.length ?? 0,
    zoomsPerMinute: r1((info.zooms?.length ?? 0) / minutes),
    adjacentZooms: 0,
    captions: info.captions?.length ?? 0,
    badLineEnds: [],
    orphanCaptions: 0,
  };
  if (plan) {
    stats.plannedDuration = r3(editDuration(plan));
    // Ignore the head/tail trims: they are not visible jumps.
    const inner = segs.filter((_, i) => i > 0 && i < segs.length - 1);
    const shortest = (inner.length ? inner : segs).reduce<{ seconds: number; at: number } | undefined>(
      (m, s) => (!m || s.end - s.start < m.seconds ? { seconds: r3(s.end - s.start), at: r2(s.start) } : m),
      undefined,
    );
    if (shortest) stats.shortestKeep = shortest;
  }
  const words: Word[] = (transcript?.segments.flatMap((s) => s.words) ?? []).filter((w) => wn(w.text) && w.end - w.start > 0.015);
  if (words.length) {
    // Edited positions of kept words.
    const kept: { w: Word; s: number; e: number }[] = [];
    for (const w of words) {
      const se = spokenEnd(w);
      if (plan) {
        let inside = 0;
        for (const k of plan.keep) inside += Math.max(0, Math.min(se, k.end) - Math.max(w.start, k.start));
        const frac = inside / Math.max(se - w.start, 1e-3);
        const s = mapTime(plan, w.start);
        const e = mapTime(plan, se);
        if (frac > 0.1 && frac < 0.85 && se - w.start > 0.1) {
          stats.wordsCut.push({ word: w.text.trim(), at: r2(s ?? e ?? 0), keptFraction: r2(frac) });
        }
        if (frac >= 0.5 && s !== null && e !== null) kept.push({ w, s, e });
        else if (frac >= 0.5) {
          const m = mapTime(plan, (w.start + se) / 2);
          if (m !== null) kept.push({ w, s: m - (se - w.start) / 2, e: m + (se - w.start) / 2 });
        }
      } else kept.push({ w, s: w.start, e: se });
    }
    let longest: { seconds: number; at: number } | undefined;
    for (let i = 1; i < kept.length; i++) {
      const gap = kept[i].s - kept[i - 1].e;
      // Transcript timings are approximate: a "gap" the audio fills with speech is not a pause.
      const real = gap > 0.3 && (!info.isQuiet || info.isQuiet(kept[i - 1].e, kept[i].s));
      if (real && (!longest || gap > longest.seconds)) longest = { seconds: r2(gap), at: r2(kept[i - 1].e) };
      const join = joins.find((j) => j > kept[i - 1].e - 0.05 && j < kept[i].s + 0.05);
      if (join !== undefined) {
        const measured = info.quietRunAt ? Math.min(Math.max(0, gap), info.quietRunAt(join)) : Math.max(0, gap);
        stats.joinPauses.push({ at: r2(join), pause: r2(measured) });
      }
    }
    if (longest) stats.longestPause = longest;
  }
  if (info.zooms?.length) {
    const z = [...info.zooms].sort((a, b) => a.start - b.start);
    stats.maxZoomScale = Math.max(...z.map((x) => x.scale));
    for (let i = 1; i < z.length; i++) {
      const between = joins.filter((j) => j > z[i - 1].end + 0.01 && j < z[i].start - 0.01).length;
      if (z[i].start - z[i - 1].end < 1 || (segs.length > 2 && between === 0 && z[i].start - z[i - 1].end < 3)) stats.adjacentZooms++;
    }
  }
  if (info.captions?.length) {
    let maxCps = 0;
    let minD = Infinity;
    let maxD = 0;
    let maxLine = 0;
    // Word-by-word styles (<= 3 words per cue) are read as speech is heard: reading speed does not apply.
    const phraseCues = info.captions.filter((c) => c.text.split(/\s+/).filter(Boolean).length > 3);
    for (const c of info.captions) {
      const d = c.end - c.start;
      const lines = c.text.split("\n");
      const chars = lines.join(" ").length;
      if (!phraseCues.length || phraseCues.includes(c)) maxCps = Math.max(maxCps, chars / Math.max(d, 0.05));
      // Word-by-word pages (<= 3 words) are paced by speech: only flashes under 0.25 s count.
      const wordPop = lines.join(" ").split(/\s+/).filter(Boolean).length <= 3 && phraseCues.length < info.captions.length / 2;
      minD = Math.min(minD, wordPop ? Math.max(d, d < 0.25 ? d : 0.9) : d);
      maxD = Math.max(maxD, d);
      for (const l of lines) maxLine = Math.max(maxLine, l.trim().length);
      const allWords = lines.join(" ").split(/\s+/).filter(Boolean);
      if (allWords.length === 1 && info.captions.length > 1 && !/[.!?,]$/.test(allWords[0])) stats.orphanCaptions++;
      // A line (or a cue that does not end a sentence) ending on a function word splits a phrase.
      lines.forEach((l, k) => {
        const last = l.trim().split(/\s+/).at(-1) ?? "";
        const isLastLine = k === lines.length - 1;
        if (/[.!?,;:]$/.test(last)) return;
        const wordByWord = phraseCues.length < info.captions!.length / 2;
        if (FUNCTION_WORDS.has(wn(last)) && (!isLastLine || (allWords.length > 1 && !wordByWord))) {
          if (stats.badLineEnds.length < 8) stats.badLineEnds.push(`"${lines.join(" / ")}"`);
        }
      });
    }
    if (phraseCues.length) stats.captionMaxCps = r1(maxCps);
    stats.captionMinDuration = r2(minD);
    stats.captionMaxDuration = r2(maxD);
    stats.captionMaxLine = maxLine;
  }
  return stats;
}

export interface MediaChecks {
  duration: number;
  width?: number;
  height?: number;
  loudness: LoudnessStats;
  peakDb?: number;
  black: TimeRange[];
  frozen: TimeRange[];
  /** Joins where the audio is loud right at the cut (a word clipped). */
  hotJoins: number[];
  /** Joins with an abrupt level jump (> 12 dB within 40 ms). */
  jumpJoins: number[];
}

/** Joins (edited seconds) whose audio is at speech level right at the cut, or jumps abruptly. Pure. */
export function joinAudioIssues(env: EnergyEnvelope, joins: number[]): { hot: number[]; jumps: number[] } {
  const lv = adaptiveLevels(env.db);
  const gate = Math.max(lv.thresholdDb, (lv.floorDb + lv.speechDb) / 2);
  const hot: number[] = [];
  const jumps: number[] = [];
  for (const j of joins) {
    const before = meanDb(env, j - 0.03, j - 0.005);
    const after = meanDb(env, j + 0.005, j + 0.03);
    // Both sides at speech level: the cut is inside sound (mid-word, or a tail/onset cut off).
    if (before > gate && after > gate) hot.push(r2(j));
    else if (Math.abs(before - after) > 12 && Math.max(before, after) > gate) jumps.push(r2(j));
  }
  return { hot, jumps };
}

/** Audio-based pause probes over an envelope (see EditInfo.isQuiet / quietRunAt). Pure. */
export function quietProbes(env: EnergyEnvelope): { isQuiet: (a: number, b: number) => boolean; quietRunAt: (t: number) => number } {
  const lv = adaptiveLevels(env.db);
  const gate = Math.max(lv.thresholdDb, (lv.floorDb + lv.speechDb) / 2);
  const db = smooth(env.db);
  const raw = (i: number) => (db[i] ?? -120) <= gate;
  // Bridge blips of up to 20 ms (breath noise, room tone wobble) inside a pause.
  const bridge = Math.max(1, Math.round(0.02 / env.hop));
  const quiet = (i: number) => {
    if (raw(i)) return true;
    let l = 0;
    let r = 0;
    while (l <= bridge && !raw(i - l - 1) && i - l - 1 >= 0) l++;
    while (r <= bridge && !raw(i + r + 1) && i + r + 1 < db.length) r++;
    return l + r + 1 <= bridge && i - l - 1 >= 0 && i + r + 1 < db.length;
  };
  return {
    isQuiet: (a, b) => {
      const i0 = Math.max(0, Math.floor(a / env.hop));
      const i1 = Math.min(env.db.length, Math.ceil(b / env.hop));
      if (i1 <= i0) return true;
      let q = 0;
      for (let i = i0; i < i1; i++) if (quiet(i)) q++;
      return q / (i1 - i0) >= 0.7;
    },
    quietRunAt: (t) => {
      const c = Math.round(t / env.hop);
      // Find the quiet run nearest the join (within 60 ms), then measure it.
      let k = -1;
      for (let d = 0; d <= Math.round(0.06 / env.hop); d++) {
        if (quiet(c - d)) { k = c - d; break; }
        if (quiet(c + d)) { k = c + d; break; }
      }
      if (k < 0) return 0;
      let a = k;
      let b = k;
      while (a > 0 && quiet(a - 1)) a--;
      while (b < env.db.length - 1 && quiet(b + 1)) b++;
      return (b - a + 1) * env.hop;
    },
  };
}

/** Warnings against the professional standards. Pure. */
export function reviewWarnings(s: EditStats, m: MediaChecks, std: ReviewStandards): string[] {
  const w: string[] = [];
  if (s.plannedDuration !== undefined && Math.abs(s.plannedDuration - m.duration) > 0.5) {
    w.push(`duration ${m.duration.toFixed(2)}s differs from the plan (${s.plannedDuration.toFixed(2)}s): something was dropped or doubled`);
  }
  if (s.shortestKeep && s.shortestKeep.seconds < std.minKeep) {
    w.push(`choppy: a kept piece of only ${s.shortestKeep.seconds}s at ${fmt(s.shortestKeep.at)} (min ${std.minKeep}s); merge it with a neighbour`);
  }
  if (s.cutsPerMinute > std.maxCutsPerMinute) w.push(`${s.cutsPerMinute} cuts/min is frantic for ${std.format}-form (<= ${std.maxCutsPerMinute}); use tightness "loose" or a larger minSilence`);
  const breathless = s.joinPauses.filter((p) => p.pause < std.minJoinPause);
  if (breathless.length) {
    w.push(`breathless joins (< ${std.minJoinPause}s of pause left): ${breathless.slice(0, 6).map((p) => `${fmt(p.at)} (${p.pause}s)`).join(", ")}${breathless.length > 6 ? "…" : ""}; raise keepPause`);
  }
  if (s.longestPause && s.longestPause.seconds > std.maxPause) w.push(`dead air: ${s.longestPause.seconds}s pause at ${fmt(s.longestPause.at)}`);
  if (s.wordsCut.length) {
    w.push(`cut inside a word: ${s.wordsCut.slice(0, 6).map((x) => `"${x.word}" at ${fmt(x.at)} (${Math.round(x.keptFraction * 100)}% kept)`).join(", ")}`);
  }
  if (m.hotJoins.length) w.push(`audio is at speech level right at ${m.hotJoins.length} join(s) (${m.hotJoins.slice(0, 6).map(fmt).join(", ")}): a word tail or onset is probably clipped`);
  if (m.jumpJoins.length) w.push(`abrupt level jump at join(s) ${m.jumpJoins.slice(0, 6).map(fmt).join(", ")}; an audio crossfade would hide it`);
  if (s.zoomsPerMinute > std.maxZoomsPerMinute) w.push(`${s.zoomsPerMinute} zooms/min is too busy for ${std.format}-form (<= ${std.maxZoomsPerMinute}); use auto_zooms density "subtle"/"normal"`);
  if (s.adjacentZooms) w.push(`${s.adjacentZooms} zoom(s) follow another with no shot at 100% between: it reads as constant zooming`);
  if (s.maxZoomScale !== undefined && s.maxZoomScale > std.maxZoomScale) w.push(`zoom ${s.maxZoomScale}% softens a 1080p image; keep <= ${std.maxZoomScale}%`);
  if (s.captionMaxCps !== undefined && s.captionMaxCps > std.maxCps + 3) w.push(`captions up to ${s.captionMaxCps} chars/s: too fast to read (target <= ${std.maxCps})`);
  if (s.captionMinDuration !== undefined && s.captionMinDuration < std.minCaptionDuration - 0.05) w.push(`a caption is on screen only ${s.captionMinDuration}s (min ${std.minCaptionDuration}s)`);
  if (s.captionMaxDuration !== undefined && s.captionMaxDuration > std.maxCaptionDuration) w.push(`a caption stays ${s.captionMaxDuration}s (max ${std.maxCaptionDuration}s)`);
  if (s.captionMaxLine !== undefined && s.captionMaxLine > std.maxCharsPerLine) w.push(`caption line of ${s.captionMaxLine} chars (max ${std.maxCharsPerLine} for this aspect)`);
  if (s.badLineEnds.length) w.push(`caption breaks split a phrase: ${s.badLineEnds.slice(0, 4).join(", ")}`);
  if (s.orphanCaptions > 1) w.push(`${s.orphanCaptions} single-word captions (orphans)`);
  const I = m.loudness.integrated;
  if (I !== undefined && Number.isFinite(I) && Math.abs(I - std.targetLufs) > 1.5) w.push(`loudness ${I} LUFS (target ${std.targetLufs} ±1); render with loudnorm: true`);
  if (m.loudness.truePeak !== undefined && m.loudness.truePeak > std.maxTruePeak) w.push(`true peak ${m.loudness.truePeak} dBTP (max ${std.maxTruePeak})`);
  if (m.peakDb !== undefined && m.peakDb >= -0.1) w.push(`audio clips (sample peak ${m.peakDb} dBFS)`);
  for (const b of m.black) if (b.end - b.start >= 0.3) w.push(`black frames ${fmt(b.start)}–${fmt(b.end)}`);
  for (const f of m.frozen) if (Math.min(f.end, m.duration) - f.start >= 2) w.push(`frozen picture ${fmt(f.start)}–${Number.isFinite(f.end) ? fmt(f.end) : "end"}`);
  return w;
}

/** Times for the contact sheet: before/after the most important joins, plus regular intervals. Pure. */
export function contactTimes(joins: number[], duration: number, o: { maxJoins?: number; intervals?: number; offset?: number; priority?: number[] } = {}): { t: number; kind: "before" | "after" | "interval"; join?: number }[] {
  const maxJoins = o.maxJoins ?? 10;
  const off = o.offset ?? 0.3;
  const prio = new Set((o.priority ?? []).map((p) => r2(p)));
  let pick = joins;
  if (joins.length > maxJoins) {
    const flagged = joins.filter((j) => prio.has(r2(j))).slice(0, maxJoins);
    const rest = joins.filter((j) => !prio.has(r2(j)));
    const need = maxJoins - flagged.length;
    const even = need > 0 ? Array.from({ length: need }, (_, i) => rest[Math.floor(((i + 0.5) * rest.length) / need)]) : [];
    pick = [...new Set([...flagged, ...even])].sort((a, b) => a - b);
  }
  const out: { t: number; kind: "before" | "after" | "interval"; join?: number }[] = [];
  pick.forEach((j) => {
    out.push({ t: Math.max(0, r2(j - off)), kind: "before", join: j });
    out.push({ t: Math.min(Math.max(0, duration - 0.05), r2(j + off)), kind: "after", join: j });
  });
  const n = o.intervals ?? 6;
  for (let i = 0; i < n; i++) out.push({ t: r2(((i + 0.5) * duration) / n), kind: "interval" });
  return out;
}

// ---------------------------------------------------------------- runner

export interface ReviewResult {
  stats: EditStats;
  media: MediaChecks;
  warnings: string[];
  sheetPath?: string;
  sheet?: Buffer;
  wavePath?: string;
  wave?: Buffer;
  /** Human-readable legend for the contact sheet tiles. */
  legend: string;
  /** Beat alignment, split edits, ramp sanity (review-rhythm.ts). */
  rhythm?: RhythmStats;
}

async function measure(path: string, hasVideo: boolean): Promise<{ loudness: LoudnessStats; peakDb?: number; black: TimeRange[]; frozen: TimeRange[] }> {
  const args = ["-hide_banner", "-nostats", "-i", path];
  if (hasVideo) args.push("-map", "0:v:0", "-vf", "fps=10,scale=320:-2,blackdetect=d=0.2:pix_th=0.10,freezedetect=n=-60dB:d=1.5");
  args.push("-map", "0:a:0?", "-af", "ebur128=peak=true,astats=measure_perchannel=none", "-f", "null", "-");
  const r = await run("ffmpeg", args, { timeoutMs: 20 * 60_000, allowFailure: true });
  const log = r.stderr;
  return { loudness: parseEbur128(log), peakDb: parseAstatsPeak(log), ...parseBlackFreeze(log) };
}

/**
 * Review a rendered edit. Measures loudness / peaks / black / frozen frames, checks
 * the audio at every join, computes edit statistics from the plan, transcript,
 * zooms and captions, and renders a contact sheet (frames 0.3 s before/after joins
 * and at regular intervals) plus a waveform with the joins marked.
 */
export async function reviewEdit(
  path: string,
  info: Omit<EditInfo, "duration"> & { format?: "long" | "short"; outDir?: string; music?: MusicUnder },
): Promise<ReviewResult> {
  const abs = resolveMediaPath(path);
  const p = await probe(abs);
  const format = info.format ?? (p.height && p.width && p.height > p.width ? "short" : "long");
  const std = standardsFor(format);
  const joins = info.plan ? editSegments(info.plan).slice(1).map((s) => s.start) : [];
  const env = p.hasAudio ? await analyzeEnergy(abs, 0.005) : undefined;
  const stats = editStats({ ...info, ...(env ? quietProbes(env) : {}), duration: p.duration });

  const meas = await measure(abs, p.hasVideo);
  let hot: number[] = [];
  let jumps: number[] = [];
  if (env && joins.length) ({ hot, jumps } = joinAudioIssues(env, joins));
  const media: MediaChecks = { duration: p.duration, width: p.width, height: p.height, ...meas, hotJoins: hot, jumpJoins: jumps };
  const warnings = reviewWarnings(stats, media, std);
  // Rhythm: beat alignment of the cuts (when music is under the edit), J/L, speed ramps.
  let rhythm: RhythmStats | undefined;
  const fullPlan = info.plan as (CutPlan & Partial<Pick<CutPlan, "splits" | "ramps" | "freezes">>) | undefined;
  if (info.music || fullPlan?.splits?.length || fullPlan?.ramps?.length || fullPlan?.freezes?.length) {
    rhythm = rhythmStats(joins, { music: info.music, plan: fullPlan, fps: p.fps });
    warnings.push(...rhythmWarnings(rhythm, { plan: fullPlan, dialogue: Boolean(info.transcript), singleCamera: true }));
  }

  const outBase = abs.replace(/\.[^.]+$/, "");
  const work = mkdtempSync(join(paths.tmp(), "review-"));
  const legend: string[] = [];
  let sheet: Buffer | undefined;
  let wave: Buffer | undefined;
  let sheetPath: string | undefined;
  let wavePath: string | undefined;
  try {
    if (p.hasVideo) {
      const vertical = (p.height ?? 0) > (p.width ?? 1);
      const tw = vertical ? 180 : 320;
      const th = vertical ? 320 : 180;
      const cols = vertical ? 8 : 6;
      const times = contactTimes(joins, p.duration, { maxJoins: vertical ? 12 : 9, priority: [...hot, ...jumps, ...stats.wordsCut.map((x) => x.at)] });
      let k = 0;
      for (const t of times) {
        // Before = blue bar, after = orange bar, interval = grey bar (no drawtext dependency).
        const bar = t.kind === "before" ? "0x3D7BFF" : t.kind === "after" ? "0xFF8A00" : "0x808080";
        await run(
          "ffmpeg",
          ["-hide_banner", "-loglevel", "error", "-y", "-ss", t.t.toFixed(3), "-i", abs, "-frames:v", "1",
            "-vf", `scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2,drawbox=x=0:y=0:w=iw:h=6:color=${bar}:t=fill`,
            "-q:v", "3", join(work, `f${String(k).padStart(3, "0")}.jpg`)],
          { timeoutMs: 60_000, allowFailure: true },
        );
        k++;
      }
      const rows = Math.ceil(times.length / cols);
      sheetPath = `${outBase}.review.jpg`;
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", "1", "-i", join(work, "f%03d.jpg"),
        "-vf", `tile=${cols}x${rows}:padding=4:margin=4:color=0x111111`, "-frames:v", "1", "-q:v", "3", sheetPath], { timeoutMs: 120_000 });
      sheet = readFileSync(sheetPath);
      // Legend, in tile order (row-major).
      let row: string[] = [];
      times.forEach((t, i) => {
        row.push(t.kind === "interval" ? `[${fmt(t.t)}]` : `${t.kind === "before" ? "◀" : "▶"}cut ${fmt(t.join ?? t.t)}`);
        if ((i + 1) % cols === 0 || i === times.length - 1) {
          legend.push(`row ${Math.floor(i / cols) + 1}: ${row.join("  ")}`);
          row = [];
        }
      });
    }
    if (p.hasAudio) {
      // Waveform of the whole edit, joins in red, zooms as yellow bars, and 1 s close-ups of the first joins.
      const W = 1600;
      const boxes = joins.map((j) => `drawbox=x=${Math.round((j / p.duration) * W)}:y=0:w=2:h=ih:color=red@0.8:t=fill`);
      for (const z of info.zooms ?? []) {
        boxes.push(`drawbox=x=${Math.round((z.start / p.duration) * W)}:y=ih-10:w=${Math.max(2, Math.round(((z.end - z.start) / p.duration) * W))}:h=10:color=yellow@0.9:t=fill`);
      }
      wavePath = `${outBase}.review-wave.png`;
      // showwavespic is transparent: flatten it on a dark background so the markers are visible.
      const graph =
        `[0:a]aformat=channel_layouts=mono,showwavespic=s=${W}x200:colors=0xBBBBBB:scale=sqrt[wv];color=c=0x1A1A1A:s=${W}x200[bg];` +
        `[bg][wv]overlay=format=auto,format=rgb24${boxes.length ? `,${boxes.slice(0, 400).join(",")}` : ""}[w]`;
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", abs, "-filter_complex", graph, "-map", "[w]", "-frames:v", "1", wavePath], { timeoutMs: 120_000 });
      // Close-ups: up to 8 joins, 1 s each centred on the join.
      const close = joins.length > 8 ? [...new Set([...hot, ...jumps, ...joins])].slice(0, 8).sort((a, b) => a - b) : joins;
      if (close.length) {
        let n = 0;
        for (const j of close) {
          const s = Math.max(0, j - 0.5);
          await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", s.toFixed(3), "-t", "1", "-i", abs, "-filter_complex",
            `[0:a]aformat=channel_layouts=mono,apad=whole_dur=1,showwavespic=s=396x120:colors=0xBBBBBB[wv];color=c=0x1A1A1A:s=396x120[bg];` +
              `[bg][wv]overlay=format=auto,format=rgb24,drawbox=x=${Math.round(((j - s) / 1) * 396)}:y=0:w=2:h=ih:color=red:t=fill[w]`,
            "-map", "[w]", "-frames:v", "1", join(work, `w${String(n).padStart(3, "0")}.png`)], { timeoutMs: 60_000, allowFailure: true });
          n++;
        }
        const closePath = join(work, "close.png");
        await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", "1", "-i", join(work, "w%03d.png"),
          "-vf", `tile=4x${Math.ceil(close.length / 4)}:padding=4:color=0x111111,scale=${W}:-2`, "-frames:v", "1", closePath], { timeoutMs: 60_000, allowFailure: true });
        await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", wavePath, "-i", closePath, "-filter_complex", "[0][1]vstack", wavePath.replace(/\.png$/, ".tmp.png")], { timeoutMs: 60_000, allowFailure: true });
        try {
          writeFileSync(wavePath, readFileSync(wavePath.replace(/\.png$/, ".tmp.png")));
          rmSync(wavePath.replace(/\.png$/, ".tmp.png"), { force: true });
        } catch {
          /* keep the overview only */
        }
        legend.push(`waveform: whole edit (red = joins, yellow = zooms); below, 1 s close-ups centred on joins ${close.map(fmt).join(", ")}`);
      }
      wave = readFileSync(wavePath);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { stats, media, warnings, sheet, sheetPath, wave, wavePath, legend: legend.join("\n"), rhythm };
}

/** Text report for review_edit. Pure. */
export function formatReview(r: Pick<ReviewResult, "stats" | "media" | "warnings" | "legend"> & { rhythm?: RhythmStats }, path: string): string {
  const s = r.stats;
  const m = r.media;
  const pauses = s.joinPauses.map((p) => p.pause).sort((a, b) => a - b);
  const median = pauses.length ? pauses[Math.floor(pauses.length / 2)] : undefined;
  const lines = [
    `Review of ${path}`,
    `duration ${m.duration.toFixed(2)}s${s.plannedDuration !== undefined ? ` (plan ${s.plannedDuration.toFixed(2)}s)` : ""}, ${m.width ?? "?"}x${m.height ?? "?"}`,
    `cuts ${s.cuts} (${s.cutsPerMinute}/min)${s.shortestKeep ? `, shortest keep ${s.shortestKeep.seconds}s at ${fmt(s.shortestKeep.at)}` : ""}`,
    `pauses at joins: ${pauses.length ? `min ${pauses[0]}s, median ${median}s, max ${pauses.at(-1)}s` : "n/a"}${s.longestPause ? `; longest remaining pause ${s.longestPause.seconds}s at ${fmt(s.longestPause.at)}` : ""}`,
    `zooms ${s.zooms} (${s.zoomsPerMinute}/min)${s.maxZoomScale ? `, max ${s.maxZoomScale}%` : ""}${s.adjacentZooms ? `, ${s.adjacentZooms} back-to-back` : ""}`,
    `captions ${s.captions}${s.captionMaxCps !== undefined ? `: max ${s.captionMaxCps} cps, ${s.captionMinDuration}–${s.captionMaxDuration}s, longest line ${s.captionMaxLine} chars` : ""}`,
    `loudness ${m.loudness.integrated ?? "?"} LUFS, true peak ${m.loudness.truePeak ?? "?"} dBTP, LRA ${m.loudness.lra ?? "?"} LU, sample peak ${m.peakDb ?? "?"} dBFS`,
    `black ${m.black.length ? m.black.map((b) => `${fmt(b.start)}–${fmt(b.end)}`).join(", ") : "none"}; frozen ${m.frozen.length ? m.frozen.map((f) => `${fmt(f.start)}–${Number.isFinite(f.end) ? fmt(f.end) : "end"}`).join(", ") : "none"}`,
    ...(r.rhythm && formatRhythm(r.rhythm) ? [`rhythm: ${formatRhythm(r.rhythm)}`] : []),
    "",
    r.warnings.length ? `WARNINGS (${r.warnings.length}):\n${r.warnings.map((w) => `- ${w}`).join("\n")}` : "No warnings against the editorial standards.",
  ];
  if (r.legend) lines.push("", "Contact sheet (blue bar = 0.3 s before a cut, orange = 0.3 s after, grey = regular interval):", r.legend);
  return lines.join("\n");
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}
function r1(n: number): number {
  return Math.round(n * 10) / 10;
}
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
