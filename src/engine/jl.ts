/**
 * J and L cuts (split edits) on a cut plan.
 *
 * At the join between keep[j] (A) and keep[j+1] (B):
 *  - J: B's audio starts `d` seconds before B's picture ("sound leads picture": we hear the next
 *    line, breath or scene before we see it);
 *  - L: A's audio carries on `d` seconds over B's picture ("sound lags picture": the end of a line
 *    plays over the reaction / the next shot).
 * With roll "audio" (default) the picture cut stays put and the audio edit point moves, taking
 * source handles beyond the kept range; with roll "video" the audio cut stays and the picture
 * edit point moves. Either way every piece stays in sync with its own source (a source time
 * lands at the same edit time in both tracks) and the total duration is unchanged, so captions,
 * markers and zooms need no remapping.
 *
 * Pure: the renderer, the interchange writers and review all use splitRanges().
 */
import type { CutPlan, SplitEdit, TimeRange, Transcript, Word } from "../hosts/types.js";
import { spokenEnd } from "./vad.js";

/** Shortest audio or video piece a split may leave (s). */
export const MIN_SPLIT_PIECE = 0.1;
/** Split lengths accepted (s). Typical craft range is 0.3-1.5 s; longer becomes a sound bridge. */
export const MAX_SPLIT = 4;

export interface SplitRanges {
  /** Source range of each kept piece's picture. */
  video: TimeRange[];
  /** Source range of each kept piece's sound. */
  audio: TimeRange[];
}

const EPS = 1e-6;

/**
 * Source ranges for picture and sound once the plan's splits are applied. Picture and sound of
 * piece i start/end at edit times that differ by the split amounts; each still maps source time s
 * to the same edit time. Assumes normalised splits (see normalizeSplits).
 */
export function splitRanges(plan: Pick<CutPlan, "keep"> & Partial<Pick<CutPlan, "splits">>): SplitRanges {
  const video = plan.keep.map((k) => ({ start: k.start, end: k.end }));
  const audio = plan.keep.map((k) => ({ start: k.start, end: k.end }));
  for (const s of plan.splits ?? []) {
    const j = s.index;
    if (j < 0 || j >= plan.keep.length - 1 || !(s.seconds > 0)) continue;
    // Signed shift of the audio boundary relative to the picture boundary: J = earlier (-), L = later (+).
    const shift = s.type === "J" ? -s.seconds : s.seconds;
    if ((s.roll ?? "audio") === "audio") {
      audio[j].end += shift;
      audio[j + 1].start += shift;
    } else {
      // The picture boundary moves the opposite way; the audio boundary stays on the original join.
      video[j].end -= shift;
      video[j + 1].start -= shift;
    }
  }
  return { video, audio };
}

/**
 * Clamp / drop splits that cannot be honoured: index out of range, one split per join, enough
 * source handle (0..sourceDuration), every picture and sound piece >= MIN_SPLIT_PIECE, and no
 * split at an edge that has a speed ramp or freeze on it. Returns the usable splits and notes.
 */
export function normalizeSplits(
  plan: Pick<CutPlan, "keep" | "duration"> & Partial<Pick<CutPlan, "ramps" | "freezes">>,
  splits: SplitEdit[],
  opts: { sourceDuration?: number } = {},
): { splits: SplitEdit[]; notes: string[] } {
  const notes: string[] = [];
  const srcDur = opts.sourceDuration ?? plan.duration;
  const byJoin = new Map<number, SplitEdit>();
  for (const s of splits) {
    if (!Number.isInteger(s.index) || s.index < 0 || s.index >= plan.keep.length - 1) {
      notes.push(`join ${s.index}: no such join (the plan has ${Math.max(0, plan.keep.length - 1)} joins, 0-based)`);
      continue;
    }
    if (!(s.seconds > 0)) continue;
    if (byJoin.has(s.index)) notes.push(`join ${s.index}: several splits given, using the last`);
    byJoin.set(s.index, { ...s, seconds: Math.min(MAX_SPLIT, s.seconds) });
  }
  const ordered = [...byJoin.values()].sort((a, b) => a.index - b.index);
  const out: SplitEdit[] = [];
  const timed = (t: number) =>
    (plan.ramps ?? []).some((r) => t >= r.start - 0.05 && t <= r.end + 0.05) || (plan.freezes ?? []).some((f) => Math.abs(f.at - t) < 0.05);
  for (const s of ordered) {
    const A = plan.keep[s.index];
    const B = plan.keep[s.index + 1];
    if (timed(A.end) || timed(B.start)) {
      notes.push(`join ${s.index}: a speed ramp / freeze touches this cut; split edit skipped`);
      continue;
    }
    const roll = s.roll ?? "audio";
    // Ranges as already modified by the splits accepted so far (the one at join index-1 may move A's start).
    const prior = splitRanges({ keep: plan.keep, splits: out });
    const v = prior.video;
    const a = prior.audio;
    const j = s.index;
    let d = s.seconds;
    const len = (r: TimeRange) => r.end - r.start;
    const limits: number[] = [];
    if (roll === "audio" && s.type === "J") limits.push(len(a[j]) - MIN_SPLIT_PIECE, B.start);
    else if (roll === "audio") limits.push(srcDur - A.end, len(a[j + 1]) - MIN_SPLIT_PIECE);
    else if (s.type === "J") limits.push(srcDur - A.end, len(v[j + 1]) - MIN_SPLIT_PIECE);
    else limits.push(len(v[j]) - MIN_SPLIT_PIECE, B.start);
    d = Math.min(d, ...limits);
    d = Math.floor(Math.max(0, d) * 1000) / 1000;
    if (d < 0.04) {
      notes.push(`join ${j}: no room for a ${s.type}-cut (handles / piece lengths); skipped`);
      continue;
    }
    if (d < s.seconds - 1e-3) notes.push(`join ${j}: ${s.type}-cut shortened to ${d}s (handles / piece lengths)`);
    out.push({ index: j, type: s.type, seconds: d, ...(roll !== "audio" ? { roll } : {}) });
  }
  return { splits: out, notes };
}

