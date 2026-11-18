/**
 * Musical time for editing: tempo, beats, downbeats (bar lines), sections and energy.
 *
 * Pure TypeScript on typed arrays, no native deps:
 *  1. decode to mono 22.05 kHz PCM with ffmpeg;
 *  2. log-mel spectrogram (1024-point FFT, 256 hop ≈ 11.6 ms, 40 bands) and a spectral-flux
 *     onset envelope (half-wave-rectified band-wise log-energy rise), plus a low-band (kick/bass)
 *     flux used for bar accents;
 *  3. tempo from the autocorrelation of the onset envelope, weighted by a log-normal prior around
 *     120 BPM and enhanced with its 2x lag (Ellis 2007's TPS2), parabolic-interpolated;
 *  4. beats by dynamic programming (Ellis 2007, "Beat Tracking by Dynamic Programming"): maximise
 *     onset strength at beat times minus a log-squared penalty on deviations from the period,
 *     then each beat is refined to the sample-level transient it sits on;
 *  5. downbeats: the bar phase (meter 4 or 3) whose beats carry the most low-frequency accent and
 *     harmonic change (chords change on the "one");
 *  6. sections from a Foote checkerboard novelty curve over a bar-level self-similarity matrix,
 *     labelled by energy (intro / build / drop / breakdown / outro).
 * Everything except decodeMono / detectBeats is pure and unit-tested.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./exec.js";
import { fileKey, resolveMediaPath } from "./media.js";
import { paths } from "./paths.js";

export const BEAT_SR = 22050;
export const BEAT_NFFT = 1024;
export const BEAT_HOP = 256;
const NMEL = 40;
const ANALYSIS_VERSION = 3;

export type SectionKind = "intro" | "main" | "build" | "drop" | "breakdown" | "outro";

export interface MusicSection {
  start: number;
  end: number;
  /** Bars in the section (when downbeats are known). */
  bars?: number;
  /** Relative energy 0..1 across the song (loudness + onset density). */
  energy: number;
  /** Mean loudness, dBFS. */
  loudnessDb: number;
  kind: SectionKind;
}

export interface BeatAnalysis {
  path: string;
  duration: number;
  /** Beats per minute (from the tracked beats: regression over their times). */
  tempo: number;
  /** 0..1: how periodic the onsets are and how steady the tracked beats are. */
  confidence: number;
  /** Beats per bar (4 or 3). */
  meter: number;
  /** Beat times, seconds. */
  beats: number[];
  /** Downbeat (bar line) times, seconds; a subset of beats. */
  downbeats: number[];
  /** Per-beat accent strength 0..1 (same length as beats). */
  beatStrength: number[];
  sections: MusicSection[];
  /** Section starts where the energy jumps up (drops) / the song breaks down. */
  drops: number[];
  /** Loudness curve summary: `values` 0..1 every `hop` seconds. */
  energy: { hop: number; values: number[] };
  /** Time of the final strong downbeat (the musical resolution) and when its tail dies away. */
  ending: { finalDownbeat: number; tailEnd: number };
}

// ---------------------------------------------------------------- decoding

/** Decode the first audio stream to mono float PCM at `sr`. */
export async function decodeMono(path: string, sr = BEAT_SR): Promise<Float32Array> {
  const abs = resolveMediaPath(path);
  const raw = join(paths.tmp(), `mono-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.f32`);
  try {
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", abs, "-map", "0:a:0", "-ac", "1", "-ar", String(sr), "-f", "f32le", raw], {
      timeoutMs: 10 * 60_000,
    });
    const buf = readFileSync(raw);
    const out = new Float32Array(Math.floor(buf.length / 4));
    out.set(new Float32Array(buf.buffer, buf.byteOffset, out.length));
    return out;
  } finally {
    rmSync(raw, { force: true });
  }
}

// ---------------------------------------------------------------- FFT / spectrogram

