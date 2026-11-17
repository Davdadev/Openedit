import type { Cut, CutPlan, CutReason, TimeRange, Transcript, Word } from "../hosts/types.js";
import { editDuration } from "./remap.js";
import { spokenEnd } from "./vad.js";

export const DEFAULT_FILLERS = ["um", "umm", "uh", "uhh", "uhm", "erm", "er", "ah", "ahh", "hmm", "hm", "mm", "mhm"];

export type Tightness = "loose" | "normal" | "tight";

/** Padding / shortest removed pause / shortest kept piece (seconds) per tightness. */
export const TIGHTNESS: Record<Tightness, { padding: number; minSilence: number; minKeep: number }> = {
  loose: { padding: 0.15, minSilence: 0.8, minKeep: 0.3 },
  normal: { padding: 0.08, minSilence: 0.5, minKeep: 0.25 },
  tight: { padding: 0.04, minSilence: 0.3, minKeep: 0.2 },
};

export interface CutPlanInput {
  source: string;
  duration: number;
  /** Silent ranges to remove (from detectSilences). */
  silences?: TimeRange[];
  transcript?: Transcript;
  removeFillers?: boolean;
  /** Filler words/phrases (case-insensitive). Multi-word phrases like "you know" are supported. */
  fillerWords?: string[];
  /** Remove earlier attempts of restarted sentences (needs transcript). */
  removeRetakes?: boolean;
  retakeWindow?: number;
  /** Preset for padding / minKeep (explicit values win). Default "normal". */
  tightness?: Tightness;
  /** Seconds of breathing room left around speech at each silence cut. Default 0.08. */
  padding?: number;
  /** Kept pieces shorter than this (s) are dropped. Default 0.25. */
  minKeep?: number;
  /** Extra ranges to remove, e.g. chosen by Claude from the transcript. */
  manualCuts?: (TimeRange & { label?: string })[];
}

export function normalizeWord(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "").replace(/^'+|'+$/g, "");
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Sort and merge overlapping/touching cuts. The merged cut keeps the reason that covers the most time. */
export function mergeCuts(cuts: Cut[], tolerance = 0.001): Cut[] {
  const sorted = cuts.filter((c) => c.end > c.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: (Cut & { _w: Map<CutReason, number>; _labels: string[] })[] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.start <= last.end + tolerance) {
      last.end = Math.max(last.end, c.end);
      last._w.set(c.reason, (last._w.get(c.reason) ?? 0) + (c.end - c.start));
      if (c.label) last._labels.push(c.label);
    } else {
      out.push({ ...c, _w: new Map([[c.reason, c.end - c.start]]), _labels: c.label ? [c.label] : [] });
    }
  }
  return out.map(({ _w, _labels, ...c }) => {
    let reason = c.reason;
    let best = -1;
    for (const [r, w] of _w) if (w > best) [reason, best] = [r, w];
    const cut: Cut = { start: c.start, end: c.end, reason };
    const labels = [...new Set(_labels)];
    if (labels.length) cut.label = labels.join("; ");
    return cut;
  });
}

/** Complement of `cuts` within [0, duration]. */
export function invertRanges(cuts: TimeRange[], duration: number): TimeRange[] {
  const keep: TimeRange[] = [];
  let pos = 0;
  for (const c of [...cuts].sort((a, b) => a.start - b.start)) {
    if (c.start > pos) keep.push({ start: pos, end: Math.min(c.start, duration) });
    pos = Math.max(pos, c.end);
    if (pos >= duration) break;
  }
  if (pos < duration) keep.push({ start: pos, end: duration });
  return keep.filter((k) => k.end > k.start);
}

/** Cuts for filler words / phrases found in the transcript. */
export function detectFillers(transcript: Transcript, fillerWords: string[] = DEFAULT_FILLERS): Cut[] {
  const words = transcript.segments.flatMap((s) => s.words);
  const norm = words.map((w) => normalizeWord(w.text));
  const phrases = fillerWords
    .map((f) => f.split(/\s+/).map(normalizeWord).filter(Boolean))
    .filter((p) => p.length)
    .sort((a, b) => b.length - a.length);
  const cuts: Cut[] = [];
  for (let i = 0; i < words.length; i++) {
    for (const p of phrases) {
      if (p.every((tok, k) => norm[i + k] === tok)) {
        const last = words[i + p.length - 1];
        cuts.push({ start: words[i].start, end: last.end, reason: "filler", label: p.join(" ") });
        i += p.length - 1;
        break;
      }
    }
  }
  return cuts;
}

