/**
 * analyze_footage: split files into shots and describe every shot the way an editor
 * logs footage (duration, motion and camera move, sharpness, exposure, palette, faces
 * and shot size, Vision labels, feature prints for similarity), cached per file.
 *
 * Pipeline per file: one streaming decode -> FrameStats -> boundaries -> shots;
 * one select pass for 1-3 representative 320px JPEGs per shot; one Vision helper run.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileKey, mediaKind, probe, resolveMediaPath } from "../media.js";
import { paths } from "../paths.js";
import { decodeStats, extractFrames } from "./frames.js";
import {
  type Boundary,
  type BoundaryKind,
  type CameraMove,
  classifyCamera,
  type DetectOptions,
  detectBoundaries,
  exposureLabel,
  type FrameStats,
  PAL_H,
  PAL_W,
  palette,
  repFractions,
  shotSize,
  type ShotSize,
} from "./shots.js";
import { composeSheet, type SheetTile, visionAnalyze, type VisionFrame } from "./vision.js";

export const ANALYSIS_VERSION = 5;

export interface ShotRep {
  /** Source time (s). */
  t: number;
  frame: number;
  /** ≤320px JPEG in the analysis cache. */
  thumb: string;
  /** Feature print, int8-quantised base64 (see fpVector). */
  fpq?: string;
  /** 8x8 saliency grid and box [x,y,w,h]. */
  sal?: number[];
  salBox?: number[];
  edges?: number[];
  /** [x,y,w,h,conf]. */
  faces?: number[][];
  sharp?: number;
}

export interface Shot {
  /** "<file stem>#<index>" (unique within an analysis). */
  id: string;
  file: string;
  index: number;
  start: number;
  end: number;
  duration: number;
  startFrame: number;
  endFrame: number;
  /** How the shot begins. */
  transition: BoundaryKind | "start";
  /** Mean frame-to-frame luma change 0..1 (subject + camera motion). */
  motion: number;
  camera: CameraMove;
  pan: number;
  tilt: number;
  zoom: number;
  shake: number;
  /** Motion at the head and tail of the shot (frame widths/s), for match cuts. */
  headMotion: { dx: number; dy: number };
  tailMotion: { dx: number; dy: number };
  brightness: number;
  exposure: ReturnType<typeof exposureLabel>;
  /** Laplacian variance on the 320px frame (higher = sharper; < ~25 is soft). */
  sharpness?: number;
  palette: { hex: string; weight: number; rgb: [number, number, number] }[];
  faces: { count: number; maxH: number; cx?: number; cy?: number };
  shotSize: ShotSize;
  labels: { label: string; conf: number }[];
  reps: ShotRep[];
}

export interface FootageAnalysis {
  version: number;
  path: string;
  key: string;
  duration: number;
  fps: number;
  width?: number;
  height?: number;
  frames: number;
  vision: boolean;
  shots: Shot[];
  boundaries: Boundary[];
  timing: { decodeSec: number; framesSec: number; visionSec: number; totalSec: number };
}

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mxf", ".mts", ".m2ts", ".mpg", ".mpeg", ".ogv", ".wmv", ".3gp"]);

/** Video files under a folder (recursive, sorted), or the given paths. */
export function collectVideos(input: { paths?: string[]; folder?: string }): string[] {
  const out: string[] = [];
  for (const p of input.paths ?? []) out.push(resolveMediaPath(p));
  if (input.folder) {
    const root = resolveMediaPath(input.folder);
    const walk = (d: string) => {
      for (const e of readdirSync(d).sort()) {
        if (e.startsWith(".")) continue;
        const p = join(d, e);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (VIDEO_EXT.has(extname(e).toLowerCase()) && mediaKind(p) === "video") out.push(p);
      }
    };
    walk(root);
  }
  return [...new Set(out)];
}

export function analysisDir(): string {
  const d = join(paths.home(), "analysis");
  mkdirSync(d, { recursive: true });
  return d;
}

/** Decode a quantised feature print. */
export function fpVector(rep: Pick<ShotRep, "fpq">): number[] | undefined {
  if (!rep.fpq) return undefined;
  const b = Buffer.from(rep.fpq, "base64");
  const v = new Array<number>(b.length);
  for (let i = 0; i < b.length; i++) v[i] = (b[i] << 24) >> 24;
  return v;
}