/** In-place iterative radix-2 FFT of size n (power of two). */
export class FFT {
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  constructor(readonly n: number) {
    if (n & (n - 1)) throw new Error("FFT size must be a power of two");
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
  }
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = this.sin[k * step];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

const hz2mel = (f: number) => 2595 * Math.log10(1 + f / 700);
const mel2hz = (m: number) => 700 * (10 ** (m / 2595) - 1);

/** Triangular mel filterbank (HTK mel) over nfft/2+1 bins: [band][bin] weights, plus band centre Hz. */
export function melFilterbank(sr: number, nfft: number, nmel: number, fmin = 30, fmax = 11000): { weights: Float64Array[]; centers: number[] } {
  const bins = nfft / 2 + 1;
  const lo = hz2mel(fmin);
  const hi = hz2mel(Math.min(fmax, sr / 2));
  const pts = Array.from({ length: nmel + 2 }, (_, i) => mel2hz(lo + ((hi - lo) * i) / (nmel + 1)));
  const binHz = sr / nfft;
  const weights: Float64Array[] = [];
  for (let m = 0; m < nmel; m++) {
    const w = new Float64Array(bins);
    const [a, c, b] = [pts[m], pts[m + 1], pts[m + 2]];
    for (let k = 0; k < bins; k++) {
      const f = k * binHz;
      if (f > a && f < b) w[k] = f <= c ? (f - a) / (c - a) : (b - f) / (b - c);
    }
    // Narrow low bands may fall between bins: give them the nearest bin.
    if (!w.some((x) => x > 0)) w[Math.min(bins - 1, Math.round(c / binHz))] = 1;
    weights.push(w);
  }
  return { weights, centers: pts.slice(1, -1) };
}

export interface Spectral {
  /** Frames per second of every per-frame array. */
  fps: number;
  frames: number;
  /** Log-mel energies, frames x NMEL, dB. */
  melDb: Float32Array;
  nmel: number;
  /** Onset strength (spectral flux), >= 0. */
  onset: Float32Array;
  /** Low-band (< ~180 Hz) flux: kick / bass attacks. */
  lowOnset: Float32Array;
  /** Frame loudness, dBFS. */
  rmsDb: Float32Array;
}

/** Log-mel spectrogram, onset envelopes and loudness. Frames are centred: frame t is at t*hop/sr. */
export function spectralFeatures(samples: Float32Array, sr = BEAT_SR, nfft = BEAT_NFFT, hop = BEAT_HOP): Spectral {
  const pad = nfft / 2;
  const frames = Math.max(1, Math.floor(samples.length / hop) + 1);
  const fft = new FFT(nfft);
  const win = new Float64Array(nfft);
  for (let i = 0; i < nfft; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nfft);
  const { weights, centers } = melFilterbank(sr, nfft, NMEL);
  // Sparse filterbank: [band] -> (first bin, weights)
  const sparse = weights.map((w) => {
    let a = 0;
    while (a < w.length && w[a] === 0) a++;
    let b = w.length - 1;
    while (b > a && w[b] === 0) b--;
    return { a, w: w.slice(a, b + 1) };
  });
  const lowBands = centers.map((c, i) => (c < 180 ? i : -1)).filter((i) => i >= 0);
  const melDb = new Float32Array(frames * NMEL);
  const rmsDb = new Float32Array(frames);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const pow = new Float64Array(nfft / 2 + 1);
  for (let t = 0; t < frames; t++) {
    const off = t * hop - pad;
    let e = 0;
    for (let i = 0; i < nfft; i++) {
      const j = off + i;
      const x = j >= 0 && j < samples.length ? samples[j] : 0;
      re[i] = x * win[i];
      im[i] = 0;
      if (i >= pad - hop / 2 && i < pad + hop / 2) e += x * x;
    }
    rmsDb[t] = 10 * Math.log10(e / hop + 1e-12);
    fft.transform(re, im);
    for (let k = 0; k <= nfft / 2; k++) pow[k] = re[k] * re[k] + im[k] * im[k];
    for (let m = 0; m < NMEL; m++) {
      const { a, w } = sparse[m];
      let s = 0;
      for (let k = 0; k < w.length; k++) s += w[k] * pow[a + k];
      melDb[t * NMEL + m] = 10 * Math.log10(s + 1e-10);
    }
  }
  // Dynamic range: 80 dB below the loudest band value.
  let max = -Infinity;
  for (let i = 0; i < melDb.length; i++) if (melDb[i] > max) max = melDb[i];
  const floor = max - 80;
  for (let i = 0; i < melDb.length; i++) if (melDb[i] < floor) melDb[i] = floor;
  const onset = new Float32Array(frames);
  const lowOnset = new Float32Array(frames);
  for (let t = 1; t < frames; t++) {
    let s = 0;
    for (let m = 0; m < NMEL; m++) {
      const d = melDb[t * NMEL + m] - melDb[(t - 1) * NMEL + m];
      if (d > 0) s += d;
    }
    onset[t] = s / NMEL;
    let l = 0;
    for (const m of lowBands) {
      const d = melDb[t * NMEL + m] - melDb[(t - 1) * NMEL + m];
      if (d > 0) l += d;
    }
    lowOnset[t] = lowBands.length ? l / lowBands.length : 0;
  }
  return { fps: sr / hop, frames, melDb, nmel: NMEL, onset, lowOnset, rmsDb };
}

// ---------------------------------------------------------------- tempo

function mean(a: ArrayLike<number>, i0 = 0, i1 = a.length): number {
  let s = 0;
  for (let i = i0; i < i1; i++) s += a[i];
  return i1 > i0 ? s / (i1 - i0) : 0;
}
function std(a: ArrayLike<number>): number {
  const m = mean(a);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2;
  return Math.sqrt(s / Math.max(1, a.length));
}

export interface TempoEstimate {
  bpm: number;
  /** Beat period in onset frames (fractional). */
  period: number;
  /** Peak autocorrelation (normalised) at the chosen period, 0..1. */
  strength: number;
}

/**
 * Global tempo from the onset envelope: autocorrelation weighted by a log-normal prior
 * (centre `prior` BPM, 1 octave sd) with Ellis's harmonic enhancement ac(L) + 0.5 ac(2L).
 */
export function estimateTempo(onset: Float32Array, fps: number, opts: { prior?: number; min?: number; max?: number } = {}): TempoEstimate {
  const prior = opts.prior ?? 120;
  const minBpm = opts.min ?? 50;
  const maxBpm = opts.max ?? 220;
  const n = onset.length;
  const m = mean(onset);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = onset[i] - m;
  const minL = Math.max(2, Math.floor((fps * 60) / maxBpm));
  const maxL = Math.min(n - 2, Math.ceil((fps * 60) / minBpm));
  const top = Math.min(n - 1, 2 * maxL + 2);
  const ac = new Float64Array(top + 1);
  for (let L = 0; L <= top; L++) {
    let s = 0;
    for (let i = 0; i + L < n; i++) s += x[i] * x[i + L];
    ac[L] = s / (n - L);
  }
  const ac0 = ac[0] || 1;
  for (let L = 0; L <= top; L++) ac[L] /= ac0;
  const acAt = (L: number) => {
    const a = Math.floor(L);
    const f = L - a;
    return a + 1 <= top ? ac[a] * (1 - f) + ac[a + 1] * f : 0;
  };
  const score = (L: number) => {
    const bpm = (60 * fps) / L;
    const w = Math.exp(-0.5 * Math.log2(bpm / prior) ** 2);
    return w * (acAt(L) + 0.5 * acAt(2 * L));
  };
  let best = minL;
  let bestS = -Infinity;
  for (let L = minL; L <= maxL; L++) {
    const s = score(L);
    if (s > bestS) [best, bestS] = [L, s];
  }
  // Parabolic interpolation around the integer peak.
  let period = best;
  if (best > minL && best < maxL) {
    const a = score(best - 1);
    const b = score(best);
    const c = score(best + 1);
    const den = a - 2 * b + c;
    if (den < 0) period = best + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
  }
  return { bpm: (60 * fps) / period, period, strength: Math.max(0, Math.min(1, acAt(period))) };
}

// ---------------------------------------------------------------- beat tracking (DP)

/** Normalised, smoothed onset envelope used as the DP local score. */
function localScore(onset: Float32Array, period: number): Float64Array {
  const s = std(onset) || 1;
  const sigma = Math.max(1, period / 32);
  const half = Math.ceil(sigma * 3);
  const k = Array.from({ length: 2 * half + 1 }, (_, i) => Math.exp(-0.5 * ((i - half) / sigma) ** 2));
  const ks = k.reduce((a, b) => a + b, 0);
  const out = new Float64Array(onset.length);
  for (let t = 0; t < onset.length; t++) {
    let v = 0;
    for (let j = -half; j <= half; j++) {
      const i = t + j;
      if (i >= 0 && i < onset.length) v += (onset[i] / s) * k[j + half];
    }
    out[t] = v / ks;
  }
  return out;
}

/**
 * Ellis (2007) dynamic-programming beat tracker. Returns beat frames.
 * `tightness` weighs tempo consistency against onset strength (100 is librosa's default).
 */
export function trackBeats(onset: Float32Array, period: number, tightness = 100): number[] {
  const n = onset.length;
  if (n < period * 2) return [];
  const local = localScore(onset, period);
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(2 * period);
  const hi = Math.max(1, Math.round(period / 2));
  let maxLocal = 0;
  for (let t = 0; t < n; t++) maxLocal = Math.max(maxLocal, local[t]);
  let started = false;
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let arg = -1;
    for (let p = Math.max(0, t - lo); p <= t - hi; p++) {
      const s = cum[p] - tightness * Math.log((t - p) / period) ** 2;
      if (s > best) [best, arg] = [s, p];
    }
    // Before the first real onset, do not chain beats through silence.
    if (!started && local[t] < 0.01 * maxLocal) {
      cum[t] = local[t];
      back[t] = -1;
      continue;
    }
    started = true;
    if (arg >= 0 && best > 0) {
      cum[t] = local[t] + best;
      back[t] = arg;
    } else cum[t] = local[t];
  }
  // Last beat: the last local max of the cumulative score above half the median of the local maxima.
  const peaks: number[] = [];
  for (let t = 1; t < n - 1; t++) if (cum[t] > cum[t - 1] && cum[t] >= cum[t + 1]) peaks.push(t);
  if (!peaks.length) return [];
  const sorted = peaks.map((t) => cum[t]).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  let last = peaks[peaks.length - 1];
  for (let i = peaks.length - 1; i >= 0; i--) {
    if (cum[peaks[i]] >= 0.5 * med) {
      last = peaks[i];
      break;
    }
  }
  const beats: number[] = [];
  for (let t = last; t >= 0; t = back[t]) {
    beats.push(t);
    if (back[t] < 0) break;
  }
  beats.reverse();
  // Trim weak leading / trailing beats (silence, fade-ins and ring-outs).
  const rms = Math.sqrt(beats.reduce((a, b) => a + local[b] ** 2, 0) / Math.max(1, beats.length));
  const thr = 0.5 * rms;
  let a = 0;
  let b = beats.length;
  while (a < b && local[beats[a]] < thr) a++;
  while (b > a && local[beats[b - 1]] < thr) b--;
  return beats.slice(a, b);
}

