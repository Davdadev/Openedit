/**
 * Cutting to music: fit a song to a length on its bar lines, snap an edit's cuts to the beat
 * without cutting into words, and plan a montage cut to the music.
 *
 * Editorial rules encoded here (see skills/openedit-rhythm):
 *  - music is edited on bar lines, ideally whole phrases (4/8 bars) apart, with a very short
 *    equal-power crossfade placed just before the downbeat so the new bar's attack is clean;
 *  - a song should END on its own ending (the final downbeat and its ring-out), not on a
 *    random fade: when the target is shorter, the cut is made in the middle;
 *  - dialogue cuts move only inside pauses and only by small amounts; never into a word;
 *  - montage cuts follow the chosen grid (beat / 2 beats / bar / phrase), always hit section
 *    changes and drops, loosen in quiet sections, never go under ~0.45 s, and the last shot
 *    holds through the musical resolution.
 * Pure except renderFittedMusic / saveMontage / loadMontage.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CutPlan, Transcript, Word } from "../hosts/types.js";
import type { BeatAnalysis, MusicSection } from "./beats.js";
import { nearest } from "./beats.js";
import { run } from "./exec.js";
import { paths } from "./paths.js";
import { editSegments } from "./remap.js";
import { spokenEnd } from "./vad.js";

// ---------------------------------------------------------------- fit_music

export interface MusicSegment {
  /** Source seconds in the music file. */
  in: number;
  out: number;
}

export interface MusicFit {
  source: string;
  /** Requested length (s); the rendered file is exactly this long. */
  target: number;
  /** Source ranges played in order, joined by `crossfade`-second equal-power crossfades. */
  segments: MusicSegment[];
  crossfade: number;
  /** Output length of the joined segments before trimming / padding. */
  joinedLength: number;
  /** Fade-out at the end (s), only when the ring-out had to be shortened. */
  fadeOut: number;
  /** Silence added after the natural ending (s). */
  padEnd: number;
  /** Music edits in output time: where the cut is heard, and the source jump. */
  edits: { at: number; from: number; to: number; bars: number }[];
  /** Beats / downbeats / section starts mapped to output time. */
  beats: number[];
  downbeats: number[];
  sections: (MusicSection & { outStart: number; outEnd: number })[];
  /** Output time of the final downbeat (the resolution). */
  endsOn: number;
  /** Human notes about the choice. */
  notes: string[];
}

/** Crossfade length and how far before the downbeat it is centred (s). */
export const MUSIC_XFADE = 0.03;
export const MUSIC_PREROLL = 0.02;

/** Map source time -> output time through fit segments (first segment that contains it). */
export function fitMapTime(segments: MusicSegment[], crossfade: number, s: number): number | null {
  let o = 0;
  for (let k = 0; k < segments.length; k++) {
    const g = segments[k];
    if (s >= g.in - 1e-6 && s <= g.out + 1e-6) return o + (s - g.in);
    o += g.out - g.in - (k < segments.length - 1 ? crossfade : 0);
  }
  return null;
}

function joinedLength(segments: MusicSegment[], crossfade: number): number {
  return segments.reduce((a, g) => a + g.out - g.in, 0) - crossfade * Math.max(0, segments.length - 1);
}

/** Segments for "play [0, x) then jump to y" with the crossfade centred PREROLL before the downbeats. */
function cutSegments(parts: { from: number; to: number }[], end: number): MusicSegment[] {
  // parts: list of (play-from, jump-at) pairs; consecutive jumps.
  const h = MUSIC_XFADE / 2;
  const segs: MusicSegment[] = [];
  let start = parts[0].from;
  for (let k = 1; k < parts.length; k++) {
    const x = parts[k - 1].to; // downbeat where we leave
    const y = parts[k].from; // downbeat where we land
    segs.push({ in: Math.max(0, start), out: x - MUSIC_PREROLL + h });
    start = y - MUSIC_PREROLL - h;
  }
  segs.push({ in: Math.max(0, start), out: end });
  return segs;
}

/**
 * Edit a song to `target` seconds on its bar lines so it ends on its own ending.
 *  - Longer song: remove whole bars from the middle ([0, x) + [y, end)), preferring a jump that is
 *    a multiple of 4 bars, lands on the phrase grid or a section boundary, and keeps the intro.
 *  - Shorter song: repeat whole phrases (jump back), up to 4 times.
 * The remainder under one bar is absorbed by shortening the ring-out (with a short fade) or by
 * padding silence after it. Pure.
 */
