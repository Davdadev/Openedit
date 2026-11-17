/**
 * Subject-aware reframing (16:9 -> 9:16 / 1:1 / 4:5, or vertical -> 16:9).
 *
 * 1. Sample the source every `interval` seconds (ffmpeg -> small JPEGs).
 * 2. Detect faces with Apple's Vision framework through a tiny Swift helper,
 *    compiled once to ~/.openedit/bin/openedit-faces (swiftc), or run with
 *    `swift` as a script when swiftc is unavailable. Results are cached per file.
 * 3. Pick the subject (largest face, preferring the one nearest the previous
 *    pick), fill gaps, median-filter detector jitter, then run a camera-operator
 *    smoother: hold the crop still while the subject stays inside a dead zone,
 *    otherwise ease towards it with an EMA under a maximum pan speed.
 * 4. Simplify to a few piecewise-linear keyframes and emit an ffmpeg `crop`
 *    x/y expression (a flat sum of hinge terms, no nesting) on the edit timeline.
 *
 * Without Swift/Vision (Linux, Windows) or when no face is found, the crop
 * uses `focusX` (0-1) or the centre.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CutPlan, MediaInfo } from "../hosts/types.js";
import { run } from "./exec.js";
import { fileKey } from "./media.js";
import { paths } from "./paths.js";
import { mapTime } from "./remap.js";

export type ReframeAspect = "9:16" | "1:1" | "16:9" | "4:5";
export type ReframeMode = "auto" | "center" | "manual";

export interface ReframeSpec {
  aspect: ReframeAspect;
  /** auto = follow faces (falls back to focusX, then centre); center = static centre crop; manual = static crop at focusX/focusY. */
  mode?: ReframeMode;
  /** Horizontal focus 0 (left) .. 1 (right) for manual mode or as the auto fallback. */
  focusX?: number;
  /** Vertical focus 0 (top) .. 1 (bottom), used when cropping a vertical source to a wider aspect. */
  focusY?: number;
}

/** A face box in normalised source coordinates (origin top-left). */
export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
  conf?: number;
}

export interface FaceSample {
  /** Source time (s). */
  t: number;
  faces: FaceBox[];
}

export interface TrackPoint {
  t: number;
  /** Normalised crop centre along the cropped axis, or null when nothing was seen. */
  x: number | null;
}

export interface SmoothOptions {
  /** Hold still while the target stays within this distance of the crop centre (normalised units). Default 0.05. */
  deadzone?: number;
  /** Maximum pan speed in normalised units per second. Default 0.2 (a fifth of the frame per second). */
  maxSpeed?: number;
  /** EMA factor per second-equivalent step (0-1). Default 0.5 per sample at 2 samples/s. */
  alpha?: number;
  /** Clamp range for the crop centre (keeps the crop inside the frame). */
  min?: number;
  max?: number;
  /** Used when no sample has a value. Default 0.5. */
  fallback?: number;
  /** Median filter window (odd). Default 5. */
  median?: number;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

// ---------------------------------------------------------------------------
// Pure tracking maths (unit tested)
// ---------------------------------------------------------------------------

/**
 * Choose the subject in each sample: the largest face, but when several faces
 * are similar in size prefer the one closest to the previous pick (no ping-pong).
 * Returns the face centre along the axis we crop.
 */
export function subjectTrack(samples: FaceSample[], axis: "x" | "y" = "x"): TrackPoint[] {
  let prev: number | null = null;
  return samples.map((s) => {
    const faces = s.faces.filter((f) => f.w > 0.01 && f.h > 0.01 && (f.conf ?? 1) >= 0.4);
    if (!faces.length) return { t: s.t, x: null };
    const maxArea = Math.max(...faces.map((f) => f.w * f.h));
    const candidates = faces.filter((f) => f.w * f.h >= maxArea * 0.6);
    const centre = (f: FaceBox) => (axis === "x" ? f.x + f.w / 2 : f.y + f.h / 2);
    let pick = candidates.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
    if (prev !== null && candidates.length > 1) {
      const p = prev;
      pick = candidates.reduce((a, b) => (Math.abs(centre(a) - p) <= Math.abs(centre(b) - p) ? a : b));
    }
    prev = centre(pick);
    return { t: s.t, x: prev };
  });
}

/** Fill gaps: hold the last value, back-fill the start, fallback when empty. */
export function fillGaps(track: TrackPoint[], fallback = 0.5): { t: number; x: number }[] {
  const firstKnown = track.find((p) => p.x !== null)?.x ?? fallback;
  let last = firstKnown;
  return track.map((p) => {
    if (p.x !== null) last = p.x;
    return { t: p.t, x: p.x ?? last };
  });
}

export function medianFilter(values: number[], window = 5): number[] {
  const h = Math.floor(Math.max(1, window) / 2);
  if (h === 0) return [...values];
  return values.map((_, i) => {
    const w = values.slice(Math.max(0, i - h), Math.min(values.length, i + h + 1)).sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)];
  });
}

