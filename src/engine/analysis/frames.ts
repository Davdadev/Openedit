/**
 * One streaming ffmpeg decode per file: every frame scaled to 96x54 RGB and
 * reduced on the fly to the per-frame statistics shot detection needs
 * (FrameStats). Nothing large is kept in memory: ~1 KB per frame.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { currentSignal, run, trackChild } from "../exec.js";
import { estimateMotion, type FrameStats, PAL_H, PAL_W, THUMB_H, THUMB_W, TINY_H, TINY_W } from "./shots.js";

const FRAME_BYTES = TINY_W * TINY_H * 3;

/** Grow-able typed array helpers. */
class F32 {
  a = new Float32Array(4096);
  n = 0;
  push(v: number) {
    if (this.n === this.a.length) {
      const b = new Float32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done() {
    return this.a.slice(0, this.n);
  }
}
class U8 {
  a: Uint8Array;
  n = 0;
  constructor(cap: number) {
    this.a = new Uint8Array(cap);
  }
  reserve(k: number) {
    if (this.n + k > this.a.length) {
      const b = new Uint8Array(Math.max(this.a.length * 2, this.n + k));
      b.set(this.a);
      this.a = b;
    }
  }
  done() {
    return this.a.slice(0, this.n);
  }
}

/** Reduce raw 96x54 RGB frames to FrameStats. Exported for tests (feed synthetic frames). */
export class FrameAccumulator {
  private lumaDiff = new F32();
  private histDiff = new F32();
  private luma = new F32();
  private hi = new F32();
  private lo = new F32();
  private thumbs = new U8(THUMB_W * THUMB_H * 4096);
  private pal = new U8(PAL_W * PAL_H * 3 * 4096);
  private motion: FrameStats["motion"] = [];
  private prevY: Uint8Array | null = null;
  private prevHist: Float32Array | null = null;
  private count = 0;
  constructor(
    readonly fps: number,
    /** Motion sample every `motionStep` frames. */
    readonly motionStep = Math.max(1, Math.round(fps / 6)),
  ) {}

  push(rgb: Uint8Array): void {
    const N = TINY_W * TINY_H;
    const Y = new Uint8Array(N);
    const hist = new Float32Array(64);
    let ysum = 0;
    let hi = 0;
    let lo = 0;
    for (let i = 0, p = 0; i < N; i++, p += 3) {
      const r = rgb[p];
      const g = rgb[p + 1];
      const b = rgb[p + 2];
      const y = (77 * r + 150 * g + 29 * b) >> 8;
      Y[i] = y;
      ysum += y;
      if (y >= 250) hi++;
      else if (y <= 6) lo++;
      hist[((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6)]++;
    }
    let ld = 0;
    let hd = 0;
    if (this.prevY && this.prevHist) {
      let s = 0;
      for (let i = 0; i < N; i++) s += Math.abs(Y[i] - this.prevY[i]);
      ld = s / N / 255;
      let h = 0;
      for (let i = 0; i < 64; i++) h += Math.abs(hist[i] - this.prevHist[i]);
      hd = h / (2 * N);
    }
    this.lumaDiff.push(ld);
    this.histDiff.push(hd);
    this.luma.push(ysum / N / 255);
    this.hi.push(hi / N);
    this.lo.push(lo / N);
    // 32x18 luma (3x3 boxes).
    this.thumbs.reserve(THUMB_W * THUMB_H);
    const fx = TINY_W / THUMB_W;
    const fy = TINY_H / THUMB_H;
    for (let ty = 0; ty < THUMB_H; ty++) {
      for (let tx = 0; tx < THUMB_W; tx++) {
        let s = 0;
        let c = 0;
        for (let y = ty * fy; y < (ty + 1) * fy; y++) for (let x = tx * fx; x < (tx + 1) * fx; x++, c++) s += Y[y * TINY_W + x];
        this.thumbs.a[this.thumbs.n++] = Math.round(s / c);
      }
    }
    // 16x9 RGB (6x6 boxes).
    this.pal.reserve(PAL_W * PAL_H * 3);
    const px = TINY_W / PAL_W;
    const py = TINY_H / PAL_H;
    for (let ty = 0; ty < PAL_H; ty++) {
      for (let tx = 0; tx < PAL_W; tx++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let c = 0;
        for (let y = ty * py; y < (ty + 1) * py; y++) {
          for (let x = tx * px; x < (tx + 1) * px; x++, c++) {
            const p = (y * TINY_W + x) * 3;
            r += rgb[p];
            g += rgb[p + 1];
            b += rgb[p + 2];
          }
        }
        this.pal.a[this.pal.n++] = Math.round(r / c);
        this.pal.a[this.pal.n++] = Math.round(g / c);
        this.pal.a[this.pal.n++] = Math.round(b / c);
      }
    }
    if (this.prevY && this.count % this.motionStep === 0) {
      const m = estimateMotion(this.prevY, Y, TINY_W, TINY_H, 4);
      this.motion.push({ f: this.count, dx: round3(m.dx), dy: round3(m.dy), zoom: round4(m.zoom), resid: round3(m.resid) });
    }
    this.prevY = Y;
    this.prevHist = hist;
    this.count++;
  }

  result(): FrameStats {
    return {
      count: this.count,
      fps: this.fps,
      lumaDiff: this.lumaDiff.done(),
      histDiff: this.histDiff.done(),
      luma: this.luma.done(),
      hi: this.hi.done(),
      lo: this.lo.done(),
      thumbs: this.thumbs.done(),
      pal: this.pal.done(),
      motion: this.motion,
    };
  }
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Decode `path` once and compute FrameStats (streaming). */
export function decodeStats(path: string, fps: number): Promise<FrameStats> {
  return new Promise((resolve, reject) => {
    const signal = currentSignal();
    if (signal?.aborted) return reject(new Error("cancelled"));
    const child = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-threads", "0", "-i", path, "-an", "-sn", "-dn", "-vf", `scale=${TINY_W}:${TINY_H}:flags=area,format=rgb24`, "-f", "rawvideo", "-"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    trackChild(child);
    const acc = new FrameAccumulator(fps);
    let pending: Buffer = Buffer.alloc(0);
    let err = "";
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, d]) : d;
      let off = 0;
      while (pending.length - off >= FRAME_BYTES) {
        acc.push(new Uint8Array(pending.buffer, pending.byteOffset + off, FRAME_BYTES));
        off += FRAME_BYTES;
      }
      pending = off ? Buffer.from(pending.subarray(off)) : pending;
    });
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(new Error("cancelled"));
      if (code !== 0 && acc.result().count === 0) return reject(new Error(`ffmpeg decode failed (${code}): ${err.trim().split("\n").slice(-3).join(" ")}`));
      resolve(acc.result());
    });
  });
}

