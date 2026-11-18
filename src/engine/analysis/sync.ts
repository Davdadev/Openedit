/**
 * Multicam audio sync: FFT cross-correlation of onset envelopes (robust to gain, mic
 * colour and noise) for a coarse lag over ± several minutes, then sample-accurate
 * refinement by normalised cross-correlation of the 8 kHz signals, and a drift check
 * (offset measured near the start and near the end of the overlap).
 *
 * Convention: offset of angle B relative to the reference A is the reference time at which
 * B's t=0 happens, i.e. tA = tB + offset.
 */
import { spawn } from "node:child_process";
import { currentSignal, trackChild } from "../exec.js";

export const SYNC_RATE = 8000;
/** Envelope rate (Hz) for the coarse search. */
export const ENV_RATE = 400;

/** Decode mono float PCM at `rate` (default 8 kHz). */
export function decodeAudio(path: string, rate = SYNC_RATE, o: { start?: number; duration?: number } = {}): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-loglevel", "error"];
    if (o.start) args.push("-ss", String(o.start));
    if (o.duration) args.push("-t", String(o.duration));
    args.push("-i", path, "-vn", "-sn", "-dn", "-ac", "1", "-ar", String(rate), "-f", "f32le", "-");
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    trackChild(child);
    const signal = currentSignal();
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    const chunks: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code !== 0) return reject(new Error(`ffmpeg audio decode failed (${code}): ${err.trim().split("\n").slice(-2).join(" ")}`));
      const buf = Buffer.concat(chunks);
      const n = Math.floor(buf.length / 4);
      resolve(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * 4)));
    });
  });
}

// ---------------------------------------------------------------------------
// FFT (iterative radix-2, in place)
// ---------------------------------------------------------------------------

export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n & (n - 1)) throw new Error("fft size must be a power of two");
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** Circular cross-correlation c[k] = Σ a[n+k]·b[n] for lags -(nb-1)..(na-1), via FFT. Returns lag -> value accessor. */
export function xcorr(a: Float32Array | Float64Array, b: Float32Array | Float64Array): { at: (lag: number) => number; minLag: number; maxLag: number } {
  let n = 1;
  while (n < a.length + b.length) n <<= 1;
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  ar.set(a);
  br.set(b);
  fft(ar, ai);
  fft(br, bi);
  for (let i = 0; i < n; i++) {
    // A * conj(B)
    const r = ar[i] * br[i] + ai[i] * bi[i];
    const im = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = r;
    ai[i] = im;
  }
  fft(ar, ai, true);
  return { at: (lag: number) => ar[(lag + n) % n], minLag: -(b.length - 1), maxLag: a.length - 1 };
}

/**
 * Onset envelope at ENV_RATE: log energy in short windows, positive first difference,
 * mean-removed and normalised. Insensitive to gain and steady noise.
 */
export function onsetEnvelope(x: Float32Array, rate = SYNC_RATE, envRate = ENV_RATE): Float64Array {
  const hop = Math.round(rate / envRate);
  const win = hop * 2;
  const m = Math.max(0, Math.floor((x.length - win) / hop) + 1);
  const e = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let s = 0;
    const o = i * hop;
    for (let j = 0; j < win; j++) s += x[o + j] * x[o + j];
    e[i] = Math.log10(s / win + 1e-9);
  }
  const d = new Float64Array(m);
  for (let i = 1; i < m; i++) d[i] = Math.max(0, e[i] - e[i - 1]);
  let mean = 0;
  for (let i = 0; i < m; i++) mean += d[i] / Math.max(1, m);
  let sd = 0;
  for (let i = 0; i < m; i++) {
    d[i] -= mean;
    sd += d[i] * d[i];
  }
  sd = Math.sqrt(sd / Math.max(1, m)) || 1;
  for (let i = 0; i < m; i++) d[i] /= sd;
  return d;
}

/** Sample-accurate refinement: normalised cross-correlation around a lag (samples), parabolic sub-sample peak. */
export function refineLag(a: Float32Array, b: Float32Array, lag: number, radius: number, region?: { start: number; length: number }): { lag: number; ncc: number } {
  // Region in A's samples where both overlap.
  const lo = Math.max(0, lag + radius, region?.start ?? 0);
  const hi = Math.min(a.length, b.length + lag - radius, region ? region.start + region.length : a.length);
  if (hi - lo < 1000) return { lag, ncc: 0 };
  const vals: number[] = [];
  let best = -2;
  let bi = 0;
  for (let k = -radius; k <= radius; k++) {
    const L = lag + k;
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let n = lo; n < hi; n++) {
      const x = a[n];
      const y = b[n - L];
      ab += x * y;
      aa += x * x;
      bb += y * y;
    }
    const v = aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
    vals.push(v);
    if (v > best) {
      best = v;
      bi = k + radius;
    }
  }
  let frac = 0;
  if (bi > 0 && bi < vals.length - 1) {
    const d = vals[bi - 1] - 2 * vals[bi] + vals[bi + 1];
    if (d < 0) frac = (0.5 * (vals[bi - 1] - vals[bi + 1])) / d;
  }
  return { lag: lag + bi - radius + frac, ncc: best };
}

