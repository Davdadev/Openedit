import type { CutPlan, Transcript, Word } from "../hosts/types.js";
import { editSegments, mapTime } from "./remap.js";
import type { ZoomSpec } from "./render.js";
import { spokenEnd } from "./vad.js";

/**
 * Emphasis-aware automatic zooms. Pure: picks moments on the EDITED timeline
 * from the transcript (sentence starts after pauses, emphasised words,
 * exclamations, questions) and the plan's jump cuts, keeps them `minGap`
 * apart and alternates framing levels.
 */

export type ZoomStyle = "punch" | "smooth";

export interface AutoZoomOptions {
  /** "punch" = hard cut in framing (default); "smooth" = eased ramp. */
  style?: ZoomStyle;
  /** Zoom levels in percent: [normal punch-in, emphasis punch-in]. Default [108, 115]. */
  levels?: number[];
  /** Minimum edited seconds between framing changes. Default 3. */
  minGap?: number;
  /** Longest a zoom is held, seconds. Default 5. */
  maxHold?: number;
  /** Shortest zoom, seconds. Default 1.2. */
  minHold?: number;
  /** Without a transcript: add a framing change every this many seconds inside long segments. Default 6. */
  every?: number;
  /** Ramp seconds for "smooth". Default 0.4. */
  ease?: number;
}

export type MomentKind = "emphasis" | "question" | "sentence" | "jumpcut" | "periodic";

export interface ZoomMoment {
  /** Edited-timeline seconds. */
  time: number;
  kind: MomentKind;
  weight: number;
  /** The word / phrase that triggered it. */
  text?: string;
}

export interface PlannedZoom extends ZoomSpec {
  kind: MomentKind;
  text?: string;
}

const EMPHASIS = new Set([
  "important", "importantly", "never", "always", "every", "everyone", "everything", "nobody", "nothing", "only",
  "huge", "massive", "biggest", "best", "worst", "first", "key", "secret", "must", "really", "actually", "exactly",
  "absolutely", "completely", "totally", "incredible", "amazing", "crazy", "insane", "wrong", "problem", "mistake",
  "free", "fast", "easy", "hard", "impossible", "remember", "imagine", "listen", "look", "why", "how", "but",
  "percent", "hundred", "thousand", "million", "billion", "twice", "double", "half",
]);
const NUMBER_WORDS = new Set(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "twenty", "fifty"]);

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
const endsSentence = (t: string) => /[.!?]["')\]]*$/.test(t.trim());

/** Strength of a single word as an emphasis point (0 = none). */
export function emphasisWeight(w: Word, next?: Word): number {
  const n = norm(w.text);
  if (!n) return 0;
  if (/!/.test(w.text)) return 2.5;
  if (/\d/.test(n) || NUMBER_WORDS.has(n)) return 2.2;
  // Common words only count when they lead a strong claim ("but" / "how" / "why" at a clause start).
  if (n === "but" || n === "how" || n === "why" || n === "look" || n === "listen") return next ? 1.2 : 0;
  if (EMPHASIS.has(n)) return 2;
  return 0;
}

/** Candidate moments on the edited timeline. */
export function zoomMoments(plan: Pick<CutPlan, "keep">, transcript?: Transcript, every = 6): ZoomMoment[] {
  const out: ZoomMoment[] = [];
  const segs = editSegments(plan);
  segs.forEach((s, k) => {
    if (k > 0) out.push({ time: s.start, kind: "jumpcut", weight: 1 });
  });
  const words = transcript?.segments.flatMap((s) => s.words) ?? [];
  if (!words.length) {
    for (const s of segs) for (let t = s.start + every; t < s.end - every / 2; t += every) out.push({ time: t, kind: "periodic", weight: 0.5 });
    return out;
  }
  // Index of the first word of each sentence, to place question zooms at the sentence start.
  let sentenceStart = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = words[i - 1];
    if (i === 0 || endsSentence(prev.text)) sentenceStart = i;
    const at = mapTime(plan, w.start + 0.001);
    if (at === null) continue;
    const time = Math.max(0, at - 0.001);
    if (i === sentenceStart) {
      const gap = prev ? w.start - spokenEnd(prev) : 0;
      out.push({ time, kind: "sentence", weight: gap >= 0.4 ? 1.5 : 1.1, text: w.text });
      // A question: zoom from its first word.
      let j = i;
      while (j < words.length - 1 && !endsSentence(words[j].text) && j - i < 40) j++;
      if (/\?/.test(words[j].text)) out.push({ time, kind: "question", weight: 1.8, text: words.slice(i, j + 1).map((x) => x.text).join(" ") });
    }
    const e = emphasisWeight(w, words[i + 1]);
    if (e > 0) out.push({ time: Math.max(0, time - 0.05), kind: "emphasis", weight: e, text: w.text });
  }
  return out;
}

/** Pick zooms: strongest moments first, `minGap` apart, alternating levels. */
export function planZooms(plan: Pick<CutPlan, "keep">, transcript: Transcript | undefined, opts: AutoZoomOptions = {}): PlannedZoom[] {
  const style = opts.style ?? "punch";
  const levels = (opts.levels?.length ? opts.levels : [108, 115]).filter((l) => l > 100);
  const low = levels[0] ?? 108;
  const high = levels[levels.length - 1] ?? low;
  const minGap = opts.minGap ?? 3;
  const maxHold = opts.maxHold ?? 5;
  const minHold = opts.minHold ?? 1.2;
  const ease = style === "smooth" ? (opts.ease ?? 0.4) : 0;
  const total = editSegments(plan).at(-1)?.end ?? 0;

  const moments = zoomMoments(plan, transcript, opts.every ?? 6)
    .filter((m) => m.time < total - minHold)
    .sort((a, b) => b.weight - a.weight || a.time - b.time);
  const chosen: ZoomMoment[] = [];
  for (const m of moments) {
    if (chosen.every((c) => Math.abs(c.time - m.time) >= minGap)) chosen.push(m);
  }
  chosen.sort((a, b) => a.time - b.time);

  const out: PlannedZoom[] = [];
  let prevLevel = 100;
  let prevEnd = -1;
  for (let k = 0; k < chosen.length; k++) {
    const m = chosen[k];
    const next = chosen[k + 1]?.time ?? total;
    let level = m.weight >= 1.8 ? high : low;
    // Contiguous with the previous zoom at the same level: go back to 100% instead, so framing alternates.
    if (Math.abs(prevEnd - m.time) < 0.01 && level === prevLevel) {
      prevLevel = 100;
      prevEnd = -1;
      continue;
    }
    const end = Math.min(next, m.time + maxHold, total);
    if (end - m.time < minHold) continue;
    out.push({ start: r2(m.time), end: r2(end), scale: level, ease, kind: m.kind, ...(m.text ? { text: m.text } : {}) });
    prevLevel = level;
    prevEnd = end;
  }
  return out;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
