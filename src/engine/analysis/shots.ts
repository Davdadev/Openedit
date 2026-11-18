/**
 * Pure shot-analysis maths (unit tested): per-frame difference scores, adaptive
 * shot-boundary detection (hard cuts, dissolves, fades, flash rejection), global
 * camera-motion estimation by block matching on tiny luma frames, palette k-means
 * and shot-size classification.
 */

export const TINY_W = 96;
export const TINY_H = 54;
/** Small luma thumbnails kept for every frame (dissolve tests, long-gap distances). */
export const THUMB_W = 32;
export const THUMB_H = 18;
/** Tiny RGB thumbnails kept for every frame (palette). */
export const PAL_W = 16;
export const PAL_H = 9;

export interface FrameStats {
  /** Frames decoded. */
  count: number;
  fps: number;
  /** Mean |ΔY| between frame i and i-1 on 96x54 luma, 0..1 (index 0 = 0). */
  lumaDiff: Float32Array;
  /** Half L1 distance between 64-bin RGB histograms of frame i and i-1, 0..1. */
  histDiff: Float32Array;
  /** Mean luma 0..1. */
  luma: Float32Array;
  /** Fraction of pixels ≥ 250 / ≤ 6 luma. */
  hi: Float32Array;
  lo: Float32Array;
  /** 32x18 luma per frame (count * 576 bytes). */
  thumbs: Uint8Array;
  /** 16x9 RGB per frame (count * 432 bytes). */
  pal: Uint8Array;
  /** Camera motion samples: frame index, dx, dy (pixels of a 96-wide frame per frame), zoom (relative scale change per frame), residual. */
  motion: { f: number; dx: number; dy: number; zoom: number; resid: number }[];
}

export type BoundaryKind = "cut" | "dissolve" | "fade";

export interface Boundary {
  /** First frame of the new shot. */
  frame: number;
  kind: BoundaryKind;
  score: number;
  /** For dissolves / fades: transition length in frames. */
  length?: number;
}

const THUMB_N = THUMB_W * THUMB_H;

/** Mean absolute difference of two luma thumbnails, 0..1. */
export function thumbDist(thumbs: Uint8Array, a: number, b: number): number {
  const oa = a * THUMB_N;
  const ob = b * THUMB_N;
  let s = 0;
  for (let i = 0; i < THUMB_N; i++) s += Math.abs(thumbs[oa + i] - thumbs[ob + i]);
  return s / THUMB_N / 255;
}

/** How well frame m is explained as the average of frames a and b (dissolve linearity), 0 = perfectly. */
export function blendError(thumbs: Uint8Array, a: number, m: number, b: number): number {
  const oa = a * THUMB_N;
  const om = m * THUMB_N;
  const ob = b * THUMB_N;
  const wa = (b - m) / (b - a);
  let err = 0;
  let span = 0;
  for (let i = 0; i < THUMB_N; i++) {
    const pred = thumbs[oa + i] * wa + thumbs[ob + i] * (1 - wa);
    err += Math.abs(thumbs[om + i] - pred);
    span += Math.abs(thumbs[oa + i] - thumbs[ob + i]);
  }
  return span < 1 ? 1 : err / span;
}

/** Combined per-frame cut score 0..1 (histogram change + luma change). */
export function cutScores(st: Pick<FrameStats, "lumaDiff" | "histDiff" | "count">): Float32Array {
  const s = new Float32Array(st.count);
  for (let i = 1; i < st.count; i++) s[i] = 0.5 * st.histDiff[i] + 0.5 * Math.min(1, st.lumaDiff[i] * 3);
  return s;
}

export interface DetectOptions {
  /** Ratio of a frame's score to its neighbourhood mean to call a cut (default 3). */
  ratio?: number;
  /** Minimum absolute score for a cut (default 0.12). */
  minScore?: number;
  /** Score that is a cut whatever the neighbourhood (default 0.45). */
  strongScore?: number;
  /** Half window (frames) for the adaptive mean (default ~1 s). */
  window?: number;
  /** Minimum shot length in frames (default ~0.3 s). */
  minShot?: number;
  /** Detect dissolves (default true). */
  dissolves?: boolean;
  /** Minimum dissolve score (picture change × blend linearity, default 0.12). */
  dissolveMin?: number;
}