export function fitMusic(a: BeatAnalysis, target: number, opts: { fps?: number; energyWeight?: number } = {}): MusicFit {
  const fps = opts.fps ?? 30;
  // Montages prefer the song's energetic material (energyWeight ~2); beds under speech do not care.
  const energyWeight = opts.energyWeight ?? 0;
  const keptEnergy = (ranges: { from: number; to: number }[]) => {
    let e = 0;
    let len = 0;
    for (const r of ranges)
      for (const sct of a.sections) {
        const o = Math.min(r.to, sct.end) - Math.max(r.from, sct.start);
        if (o > 0) {
          e += o * sct.energy;
          len += o;
        }
      }
    return len ? e / len : 0;
  };
  const notes: string[] = [];
  const downs = a.downbeats;
  const end = Math.min(a.duration, Math.max(a.ending.tailEnd, a.ending.finalDownbeat + 0.5));
  const finalDown = a.ending.finalDownbeat;
  // How much of the ring-out we may shorten (keep at least ~1 beat after the final hit).
  const beatLen = 60 / Math.max(30, a.tempo || 120);
  const tailSlack = Math.max(0, end - finalDown - Math.max(beatLen, 0.6));
  const firstDown = downs[0] ?? 0;
  const phraseIdx = (t: number) => downs.findIndex((d) => Math.abs(d - t) < 1e-3);
  const sectionStarts = new Set(a.sections.map((s) => Math.round(s.start * 1000)));
  const atSection = (t: number) => [...sectionStarts].some((s) => Math.abs(s / 1000 - t) < 0.15);

  let best: { parts: { from: number; to: number }[]; score: number; len: number; bars: number } | null = null;
  const consider = (parts: { from: number; to: number }[], len: number, bars: number, bonus: number) => {
    // Too long beyond what the tail can absorb is not allowed; shorter is padded (costs a bit more).
    const over = len - target;
    if (over > tailSlack + 1e-6) return;
    const err = over >= 0 ? over * 0.6 : -over * 1.0;
    const score = err - bonus - (energyWeight ? energyWeight * keptEnergy(parts) : 0);
    if (!best || score < best.score) best = { parts, score, len, bars };
  };

  if (end <= target + 1e-6) {
    consider([{ from: 0, to: end }], end, 0, 0.5); // as is
    // Extend by repeating whole phrases (jump back from x to an earlier y).
    if (downs.length >= 8 && target - end > 1) {
      for (let i = 4; i < downs.length; i++) {
        for (let j = 0; j < i; j++) {
          const x = downs[i];
          const y = downs[j];
          if (x >= finalDown - 1e-3) continue;
          const bars = i - j;
          const reps = Math.max(1, Math.min(4, Math.floor((target - end) / (x - y) + 0.5)));
          const len = end + reps * (x - y);
          const phrase = (bars % 4 === 0 ? 2.5 : bars % 2 === 0 ? -1.5 : -3) - 0.5 * (reps - 1);
          const grid = (j - phraseIdx(firstDown)) % 4 === 0 ? 0.5 : 0;
          const sec = atSection(y) || atSection(x) ? 0.75 : 0;
          // Jumping back into a quiet intro mid-song sounds like a restart.
          const introLand = a.sections.find((sct) => y >= sct.start - 1e-3 && y < sct.end)?.kind === "intro" ? -1.5 : 0;
          const parts: { from: number; to: number }[] = [{ from: 0, to: x }];
          for (let r = 0; r < reps; r++) parts.push({ from: y, to: r === reps - 1 ? end : x });
          consider(parts, len, -bars * reps, phrase + grid + sec + introLand);
        }
      }
    }
  } else {
    // Remove [x, y): x, y downbeats (x may be 0 = start the song at y).
    const xs = [0, ...downs];
    for (let i = 0; i < xs.length; i++) {
      for (let j = 0; j < downs.length; j++) {
        const x = xs[i];
        const y = downs[j];
        if (y <= x + 1e-3 || y > finalDown + 1e-3) continue;
        // Leaving within the first two bars is the same as starting the song at y.
        if (i > 0 && i - 1 < 2) continue;
        const len = x + (end - y);
        if (Math.abs(len - target) > Math.max(8, target)) continue;
        const bars = i === 0 ? j : j - (i - 1);
        const phrase = i === 0 ? 0.25 : bars % 8 === 0 ? 2.75 : bars % 4 === 0 ? 2.5 : bars % 2 === 0 ? 0 : -2;
        const grid = i > 0 && (i - 1 - phraseIdx(firstDown)) % 4 === 0 ? 0.5 : 0;
        const sec = (x > 0 && atSection(x)) || atSection(y) ? 0.75 : 0;
        // Keep the intro: starting late sounds like a cold open (fine for short targets only).
        const intro = i === 0 ? (target < 20 ? 0 : -1.5) : 1;
        consider(i === 0 ? [{ from: y, to: end }] : [{ from: 0, to: x }, { from: y, to: end }], len, bars, phrase + grid + sec + intro);
      }
    }
    if (!best) {
      // Nothing short enough with a natural ending: end on the downbeat closest to target with a button fade.
      const x = [...downs].reverse().find((d) => d <= target - beatLen) ?? target;
      best = { parts: [{ from: 0, to: Math.min(a.duration, x + beatLen) }], score: 99, len: Math.min(a.duration, x + beatLen), bars: 0 };
      notes.push("no bar-line edit keeps the song's own ending at this length: ends on a downbeat with a one-beat fade (a 'button')");
    }
  }
  const chosen = best as unknown as { parts: { from: number; to: number }[]; len: number; bars: number };
  const segments = chosen.parts.length === 1 ? [{ in: chosen.parts[0].from, out: chosen.parts[0].to }] : cutSegments(chosen.parts, end);
  // Exact joined length (the crossfade geometry keeps each landing downbeat where the left one was).
  const joined = joinedLength(segments, MUSIC_XFADE);
  let fadeOut = 0;
  let padEnd = 0;
  if (joined > target) {
    const cutTail = joined - target;
    fadeOut = Math.min(2, Math.max(0.3, cutTail * 1.5));
    notes.push(`ring-out shortened by ${cutTail.toFixed(2)}s with a ${fadeOut.toFixed(2)}s fade`);
  } else if (joined < target) {
    padEnd = target - joined;
    if (padEnd > 1 / fps) notes.push(`song ends naturally ${padEnd.toFixed(2)}s before the target; silence after the ring-out (hold the last shot or end card)`);
  }
  const edits = segments.slice(1).map((g, k) => {
    const at = segments.slice(0, k + 1).reduce((acc, s) => acc + s.out - s.in, 0) - MUSIC_XFADE * (k + 1) + MUSIC_XFADE / 2 + MUSIC_PREROLL;
    return { at: r3(at), from: r3(segments[k].out - MUSIC_XFADE / 2 + MUSIC_PREROLL), to: r3(g.in + MUSIC_XFADE / 2 + MUSIC_PREROLL), bars: 0 };
  });
  for (const e of edits) {
    const i = downs.findIndex((d) => Math.abs(d - e.from) < 0.01);
    const j = downs.findIndex((d) => Math.abs(d - e.to) < 0.01);
    e.bars = i >= 0 && j >= 0 ? j - i : 0;
  }
  if (edits.length) notes.push(`${edits.length} bar-line edit${edits.length > 1 ? "s" : ""}: ${edits.map((e) => `${e.bars > 0 ? `skips ${e.bars}` : `repeats ${-e.bars}`} bars at ${e.at.toFixed(2)}s`).join(", ")}`);
  const mapped = (ts: number[]) => {
    const out: number[] = [];
    let o = 0;
    segments.forEach((g, k) => {
      for (const t of ts) if (t >= g.in - 1e-6 && t <= g.out + 1e-6) out.push(o + (t - g.in));
      o += g.out - g.in - (k < segments.length - 1 ? MUSIC_XFADE : 0);
    });
    const sorted = out.filter((t) => t <= target + 1e-6).sort((x, y) => x - y);
    return sorted.filter((t, i) => i === 0 || t - sorted[i - 1] > 0.06).map(r3);
  };
  const sections: MusicFit["sections"] = [];
  {
    let o = 0;
    segments.forEach((g, k) => {
      for (const s of a.sections) {
        const s0 = Math.max(s.start, g.in);
        const s1 = Math.min(s.end, g.out);
        if (s1 - s0 > 0.5) sections.push({ ...s, outStart: r3(o + s0 - g.in), outEnd: r3(Math.min(target, o + s1 - g.in)) });
      }
      o += g.out - g.in - (k < segments.length - 1 ? MUSIC_XFADE : 0);
    });
  }
  const endsOn = mapped([finalDown]).at(-1) ?? Math.max(0, target - beatLen);
  return {
    source: a.path,
    target: r3(target),
    segments: segments.map((g) => ({ in: r3(g.in), out: r3(g.out) })),
    crossfade: MUSIC_XFADE,
    joinedLength: r3(joined),
    fadeOut: r3(fadeOut),
    padEnd: r3(padEnd),
    edits,
    beats: mapped(a.beats),
    downbeats: mapped(a.downbeats),
    sections: sections.filter((s) => s.outStart < target),
    endsOn: r3(endsOn),
    notes,
  };
}