/**
 * Camera-operator smoothing: hold while the subject is within the dead zone,
 * otherwise ease (EMA) towards it, never faster than maxSpeed, and keep
 * moving until close to the target (hysteresis) so the crop settles cleanly.
 */
export function smoothTrack(track: TrackPoint[], o: SmoothOptions = {}): { t: number; x: number }[] {
  if (!track.length) return [];
  const dead = o.deadzone ?? 0.05;
  const maxSpeed = o.maxSpeed ?? 0.2;
  const alpha = o.alpha ?? 0.5;
  const lo = o.min ?? 0;
  const hi = o.max ?? 1;
  const filled = fillGaps(track, o.fallback ?? 0.5);
  const med = medianFilter(
    filled.map((p) => p.x),
    o.median ?? 5,
  );
  let cur = clamp(med[0], lo, hi);
  let moving = false;
  const out: { t: number; x: number }[] = [];
  for (let i = 0; i < filled.length; i++) {
    const target = clamp(med[i], lo, hi);
    const dt = i === 0 ? 0 : Math.max(0, filled[i].t - filled[i - 1].t);
    const err = target - cur;
    if (!moving && Math.abs(err) > dead) moving = true;
    if (moving && i > 0) {
      const step = clamp(err * alpha, -maxSpeed * dt, maxSpeed * dt);
      cur = clamp(cur + step, lo, hi);
      if (Math.abs(target - cur) < dead * 0.25) moving = false;
    }
    out.push({ t: filled[i].t, x: cur });
  }
  return out;
}

/** Ramer–Douglas–Peucker on (t, x): drop keyframes that a straight line already explains within `eps`. */
export function simplifyTrack(points: { t: number; x: number }[], eps = 0.003): { t: number; x: number }[] {
  if (points.length <= 2) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const pa = points[a];
    const pb = points[b];
    let worst = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const p = points[i];
      const k = pb.t === pa.t ? 0 : (p.t - pa.t) / (pb.t - pa.t);
      const d = Math.abs(p.x - (pa.x + k * (pb.x - pa.x)));
      if (d > worst) {
        worst = d;
        idx = i;
      }
    }
    if (worst > eps && idx > 0) {
      keep[idx] = true;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const n3 = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * Piecewise-linear function of `t` through the keyframes, as a flat ffmpeg
 * expression: v0 + Σ Δslope_i·max(0, t − t_i). Constant before the first and
 * after the last keyframe. No nesting, so hundreds of keys stay cheap.
 */
export function piecewiseExpression(keys: { t: number; v: number }[], variable = "t"): string {
  if (!keys.length) return "0";
  const k = keys.filter((p, i) => i === 0 || p.t > keys[i - 1].t + 1e-6);
  if (k.length === 1 || k.every((p) => Math.abs(p.v - k[0].v) < 0.5)) return n3(k[0].v);
  const terms: string[] = [n3(k[0].v)];
  let prevSlope = 0;
  for (let i = 0; i < k.length; i++) {
    const slope = i < k.length - 1 ? (k[i + 1].v - k[i].v) / (k[i + 1].t - k[i].t) : 0;
    const d = slope - prevSlope;
    if (Math.abs(d) > 1e-9) terms.push(`${d >= 0 ? "+" : "-"}${n3(Math.abs(d))}*max(0,${variable}-${n3(k[i].t)})`);
    prevSlope = slope;
  }
  return terms.join("");
}

/** Evaluate the same piecewise-linear function in JS (for tests and stills). */
export function piecewiseAt(keys: { t: number; v: number }[], t: number): number {
  if (!keys.length) return 0;
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1];
      const b = keys[i];
      return a.v + ((t - a.t) / (b.t - a.t)) * (b.v - a.v);
    }
  }
  return keys[keys.length - 1].v;
}