/**
 * Move each beat to the attack it sits on: within [t - 30 ms, t + 50 ms] (log-spectral flux
 * peaks up to half a window early), the point where the pre-emphasised energy of the next 3 ms
 * rises most over the previous 6 ms, when that rise is clear (>= 6 dB); else the beat is left
 * alone. Pre-emphasis keeps a bass note's waveform from masquerading as attacks.
 */
export function refineToTransients(samples: Float32Array, sr: number, times: number[]): number[] {
  const n = samples.length;
  // Cumulative energy of the pre-emphasised signal.
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const y = samples[i] - 0.97 * (i > 0 ? samples[i - 1] : 0);
    cum[i + 1] = cum[i] + y * y;
  }
  const w = Math.max(2, Math.round(sr * 0.003));
  const step = Math.max(1, Math.round(sr * 0.0005));
  const e = (a: number, b: number) => 10 * Math.log10((cum[Math.min(n, b)] - cum[Math.max(0, a)]) / Math.max(1, b - a) + 1e-14);
  return times.map((t) => {
    const a = Math.max(2 * w, Math.round((t - 0.03) * sr));
    const b = Math.min(n - w, Math.round((t + 0.05) * sr));
    let best = -Infinity;
    let at = -1;
    for (let i = a; i <= b; i += step) {
      const d = e(i, i + w) - e(i - 2 * w, i);
      if (d > best) [best, at] = [d, i];
    }
    return best >= 6 && at >= 0 ? at / sr : t;
  });
}