/** ffmpeg filter for a fit: segments, crossfades, fade, pad and exact length, from input `inLabel`. */
export function fitFilter(fit: MusicFit, inLabel = "0:a:0", outLabel = "music"): string {
  const lines: string[] = [];
  const n = fit.segments.length;
  fit.segments.forEach((g, k) => {
    lines.push(`[${inLabel}]atrim=start=${n6(g.in)}:end=${n6(g.out)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[mseg${k}]`);
  });
  let acc = "mseg0";
  for (let k = 1; k < n; k++) {
    lines.push(`[${acc}][mseg${k}]acrossfade=d=${n6(fit.crossfade)}:c1=qsin:c2=qsin[mx${k}]`);
    acc = `mx${k}`;
  }
  const post: string[] = [];
  if (fit.fadeOut > 0) post.push(`afade=t=out:st=${n6(Math.max(0, fit.target - fit.fadeOut))}:d=${n6(fit.fadeOut)}`);
  post.push("apad", `atrim=duration=${n6(fit.target)}`, "asetpts=PTS-STARTPTS");
  lines.push(`[${acc}]${post.join(",")}[${outLabel}]`);
  return lines.join(";\n");
}

/** Render the fitted music to a file (wav / m4a by extension), exactly `target` seconds long. */
export async function renderFittedMusic(fit: MusicFit, output: string): Promise<string> {
  const out = resolve(output);
  mkdirSync(dirname(out), { recursive: true });
  const codec = /\.wav$/i.test(out) ? ["-c:a", "pcm_s16le"] : /\.(m4a|mp4|aac)$/i.test(out) ? ["-c:a", "aac", "-b:a", "256k"] : [];
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", fit.source, "-filter_complex", fitFilter(fit), "-map", "[music]", ...codec, out], {
    timeoutMs: 10 * 60_000,
  });
  return out;
}