/**
 * Shot boundaries from per-frame stats.
 *  - Hard cuts: score is a local maximum, above an absolute floor, and `ratio` times the mean of
 *    its neighbourhood (excluding itself), so busy handheld shots raise their own bar.
 *    Flashes (frame i+1 back to looking like i-1) are rejected.
 *  - Dissolves: the distance between frames i-k and i+k peaks while frame i is close to the
 *    linear blend of the two (pans and zooms are not), tried at several k.
 *  - Fades: runs of near-black frames between two brighter shots.
 */
export function detectBoundaries(st: FrameStats, o: DetectOptions = {}): Boundary[] {
  const n = st.count;
  if (n < 3) return [];
  const fps = st.fps || 25;
  const ratio = o.ratio ?? 3;
  const minScore = o.minScore ?? 0.12;
  const strong = o.strongScore ?? 0.45;
  const W = o.window ?? Math.max(6, Math.round(fps));
  const minShot = o.minShot ?? Math.max(3, Math.round(fps * 0.3));
  const dissolveMin = o.dissolveMin ?? 0.12;
  const s = cutScores(st);

  // Prefix sums for the adaptive mean.
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + s[i];
  const out: Boundary[] = [];
  for (let i = 1; i < n; i++) {
    const v = s[i];
    if (v < minScore) continue;
    if (v < s[i - 1] || (i + 1 < n && v < s[i + 1])) continue;
    const a = Math.max(1, i - W);
    const b = Math.min(n - 1, i + W);
    // Exclude i and its immediate neighbours (a cut spills one frame with some codecs).
    let sum = pre[b + 1] - pre[a];
    let cnt = b - a + 1;
    for (let j = i - 1; j <= i + 1; j++) {
      if (j >= a && j <= b) {
        sum -= s[j];
        cnt--;
      }
    }
    const mean = cnt > 0 ? sum / cnt : 0;
    const r = v / (mean + 0.01);
    if (v < strong && r < ratio) continue;
    // Flash / single-frame glitch: the frame after looks like the frame before.
    if (i + 1 < n && i >= 2 && st.thumbs.length) {
      const back = thumbDist(st.thumbs, i - 1, i + 1);
      const across = thumbDist(st.thumbs, i - 1, i);
      if (back < across * 0.3 && s[i + 1] > minScore) continue;
    }
    // ...and the frame after a flash: this frame looks like the one two back.
    if (i >= 2 && st.thumbs.length) {
      const back2 = thumbDist(st.thumbs, i - 2, i);
      const across = thumbDist(st.thumbs, i - 1, i);
      if (back2 < across * 0.3 && s[i - 1] > minScore) continue;
    }
    out.push({ frame: i, kind: "cut", score: Math.round(v * 1000) / 1000 });
  }

  if (o.dissolves !== false && st.thumbs.length >= n * THUMB_N) {
    const isNearCut = (f: number, d: number) => out.some((c) => c.kind === "cut" && Math.abs(c.frame - f) <= d);
    const ks = [Math.round(fps * 0.2), Math.round(fps * 0.4), Math.round(fps * 0.8)].filter((k, i, a) => k >= 3 && a.indexOf(k) === i);
    const found: Boundary[] = [];
    for (const k of ks) {
      const L = new Float32Array(n);
      for (let i = k; i + k < n; i++) L[i] = thumbDist(st.thumbs, i - k, i + k);
      for (let i = k; i + k < n; i++) {
        const v = L[i];
        if (v < dissolveMin * 0.8) continue;
        let isMax = true;
        for (let j = Math.max(k, i - k); j <= Math.min(n - k - 1, i + k); j++) {
          if (L[j] > v || (L[j] === v && j < i)) {
            isMax = false;
            break;
          }
        }
        if (!isMax) continue;
        if (isNearCut(i, k + 1)) continue;
        // Linearity at the middle and at the quarter points.
        const e1 = blendError(st.thumbs, i - k, i, i + k);
        const e2 = blendError(st.thumbs, i - k, i - Math.floor(k / 2), i + k);
        const e3 = blendError(st.thumbs, i - k, i + Math.floor(k / 2), i + k);
        const err = (e1 + e2 + e3) / 3;
        if (err > 0.3) continue;
        // The frames outside the transition must be stable relative to the change (not a pan):
        // consecutive differences inside the window should be small and even.
        let maxStep = 0;
        let sumStep = 0;
        for (let j = i - k + 1; j <= i + k; j++) {
          maxStep = Math.max(maxStep, s[j]);
          sumStep += s[j];
        }
        if (sumStep > 0 && maxStep > 0.5 * sumStep && maxStep > minScore) continue;
        const score = v * (1 - err);
        if (score < dissolveMin) continue;
        found.push({ frame: i, kind: "dissolve", score: Math.round(score * 1000) / 1000, length: 2 * k });
      }
    }
    // Merge dissolves found at several k: keep the best per neighbourhood.
    found.sort((a, b) => b.score - a.score);
    for (const d of found) {
      if (out.some((c) => Math.abs(c.frame - d.frame) <= Math.max(minShot, (d.length ?? 0) / 2))) continue;
      out.push(d);
    }
  }

  // Fades through black: a dark luma minimum with clearly brighter pictures on both sides.
  const span = Math.max(4, Math.round(fps));
  const fades: Boundary[] = [];
  for (let i = 1; i < n - 1; i++) {
    const v = st.luma[i];
    if (v > 0.06) continue;
    let isMin = true;
    for (let j = Math.max(0, i - Math.round(span / 2)); j <= Math.min(n - 1, i + Math.round(span / 2)); j++) {
      if (st.luma[j] < v - 1e-6 || (j > i && Math.abs(st.luma[j] - v) <= 1e-6)) {
        isMin = false;
        break;
      }
    }
    if (!isMin) continue;
    let before = 0;
    let after = 0;
    for (let j = Math.max(0, i - span); j < i; j++) before = Math.max(before, st.luma[j]);
    for (let j = i + 1; j <= Math.min(n - 1, i + span); j++) after = Math.max(after, st.luma[j]);
    if (before < v + 0.1 || after < v + 0.1) continue;
    // A held black: centre of the run of near-black frames.
    let a = i;
    let b = i;
    while (a > 0 && st.luma[a - 1] <= v + 0.01) a--;
    while (b < n - 1 && st.luma[b + 1] <= v + 0.01) b++;
    const frame = b > a ? Math.round((a + b + 1) / 2) : i;
    let len = 1;
    while (frame - len > 0 && st.luma[frame - len] < before * 0.9 && len < span) len++;
    fades.push({ frame, kind: "fade", score: 1, length: Math.min(span * 2, 2 * len) });
  }
  for (const f of fades) {
    const guard = Math.max(minShot, Math.round(fps * 0.4), (f.length ?? 0) / 2);
    for (let k = out.length - 1; k >= 0; k--) if (Math.abs(out[k].frame - f.frame) <= guard) out.splice(k, 1);
    out.push(f);
  }

  out.sort((a, b) => a.frame - b.frame);
  // Enforce a minimum shot length: keep the stronger of two boundaries too close together.
  const kept: Boundary[] = [];
  for (const b of out) {
    const last = kept[kept.length - 1];
    if (b.frame < minShot) continue;
    if (last && b.frame - last.frame < minShot) {
      if (b.score > last.score) kept[kept.length - 1] = b;
      continue;
    }
    kept.push(b);
  }
  return kept.filter((b) => n - b.frame >= Math.min(minShot, 2));
}