// ---------------------------------------------------------------- downbeats

/** Cosine distance between the mean mel spectra of two frame ranges. */
function spectralChange(sp: Spectral, a0: number, a1: number, b0: number, b1: number): number {
  const M = sp.nmel;
  const va = new Float64Array(M);
  const vb = new Float64Array(M);
  const acc = (v: Float64Array, s: number, e: number) => {
    s = Math.max(0, s);
    e = Math.min(sp.frames, e);
    for (let t = s; t < e; t++) for (let m = 0; m < M; m++) v[m] += sp.melDb[t * M + m];
    const n = Math.max(1, e - s);
    for (let m = 0; m < M; m++) v[m] /= n;
    const mu = mean(v);
    for (let m = 0; m < M; m++) v[m] -= mu;
  };
  acc(va, a0, a1);
  acc(vb, b0, b1);
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let m = 0; m < M; m++) {
    d += va[m] * vb[m];
    na += va[m] ** 2;
    nb += vb[m] ** 2;
  }
  return 1 - d / Math.sqrt(na * nb + 1e-12);
}

function zscore(a: number[]): number[] {
  const m = mean(a);
  const s = std(a) || 1;
  return a.map((x) => (x - m) / s);
}

/**
 * Choose meter (4 or 3) and bar phase: downbeats carry low-frequency accent (kick / bass note)
 * and harmonic change (the chord changes on the one). Returns indices into `beatFrames`.
 */
