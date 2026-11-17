import type { Cut, CutPlan, CutReason, TimeRange, Transcript, Word } from "../hosts/types.js";
import { editDuration } from "./remap.js";

export const DEFAULT_FILLERS = ["um", "umm", "uh", "uhh", "uhm", "erm", "er", "ah", "ahh", "hmm", "hm", "mm", "mhm"];

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
  /** Words that must match at the restart (fewer allowed if the abandoned attempt was shorter). Default 3. */
  minMatch?: number;
  fillerWords?: string[];
}

/**
 * Heuristic retake detection: when a phrase is started, abandoned and started
 * again (the same leading words re-appear at a later phrase start within the
 * window), cut the earlier attempt, from its first word to the restart.
 */
export function detectRetakes(transcript: Transcript, opts: RetakeOptions = {}): Cut[] {
  const window = opts.window ?? 10;
  const minMatch = opts.minMatch ?? 3;
  const fillers = new Set((opts.fillerWords ?? DEFAULT_FILLERS).map(normalizeWord));
  const words: (Word & { n: string; segStart: boolean })[] = [];
  for (const seg of transcript.segments) {
    seg.words.forEach((w, k) => {
      const n = normalizeWord(w.text);
      if (n) words.push({ ...w, n, segStart: k === 0 });
    });
  }
  const isPhraseStart = (i: number): boolean => {
    if (i === 0 || words[i].segStart) return true;
    const prev = words[i - 1];
    if (/[.!?,;:…—-]$/.test(prev.text.trim())) return true;
    if (fillers.has(prev.n)) return true;
    return words[i].start - prev.end >= 0.35;
  };
  const starts = words.map((_, i) => i).filter(isPhraseStart);
  const cuts: Cut[] = [];
  let si = 0;
  while (si < starts.length) {
    const i = starts[si];
    if (fillers.has(words[i].n)) {
      si++;
      continue;
    }
    let matched = -1;
    for (let sj = si + 1; sj < starts.length; sj++) {
      const j = starts[sj];
      if (words[j].start - words[i].start > window) break;
      let m = 0;
      while (i + m < j && j + m < words.length && words[i + m].n === words[j + m].n) m++;
      if (m >= 2 && m >= Math.min(minMatch, j - i)) {
        matched = sj;
        break;
      }
    }
    if (matched < 0) {
      si++;
      continue;
    }
    const j = starts[matched];
    const attempt = words.slice(i, j).map((w) => w.text).join(" ");
    cuts.push({
      start: words[i].start,
      end: words[j].start,
      reason: "retake",
      label: `retake: "${attempt.length > 80 ? `${attempt.slice(0, 77)}...` : attempt}"`,
    });
    si = matched;
  }
  return cuts;
}

/**
 * Build the edit decision: which source ranges to keep. Silences are shrunk by
 * `padding` on each side so speech is never clipped; overlapping cuts merge;
 * keeps shorter than `minKeep` are dropped.
 */
export function buildCutPlan(input: CutPlanInput): CutPlan {
  const { source, duration } = input;
  const padding = input.padding ?? 0.08;
  const minKeep = input.minKeep ?? 0.25;
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