export interface RetakeOptions {
  /** Max seconds between the start of the abandoned attempt and the restart. Default 10. */
  window?: number;
  /** Leading words that must match for a full-sentence retake. Default 4. */
  minMatch?: number;
  /** Longest single retake cut, seconds. Default 15. */
  maxCut?: number;
  fillerWords?: string[];
}

export interface Retake {
  cut: Cut;
  /** The abandoned attempt (removed). */
  attempt: string;
  /** The start of the kept restart. */
  restart: string;
  /** How many leading words matched. */
  matched: number;
  why: string;
}

/** Ordered similarity of the first n tokens of two word lists (0..1). */
export function leadingSimilarity(a: string[], b: string[], n = 5): number {
  const x = a.slice(0, n);
  const y = b.slice(0, n);
  if (!x.length || !y.length) return 0;
  // LCS on short prefixes.
  const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = 1; i <= x.length; i++)
    for (let j = 1; j <= y.length; j++)
      dp[i][j] = x[i - 1] === y[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[x.length][y.length] / Math.max(x.length, y.length);
}

/**
 * Retake detection: a phrase is started, abandoned and started again. To avoid
 * cutting real content (people repeat sentence openings on purpose), a match needs
 *  - the same opening at a later phrase start within `window` seconds, with either
 *    >= minMatch (4) identical leading words, >= 80% similarity of the first 5 words
 *    (4+ words compared), or an unfinished fragment that is exactly a 2-3 word prefix
 *    of the restart ("so the — so the plan is");
 *  - evidence the first attempt was abandoned: it does not end a sentence, or is
 *    followed by a pause / filler, or is entirely repeated by the restart;
 *  - a cut no longer than `maxCut` (15 s).
 * Zero-length (collapsed / hallucinated) words are ignored. The earlier attempt
 * is cut, from its first word to the restart.
 */