export function findDownbeats(sp: Spectral, beatFrames: number[], meters: number[] = [4, 3]): { meter: number; phase: number; indices: number[]; contrast: number } {
  const n = beatFrames.length;
  if (n < 4) return { meter: 4, phase: 0, indices: n ? [0] : [], contrast: 0 };
  const near = (env: Float32Array, f: number) => {
    let m = 0;
    for (let i = Math.max(0, f - 3); i <= Math.min(env.length - 1, f + 3); i++) m = Math.max(m, env[i]);
    return m;
  };
  const low = zscore(beatFrames.map((f) => near(sp.lowOnset, f)));
  const acc = zscore(beatFrames.map((f) => near(sp.onset, f)));
  const change = zscore(
    beatFrames.map((f, k) => {
      const prev = beatFrames[k - 1] ?? Math.max(0, f - (beatFrames[1] - beatFrames[0]));
      const next = beatFrames[k + 1] ?? f + (f - prev);
      return spectralChange(sp, prev, f, f, next);
    }),
  );
  const score = beatFrames.map((_, k) => low[k] + 0.5 * acc[k] + change[k]);
  let best = { meter: 4, phase: 0, contrast: -Infinity };
  for (const M of meters) {
    if (n < 2 * M) continue;
    for (let p = 0; p < M; p++) {
      let on = 0;
      let nOn = 0;
      let off = 0;
      let nOff = 0;
      for (let k = 0; k < n; k++) {
        if ((k - p) % M === 0) {
          on += score[k];
          nOn++;
        } else {
          off += score[k];
          nOff++;
        }
      }
      // Prefer 4/4 unless 3/4 is clearly better.
      const c = (on / Math.max(1, nOn) - off / Math.max(1, nOff)) * (M === 4 ? 1.15 : 1);
      if (c > best.contrast) best = { meter: M, phase: p, contrast: c };
    }
  }
  const indices: number[] = [];
  for (let k = best.phase; k < n; k += best.meter) indices.push(k);
  return { ...best, indices };
}

// ---------------------------------------------------------------- sections

/**
 * Foote novelty over a sequence of feature vectors (checkerboard kernel, half-width w).
 * Columns are standardised across the sequence first, so loudness and spectral-shape changes
 * both count; similarity is the cosine of the standardised vectors. The first and last w/2
 * units get no novelty (the kernel would hang off the edge).
 */
export function footeNovelty(features: Float64Array[], w = 4): number[] {
  const n = features.length;
  if (!n) return [];
  const D = features[0].length;
  const mu = new Float64Array(D);
  const sd = new Float64Array(D);
  for (const v of features) for (let d = 0; d < D; d++) mu[d] += v[d] / n;
  for (const v of features) for (let d = 0; d < D; d++) sd[d] += (v[d] - mu[d]) ** 2 / n;
  const unit = features.map((v) => {
    const c = new Float64Array(D);
    for (let d = 0; d < D; d++) c[d] = (v[d] - mu[d]) / (Math.sqrt(sd[d]) || 1);
    const nn = Math.sqrt(c.reduce((a, b) => a + b * b, 0)) || 1;
    for (let d = 0; d < D; d++) c[d] /= nn;
    return c;
  });
  const sim = (i: number, j: number) => {
    let s = 0;
    for (let k = 0; k < D; k++) s += unit[i][k] * unit[j][k];
    return s;
  };
  const out = new Array<number>(n).fill(0);
  const edge = Math.max(1, Math.floor(w / 2));
  for (let c = edge; c <= n - edge; c++) {
    let s = 0;
    let wsum = 0;
    for (let i = -w; i < w; i++) {
      for (let j = -w; j < w; j++) {
        const a = c + i;
        const b = c + j;
        if (a < 0 || b < 0 || a >= n || b >= n) continue;
        const sign = (i < 0) === (j < 0) ? 1 : -1;
        const g = Math.exp(-0.5 * (((i + 0.5) / w) ** 2 + ((j + 0.5) / w) ** 2));
        s += sign * g * sim(a, b);
        wsum += g;
      }
    }
    out[c] = wsum ? Math.max(0, s / wsum) : 0;
  }
  return out;
}

interface Unit {
  start: number;
  end: number;
  f0: number;
  f1: number;
}

/**
 * Sections over bar units: novelty peaks (prefer the 4-bar phrase grid), labelled by energy.
 * `units` are bars (downbeat to downbeat) or fixed windows when there is no beat.
 */