function quantise(fp: number[] | undefined): string | undefined {
  if (!fp?.length) return undefined;
  // fp is unit-norm * 16; int8 at unit * 400.
  const b = Buffer.alloc(fp.length);
  for (let i = 0; i < fp.length; i++) b[i] = Math.max(-127, Math.min(127, Math.round((fp[i] / 16) * 400))) & 0xff;
  return b.toString("base64");
}

/** Mean feature print over a shot's reps (or one rep). */
export function shotVector(shot: Shot, which: "all" | "first" | "last" = "all"): number[] | undefined {
  const reps = which === "first" ? shot.reps.slice(0, 1) : which === "last" ? shot.reps.slice(-1) : shot.reps;
  const vs = reps.map(fpVector).filter((v): v is number[] => !!v);
  if (!vs.length) return undefined;
  const out = new Array<number>(vs[0].length).fill(0);
  for (const v of vs) for (let i = 0; i < v.length; i++) out[i] += v[i] / vs.length;
  return out;
}

/** Turn boundaries + frame stats into shots (without Vision fields). Pure; exported for tests. */
export function shotsFromStats(st: FrameStats, boundaries: Boundary[], file: string): Omit<Shot, "reps" | "labels" | "faces" | "shotSize" | "sharpness">[] {
  const fps = st.fps || 25;
  const stem = basename(file, extname(file));
  const cuts = [{ frame: 0, kind: "start" as const }, ...boundaries];
  const shots: Omit<Shot, "reps" | "labels" | "faces" | "shotSize" | "sharpness">[] = [];
  for (let i = 0; i < cuts.length; i++) {
    const startFrame = cuts[i].frame;
    const endFrame = i + 1 < cuts.length ? cuts[i + 1].frame : st.count;
    if (endFrame <= startFrame) continue;
    // Inner frames (skip transition spill).
    const a = Math.min(endFrame - 1, startFrame + 2);
    const b = Math.max(a + 1, endFrame - 2);
    let motion = 0;
    let luma = 0;
    let hi = 0;
    let lo = 0;
    for (let f = a; f < b; f++) {
      motion += st.lumaDiff[f];
      luma += st.luma[f];
      hi += st.hi[f];
      lo += st.lo[f];
    }
    const n = Math.max(1, b - a);
    const ms = st.motion.filter((m) => m.f > startFrame + 1 && m.f < endFrame - 1);
    const cam = classifyCamera(ms, fps);
    const edge = Math.max(2, Math.round(fps * 0.6));
    const avg = (xs: typeof ms) =>
      xs.length ? { dx: r3(((xs.reduce((s, m) => s + m.dx, 0) / xs.length) * fps) / 96), dy: r3(((xs.reduce((s, m) => s + m.dy, 0) / xs.length) * fps) / 96) } : { dx: 0, dy: 0 };
    // Palette from up to 24 frames spread over the shot.
    const picks = Math.min(24, endFrame - startFrame);
    const px: number[] = [];
    const per = PAL_W * PAL_H * 3;
    for (let k = 0; k < picks; k++) {
      const f = startFrame + Math.floor(((k + 0.5) * (endFrame - startFrame)) / picks);
      for (let j = 0; j < per; j++) px.push(st.pal[f * per + j]);
    }
    shots.push({
      id: `${stem}#${shots.length + 1}`,
      file,
      index: shots.length + 1,
      start: r3(startFrame / fps),
      end: r3(endFrame / fps),
      duration: r3((endFrame - startFrame) / fps),
      startFrame,
      endFrame,
      transition: cuts[i].kind,
      motion: r3(motion / n),
      camera: cam.move,
      pan: cam.panPerSec,
      tilt: cam.tiltPerSec,
      zoom: cam.zoomPerSec,
      shake: cam.shake,
      headMotion: avg(ms.filter((m) => m.f < startFrame + edge)),
      tailMotion: avg(ms.filter((m) => m.f > endFrame - edge)),
      brightness: r3(luma / n),
      exposure: exposureLabel(luma / n, hi / n, lo / n),
      palette: palette(px, 4),
    });
  }
  return shots;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export interface AnalyzeOptions extends DetectOptions {
  /** Skip Vision (labels, faces, feature prints). */
  noVision?: boolean;
  /** Re-analyse even when cached. */
  force?: boolean;
}

/** Analyse one file (cached under OPENEDIT_HOME/analysis/<key>.json). */
export async function analyzeFile(path: string, o: AnalyzeOptions = {}): Promise<FootageAnalysis> {
  const abs = resolveMediaPath(path);
  const key = await fileKey(abs);
  const dir = analysisDir();
  const cacheFile = join(dir, `${key}.json`);
  if (!o.force && existsSync(cacheFile)) {
    try {
      const c = JSON.parse(readFileSync(cacheFile, "utf8")) as FootageAnalysis;
      if (c.version === ANALYSIS_VERSION && c.shots.every((s) => s.reps.every((r) => existsSync(r.thumb))) && (c.vision || o.noVision)) return c;
    } catch {
      /* re-analyse */
    }
  }
  const t0 = Date.now();
  const info = await probe(abs);
  if (!info.hasVideo) throw new Error(`${abs} has no video stream`);
  const fps = info.fps && info.fps > 0 && info.fps < 240 ? info.fps : 25;
  const st = await decodeStats(abs, fps);
  const t1 = Date.now();
  const boundaries = detectBoundaries(st, o);
  const base = shotsFromStats(st, boundaries, abs);

  // Representative frames.
  const thumbDir = join(dir, key);
  rmSync(thumbDir, { recursive: true, force: true });
  mkdirSync(thumbDir, { recursive: true });
  const reqFrames: number[] = [];
  const reqNames: string[] = [];
  const repPlan = base.map((s) => {
    const len = s.endFrame - s.startFrame;
    const margin = Math.min(Math.floor(len / 2), Math.round(fps * 0.15));
    return repFractions(s.duration).map((fr) => {
      const f = Math.min(s.endFrame - 1 - margin, Math.max(s.startFrame + margin, s.startFrame + Math.round(fr * len)));
      reqFrames.push(f);
      reqNames.push(`s${String(s.index).padStart(4, "0")}-f${f}.jpg`);
      return f;
    });
  });
  const files = await extractFrames(abs, reqFrames, thumbDir, reqNames, 320);
  const t2 = Date.now();
  let vision: Map<string, VisionFrame> | null = null;
  if (!o.noVision) {
    try {
      vision = await visionAnalyze(files.filter(Boolean), paths.tmp());
    } catch (e) {
      process.stderr.write(`openedit: Vision analysis failed: ${(e as Error).message}\n`);
      vision = null;
    }
  }
  const t3 = Date.now();
  let k = 0;
  const shots: Shot[] = base.map((s, i) => {
    const reps: ShotRep[] = repPlan[i].map((f) => {
      const thumb = files[k++];
      const v = vision?.get(thumb);
      return {
        t: r3(f / fps),
        frame: f,
        thumb,
        fpq: quantise(v?.fp),
        sal: v?.sal,
        salBox: v?.salBox,
        edges: v?.edges,
        faces: v?.faces?.filter((x) => (x[4] ?? 1) >= 0.5 && x[3] > 0.03),
        sharp: v?.sharp,
      };
    });
    const labels = new Map<string, number>();
    for (const r of reps) {
      for (const [l, c] of vision?.get(r.thumb)?.labels ?? []) labels.set(l, Math.max(labels.get(l) ?? 0, c));
    }
    const faceCounts = reps.map((r) => r.faces?.length ?? 0);
    const allFaces = reps.flatMap((r) => r.faces ?? []);
    const big = allFaces.reduce<number[] | undefined>((a, f) => (!a || f[3] > a[3] ? f : a), undefined);
    const sharpVals = reps.map((r) => r.sharp).filter((x): x is number => typeof x === "number");
    return {
      ...s,
      sharpness: sharpVals.length ? Math.round(Math.max(...sharpVals) * 10) / 10 : undefined,
      faces: { count: Math.max(0, ...faceCounts), maxH: big ? r3(big[3]) : 0, cx: big ? r3(big[0] + big[2] / 2) : undefined, cy: big ? r3(big[1] + big[3] / 2) : undefined },
      shotSize: vision ? shotSize(big?.[3]) : "no-faces",
      labels: [...labels.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([label, conf]) => ({ label, conf })),
      reps,
    };
  });
  const result: FootageAnalysis = {
    version: ANALYSIS_VERSION,
    path: abs,
    key,
    duration: r3(st.count / fps),
    fps,
    width: info.width,
    height: info.height,
    frames: st.count,
    vision: !!vision,
    shots,
    boundaries,
    timing: { decodeSec: (t1 - t0) / 1000, framesSec: (t2 - t1) / 1000, visionSec: (t3 - t2) / 1000, totalSec: (Date.now() - t0) / 1000 },
  };
  writeFileSync(cacheFile, JSON.stringify(result));
  return result;
}

/** Analyse many files, two at a time. */
export async function analyzeMany(files: string[], o: AnalyzeOptions = {}): Promise<FootageAnalysis[]> {
  const out: FootageAnalysis[] = new Array(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      out[i] = await analyzeFile(files[i], o);
    }
  };
  await Promise.all([worker(), worker()]);
  return out;
}