export function findRetakes(transcript: Transcript, opts: RetakeOptions = {}): Retake[] {
  const window = opts.window ?? 10;
  const minMatch = opts.minMatch ?? 4;
  const maxCut = opts.maxCut ?? 15;
  const fillers = new Set((opts.fillerWords ?? DEFAULT_FILLERS).map(normalizeWord));
  const words: (Word & { n: string; segStart: boolean })[] = [];
  for (const seg of transcript.segments) {
    seg.words.forEach((w, k) => {
      const n = normalizeWord(w.text);
      if (n && w.end - w.start > 0.015) words.push({ ...w, n, segStart: k === 0 });
    });
  }
  const gapBefore = (i: number) => (i === 0 ? Infinity : words[i].start - spokenEnd(words[i - 1]));
  const isPhraseStart = (i: number): boolean => {
    if (i === 0 || words[i].segStart) return true;
    const prev = words[i - 1];
    if (/[.!?,;:…—-]$/.test(prev.text.trim())) return true;
    if (fillers.has(prev.n)) return true;
    return gapBefore(i) >= 0.35;
  };
  const starts = words.map((_, i) => i).filter(isPhraseStart);
  const out: Retake[] = [];
  let si = 0;
  while (si < starts.length) {
    const i = starts[si];
    if (fillers.has(words[i].n)) {
      si++;
      continue;
    }
    let found: Retake | null = null;
    let foundSj = -1;
    for (let sj = si + 1; sj < starts.length && !found; sj++) {
      const j = starts[sj];
      if (words[j].start - words[i].start > window) break;
      if (fillers.has(words[j].n)) continue;
      const attemptLen = j - i;
      let m = 0;
      while (i + m < j && j + m < words.length && words[i + m].n === words[j + m].n) m++;
      const content = words.slice(i, j).filter((w) => !fillers.has(w.n));
      const sim = leadingSimilarity(content.map((w) => w.n), words.slice(j, j + 8).filter((w) => !fillers.has(w.n)).map((w) => w.n));
      const compared = Math.min(5, content.length, words.length - j);
      let why = "";
      if (m >= minMatch) why = `${m} leading words repeated`;
      else if (compared >= 4 && sim >= 0.8) why = `first words ${Math.round(sim * 100)}% similar`;
      else if (m >= 2 && m === content.length && m <= 3) why = `abandoned "${content.map((w) => w.text).join(" ")}" restarted`;
      if (!why) continue;
      const lastAttempt = words[j - 1];
      const endsSentence = /[.!?]["')\]]*$/.test(lastAttempt.text.trim());
      const pause = gapBefore(j) >= 0.3 || fillers.has(lastAttempt.n) || /[,…—-]$/.test(lastAttempt.text.trim());
      const short = attemptLen <= m; // the whole attempt is repeated by the restart
      if (endsSentence && !pause && !short) continue; // a finished sentence, not an abandoned one
      // A 2-3 word fragment counts only if it was cut off mid-sentence ("Empty document. Empty document." is deliberate).
      if (why.startsWith("abandoned") && endsSentence) continue;
      const cutLen = words[j].start - words[i].start;
      if (cutLen > maxCut || cutLen <= 0) continue;
      const attempt = words.slice(i, j).map((w) => w.text).join(" ");
      const restart = words.slice(j, j + Math.max(m, 6)).map((w) => w.text).join(" ");
      found = {
        cut: {
          start: words[i].start,
          end: words[j].start,
          reason: "retake",
          label: `retake: "${attempt.length > 80 ? `${attempt.slice(0, 77)}...` : attempt}"`,
        },
        attempt,
        restart,
        matched: m,
        why,
      };
      foundSj = sj;
    }
    if (!found) {
      si++;
      continue;
    }
    out.push(found);
    si = foundSj;
  }
  return out;
}

/** Retake cuts (see findRetakes). */
export function detectRetakes(transcript: Transcript, opts: RetakeOptions = {}): Cut[] {
  return findRetakes(transcript, opts).map((r) => r.cut);
}

/**
 * Build the edit decision: which source ranges to keep. Silences are shrunk by
 * `padding` on each side so speech is never clipped; overlapping cuts merge;
 * keeps shorter than `minKeep` are dropped.
 */
export function buildCutPlan(input: CutPlanInput): CutPlan {
  const { source, duration } = input;
  const preset = TIGHTNESS[input.tightness ?? "normal"];
  const padding = input.padding ?? preset.padding;
  const minKeep = input.minKeep ?? preset.minKeep;
  const raw: Cut[] = [];

  for (const s of input.silences ?? []) {
    const start = s.start <= 0.001 ? 0 : s.start + padding;
    const end = s.end >= duration - 0.001 ? duration : s.end - padding;
    if (end > start) raw.push({ start, end, reason: "silence" });
  }
  if (input.transcript && input.removeFillers) raw.push(...detectFillers(input.transcript, input.fillerWords));
  if (input.transcript && input.removeRetakes) {
    raw.push(...detectRetakes(input.transcript, { window: input.retakeWindow, fillerWords: input.fillerWords }));
  }
  for (const m of input.manualCuts ?? []) {
    raw.push({ start: m.start, end: m.end, reason: "manual", ...(m.label ? { label: m.label } : {}) });
  }

  const clipped = raw
    .map((c) => ({ ...c, start: Math.max(0, c.start), end: Math.min(duration, c.end) }))
    .filter((c) => c.end > c.start);
  let cuts = mergeCuts(clipped);

  // Drop slivers: tiny keeps become part of the surrounding cuts.
  const keepsBefore = invertRanges(cuts, duration);
  const slivers = keepsBefore.filter((k) => k.end - k.start < minKeep);
  if (slivers.length) {
    const sliverCuts: Cut[] = slivers.map((k) => {
      const neighbor = cuts.find((c) => Math.abs(c.end - k.start) < 0.002 || Math.abs(c.start - k.end) < 0.002);
      return { start: k.start, end: k.end, reason: neighbor?.reason ?? "silence" };
    });
    cuts = mergeCuts([...cuts, ...sliverCuts]);
  }

  const keep = invertRanges(cuts, duration).map((k) => ({ start: round3(k.start), end: round3(k.end) }));
  return {
    source,
    duration,
    keep,
    cuts: cuts.map((c) => ({ ...c, start: round3(c.start), end: round3(c.end) })),
  };
}

export interface PlanSummary {
  originalDuration: number;
  editedDuration: number;
  timeSaved: number;
  percentSaved: number;
  keptSegments: number;
  cutsByReason: Record<CutReason, { count: number; seconds: number }>;
}

export function summarizePlan(plan: CutPlan): PlanSummary {
  const edited = editDuration(plan);
  const cutsByReason: PlanSummary["cutsByReason"] = {
    silence: { count: 0, seconds: 0 },
    filler: { count: 0, seconds: 0 },
    retake: { count: 0, seconds: 0 },
    manual: { count: 0, seconds: 0 },
  };
  for (const c of plan.cuts) {
    cutsByReason[c.reason].count++;
    cutsByReason[c.reason].seconds = round3(cutsByReason[c.reason].seconds + (c.end - c.start));
  }
  return {
    originalDuration: round3(plan.duration),
    editedDuration: round3(edited),
    timeSaved: round3(plan.duration - edited),
    percentSaved: plan.duration ? Math.round(((plan.duration - edited) / plan.duration) * 1000) / 10 : 0,
    keptSegments: plan.keep.length,
    cutsByReason,
  };
}