export function findSections(sp: Spectral, units: Unit[], duration: number, phraseBars = 4): MusicSection[] {
  if (!units.length) return [];
  const M = sp.nmel;
  // Spectral shape (40 mel bands) plus loudness and onset density, each repeated so they weigh
  // like a dozen bands: energy changes (drops, breakdowns) matter as much as timbre.
  const EXTRA = 12;
  const feats = units.map((u) => {
    const v = new Float64Array(M + 2 * EXTRA);
    const a = Math.max(0, u.f0);
    const b = Math.max(a + 1, Math.min(sp.frames, u.f1));
    for (let t = a; t < b; t++) for (let m = 0; m < M; m++) v[m] += sp.melDb[t * M + m];
    for (let m = 0; m < M; m++) v[m] /= b - a;
    const l = mean(sp.rmsDb, a, b);
    const d = mean(sp.onset, a, b);
    for (let k = 0; k < EXTRA; k++) {
      v[M + k] = l;
      v[M + EXTRA + k] = d;
    }
    return v;
  });
  const loud = units.map((u) => {
    // Power mean of frame loudness.
    let s = 0;
    const a = Math.max(0, u.f0);
    const b = Math.max(a + 1, Math.min(sp.frames, u.f1));
    for (let t = a; t < b; t++) s += 10 ** (sp.rmsDb[t] / 10);
    return 10 * Math.log10(s / (b - a) + 1e-12);
  });
  const dens = units.map((u) => mean(sp.onset, Math.max(0, u.f0), Math.max(u.f0 + 1, Math.min(sp.frames, u.f1))));
  const nov = footeNovelty(feats, Math.min(4, Math.max(2, Math.floor(units.length / 6))));
  const nmax = Math.max(...nov);
  // Candidate boundaries: local maxima above 12% of the strongest change, at least
  // `phraseBars` apart, strongest first (phrase-grid positions get a 25% bonus).
  const cands = nov
    .map((v, i) => ({ v: v * (i % phraseBars === 0 ? 1.25 : 1), i }))
    .filter(({ i }) => i > 0 && i < units.length && nov[i] >= (nov[i - 1] ?? 0) && nov[i] >= (nov[i + 1] ?? 0) && nov[i] >= 0.12 * nmax && nov[i] > 0.02)
    .sort((a, b) => b.v - a.v);
  const bounds: number[] = [];
  // Long songs: sections of at least two phrases, and no more than one per ~15 s.
  const minGap = units.length > 48 ? 2 * phraseBars : phraseBars;
  const maxSections = Math.max(2, Math.round(duration / 15));
  for (const c of cands) if (bounds.length < maxSections - 1 && bounds.every((b) => Math.abs(b - c.i) >= minGap)) bounds.push(c.i);
  bounds.sort((a, b) => a - b);
  const edges = [0, ...bounds, units.length];
  const raw = edges.slice(0, -1).map((a, k) => {
    const b = edges[k + 1];
    let s = 0;
    for (let i = a; i < b; i++) s += 10 ** (loud[i] / 10);
    const l = 10 * Math.log10(s / (b - a) + 1e-12);
    const d = mean(dens, a, b);
    // Within-section slope (first vs last third) for builds.
    const third = Math.max(1, Math.floor((b - a) / 3));
    const rise = mean(loud, b - third, b) - mean(loud, a, a + third) + 10 * (mean(dens, b - third, b) - mean(dens, a, a + third));
    return { a, b, l, d, rise };
  });
  const lmin = Math.min(...raw.map((r) => r.l));
  const lmax = Math.max(...raw.map((r) => r.l));
  const dmax = Math.max(...raw.map((r) => r.d)) || 1;
  const sections: MusicSection[] = raw.map((r, k) => {
    const energy = 0.6 * (lmax > lmin ? (r.l - lmin) / (lmax - lmin) : 1) + 0.4 * (r.d / dmax);
    return {
      start: k === 0 ? 0 : units[r.a].start,
      end: k === raw.length - 1 ? duration : units[r.b - 1].end,
      bars: r.b - r.a,
      energy: Math.round(energy * 100) / 100,
      loudnessDb: Math.round(r.l * 10) / 10,
      kind: "main" as SectionKind,
    };
  });
  sections.forEach((s, k) => {
    const prev = sections[k - 1];
    const r = raw[k];
    if (prev && s.energy - prev.energy >= 0.3 && s.energy >= 0.85) s.kind = "drop";
    else if (prev && prev.energy - s.energy >= 0.3) s.kind = "breakdown";
    else if (r.rise >= 3 && k < sections.length - 1) s.kind = "build";
    if (k === 0 && s.kind !== "drop" && s.energy < 0.6 && sections.length > 2) s.kind = "intro";
    if (k === sections.length - 1 && sections.length > 2 && s.energy < 0.5 && s.kind !== "build") s.kind = "outro";
  });
  // A section right before a drop that rises is a build.
  sections.forEach((s, k) => {
    if (sections[k + 1]?.kind === "drop" && raw[k].rise > 1 && s.kind === "main") s.kind = "build";
  });
  return sections;
}