// ---------------------------------------------------------------------------
// Camera motion
// ---------------------------------------------------------------------------

/** Sum of absolute differences of a block shifted by (dx, dy); NaN when out of range. */
function sad(a: Uint8Array, b: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number, dx: number, dy: number): number {
  let s = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    const yy = y + dy;
    for (let x = x0; x < x1; x += 1) {
      const xx = x + dx;
      s += Math.abs(a[y * w + x] - b[yy * w + xx]);
      n++;
    }
  }
  return n ? s / n : Number.NaN;
}

/** Best integer shift of a region within ±r with parabolic sub-pixel refinement. */
function regionShift(a: Uint8Array, b: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number, r: number): { dx: number; dy: number; cost: number } {
  let best = Number.POSITIVE_INFINITY;
  let bx = 0;
  let by = 0;
  const costs = new Map<string, number>();
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const c = sad(a, b, w, Math.max(x0, -dx), Math.max(y0, -dy), Math.min(x1, w - dx), Math.min(y1, h - dy), dx, dy);
      costs.set(`${dx},${dy}`, c);
      if (c < best - 1e-9 || (Math.abs(c - best) < 1e-9 && Math.abs(dx) + Math.abs(dy) < Math.abs(bx) + Math.abs(by))) {
        best = c;
        bx = dx;
        by = dy;
      }
    }
  }
  const sub = (cm: number | undefined, c0: number, cp: number | undefined) => {
    if (cm === undefined || cp === undefined) return 0;
    const d = cm - 2 * c0 + cp;
    return d > 1e-6 ? Math.max(-0.5, Math.min(0.5, (cm - cp) / (2 * d))) : 0;
  };
  const fx = sub(costs.get(`${bx - 1},${by}`), best, costs.get(`${bx + 1},${by}`));
  const fy = sub(costs.get(`${bx},${by - 1}`), best, costs.get(`${bx},${by + 1}`));
  return { dx: bx + fx, dy: by + fy, cost: best };
}