// ---------------------------------------------------------------- snap_to_beats (dialogue plans)

export interface SnapReport {
  joins: number;
  moved: { index: number; from: number; to: number; shift: number; how: string }[];
  skipped: { index: number; reason: string }[];
  /** Share of joins within `tolerance` of a beat, before and after. */
  alignedBefore: number;
  alignedAfter: number;
  /** Music offset applied when slideMusic was on (s, added to musicAt). */
  musicShift: number;
}

/** Joins (edit times) of a plan. */
export function planJoins(plan: Pick<CutPlan, "keep"> & Partial<Pick<CutPlan, "ramps" | "freezes">>): number[] {
  return editSegments(plan).slice(1).map((s) => s.start);
}

/** Share of `times` within `tol` of a grid time. */
export function alignment(times: number[], grid: number[], tol = 0.04): number {
  if (!times.length) return 1;
  const hit = times.filter((t) => {
    const n = nearest(grid, t);
    return n !== undefined && Math.abs(n - t) <= tol + 1e-9;
  }).length;
  return hit / times.length;
}

/** The music offset (within one beat) that puts the most joins near a beat. Pure. */
export function bestMusicShift(joins: number[], beats: number[], tol = 0.04, period = 0.5): number {
  let best = 0;
  let bestN = -1;
  let bestErr = Infinity;
  for (let s = -period / 2; s <= period / 2 + 1e-9; s += 0.005) {
    const shifted = beats.map((b) => b + s);
    let n = 0;
    let err = 0;
    for (const j of joins) {
      const d = Math.abs((nearest(shifted, j) ?? Infinity) - j);
      if (d <= tol) n++;
      err += Math.min(d, period / 2);
    }
    if (n > bestN || (n === bestN && err < bestErr)) [best, bestN, bestErr] = [s, n, err];
  }
  return r3(best);
}

