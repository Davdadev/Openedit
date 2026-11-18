import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TimeRange, Transcript, Word } from "../hosts/types.js";
import { run } from "./exec.js";
import { fileKey, resolveMediaPath } from "./media.js";
import { paths } from "./paths.js";

/**
 * Speech-activity helpers. Two complementary signals:
 *  - an energy envelope of the voice band (120 Hz–4 kHz) with an ADAPTIVE
 *    threshold derived from the clip's own noise floor / speech level, so a
 *    music bed or room tone does not hide every pause;
 *  - the word timestamps of the whisper transcript as a speech map, which
 *    still works when music never lets the energy drop.
 * Everything except `analyzeEnergy` is pure and unit-tested.
 */

export interface EnergyEnvelope {
  /** Seconds per frame. */
  hop: number;
  /** Frame loudness in dBFS (voice band). */
  db: number[];
}

export interface AdaptiveLevels {
  /** Chosen silence threshold, dBFS. */
  thresholdDb: number;
  /** ~10th percentile frame level (noise floor / music bed). */
  floorDb: number;
  /** ~90th percentile frame level (speech). */
  speechDb: number;
}

export const ENERGY_HOP = 0.05;

/** Per-frame RMS level (dBFS) of mono float samples. */
export function frameDb(samples: Float32Array, sampleRate: number, hop = ENERGY_HOP): number[] {
  const n = Math.max(1, Math.round(sampleRate * hop));
  const out: number[] = [];
  for (let i = 0; i + n <= samples.length; i += n) {
    let s = 0;
    for (let k = i; k < i + n; k++) s += samples[k] * samples[k];
    out.push(10 * Math.log10(s / n + 1e-12));
  }
  return out;
}

/** 3-tap median filter: removes single-frame clicks and dropouts. */
export function smooth(db: number[]): number[] {
  return db.map((v, i) => {
    const a = db[i - 1] ?? v;
    const b = db[i + 1] ?? v;
    return Math.max(Math.min(a, b), Math.min(Math.max(a, b), v));
  });
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return -90;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
}

/** threshold = clamp(max(floor + 6, speech - 30), -60, -20). */
export function adaptiveLevels(db: number[]): AdaptiveLevels {
  const sorted = db.filter((v) => v > -120).sort((a, b) => a - b);
  const floorDb = percentile(sorted, 0.1);
  const speechDb = percentile(sorted, 0.9);
  const thresholdDb = Math.min(-20, Math.max(-60, Math.max(floorDb + 6, speechDb - 30)));
  return { thresholdDb: r1(thresholdDb), floorDb: r1(floorDb), speechDb: r1(speechDb) };
}

/** Runs of frames below `thresholdDb` lasting at least `minDuration` seconds. */
export function framesToSilences(env: EnergyEnvelope, thresholdDb: number, minDuration: number, duration: number): TimeRange[] {
  const db = smooth(env.db);
  const out: TimeRange[] = [];
  let open = -1;
  const close = (endIdx: number) => {
    const start = open * env.hop;
    const end = Math.min(duration, endIdx * env.hop);
    if (end - start >= minDuration - 1e-9) out.push({ start: r3(start), end: r3(end) });
    open = -1;
  };
  for (let i = 0; i < db.length; i++) {
    if (db[i] < thresholdDb) {
      if (open < 0) open = i;
    } else if (open >= 0) close(i);
  }
  if (open >= 0) close(Math.max(db.length, Math.ceil(duration / env.hop)));
  return out;
}

/**
 * How long a word is plausibly spoken. With DTW timings a word "ends" where
 * the next one starts, so a pause hides inside the previous word; cap it by
 * an estimate from its length (~65 ms per letter, 0.2–1.0 s).
 */
export function spokenEnd(w: Word): number {
  const t = w.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const letters = t.replace(/\p{N}/gu, "xx").length;
  const est = Math.min(1.0, Math.max(0.2, 0.1 + 0.065 * letters));
  return Math.max(w.start + 0.01, Math.min(w.end, w.start + est));
}

export interface PauseOptions {
  /** Shortest pause, seconds. Default 0.5. */
  minDuration?: number;
  /** Energy envelope used to confirm pauses (trim word tails, keep unrecognised speech). */
  energy?: EnergyEnvelope;
  levels?: AdaptiveLevels;
}

/**
 * Pauses = gaps between transcribed words (including before the first and
 * after the last). Robust under music. With an energy envelope, a gap's edges
 * are pulled in while the voice band is still loud (a word running past its
 * estimate) and loud runs >= 0.25 s inside a gap (speech whisper missed) are kept.
 */