export interface SyncResult {
  /** Seconds: reference time at which this angle's t=0 happens. */
  offset: number;
  /** 0..1: how distinct the correlation peak is. */
  confidence: number;
  /** Peak-to-second-peak ratio of the envelope correlation. */
  peakRatio: number;
  /** Normalised cross-correlation of the waveforms at the refined lag. */
  ncc: number;
  /** Clock drift between the angles (parts per million), when measurable. */
  driftPpm?: number;
  /** Overlap with the reference (seconds). */
  overlap: number;
}

/** Find the offset of `b` relative to `a` (both mono at SYNC_RATE). */
export function syncSignals(a: Float32Array, b: Float32Array, o: { maxOffset?: number } = {}): SyncResult {
  const rate = SYNC_RATE;
  const ea = onsetEnvelope(a);
  const eb = onsetEnvelope(b);
  const c = xcorr(ea, eb);
  const maxLag = Math.round((o.maxOffset ?? 600) * ENV_RATE);
  const lo = Math.max(c.minLag, -maxLag);
  const hi = Math.min(c.maxLag, maxLag);
  let best = -Infinity;
  let bl = 0;
  for (let L = lo; L <= hi; L++) {
    // Normalise by overlap so long overlaps don't win by length alone.
    const ov = Math.min(ea.length, eb.length + L) - Math.max(0, L);
    if (ov < ENV_RATE * 2) continue;
    const v = c.at(L) / Math.sqrt(ov);
    if (v > best) {
      best = v;
      bl = L;
    }
  }
  // Second peak outside ±50 ms.
  const excl = Math.round(0.05 * ENV_RATE);
  let second = -Infinity;
  let sum = 0;
  let sum2 = 0;
  let cnt = 0;
  for (let L = lo; L <= hi; L++) {
    const ov = Math.min(ea.length, eb.length + L) - Math.max(0, L);
    if (ov < ENV_RATE * 2) continue;
    const v = c.at(L) / Math.sqrt(ov);
    sum += v;
    sum2 += v * v;
    cnt++;
    if (Math.abs(L - bl) > excl && v > second) second = v;
  }
  const mean = cnt ? sum / cnt : 0;
  const sd = cnt ? Math.sqrt(Math.max(1e-12, sum2 / cnt - mean * mean)) : 1;
  const peakRatio = second > 0 ? best / second : 10;
  const z = (best - mean) / sd;
  // Refine at the sample level (±1.5 envelope hops).
  const hop = rate / ENV_RATE;
  const coarse = bl * hop;
  const overlapStart = Math.max(0, coarse);
  const overlapEnd = Math.min(a.length, b.length + coarse);
  const overlap = Math.max(0, overlapEnd - overlapStart) / rate;
  const winLen = Math.min(overlapEnd - overlapStart, 30 * rate);
  const first = refineLag(a, b, Math.round(coarse), Math.ceil(hop * 1.5), { start: overlapStart, length: winLen });
  let driftPpm: number | undefined;
  if (overlap > 120) {
    const last = refineLag(a, b, Math.round(coarse), Math.ceil(hop * 1.5), { start: overlapEnd - winLen, length: winLen });
    const span = (overlapEnd - overlapStart - winLen) / rate;
    if (last.ncc > 0.2 && first.ncc > 0.2 && span > 0) driftPpm = Math.round((((last.lag - first.lag) / rate) / span) * 1e6 * 10) / 10;
  }
  const confidence = Math.max(0, Math.min(1, (Math.min(peakRatio, 3) - 1) / 1.2)) * Math.max(0, Math.min(1, (z - 4) / 8));
  return {
    offset: Math.round((first.lag / rate) * 100000) / 100000,
    confidence: Math.round(confidence * 1000) / 1000,
    peakRatio: Math.round(peakRatio * 100) / 100,
    ncc: Math.round(first.ncc * 1000) / 1000,
    driftPpm,
    overlap: Math.round(overlap * 10) / 10,
  };
}

/** Sync every angle to the first (the reference). */
export async function syncAngles(paths: string[], o: { maxOffset?: number } = {}): Promise<SyncResult[]> {
  const sig = await Promise.all(paths.map((p) => decodeAudio(p)));
  return sig.map((s, i) => (i === 0 ? { offset: 0, confidence: 1, peakRatio: Number.POSITIVE_INFINITY, ncc: 1, overlap: s.length / SYNC_RATE } : syncSignals(sig[0], s, o)));
}