export interface AutoSplit extends SplitEdit {
  why: string;
}

/**
 * Conservative automatic split edits for a single-camera dialogue edit. On one talking head a
 * long split puts the speaker's mouth out of sync with what we hear, so only these are made:
 *  - "breath pre-lap" J-cuts at sentence boundaries where a real pause was removed: the next
 *    line's breath / room tone leads the picture by 0.12-0.35 s, so the cut lands on the sound
 *    instead of before it. Only where A's kept tail is silent for that long and the removed
 *    region's tail holds no words (removed speech is never brought back).
 *  - scene / topic transitions (>= `transitionGap` s removed, e.g. a manual cut of a tangent):
 *    the same pre-lap, up to 0.5 s.
 * At most one per `minSpacing` seconds of edit, never on two neighbouring joins.
 */
export function autoSplits(
  plan: Pick<CutPlan, "keep" | "duration"> & Partial<Pick<CutPlan, "ramps" | "freezes">>,
  transcript: Transcript | undefined,
  opts: { minSpacing?: number; transitionGap?: number; maxSeconds?: number } = {},
): AutoSplit[] {
  if (!transcript) return [];
  const words: Word[] = transcript.segments.flatMap((s) => s.words).filter((w) => w.end - w.start > 0.015 && w.text.trim());
  const minSpacing = opts.minSpacing ?? 8;
  const transitionGap = opts.transitionGap ?? 3;
  const maxD = opts.maxSeconds ?? 0.5;
  const out: AutoSplit[] = [];
  let acc = 0;
  let lastAt = -Infinity;
  let lastIndex = -10;
  for (let j = 0; j < plan.keep.length - 1; j++) {
    const A = plan.keep[j];
    const B = plan.keep[j + 1];
    acc += A.end - A.start;
    const gap = B.start - A.end;
    if (gap < 0.4) continue;
    const lastA = [...words].reverse().find((w) => (w.start + spokenEnd(w)) / 2 < A.end && w.start >= A.start - 1e-3);
    const firstB = words.find((w) => (w.start + spokenEnd(w)) / 2 > B.start && w.start <= B.end);
    if (!lastA || !firstB) continue;
    const sentenceEnd = /[.!?…]["')\]]*$/.test(lastA.text.trim());
    const transition = gap >= transitionGap;
    if (!sentenceEnd && !transition) continue;
    // A's silent tail (picture holds while B's pre-roll plays) and the word-free tail of the removed region.
    const tailFree = A.end - spokenEnd(lastA) - 0.06;
    const removedWords = words.filter((w) => w.start < B.start && spokenEnd(w) > A.end);
    const lastRemovedEnd = removedWords.length ? Math.max(...removedWords.map(spokenEnd)) : A.end;
    const preFree = B.start - Math.max(lastRemovedEnd + 0.05, A.end);
    const cap = transition ? maxD : Math.min(maxD, 0.35);
    const d = Math.floor(Math.min(cap, tailFree, preFree, B.start) * 100) / 100;
    if (d < 0.12) continue;
    if (acc - lastAt < minSpacing || j - lastIndex < 2) continue;
    out.push({
      index: j,
      type: "J",
      seconds: d,
      why: transition ? `scene/topic transition (${gap.toFixed(1)}s removed): next line's room tone leads by ${d}s` : `sentence boundary: breath pre-lap ${d}s, the cut lands on the sound`,
    });
    lastAt = acc;
    lastIndex = j;
  }
  return out;
}

/** Counts for review. */
export function splitCounts(plan: Partial<Pick<CutPlan, "splits">>): { J: number; L: number; meanSeconds: number } {
  const s = plan.splits ?? [];
  return {
    J: s.filter((x) => x.type === "J").length,
    L: s.filter((x) => x.type === "L").length,
    meanSeconds: s.length ? Math.round((s.reduce((a, b) => a + b.seconds, 0) / s.length) * 1000) / 1000 : 0,
  };
}

/** Review notes on split edits (pure). */
export function splitWarnings(plan: Pick<CutPlan, "keep"> & Partial<Pick<CutPlan, "splits">>, opts: { singleCamera?: boolean } = {}): string[] {
  const w: string[] = [];
  for (const s of plan.splits ?? []) {
    if (s.seconds > 2) w.push(`join ${s.index}: ${s.type}-cut of ${s.seconds}s is a sound bridge, not a split edit; check it is intended`);
    else if (opts.singleCamera && s.seconds > 0.6) w.push(`join ${s.index}: ${s.seconds}s ${s.type}-cut on a single camera shows the speaker out of sync with the sound; keep single-camera splits under ~0.5 s or cover them with b-roll`);
  }
  const { video, audio } = splitRanges(plan);
  video.forEach((v, i) => {
    if (v.end - v.start < MIN_SPLIT_PIECE - EPS || audio[i].end - audio[i].start < MIN_SPLIT_PIECE - EPS) w.push(`piece ${i}: a split edit leaves under ${MIN_SPLIT_PIECE}s of picture or sound`);
  });
  return w;
}