/**
 * Move a dialogue edit's cuts onto beats (edit-time `beats`) only where it is safe: each join may
 * move by at most `maxShift` (default 0.15 s), only inside the pause around it, never into a word:
 * the outgoing tail keeps >= 0.1 s after its last word, the incoming head >= 0.07 s before its
 * first word, and no removed word comes back. Later joins move with it (the edit gets longer /
 * shorter by the shifts). Without a transcript joins move by at most 0.06 s. Pure.
 */
export function snapPlanToBeats(
  plan: CutPlan,
  beats: number[],
  opts: { transcript?: Transcript; tolerance?: number; maxShift?: number; fps?: number } = {},
): { plan: CutPlan; report: SnapReport } {
  const fps = opts.fps ?? 30;
  const tol = opts.tolerance ?? Math.max(0.04, 1 / fps);
  const words: Word[] = (opts.transcript?.segments.flatMap((s) => s.words) ?? []).filter((w) => w.end - w.start > 0.015 && w.text.trim());
  const maxShift = words.length ? (opts.maxShift ?? 0.15) : Math.min(opts.maxShift ?? 0.06, 0.06);
  const keep = plan.keep.map((k) => ({ ...k }));
  const before = alignment(planJoins(plan), beats, tol);
  const moved: SnapReport["moved"] = [];
  const skipped: SnapReport["skipped"] = [];
  const free = (a: number, b: number) => !words.some((w) => w.start < b - 1e-6 && spokenEnd(w) > a + 1e-6);
  for (let j = 0; j < keep.length - 1; j++) {
    const at = planJoins({ ...plan, keep })[j];
    const b = nearest(beats, at);
    if (b === undefined) break;
    const d = b - at;
    if (Math.abs(d) <= 0.5 / fps) continue;
    if (Math.abs(d) > maxShift + 1e-6) {
      skipped.push({ index: j, reason: `nearest beat ${(d * 1000).toFixed(0)} ms away (max ${Math.round(maxShift * 1000)} ms)` });
      continue;
    }
    const A = keep[j];
    const B = keep[j + 1];
    const lastA = [...words].reverse().find((w) => w.start < A.end && w.start >= A.start - 1e-3);
    const firstB = words.find((w) => spokenEnd(w) > B.start && w.start <= B.end);
    const sentenceEnd = lastA ? /[.!?…]["')\]]*$/.test(lastA.text.trim()) : false;
    const tries: { how: string; ok: boolean; apply: () => void }[] = [];
    if (d > 0) {
      // Later: lengthen the pause (more of A's tail, or more of B's run-up).
      const tail = { how: "longer tail", ok: A.end + d <= B.start + 1e-6 && free(A.end, A.end + d), apply: () => (A.end += d) };
      const head = { how: "earlier head", ok: B.start - d >= A.end - 1e-6 && free(B.start - d, B.start), apply: () => (B.start -= d) };
      tries.push(...(sentenceEnd ? [tail, head] : [head, tail]));
    } else {
      const e = -d;
      const tail = { how: "shorter tail", ok: A.end - e - A.start >= 0.3 && (!lastA || A.end - e >= spokenEnd(lastA) + 0.1), apply: () => (A.end -= e) };
      const head = { how: "later head", ok: B.end - (B.start + e) >= 0.3 && (!firstB || B.start + e <= firstB.start - 0.07), apply: () => (B.start += e) };
      tries.push(...(sentenceEnd ? [head, tail] : [tail, head]));
    }
    const pick = tries.find((t) => t.ok);
    if (!pick) {
      skipped.push({ index: j, reason: `moving ${(d * 1000).toFixed(0)} ms would cut into a word or reach removed speech` });
      continue;
    }
    pick.apply();
    moved.push({ index: j, from: r3(at), to: r3(b), shift: r3(d), how: pick.how });
  }
  const out: CutPlan = { ...plan, keep: keep.map((k) => ({ start: r3(k.start), end: r3(k.end) })) };
  return { plan: out, report: { joins: plan.keep.length - 1, moved, skipped, alignedBefore: before, alignedAfter: alignment(planJoins(out), beats, tol), musicShift: 0 } };
}

// ---------------------------------------------------------------- montage

export type MontageStyle = "on-beat" | "every-2-beats" | "downbeats" | "phrase";
export const MONTAGE_STYLES: MontageStyle[] = ["on-beat", "every-2-beats", "downbeats", "phrase"];

export interface MontageClipInput {
  path: string;
  /** Usable source range (default the whole clip). */
  in?: number;
  out?: number;
  /** Probed duration of the file. */
  duration: number;
}

export interface MontageShot {
  path: string;
  /** Source in/out. */
  in: number;
  out: number;
  /** Edit time. */
  at: number;
  duration: number;
  /** Why this window: "interest" (analysis) or "middle". */
  pick: string;
}

export interface Montage {
  id?: string;
  style: MontageStyle;
  duration: number;
  fps: number;
  music: MusicFit;
  shots: MontageShot[];
  /** Cut times (edit seconds). */
  cuts: number[];
  notes: string[];
}

/** Interest of a clip window, 0..1 (from the shot analysis when available). */
export type InterestFn = (path: string, start: number, end: number) => number | undefined;

/** Cut intervals in beats: beat, 2 beats, bar, 2 bars, phrase (4 bars). */
const LEVEL_BEATS = (meter: number) => [1, 2, meter, 2 * meter, 4 * meter];
const STYLE_LEVEL: Record<MontageStyle, number> = { "on-beat": 0, "every-2-beats": 1, downbeats: 2, phrase: 4 };

/**
 * Cut grid for a style over a fitted song (output times). Adaptive (default): one level finer in
 * drops / the most energetic sections, one level coarser where the music is quiet (energy < 0.3),
 * so the cutting breathes with the song. Cuts always land on section changes, music edits and the
 * final resolution; never closer than `minShot`; the last shot holds >= `endHold`. Pure.
 */
export function montageGrid(fit: MusicFit, style: MontageStyle, opts: { adaptive?: boolean; minShot?: number; endHold?: number; meter?: number } = {}): number[] {
  const meter = opts.meter ?? 4;
  const minShot = opts.minShot ?? 0.45;
  const endHold = opts.endHold ?? 1.5;
  const T = fit.target;
  const beats = fit.beats;
  const downs = fit.downbeats;
  const levels = LEVEL_BEATS(meter);
  // Beat index relative to the bar grid: beats counted from the nearest preceding downbeat's index.
  const beatIdx = new Map<number, number>();
  {
    let bar = -1;
    let k = 0;
    for (const b of beats) {
      if (downs.some((d) => Math.abs(d - b) < 0.02)) {
        bar++;
        k = 0;
      }
      beatIdx.set(b, bar < 0 ? -1 : bar * meter + k);
      k++;
    }
  }
  const base = STYLE_LEVEL[style];
  const sectionAt = (t: number) => fit.sections.find((s) => t >= s.outStart - 1e-6 && t < s.outEnd);
  const cuts = new Set<number>();
  for (const b of beats) {
    if (b <= minShot || b >= T - endHold) continue;
    let level = base;
    if (opts.adaptive !== false) {
      const s = sectionAt(b);
      if (s && (s.kind === "drop" || s.energy >= 0.85)) level = Math.max(0, level - 1);
      else if (s && s.energy < 0.3) level = Math.min(Math.max(base, 3), level + 1);
    }
    const idx = beatIdx.get(b) ?? -1;
    if (idx >= 0 && idx % levels[level] === 0) cuts.add(b);
  }
  // Always cut on section changes / drops (landing a new section on a new shot).
  for (const s of fit.sections) {
    const t = nearest(downs, s.outStart);
    if (t !== undefined && t > minShot && t < T - endHold && Math.abs(t - s.outStart) < 0.3) cuts.add(t);
  }
  // Music edits are cut points too (a picture cut hides the music edit).
  for (const e of fit.edits) {
    const t = nearest(downs, e.at);
    if (t !== undefined && t > minShot && t < T - endHold) cuts.add(t);
  }
  // Last shot starts on the final resolution when it is far enough from the end.
  if (fit.endsOn > minShot && fit.endsOn < T - 0.8) cuts.add(fit.endsOn);
  const sorted = [...cuts].sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of sorted) if (t - (out.at(-1) ?? 0) >= minShot && T - t >= Math.min(endHold, 0.8)) out.push(t);
  return out.map(r3);
}