/**
 * Global motion between two luma frames (w x h): shifts of four quadrants (optical-flow-lite).
 * Pan = mean x shift, tilt = mean y shift (content moving right => dx > 0), zoom = mean radial
 * component of the quadrant shifts relative to the quadrant centre distance (> 0: zooming in).
 */
export function estimateMotion(a: Uint8Array, b: Uint8Array, w: number, h: number, r = 4): { dx: number; dy: number; zoom: number; resid: number } {
  const m = r + 1;
  const qs = [
    [m, m, w / 2, h / 2],
    [w / 2, m, w - m, h / 2],
    [m, h / 2, w / 2, h - m],
    [w / 2, h / 2, w - m, h - m],
  ].map((q) => q.map(Math.round));
  const shifts = qs.map(([x0, y0, x1, y1]) => ({ ...regionShift(a, b, w, h, x0, y0, x1, y1, r), cx: (x0 + x1) / 2 - w / 2, cy: (y0 + y1) / 2 - h / 2 }));
  const dx = shifts.reduce((s, q) => s + q.dx, 0) / 4;
  const dy = shifts.reduce((s, q) => s + q.dy, 0) / 4;
  let zoom = 0;
  for (const q of shifts) {
    const rr = Math.hypot(q.cx, q.cy) || 1;
    zoom += ((q.dx - dx) * q.cx + (q.dy - dy) * q.cy) / (rr * rr);
  }
  zoom /= 4;
  const resid = shifts.reduce((s, q) => s + Math.hypot(q.dx - dx - zoom * q.cx, q.dy - dy - zoom * q.cy), 0) / 4;
  // The shift found maps a->b positions: b(x+dx) = a(x). Content moved by +dx.
  return { dx, dy, zoom, resid };
}

export type CameraMove = "static" | "pan-left" | "pan-right" | "tilt-up" | "tilt-down" | "zoom-in" | "zoom-out" | "handheld" | "moving";

/**
 * Classify a shot's camera move from its motion samples (pixels/frame on a 96-px-wide frame).
 * A pan right moves the content left (dx < 0).
 */
export function classifyCamera(samples: { dx: number; dy: number; zoom: number; resid: number }[], fps: number): { move: CameraMove; panPerSec: number; tiltPerSec: number; zoomPerSec: number; shake: number } {
  if (!samples.length) return { move: "static", panPerSec: 0, tiltPerSec: 0, zoomPerSec: 0, shake: 0 };
  const med = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  // Frame-width fractions per second.
  const pan = (med(samples.map((s) => s.dx)) * fps) / TINY_W;
  const tilt = (med(samples.map((s) => s.dy)) * fps) / TINY_W;
  const zoom = med(samples.map((s) => s.zoom)) * fps;
  // Robust spread (median absolute deviation): fades and flashes give a few wild samples.
  const mdx = med(samples.map((s) => s.dx));
  const mdy = med(samples.map((s) => s.dy));
  const shake = (1.4826 * med(samples.map((x) => Math.hypot(x.dx - mdx, x.dy - mdy))) * fps) / TINY_W;
  const r = (n: number) => Math.round(n * 1000) / 1000;
  let move: CameraMove = "static";
  const ap = Math.abs(pan);
  const at = Math.abs(tilt);
  const az = Math.abs(zoom);
  if (ap > 0.04 || at > 0.04 || az > 0.05) {
    if (az > 0.05 && az * 1.5 > Math.max(ap, at)) move = zoom > 0 ? "zoom-in" : "zoom-out";
    else if (ap >= at) move = pan < 0 ? "pan-right" : "pan-left";
    else move = tilt < 0 ? "tilt-down" : "tilt-up";
  } else if (shake > 0.06) move = "handheld";
  const resid = samples.reduce((s, x) => s + x.resid, 0) / samples.length;
  if (move === "static" && resid > 1.2) move = "moving";
  return { move, panPerSec: r(pan), tiltPerSec: r(tilt), zoomPerSec: r(zoom), shake: r(shake) };
}

