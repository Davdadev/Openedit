import type { CutPlan, Transcript, Word } from "../hosts/types.js";
import { editSegments, mapTime } from "./remap.js";
import type { ZoomSpec } from "./render.js";
import { spokenEnd } from "./vad.js";

/**
 * Purposeful automatic zooms. Pure. An editor zooms for two reasons only:
 *  (a) to MASK A JUMP CUT: the same shot on both sides of a cut jumps; a change
 *      of framing exactly on the cut turns it into a "second camera angle". These
 *      zooms start (and, when possible, end) exactly on a cut, with a hard switch.
 *  (b) to LAND A GENUINELY EMPHASISED MOMENT (a strong claim, a striking number,
 *      an exclamation): a slow push-in over the phrase in long-form, a punch in shorts.
 * Density is low: long-form <= ~1 per 20 s ("normal"), never on adjacent segments,
 * never back-to-back. Scale 105–110% for 1080p sources so the image stays sharp.
 */

export type ZoomStyle = "punch" | "smooth";
export type ZoomDensity = "subtle" | "normal" | "energetic";
export type ZoomFormat = "long" | "short";

export interface AutoZoomOptions {
  /** "punch" = hard cut in framing; "smooth" = eased push. Default smooth for long-form, punch for shorts. Jump-cut zooms are always hard. */
  style?: ZoomStyle;
  /** How often: subtle / normal (default) / energetic. */
  density?: ZoomDensity;
  /** long-form (16:9, default) or short-form (vertical). Sets spacing and scale defaults. */
  format?: ZoomFormat;
  /** Zoom levels in percent: [jump-cut zoom, emphasis zoom]. Default long [106, 110], short [108, 112]. */
  levels?: number[];
  /** Minimum seconds between zoom starts. Default from density/format (long normal: 20). */
  minGap?: number;
  /** Longest a zoom is held, seconds. Default 6 (long) / 4 (short). */
  maxHold?: number;
  /** Shortest zoom, seconds. Default 1.5. */
  minHold?: number;
  /** Without a transcript and with no cuts: one zoom every this many seconds. Only when given explicitly. */
  every?: number;
  /** Ramp seconds for smooth emphasis zooms. Default 0.8 (long) / 0.25 (short). */
  ease?: number;
}

export type MomentKind = "emphasis" | "jumpcut" | "periodic" | "question" | "sentence";

export interface ZoomMoment {
  /** Edited-timeline seconds. */
  time: number;
  kind: MomentKind;
  weight: number;
  /** The word / phrase that triggered it. */
  text?: string;
  /** Suggested end (edited seconds), e.g. the next cut or the end of the sentence. */
  end?: number;
  /** For jump cuts: index of the segment that starts here. */
  segment?: number;
}

export interface PlannedZoom extends ZoomSpec {
  kind: MomentKind;
  text?: string;
}

/** Seconds between zoom starts per format and density. */
export const ZOOM_SPACING: Record<ZoomFormat, Record<ZoomDensity, number>> = {
  long: { subtle: 40, normal: 20, energetic: 10 },
  short: { subtle: 12, normal: 7, energetic: 4 },
};