/**
 * Plan a montage: cut grid from the style, shots assigned to slots in the order given (cycling,
 * each reuse of a clip takes a different window), windows chosen by interest when the shot
 * analysis can score them, else around the middle of the clip. Cut times are frame-quantised.
 */
export function planMontage(
  clips: MontageClipInput[],
  fit: MusicFit,
  style: MontageStyle,
  opts: { fps?: number; adaptive?: boolean; interest?: InterestFn; meter?: number } = {},
): Montage {
  if (!clips.length) throw new Error("build_montage needs at least one clip");
  const fps = opts.fps ?? 30;
  const notes: string[] = [];
  const q = (t: number) => Math.round(t * fps) / fps;
  const grid = montageGrid(fit, style, { adaptive: opts.adaptive, meter: opts.meter }).map(q);
  const T = q(fit.target);
  let edges = [0, ...grid.filter((t) => t > 0 && t < T), T];
  // Repeating a shot in one montage reads as padding. With fewer clips than slots, hold shots
  // longer (drop every other cut, keeping the downbeat grid) before falling back to reuse.
  const before = edges.length - 1;
  // Stop before shots get so long the montage loses its pulse (average over ~4 s).
  // Never hold shots longer than most clips can fill, or the montage freezes frames instead.
  const spans = clips.map((c) => (c.out ?? c.duration) - (c.in ?? 0)).sort((a, b) => a - b);
  const typicalSpan = spans[Math.floor(spans.length / 2)];
  while (edges.length - 1 > clips.length && edges.length > 3) {
    const coarser = edges.filter((_, i) => i === 0 || i === edges.length - 1 || i % 2 === 0);
    // The last shot is allowed to ring out over the ending, so it is not counted.
    const longest = Math.max(...coarser.slice(1, -1).map((t, i) => t - coarser[i]));
    if (T / (coarser.length - 1) > 4 || longest > typicalSpan + 1e-6) break;
    edges = coarser;
  }
  if (edges.length - 1 < before) {
    notes.push(`only ${clips.length} clips for ${before} slots: held shots for longer (${edges.length - 1} shots) rather than repeat footage; add clips for a faster cut`);
  }
  if (edges.length - 1 > clips.length) {
    notes.push(`${edges.length - 1} shots from ${clips.length} clips: some clips repeat (different windows); add clips to avoid it`);
  }
  const used = new Map<string, { start: number; end: number }[]>();
  const shots: MontageShot[] = [];
  let cursor = 0;
  for (let k = 0; k < edges.length - 1; k++) {
    const len = edges[k + 1] - edges[k];
    // Next clip in order that can fill the slot; prefer one not just used.
    let chosen: MontageClipInput | undefined;
    for (let tries = 0; tries < clips.length; tries++) {
      const c = clips[(cursor + tries) % clips.length];
      const span = (c.out ?? c.duration) - (c.in ?? 0);
      if (span >= len - 1e-6) {
        chosen = c;
        cursor = (cursor + tries + 1) % clips.length;
        break;
      }
    }
    if (!chosen) {
      // No clip is long enough: keep rotating (never one clip in every slot), and pick the
      // longest of the next few so as little as possible is held.
      const span = (c: MontageClipInput) => (c.out ?? c.duration) - (c.in ?? 0);
      const ring = clips.map((_, i) => clips[(cursor + i) % clips.length]);
      const prev = shots.at(-1)?.path;
      const pool = ring.filter((c) => c.path !== prev || clips.length === 1);
      chosen = pool.slice(0, Math.max(1, Math.ceil(clips.length / 3))).sort((x, y) => span(y) - span(x))[0];
      cursor = (clips.indexOf(chosen) + 1) % clips.length;
      notes.push(`slot ${k} (${len.toFixed(2)}s) is longer than every clip window; the last ${(len - span(chosen)).toFixed(2)}s of ${chosen.path.split("/").pop()} is held — give longer in/out windows or use a faster style`);
    }
    const lo = chosen.in ?? 0;
    const hi = chosen.out ?? chosen.duration;
    const prior = used.get(chosen.path) ?? [];
    const overlaps = (s: number) => prior.reduce((acc, r) => acc + Math.max(0, Math.min(r.end, s + len) - Math.max(r.start, s)), 0);
    // Candidate windows every 0.25 s: score interest, minus reuse overlap, minus distance from the middle.
    let start = Math.max(lo, (lo + hi) / 2 - len / 2);
    let pick = "middle";
    const cands: number[] = [];
    for (let s = lo; s + len <= hi + 1e-6; s += 0.25) cands.push(s);
    if (!cands.length) cands.push(lo);
    let bestScore = -Infinity;
    for (const s of cands) {
      const interest = opts.interest?.(chosen.path, s, s + len);
      const mid = 1 - Math.abs(s + len / 2 - (lo + hi) / 2) / Math.max(1, (hi - lo) / 2);
      const score = (interest ?? 0) * 2 + mid * 0.3 - (overlaps(s) / len) * 3;
      if (score > bestScore) {
        bestScore = score;
        start = s;
        pick = interest !== undefined ? "interest" : prior.length ? "unused part" : "middle";
      }
    }
    prior.push({ start, end: start + len });
    used.set(chosen.path, prior);
    shots.push({ path: chosen.path, in: r3(start), out: r3(Math.min(hi, start + len)), at: r3(edges[k]), duration: r3(len), pick });
  }
  const minLen = Math.min(...shots.map((s) => s.duration));
  notes.push(`${shots.length} shots, ${grid.length} cuts on the ${style} grid (shortest shot ${minLen.toFixed(2)}s), ends on the downbeat at ${fit.endsOn.toFixed(2)}s`);
  return { style, duration: T, fps, music: fit, shots, cuts: edges.slice(1, -1).map(r3), notes };
}