// ---------------------------------------------------------------------------
// Palette, exposure, shot size
// ---------------------------------------------------------------------------

/** Deterministic k-means on RGB pixels (farthest-point init). Returns colours sorted by weight. */
export function palette(pixels: Uint8Array | number[], k = 4, iters = 8): { hex: string; weight: number; rgb: [number, number, number] }[] {
  const n = Math.floor(pixels.length / 3);
  if (!n) return [];
  const px = (i: number): [number, number, number] => [pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2]];
  const d2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  // Init: mean, then farthest points.
  const mean = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) mean[c] += pixels[i * 3 + c] / n;
  const centres: number[][] = [];
  let far = 0;
  let fd = -1;
  for (let i = 0; i < n; i++) {
    const d = d2(px(i), mean);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  centres.push(px(far));
  while (centres.length < Math.min(k, n)) {
    let bi = 0;
    let bd = -1;
    for (let i = 0; i < n; i++) {
      const d = Math.min(...centres.map((c) => d2(px(i), c)));
      if (d > bd) {
        bd = d;
        bi = i;
      }
    }
    if (bd <= 0) break;
    centres.push(px(bi));
  }
  const assign = new Int32Array(n);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      const p = px(i);
      let best = 0;
      let bd = Number.POSITIVE_INFINITY;
      for (let c = 0; c < centres.length; c++) {
        const d = d2(p, centres[c]);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      assign[i] = best;
    }
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const s = sums[assign[i]];
      s[0] += pixels[i * 3];
      s[1] += pixels[i * 3 + 1];
      s[2] += pixels[i * 3 + 2];
      s[3]++;
    }
    for (let c = 0; c < centres.length; c++) if (sums[c][3]) centres[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
  }
  const counts = centres.map(() => 0);
  for (let i = 0; i < n; i++) counts[assign[i]]++;
  const hex = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return centres
    .map((c, i) => ({ hex: `#${hex(c[0])}${hex(c[1])}${hex(c[2])}`, weight: Math.round((counts[i] / n) * 1000) / 1000, rgb: [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])] as [number, number, number] }))
    .filter((c) => c.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.hex.localeCompare(b.hex));
}

/** Similarity of two palettes 0..1 (weighted nearest-colour distance, symmetric). */
export function paletteSimilarity(a: { rgb: number[]; weight: number }[], b: { rgb: number[]; weight: number }[]): number {
  if (!a.length || !b.length) return 0.5;
  const one = (x: typeof a, y: typeof b) =>
    x.reduce((s, c) => s + c.weight * Math.min(...y.map((d) => Math.sqrt((c.rgb[0] - d.rgb[0]) ** 2 + (c.rgb[1] - d.rgb[1]) ** 2 + (c.rgb[2] - d.rgb[2]) ** 2))), 0) /
    Math.max(1e-6, x.reduce((s, c) => s + c.weight, 0));
  const d = (one(a, b) + one(b, a)) / 2;
  return Math.max(0, 1 - d / 160);
}

export type ShotSize = "extreme-close-up" | "close-up" | "medium" | "wide" | "no-faces";

/** Shot size from the largest face height (fraction of frame height). */
export function shotSize(faceH: number | undefined): ShotSize {
  if (faceH === undefined || faceH <= 0) return "no-faces";
  if (faceH >= 0.6) return "extreme-close-up";
  if (faceH >= 0.33) return "close-up";
  if (faceH >= 0.14) return "medium";
  return "wide";
}

export function exposureLabel(luma: number, hi: number, lo: number): "ok" | "dark" | "bright" | "clipped" | "crushed" {
  if (hi > 0.12) return "clipped";
  if (lo > 0.25) return "crushed";
  if (luma < 0.18) return "dark";
  if (luma > 0.78) return "bright";
  return "ok";
}

/** Cosine similarity (feature prints are L2-normalised and scaled; this renormalises). */
export function cosine(a?: number[], b?: number[]): number {
  if (!a || !b || !a.length || a.length !== b.length) return 0;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

/** Representative frame positions (fractions of the shot) by shot length. */
export function repFractions(duration: number): number[] {
  if (duration < 3) return [0.5];
  if (duration < 10) return [0.25, 0.75];
  return [0.15, 0.5, 0.85];
}