// ---------------------------------------------------------------- full analysis

/** Linear fit t_k = a + k*T over beat times. */
export function fitGrid(times: number[]): { a: number; T: number; residual: number } {
  const n = times.length;
  if (n < 2) return { a: times[0] ?? 0, T: 0.5, residual: 0 };
  const km = (n - 1) / 2;
  const tm = mean(times);
  let num = 0;
  let den = 0;
  for (let k = 0; k < n; k++) {
    num += (k - km) * (times[k] - tm);
    den += (k - km) ** 2;
  }
  const T = num / den;
  const a = tm - T * km;
  let r = 0;
  for (let k = 0; k < n; k++) r += (times[k] - (a + k * T)) ** 2;
  return { a, T, residual: Math.sqrt(r / n) };
}

/** Analyse decoded mono samples (pure). */
export function analyzeSamples(samples: Float32Array, sr = BEAT_SR, opts: { prior?: number; meter?: number; path?: string } = {}): BeatAnalysis {
  const duration = samples.length / sr;
  const sp = spectralFeatures(samples, sr);
  const fps = sp.fps;
  const tempo = estimateTempo(sp.onset, fps, { prior: opts.prior });
  const frames = trackBeats(sp.onset, tempo.period);
  let beats = frames.map((f) => f / fps);
  beats = refineToTransients(samples, sr, beats);
  // Keep beats strictly increasing.
  beats = beats.filter((b, i) => i === 0 || b > beats[i - 1] + 0.05);
  const strengthRaw = frames.map((f) => {
    let m = 0;
    for (let i = Math.max(0, f - 2); i <= Math.min(sp.frames - 1, f + 2); i++) m = Math.max(m, sp.onset[i]);
    return m;
  });
  const smax = Math.max(1e-9, ...strengthRaw);
  const beatStrength = strengthRaw.map((s) => Math.round((s / smax) * 100) / 100);

  // Tempo from the beats themselves (sub-frame accurate); median IBI if the tempo drifts.
  let bpm = tempo.bpm;
  let steadiness = 0;
  if (beats.length >= 4) {
    const fit = fitGrid(beats);
    const ibis = beats.slice(1).map((b, i) => b - beats[i]).sort((a, b) => a - b);
    const med = ibis[Math.floor(ibis.length / 2)];
    bpm = fit.residual < 0.25 * med ? 60 / fit.T : 60 / med;
    const dev = ibis.map((x) => Math.abs(x - med) / med);
    steadiness = 1 - Math.min(1, mean(dev) * 5);
  }
  const confidence = Math.round(Math.max(0, Math.min(1, 0.5 * Math.min(1, tempo.strength * 1.5) + 0.5 * steadiness)) * 100) / 100;

  const db = findDownbeats(sp, frames, opts.meter ? [opts.meter] : [4, 3]);
  const downbeats = db.indices.map((k) => beats[k]).filter((x) => x !== undefined);

  // Bars as section units (fallback: 2 s windows).
  let units: Unit[] = [];
  if (downbeats.length >= 4) {
    const period = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : 0.5;
    const edges = [...downbeats, Math.min(duration, downbeats[downbeats.length - 1] + period * db.meter)];
    // Pickup before the first downbeat belongs to the first bar.
    units = edges.slice(0, -1).map((s, i) => ({ start: i === 0 ? 0 : s, end: edges[i + 1], f0: Math.round((i === 0 ? 0 : s) * fps), f1: Math.round(edges[i + 1] * fps) }));
    if (units.length && units[units.length - 1].end < duration) {
      const last = units[units.length - 1];
      units.push({ start: last.end, end: duration, f0: Math.round(last.end * fps), f1: sp.frames });
    }
  } else {
    for (let s = 0; s < duration; s += 2) units.push({ start: s, end: Math.min(duration, s + 2), f0: Math.round(s * fps), f1: Math.round(Math.min(duration, s + 2) * fps) });
  }
  const sections = findSections(sp, units, duration);
  const drops = sections.filter((s) => s.kind === "drop").map((s) => r3(s.start));

  // Energy curve summary: 0..1 loudness every `hop` seconds (<= 64 points).
  const hop = Math.max(0.5, Math.ceil((duration / 64) * 2) / 2);
  const values: number[] = [];
  for (let s = 0; s < duration; s += hop) {
    const a = Math.round(s * fps);
    const b = Math.max(a + 1, Math.min(sp.frames, Math.round((s + hop) * fps)));
    let p = 0;
    for (let t = a; t < b; t++) p += 10 ** (sp.rmsDb[t] / 10);
    values.push(10 * Math.log10(p / (b - a) + 1e-12));
  }
  const vmax = Math.max(...values);
  const energy = { hop, values: values.map((v) => Math.round(Math.max(0, Math.min(1, (v - (vmax - 40)) / 40)) * 100) / 100) };

  // Ending: last downbeat whose loudness is near the song's body; tail ends when the level falls 40 dB under peak.
  let peakDb = -Infinity;
  for (let t = 0; t < sp.frames; t++) peakDb = Math.max(peakDb, sp.rmsDb[t]);
  let tailEndF = sp.frames - 1;
  while (tailEndF > 0 && sp.rmsDb[tailEndF] < peakDb - 45) tailEndF--;
  const tailEnd = Math.min(duration, (tailEndF + 1) / fps);
  const loudAt = (t: number) => {
    const a = Math.round(t * fps);
    let m = -Infinity;
    for (let i = a; i < Math.min(sp.frames, a + Math.round(0.2 * fps)); i++) m = Math.max(m, sp.rmsDb[i]);
    return m;
  };
  const body = sections.length ? Math.max(...sections.map((s) => s.loudnessDb)) : peakDb;
  const finalDownbeat = [...downbeats].reverse().find((d) => d < tailEnd - 0.2 && loudAt(d) > body - 14) ?? downbeats[downbeats.length - 1] ?? 0;

  return {
    path: opts.path ?? "",
    duration: r3(duration),
    tempo: Math.round(bpm * 100) / 100,
    confidence,
    meter: db.meter,
    beats: beats.map(r3),
    downbeats: downbeats.map(r3),
    beatStrength,
    sections: sections.map((s) => ({ ...s, start: r3(s.start), end: r3(s.end) })),
    drops,
    energy,
    ending: { finalDownbeat: r3(finalDownbeat), tailEnd: r3(tailEnd) },
  };
}