const mmss = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

/** One line per shot for Claude. */
export function shotLine(s: Shot): string {
  const labels = s.labels.slice(0, 4).map((l) => l.label).join(", ");
  const faces = s.faces.count ? `${s.faces.count} face${s.faces.count > 1 ? "s" : ""} (${s.shotSize})` : "no faces";
  const sharp = s.sharpness === undefined ? "" : s.sharpness < 25 ? " soft" : "";
  return `${s.id} ${mmss(s.start)}–${mmss(s.end)} ${s.duration.toFixed(1)}s ${s.transition === "start" ? "" : `[${s.transition}] `}${s.camera}, motion ${s.motion.toFixed(3)}, ${s.exposure}${sharp}, ${faces}, ${s.palette
    .slice(0, 3)
    .map((p) => p.hex)
    .join(" ")}${labels ? ` | ${labels}` : ""}`;
}

const SIZE_COLOR: Record<ShotSize, string> = {
  "extreme-close-up": "#e5484d",
  "close-up": "#f76b15",
  medium: "#ffc53d",
  wide: "#46a758",
  "no-faces": "#3e63dd",
};

/** Contact sheet(s): the middle representative frame of each shot, labelled. */
export async function footageSheets(analyses: FootageAnalysis[], outBase: string, o: { maxTiles?: number; perSheet?: number } = {}): Promise<string[]> {
  const shots = analyses.flatMap((a) => a.shots);
  const max = o.maxTiles ?? 96;
  const pick = shots.length <= max ? shots : Array.from({ length: max }, (_, i) => shots[Math.floor((i * shots.length) / max)]);
  const per = o.perSheet ?? 48;
  const out: string[] = [];
  for (let i = 0; i < pick.length; i += per) {
    const tiles: SheetTile[] = pick.slice(i, i + per).map((s) => {
      const rep = s.reps[Math.floor(s.reps.length / 2)];
      return {
        file: rep.thumb,
        label: `${s.id} @${mmss(s.start)}`,
        sub: `${s.duration.toFixed(1)}s ${s.shotSize === "no-faces" ? "" : `${s.shotSize} `}${s.camera}${s.labels[0] ? ` · ${s.labels.slice(0, 2).map((l) => l.label).join(", ")}` : ""}`,
        color: SIZE_COLOR[s.shotSize],
      };
    });
    const file = `${outBase}-${out.length + 1}.jpg`;
    await composeSheet(tiles, file, { cols: 6, title: `${analyses.length === 1 ? basename(analyses[0].path) : `${analyses.length} files`} — shots ${i + 1}-${i + tiles.length} of ${pick.length}${pick.length < shots.length ? ` (sampled from ${shots.length})` : ""}` });
    out.push(file);
  }
  return out;
}

/** Find a shot by id across analyses. */
export function findShot(analyses: FootageAnalysis[], id: string): Shot | undefined {
  for (const a of analyses) for (const s of a.shots) if (s.id === id) return s;
  return undefined;
}

export function sheetBase(name: string): string {
  const d = join(analysisDir(), "sheets");
  mkdirSync(d, { recursive: true });
  return resolve(d, `${name.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40)}-${Date.now()}`);
}