// ---------------------------------------------------------------------------
// Crop geometry
// ---------------------------------------------------------------------------

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** Output frame size after an aspect-ratio crop (no upscaling). */
export function cropSize(width: number, height: number, aspect?: ReframeAspect): { width: number; height: number } {
  if (!aspect) return { width: even(width), height: even(height) };
  const [a, b] = aspect.split(":").map(Number);
  const r = a / b;
  if (width / height > r) return { width: even(height * r), height: even(height) };
  return { width: even(width), height: even(width / r) };
}

export interface ReframePlan {
  width: number;
  height: number;
  /** ffmpeg crop x / y (pixels; constants or expressions of t on the EDIT timeline). */
  x: string;
  y: string;
  /** Which strategy was actually used. */
  mode: "faces" | "manual" | "center";
  axis: "x" | "y";
  /** Simplified keyframes: edit time -> normalised crop centre. */
  keys: { t: number; x: number }[];
  /** Fraction of samples that had a face. */
  coverage?: number;
  note?: string;
}

/** Static crop at a normalised focus point (clamped inside the frame). */
export function staticCrop(W: number, H: number, aspect: ReframeAspect, focusX = 0.5, focusY = 0.5): ReframePlan {
  const size = cropSize(W, H, aspect);
  const axis: "x" | "y" = size.width < W ? "x" : "y";
  const x = Math.round(clamp(focusX * W - size.width / 2, 0, W - size.width));
  const y = Math.round(clamp(focusY * H - size.height / 2, 0, H - size.height));
  const f = axis === "x" ? focusX : focusY;
  return { ...size, x: String(x), y: String(y), mode: f === 0.5 ? "center" : "manual", axis, keys: [{ t: 0, x: f }] };
}

/**
 * Build the crop from face samples (SOURCE time) for a cut plan: samples are
 * mapped to the edit timeline, smoothed, simplified and turned into a crop
 * expression. Pure: exported for tests.
 */