const memo = new Map<string, BeatAnalysis>();

/** Detect tempo, beats, downbeats, sections and energy of a music file (cached per file). */
export async function detectBeats(path: string, opts: { prior?: number; meter?: number } = {}): Promise<BeatAnalysis> {
  const abs = resolveMediaPath(path);
  const key = `${await fileKey(abs)}-v${ANALYSIS_VERSION}-${opts.prior ?? 120}-${opts.meter ?? "auto"}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const dir = join(paths.cache(), "beats");
  const file = join(dir, `${key}.json`);
  if (existsSync(file)) {
    try {
      const a = { ...(JSON.parse(readFileSync(file, "utf8")) as BeatAnalysis), path: abs };
      memo.set(key, a);
      return a;
    } catch {
      /* re-analyse */
    }
  }
  const samples = await decodeMono(abs);
  if (samples.length < BEAT_SR) throw new Error(`${abs} has less than 1 s of audio: nothing to analyse`);
  const a = analyzeSamples(samples, BEAT_SR, { ...opts, path: abs });
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(a));
  memo.set(key, a);
  return a;
}

// ---------------------------------------------------------------- helpers for editing

/** Nearest grid time to t (binary search), or undefined for an empty grid. */
export function nearest(grid: number[], t: number): number | undefined {
  if (!grid.length) return undefined;
  let lo = 0;
  let hi = grid.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (grid[mid] <= t) lo = mid;
    else hi = mid;
  }
  return Math.abs(grid[lo] - t) <= Math.abs(grid[hi] - t) ? grid[lo] : grid[hi];
}

/** Bar-line times every `bars` bars (phrase grid), starting at the first downbeat. */
export function phraseGrid(a: Pick<BeatAnalysis, "downbeats">, bars = 4): number[] {
  return a.downbeats.filter((_, i) => i % bars === 0);
}

/** One-line human summary of an analysis. */
export function describeBeats(a: BeatAnalysis): string {
  const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
  const lines = [
    `${a.tempo} BPM (confidence ${a.confidence}), ${a.meter}/4, ${a.beats.length} beats, ${a.downbeats.length} bars, ${a.duration}s`,
    `first beat ${fmt(a.beats[0] ?? 0)}, first downbeat ${fmt(a.downbeats[0] ?? 0)}; final downbeat ${fmt(a.ending.finalDownbeat)}, tail ends ${fmt(a.ending.tailEnd)}`,
    `sections: ${a.sections.map((s) => `${s.kind} ${fmt(s.start)}–${fmt(s.end)} (${s.bars ?? "?"} bars, energy ${s.energy})`).join("; ")}`,
  ];
  if (a.drops.length) lines.push(`drops at ${a.drops.map(fmt).join(", ")}`);
  return lines.join("\n");
}

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