export function transcriptPauses(t: Transcript, duration: number, opts: PauseOptions = {}): TimeRange[] {
  const minDuration = opts.minDuration ?? 0.5;
  const sorted = t.segments.flatMap((s) => s.words).sort((a, b) => a.start - b.start);
  const gaps: TimeRange[] = [];
  let pos = 0;
  for (const w of sorted) {
    if (w.start - pos >= minDuration) gaps.push({ start: pos, end: w.start });
    pos = Math.max(pos, spokenEnd(w));
  }
  if (duration - pos >= minDuration) gaps.push({ start: pos, end: duration });

  if (!opts.energy || !opts.energy.db.length) return gaps.map((g) => ({ start: r3(g.start), end: r3(g.end) }));
  const env = opts.energy;
  const db = smooth(env.db);
  const lv = opts.levels ?? adaptiveLevels(env.db);
  // "Loud" = clearly above the bed: halfway between floor and speech level.
  const gate = Math.max(lv.thresholdDb, (lv.floorDb + lv.speechDb) / 2);
  const loud = (i: number) => (db[i] ?? -120) > gate;
  const idx = (s: number) => Math.round(s / env.hop);
  const out: TimeRange[] = [];
  for (const g of gaps) {
    let a = idx(g.start);
    let b = idx(g.end);
    if (g.start > 0) while (a < b && loud(a)) a++; // word tail still sounding
    if (g.end < duration) while (b > a && loud(b - 1)) b--; // next word started early
    // Split around sustained loud runs (speech the transcript missed).
    let s = a;
    let i = a;
    while (i < b) {
      if (loud(i)) {
        let j = i;
        while (j < b && loud(j)) j++;
        if ((j - i) * env.hop >= 0.25) {
          if ((i - s) * env.hop >= minDuration) out.push({ start: s * env.hop, end: i * env.hop });
          s = j;
        }
        i = j;
      } else i++;
    }
    if ((b - s) * env.hop >= minDuration) out.push({ start: s * env.hop, end: b * env.hop });
  }
  return out.map((g) => ({ start: r3(Math.max(0, g.start)), end: r3(Math.min(duration, g.end)) })).filter((g) => g.end > g.start);
}

/** Union of possibly overlapping ranges, sorted. */
export function unionRanges(ranges: TimeRange[]): TimeRange[] {
  const out: TimeRange[] = [];
  for (const r of [...ranges].filter((x) => x.end > x.start).sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

const envCache = new Map<string, EnergyEnvelope>();

/**
 * Time of the quietest frame of `env` within [lo, hi] (seconds). Ties go to
 * the frame closest to `prefer`. Used to land cut edges in the trough between
 * syllables / breaths instead of on a word onset or decaying tail.
 */
export function quietestNear(env: EnergyEnvelope, prefer: number, lo: number, hi: number): number {
  if (!env.db.length || hi <= lo) return prefer;
  const a = Math.max(0, Math.ceil(lo / env.hop - 1e-9));
  const b = Math.min(env.db.length - 1, Math.floor(hi / env.hop + 1e-9));
  if (b < a) return prefer;
  let best = -1;
  let bestDb = Infinity;
  for (let i = a; i <= b; i++) {
    const d = env.db[i];
    // 0.5 dB hysteresis so noise does not drag the edge away from the preferred point.
    if (d < bestDb - 0.5 || (Math.abs(d - bestDb) <= 0.5 && Math.abs(i * env.hop - prefer) < Math.abs(best * env.hop - prefer))) {
      if (d < bestDb) bestDb = d;
      best = i;
    }
  }
  // Frame i covers [i*hop, (i+1)*hop): cut in its middle.
  return best < 0 ? prefer : Math.min(hi, Math.max(lo, r3(best * env.hop + env.hop / 2)));
}

/** Mean level (dBFS, energy average) of `env` over [a, b] seconds; -120 when empty. */
export function meanDb(env: EnergyEnvelope, a: number, b: number): number {
  const i0 = Math.max(0, Math.floor(a / env.hop));
  const i1 = Math.min(env.db.length, Math.ceil(b / env.hop));
  if (i1 <= i0) return -120;
  let s = 0;
  for (let i = i0; i < i1; i++) s += 10 ** (env.db[i] / 10);
  return r1(10 * Math.log10(s / (i1 - i0) + 1e-12));
}

/**
 * Decode the voice band of a file's audio and compute its energy envelope
 * (cached per file and hop). `hop` 0.01 gives the 10 ms resolution used to snap cut edges.
 */
export async function analyzeEnergy(path: string, hop = ENERGY_HOP): Promise<EnergyEnvelope> {
  const abs = resolveMediaPath(path);
  const key = `${await fileKey(abs)}-${hop}`;
  const hit = envCache.get(key);
  if (hit) return hit;
  const raw = join(paths.tmp(), `energy-${key}-${process.pid}-${Date.now()}.f32`);
  try {
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", abs,
      "-map", "0:a:0", "-ac", "1", "-ar", "16000",
      "-af", "highpass=f=120,lowpass=f=4000",
      "-f", "f32le", raw,
    ]);
    const buf = readFileSync(raw);
    const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
    const env = { hop, db: frameDb(samples, 16000, hop).map(r1) };
    envCache.set(key, env);
    return env;
  } finally {
    rmSync(raw, { force: true });
  }
}

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