export function cropFromFaces(
  samples: FaceSample[],
  plan: Pick<CutPlan, "keep">,
  W: number,
  H: number,
  spec: ReframeSpec,
  smooth: SmoothOptions = {},
): ReframePlan {
  const size = cropSize(W, H, spec.aspect);
  const axis: "x" | "y" = size.width < W ? "x" : "y";
  const span = axis === "x" ? size.width / W : size.height / H;
  const fallback = axis === "x" ? (spec.focusX ?? 0.5) : (spec.focusY ?? 0.4);
  if (span >= 0.999) return staticCrop(W, H, spec.aspect, spec.focusX, spec.focusY);

  // Map to edit time; drop samples inside cuts.
  const raw = subjectTrack(samples, axis);
  const track: TrackPoint[] = [];
  for (const p of raw) {
    const et = mapTime(plan, p.t);
    if (et === null) continue;
    // Faces sit in the upper part of a frame: for a vertical crop keep some headroom below them.
    track.push({ t: et, x: p.x === null ? null : axis === "y" ? p.x + span * 0.15 : p.x });
  }
  track.sort((a, b) => a.t - b.t);
  const seen = track.filter((p) => p.x !== null).length;
  if (!seen) {
    const s = staticCrop(W, H, spec.aspect, spec.focusX, spec.focusY);
    return { ...s, coverage: 0, note: "no faces found; used focusX/centre" };
  }
  const smoothed = smoothTrack(track, { min: span / 2, max: 1 - span / 2, fallback, ...smooth });
  const keys = simplifyTrack(smoothed, smooth.deadzone ? smooth.deadzone / 10 : 0.003);
  const full = axis === "x" ? W : H;
  const cropLen = axis === "x" ? size.width : size.height;
  const pxKeys = keys.map((k) => ({ t: k.t, v: clamp(k.x * full - cropLen / 2, 0, full - cropLen) }));
  const expr = piecewiseExpression(pxKeys);
  const maxOff = full - cropLen;
  const e = /^[\d.]+$/.test(expr) ? String(Math.round(Number(expr))) : `clip(${expr},0,${maxOff})`;
  const centre = axis === "x" ? String(Math.round((H - size.height) / 2)) : String(Math.round((W - size.width) / 2));
  return {
    ...size,
    x: axis === "x" ? e : centre,
    y: axis === "y" ? e : centre,
    mode: "faces",
    axis,
    keys,
    coverage: seen / Math.max(1, track.length),
  };
}

// ---------------------------------------------------------------------------
// Face detection (macOS Vision via Swift)
// ---------------------------------------------------------------------------

const SWIFT_SOURCE = String.raw`// openedit-faces: print Vision face rectangles for every JPEG in a directory as JSON lines.
import Foundation
import Vision
import ImageIO

let args = CommandLine.arguments
guard args.count >= 2 else { FileHandle.standardError.write("usage: openedit-faces <dir>\n".data(using: .utf8)!); exit(2) }
let dir = URL(fileURLWithPath: args[1])
let files = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).filter { $0.hasSuffix(".jpg") }.sorted()
for name in files {
  autoreleasepool {
    let url = dir.appendingPathComponent(name)
    var faces: [[Double]] = []
    if let src = CGImageSourceCreateWithURL(url as CFURL, nil), let img = CGImageSourceCreateImageAtIndex(src, 0, nil) {
      let req = VNDetectFaceRectanglesRequest()
      let handler = VNImageRequestHandler(cgImage: img, options: [:])
      try? handler.perform([req])
      for o in req.results ?? [] {
        let b = o.boundingBox
        faces.append([Double(b.origin.x), Double(1 - b.origin.y - b.size.height), Double(b.size.width), Double(b.size.height), Double(o.confidence)])
      }
    }
    let row: [String: Any] = ["file": name, "faces": faces]
    if let data = try? JSONSerialization.data(withJSONObject: row), let s = String(data: data, encoding: .utf8) { print(s) }
  }
}
`;

const SWIFT_VERSION = "1";

let helperPromise: Promise<{ cmd: string; args: string[] } | null> | null = null;

/** The face helper command, compiling it on first use. null when Vision/Swift is unavailable. */
export function faceHelper(): Promise<{ cmd: string; args: string[] } | null> {
  if (!helperPromise) helperPromise = buildHelper();
  return helperPromise;
}