/**
 * Extract specific frames (decoded-frame indices) as ≤`width`px JPEGs, one decode pass.
 * Returns the output paths in the order of `frames` (duplicates share a file).
 */
export async function extractFrames(path: string, frames: number[], outDir: string, names: string[], width = 320): Promise<string[]> {
  mkdirSync(outDir, { recursive: true });
  const uniq = [...new Set(frames)].sort((a, b) => a - b);
  if (!uniq.length) return [];
  const tmp = join(outDir, `.x${process.pid}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    // Chunk the select expression: very long expressions are slow to evaluate per frame.
    const chunks: number[][] = [];
    for (let i = 0; i < uniq.length; i += 400) chunks.push(uniq.slice(i, i + 400));
    let idx = 0;
    const produced: string[] = [];
    for (const chunk of chunks) {
      const expr = chunk.map((f) => `eq(n\\,${f})`).join("+");
      const first = chunk[0];
      const last = chunk[chunk.length - 1];
      // select between first..last only (cheap guard), then the exact frames.
      await run(
        "ffmpeg",
        [
          "-hide_banner", "-loglevel", "error", "-y", "-threads", "0", "-i", path, "-an", "-sn", "-dn",
          "-vf", `select='between(n\\,${first}\\,${last})*(${expr})',scale='min(${width},iw)':-2:flags=bicubic`,
          "-fps_mode", "passthrough", "-q:v", "4", "-start_number", String(idx), join(tmp, "%06d.jpg"),
        ],
        { timeoutMs: 60 * 60_000 },
      );
      idx += chunk.length;
    }
    const got = readdirSync(tmp).filter((f) => f.endsWith(".jpg")).sort();
    const byFrame = new Map<number, string>();
    uniq.forEach((f, i) => {
      const src = got[i] ? join(tmp, got[i]) : undefined;
      if (!src) return;
      const name = names[frames.indexOf(f)] ?? `f${f}.jpg`;
      const dst = join(outDir, name);
      renameSync(src, dst);
      byFrame.set(f, dst);
      produced.push(dst);
    });
    return frames.map((f) => byFrame.get(f) ?? "");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