export function montageDir(): string {
  const d = join(paths.plans(), "montages");
  mkdirSync(d, { recursive: true });
  return d;
}

export function saveMontage(m: Montage): Montage {
  const id = `montage-${randomBytes(3).toString("hex")}`;
  const stored = { ...m, id };
  writeFileSync(join(montageDir(), `${id}.json`), JSON.stringify(stored, null, 1));
  return stored;
}

export function loadMontage(id: string): Montage {
  if (!/^montage-[a-f0-9]+$/.test(id)) throw new Error(`Invalid montage id "${id}"`);
  const p = join(montageDir(), `${id}.json`);
  if (!existsSync(p)) throw new Error(`No montage with id "${id}"`);
  return JSON.parse(readFileSync(p, "utf8")) as Montage;
}

const n6 = (n: number) => String(Math.round(n * 1e6) / 1e6);
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Window interest from the shot analysis (if that module is available): motion, sharpness and
 * exposure of the shots under a window, and a strong penalty for windows that straddle a cut
 * inside the source clip. Returns no function when the analysis cannot be loaded.
 */
export async function shotInterest(files: string[]): Promise<{ fn?: InterestFn; note: string }> {
  type ShotLike = { start: number; end: number; motion?: number; sharpness?: number; shake?: number; exposure?: string };
  type Mod = { analyzeFile?: (p: string, o?: { noVision?: boolean }) => Promise<{ shots: ShotLike[] }> };
  let mod: Mod | undefined;
  for (const spec of ["./analysis/index.js", "./analysis/analyze.js"]) {
    try {
      const m = (await import(spec)) as Mod;
      if (typeof m.analyzeFile === "function") {
        mod = m;
        break;
      }
    } catch {
      /* not available */
    }
  }
  if (!mod?.analyzeFile) return { note: "shot analysis not available: windows taken from the middle of each clip" };
  const shots = new Map<string, ShotLike[]>();
  for (const f of [...new Set(files.map((x) => resolve(x)))]) {
    try {
      shots.set(f, (await mod.analyzeFile(f, { noVision: true })).shots);
    } catch {
      /* unreadable: middle-of-clip */
    }
  }
  if (!shots.size) return { note: "shot analysis failed: windows taken from the middle of each clip" };
  const fn: InterestFn = (path, s, e) => {
    const list = shots.get(resolve(path));
    if (!list?.length) return undefined;
    const over = list.filter((x) => Math.min(x.end, e) - Math.max(x.start, s) > 0.08);
    if (over.length > 1) return -2; // a cut inside the source clip would flash inside our shot
    const x = over[0];
    if (!x) return undefined;
    const motion = Math.min(1, (x.motion ?? 0) * 8);
    const sharp = x.sharpness !== undefined ? Math.min(1, x.sharpness / 150) : 0.5;
    const expo = !x.exposure || x.exposure === "ok" ? 1 : 0;
    const shake = Math.min(1, (x.shake ?? 0) * 2);
    // Blank, blown-out, black or flash-frame shots are never montage material.
    const bright = (x as { brightness?: number }).brightness ?? 0.5;
    if (bright >= 0.93 || bright <= 0.06 || (x.sharpness !== undefined && x.sharpness < 4)) return -3;
    return 0.55 * motion + 0.25 * sharp + 0.2 * expo - 0.3 * shake;
  };
  return { fn, note: `windows chosen by motion / sharpness from the shot analysis (${shots.size} clips)` };
}