async function buildHelper(): Promise<{ cmd: string; args: string[] } | null> {
  if (process.platform !== "darwin" || process.env.OPENEDIT_NO_FACES === "1") return null;
  const binDir = join(paths.home(), "bin");
  mkdirSync(binDir, { recursive: true });
  const src = join(binDir, `openedit-faces-v${SWIFT_VERSION}.swift`);
  const bin = join(binDir, `openedit-faces-v${SWIFT_VERSION}`);
  if (!existsSync(src) || readFileSync(src, "utf8") !== SWIFT_SOURCE) writeFileSync(src, SWIFT_SOURCE);
  if (existsSync(bin) && statSync(bin).mtimeMs >= statSync(src).mtimeMs) return { cmd: bin, args: [] };
  try {
    await run("swiftc", ["-O", "-o", bin, src], { timeoutMs: 180_000 });
    if (existsSync(bin)) return { cmd: bin, args: [] };
  } catch {
    /* fall through to the interpreter */
  }
  try {
    await run("swift", ["--version"], { timeoutMs: 30_000 });
    return { cmd: "swift", args: [src] };
  } catch {
    return null;
  }
}

/**
 * Detect faces in `path` every `interval` seconds. Cached per file and interval.
 * Returns null when face detection is unavailable on this machine.
 */
export async function detectFaces(path: string, opts: { interval?: number; width?: number } = {}): Promise<FaceSample[] | null> {
  const interval = opts.interval ?? 0.5;
  const helper = await faceHelper();
  if (!helper) return null;
  const cacheDir = join(paths.cache(), "faces");
  mkdirSync(cacheDir, { recursive: true });
  const cacheFile = join(cacheDir, `${await fileKey(path)}-${interval}.json`);
  if (existsSync(cacheFile)) {
    try {
      return JSON.parse(readFileSync(cacheFile, "utf8")) as FaceSample[];
    } catch {
      /* re-detect */
    }
  }
  const work = mkdtempSync(join(paths.tmp(), "faces-"));
  try {
    await run(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", path,
        "-an", "-sn",
        "-vf", `fps=${n3(1 / interval)}:round=near,scale=${opts.width ?? 640}:-2`,
        "-q:v", "4",
        join(work, "%06d.jpg"),
      ],
      { timeoutMs: 30 * 60_000 },
    );
    const { stdout } = await run(helper.cmd, [...helper.args, work], { timeoutMs: 30 * 60_000 });
    const byFile = new Map<string, FaceBox[]>();
    for (const line of stdout.split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      const row = JSON.parse(line) as { file: string; faces: number[][] };
      byFile.set(row.file, row.faces.map(([x, y, w, h, conf]) => ({ x, y, w, h, conf })));
    }
    const files = readdirSync(work).filter((f) => f.endsWith(".jpg")).sort();
    const samples = files.map((f, i) => ({ t: Math.round(i * interval * 1000) / 1000, faces: byFile.get(f) ?? [] }));
    writeFileSync(cacheFile, JSON.stringify(samples));
    return samples;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Plan the reframe crop for a cut plan. `auto` follows faces when it can and
 * falls back to focusX / centre (the result says which happened).
 */
export async function planReframe(plan: CutPlan, info: MediaInfo, spec: ReframeSpec): Promise<ReframePlan> {
  const W = even(info.width ?? 1920);
  const H = even(info.height ?? 1080);
  const mode = spec.mode ?? "auto";
  if (mode === "center") return staticCrop(W, H, spec.aspect, 0.5, 0.5);
  if (mode === "manual") return staticCrop(W, H, spec.aspect, spec.focusX ?? 0.5, spec.focusY ?? 0.5);
  let samples: FaceSample[] | null = null;
  let note: string | undefined;
  try {
    samples = await detectFaces(plan.source);
    if (!samples) note = "face detection unavailable (needs macOS with Swift/Vision)";
  } catch (e) {
    note = `face detection failed: ${(e as Error).message.split("\n")[0]}`;
  }
  if (!samples) {
    const s = staticCrop(W, H, spec.aspect, spec.focusX ?? 0.5, spec.focusY ?? 0.5);
    return { ...s, note: `${note}; used ${spec.focusX !== undefined ? "focusX" : "centre"}` };
  }
  return cropFromFaces(samples, plan, W, H, spec);
}