/** Words that carry a strong claim. Weak intensifiers ("really", "actually", "but") do not count. */
const STRONG = new Set([
  "important", "importantly", "crucial", "critical", "never", "always", "nobody", "nothing", "only",
  "huge", "massive", "biggest", "best", "worst", "secret", "must", "absolutely", "completely", "totally", "incredible",
  "impossible", "mistake", "problem", "wrong", "remember", "imagine", "free",
]);
const MAGNITUDE = new Set(["percent", "%", "thousand", "million", "billion", "times", "twice", "double", "half", "x"]);

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}%']+/gu, "");
const endsSentence = (t: string) => /[.!?]["')\]]*$/.test(t.trim());
const endsClause = (t: string) => /[,;:—–-]["')\]]*$/.test(t.trim());

/** Strength of a single word as an emphasis point (0 = none). */
export function emphasisWeight(w: Word, next?: Word): number {
  const n = norm(w.text);
  if (!n) return 0;
  if (/!/.test(w.text)) return 2.5;
  // A number counts only when it is large or comes with a magnitude ("300 percent", "a million", "400-page").
  if (/\d/.test(n)) {
    const nn = next ? norm(next.text) : "";
    if (/^\d{3,}|\d[,.]\d{3}|%$/.test(n) || /\d-?[a-z]/.test(n) || MAGNITUDE.has(nn)) return 2.2;
    return 0;
  }
  if (MAGNITUDE.has(n) && n !== "x") return 2;
  if (STRONG.has(n)) return 2;
  return 0;
}

/** Candidate moments on the edited timeline: jump cuts and strong emphasis. */
export function zoomMoments(plan: Pick<CutPlan, "keep">, transcript?: Transcript, every?: number): ZoomMoment[] {
  const out: ZoomMoment[] = [];
  const segs = editSegments(plan);
  const words = (transcript?.segments.flatMap((s) => s.words) ?? []).filter((w) => w.text.trim());
  // Source word before each join, to tell a mid-sentence jump (very visible) from one on a sentence break.
  segs.forEach((s, k) => {
    if (k === 0) return;
    const removed = s.sourceStart - segs[k - 1].sourceEnd;
    if (removed < 0.12) return; // practically continuous
    const before = [...words].reverse().find((w) => w.start < segs[k - 1].sourceEnd);
    const midSentence = before ? !endsSentence(before.text) : true;
    const weight = 1 + (midSentence ? 0.6 : 0) + Math.min(0.6, removed / 3);
    out.push({ time: s.start, kind: "jumpcut", weight, segment: k, ...(before ? { text: `cut after "${before.text.trim()}"` } : {}) });
  });
  if (!words.length) {
    if (every && every > 0 && segs.length === 1) {
      for (const s of segs) for (let t = s.start + every; t < s.end - every / 2; t += every) out.push({ time: t, kind: "periodic", weight: 0.5 });
    }
    return out;
  }
  for (let i = 0; i < words.length; i++) {
    const e = emphasisWeight(words[i], words[i + 1]);
    if (!e) continue;
    const at = mapTime(plan, words[i].start + 0.001);
    if (at === null) continue;
    // Start at the beginning of the phrase that carries the word (max 2.5 s back), end at its sentence end.
    let p = i;
    while (p > 0 && !endsSentence(words[p - 1].text) && !endsClause(words[p - 1].text) && words[i].start - words[p - 1].start <= 2.5) p--;
    let q = i;
    while (q < words.length - 1 && !endsSentence(words[q].text) && words[q + 1].start - words[i].start < 6) q++;
    const s = mapTime(plan, words[p].start + 0.001);
    const en = mapTime(plan, spokenEnd(words[q]) - 0.001);
    const time = Math.max(0, (s ?? at) - 0.05);
    // One moment per phrase (the strongest word wins).
    const dup = out.find((o) => o.kind === "emphasis" && Math.abs(o.time - time) < 0.01);
    if (dup) {
      dup.weight = Math.max(dup.weight, e);
      continue;
    }
    out.push({
      time,
      kind: "emphasis",
      weight: e,
      text: words.slice(p, q + 1).map((w) => w.text.trim()).join(" "),
      ...(en !== null && en > time ? { end: en + 0.25 } : {}),
    });
  }
  return out;
}

/** Index of the edit segment containing edited time t. */
function segmentAt(segs: { start: number; end: number }[], t: number): number {
  const i = segs.findIndex((s) => t >= s.start - 1e-6 && t < s.end - 1e-6);
  return i < 0 ? segs.length - 1 : i;
}

/** Pick purposeful zooms: strongest moments first, sparse, never on adjacent segments. */
export function planZooms(plan: Pick<CutPlan, "keep">, transcript: Transcript | undefined, opts: AutoZoomOptions = {}): PlannedZoom[] {
  const format = opts.format ?? "long";
  const density = opts.density ?? "normal";
  const style = opts.style ?? (format === "short" ? "punch" : "smooth");
  const levels = (opts.levels?.length ? opts.levels : format === "short" ? [108, 112] : [106, 110]).filter((l) => l > 100);
  const low = levels[0] ?? 106;
  const high = levels[levels.length - 1] ?? low;
  const spacing = opts.minGap ?? ZOOM_SPACING[format][density];
  const maxHold = opts.maxHold ?? (format === "short" ? 4 : 6);
  const minHold = opts.minHold ?? 1.5;
  const ease = style === "smooth" ? (opts.ease ?? (format === "short" ? 0.25 : 0.8)) : 0;
  const segs = editSegments(plan);
  const total = segs.at(-1)?.end ?? 0;
  const rest = Math.min(4, spacing / 3); // time back at 100% between zooms

  // Proposed spans.
  const proposals = zoomMoments(plan, transcript, opts.every)
    .filter((m) => m.time < total - minHold)
    .map((m) => {
      let end: number;
      if (m.kind === "jumpcut" && m.segment !== undefined) {
        // Hold until a later cut (hard out, also masked) within [minHold, maxHold], else to maxHold / the segment end.
        const later = segs.slice(m.segment + 1).map((s) => s.start).find((t) => t - m.time >= minHold && t - m.time <= maxHold);
        end = later ?? Math.min(segs[m.segment].end, m.time + maxHold);
        if (end - m.time < minHold) end = Math.min(total, m.time + minHold);
      } else {
        end = Math.min(m.end ?? m.time + maxHold * 0.6, m.time + maxHold);
        end = Math.max(end, m.time + minHold + 2 * ease);
      }
      return { m, start: m.time, end: Math.min(end, total) };
    })
    .filter((p) => p.end - p.start >= minHold - 1e-6)
    .sort((a, b) => b.m.weight - a.m.weight || a.start - b.start);

  const budget = Math.max(1, Math.floor(total / spacing + 0.5));
  const chosen: typeof proposals = [];
  for (const p of proposals) {
    if (chosen.length >= budget) break;
    const ps = segmentAt(segs, p.start);
    const pe = segmentAt(segs, Math.max(p.start, p.end - 0.01));
    const ok = chosen.every((c) => {
      if (Math.abs(c.start - p.start) < spacing) return false;
      if (p.start < c.end + rest && c.start < p.end + rest) return false; // overlap or back-to-back
      const cs = segmentAt(segs, c.start);
      const ce = segmentAt(segs, Math.max(c.start, c.end - 0.01));
      // Never on adjacent segments: there must be at least one full segment at 100% between them.
      return ps > ce + 1 || cs > pe + 1;
    });
    if (ok) chosen.push(p);
  }
  chosen.sort((a, b) => a.start - b.start);
  return chosen.map(({ m, start, end }) => {
    const hard = m.kind === "jumpcut" || m.kind === "periodic";
    return {
      start: r2(start),
      end: r2(end),
      scale: m.kind === "emphasis" && m.weight >= 2.2 ? high : m.kind === "emphasis" ? Math.round((low + high) / 2) : low,
      ease: hard ? 0 : ease,
      kind: m.kind,
      ...(m.text ? { text: m.text } : {}),
    };
  });
}

/**
 * Warnings for zooms that would soften the picture: the effective upscale of
 * source pixels is scale × (output height / source pixels shown).
 */
export function zoomWarnings(zooms: { scale: number; start: number; end: number }[], o: { sourceHeight?: number; outputHeight?: number; sourceWidth?: number; outputWidth?: number }): string[] {
  const out: string[] = [];
  if (!zooms.length) return out;
  const maxScale = Math.max(...zooms.map((z) => z.scale));
  const srcH = o.sourceHeight ?? 1080;
  const outH = o.outputHeight ?? srcH;
  const up = (maxScale / 100) * (outH / srcH);
  if (up > 1.12 + 1e-9) {
    out.push(
      `zoom ${maxScale}% upscales the ${srcH}p source ${up.toFixed(2)}× in a ${outH}p output: the punch-in will look soft. Use <= ${Math.max(101, Math.floor((112 * srcH) / outH))}% or a higher-resolution source.`,
    );
  }
  for (let i = 1; i < zooms.length; i++) {
    if (zooms[i].start - zooms[i - 1].end < 1) out.push(`zooms at ${zooms[i - 1].start}s and ${zooms[i].start}s are back-to-back`);
  }
  return out;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
