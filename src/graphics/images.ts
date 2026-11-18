/**
 * Small image helpers for the graphics catalog: thumbnails (<= 320 px), labelled
 * contact sheets and frame strips. Built with ffmpeg + raw RGB compositing in JS, so
 * no ffmpeg drawtext/fontconfig is needed (labels use a built-in 5x7 bitmap font).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const FFMPEG = () => process.env.FFMPEG_PATH || "ffmpeg";

export function ffmpegBuffer(args: string[], input?: Buffer, timeoutMs = 60_000): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const child = spawn(FFMPEG(), ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout!.on("data", (d: Buffer) => out.push(d));
    child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) ok(Buffer.concat(out));
      else fail(new Error(`ffmpeg exited ${code}: ${err.slice(-600)}`));
    });
    if (input && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

const BG = "0x1b1c20";

/** Decode an image/video frame into a WxH rgb24 buffer (letterboxed on a dark background). */
export async function rawFrame(src: string, w: number, h: number, at = 0, bg = BG): Promise<Buffer> {
  const isVideo = /\.(mp4|mov|m4v|webm|mkv)$/i.test(src);
  const args = [...(isVideo && at > 0 ? ["-ss", String(at)] : []), "-i", src, "-f", "lavfi", "-i", `color=c=${bg}:s=${w}x${h}`];
  const fc = `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];[1:v][fg]overlay=(W-w)/2:(H-h)/2:format=auto,format=rgb24`;
  const buf = await ffmpegBuffer([...args, "-filter_complex", fc, "-frames:v", "1", "-f", "rawvideo", "-"], undefined, 30_000);
  if (buf.length < w * h * 3) throw new Error(`could not decode ${src}`);
  return buf.subarray(0, w * h * 3);
}

/** Write a JPEG thumbnail at most `width` px wide (keeps aspect). `at` = seconds into a video. */
export async function makeThumb(src: string, out: string, opts: { width?: number; at?: number } = {}): Promise<string> {
  const width = opts.width ?? 320;
  const isVideo = /\.(mp4|mov|m4v|webm|mkv)$/i.test(src);
  mkdirSync(dirname(out), { recursive: true });
  const seek = isVideo ? ["-ss", String(opts.at ?? 1)] : [];
  // Flatten alpha onto a dark grey so transparent .mogrt thumbs stay readable.
  const fc = `color=c=${BG}:s=16x16[bg];[0:v]scale='min(${width},iw)':-2[fg];[bg][fg]scale2ref[bg2][fg2];[bg2][fg2]overlay=format=auto,format=yuvj420p`;
  let buf: Buffer;
  try {
    buf = await ffmpegBuffer([...seek, "-i", src, "-filter_complex", fc, "-frames:v", "1", "-q:v", "4", "-f", "mjpeg", "-"], undefined, 30_000);
  } catch (e) {
    if (!isVideo) throw e;
    // Short clip: seek past the end yields nothing; take the first frame.
    buf = await ffmpegBuffer(["-i", src, "-filter_complex", fc, "-frames:v", "1", "-q:v", "4", "-f", "mjpeg", "-"], undefined, 30_000);
  }
  if (!buf.length) throw new Error(`no frame from ${src}`);
  writeFileSync(out, buf);
  return out;
}

export async function encodeJpeg(raw: Buffer, w: number, h: number, quality = 4): Promise<Buffer> {
  return ffmpegBuffer(["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-i", "-", "-frames:v", "1", "-q:v", String(quality), "-f", "mjpeg", "-"], raw);
}

// ------------------------------------------------------------------ bitmap text

const GLYPHS: Record<string, string> = {
  A: "01110 10001 10001 11111 10001 10001 10001", B: "11110 10001 10001 11110 10001 10001 11110",
  C: "01110 10001 10000 10000 10000 10001 01110", D: "11100 10010 10001 10001 10001 10010 11100",
  E: "11111 10000 10000 11110 10000 10000 11111", F: "11111 10000 10000 11110 10000 10000 10000",
  G: "01110 10001 10000 10111 10001 10001 01111", H: "10001 10001 10001 11111 10001 10001 10001",
  I: "01110 00100 00100 00100 00100 00100 01110", J: "00111 00010 00010 00010 00010 10010 01100",
  K: "10001 10010 10100 11000 10100 10010 10001", L: "10000 10000 10000 10000 10000 10000 11111",
  M: "10001 11011 10101 10101 10001 10001 10001", N: "10001 10001 11001 10101 10011 10001 10001",
  O: "01110 10001 10001 10001 10001 10001 01110", P: "11110 10001 10001 11110 10000 10000 10000",
  Q: "01110 10001 10001 10001 10101 10010 01101", R: "11110 10001 10001 11110 10100 10010 10001",
  S: "01111 10000 10000 01110 00001 00001 11110", T: "11111 00100 00100 00100 00100 00100 00100",
  U: "10001 10001 10001 10001 10001 10001 01110", V: "10001 10001 10001 10001 10001 01010 00100",
  W: "10001 10001 10001 10101 10101 10101 01010", X: "10001 10001 01010 00100 01010 10001 10001",
  Y: "10001 10001 10001 01010 00100 00100 00100", Z: "11111 00001 00010 00100 01000 10000 11111",
  "0": "01110 10001 10011 10101 11001 10001 01110", "1": "00100 01100 00100 00100 00100 00100 01110",
  "2": "01110 10001 00001 00010 00100 01000 11111", "3": "11111 00010 00100 00010 00001 10001 01110",
  "4": "00010 00110 01010 10010 11111 00010 00010", "5": "11111 10000 11110 00001 00001 10001 01110",
  "6": "00110 01000 10000 11110 10001 10001 01110", "7": "11111 00001 00010 00100 01000 01000 01000",
  "8": "01110 10001 10001 01110 10001 10001 01110", "9": "01110 10001 10001 01111 00001 00010 01100",
  "-": "00000 00000 00000 11111 00000 00000 00000", ".": "00000 00000 00000 00000 00000 01100 01100",
  "/": "00001 00010 00010 00100 01000 01000 10000", ":": "00000 01100 01100 00000 01100 01100 00000",
  "#": "01010 01010 11111 01010 11111 01010 01010", "(": "00010 00100 01000 01000 01000 00100 00010",
  ")": "01000 00100 00010 00010 00010 00100 01000", "'": "00100 00100 01000 00000 00000 00000 00000",
  "&": "01100 10010 10100 01000 10101 10010 01101", "+": "00000 00100 00100 11111 00100 00100 00000",
  _: "00000 00000 00000 00000 00000 00000 11111", "!": "00100 00100 00100 00100 00100 00000 00100",
  "?": "01110 10001 00001 00010 00100 00000 00100", " ": "00000 00000 00000 00000 00000 00000 00000",
};

type RGB = [number, number, number];

function fillRect(buf: Buffer, W: number, x0: number, y0: number, w: number, h: number, c: RGB, alpha = 1): void {
  const H = buf.length / 3 / W;
  for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) {
      const i = (y * W + x) * 3;
      buf[i] = Math.round(buf[i]! * (1 - alpha) + c[0] * alpha);
      buf[i + 1] = Math.round(buf[i + 1]! * (1 - alpha) + c[1] * alpha);
      buf[i + 2] = Math.round(buf[i + 2]! * (1 - alpha) + c[2] * alpha);
    }
  }
}

/** Draw text with the bitmap font; returns the drawn width. Clips at maxWidth with "..". */
export function drawText(buf: Buffer, W: number, x: number, y: number, text: string, color: RGB, scale = 2, maxWidth = Infinity): number {
  const adv = 6 * scale;
  let s = text.toUpperCase();
  const fit = Math.floor((maxWidth + scale) / adv);
  if (s.length > fit) s = s.slice(0, Math.max(0, fit - 2)) + "..";
  let cx = x;
  for (const ch of s) {
    const g = GLYPHS[ch] ?? GLYPHS["?"]!;
    g.split(" ").forEach((row, ry) => {
      for (let rx = 0; rx < 5; rx++) if (row[rx] === "1") fillRect(buf, W, cx + rx * scale, y + ry * scale, scale, scale, color);
    });
    cx += adv;
  }
  return cx - x;
}

export interface SheetTile {
  image?: string;
  label: string;
  badge?: string;
  dim?: boolean;
}

/** A labelled grid of thumbnails (JPEG). Labels are "n. name" so the text list can refer to them. */
export async function contactSheet(tiles: SheetTile[], opts: { cols?: number; tileW?: number; tileH?: number } = {}): Promise<Buffer> {
  const n = Math.max(1, tiles.length);
  const cols = Math.min(opts.cols ?? 4, n);
  const tw = opts.tileW ?? 320;
  const th = opts.tileH ?? 180;
  const label = 26;
  const gap = 6;
  const rows = Math.ceil(n / cols);
  const W = cols * tw + (cols + 1) * gap;
  const H = rows * (th + label) + (rows + 1) * gap;
  const buf = Buffer.alloc(W * H * 3);
  fillRect(buf, W, 0, 0, W, H, [17, 17, 19]);
  const raws = await Promise.all(tiles.map((t) => (t.image && existsSync(t.image) ? rawFrame(t.image, tw, th).catch(() => null) : Promise.resolve(null))));
  tiles.forEach((t, i) => {
    const cx = gap + (i % cols) * (tw + gap);
    const cy = gap + Math.floor(i / cols) * (th + label + gap);
    const raw = raws[i];
    if (raw) {
      for (let y = 0; y < th; y++) raw.copy(buf, ((cy + y) * W + cx) * 3, y * tw * 3, (y + 1) * tw * 3);
    } else {
      fillRect(buf, W, cx, cy, tw, th, [38, 39, 45]);
      drawText(buf, W, cx + 12, cy + th / 2 - 7, "NO PREVIEW", [120, 120, 128], 2);
    }
    if (t.dim) fillRect(buf, W, cx, cy, tw, th, [10, 10, 12], 0.55);
    fillRect(buf, W, cx, cy + th, tw, label, [30, 31, 36]);
    const num = `${i + 1}.`;
    const nw = drawText(buf, W, cx + 6, cy + th + 6, num, [255, 196, 64], 2);
    let right = tw - 8;
    if (t.badge) {
      const bw = t.badge.length * 6 * 2 + 6;
      fillRect(buf, W, cx + tw - bw - 4, cy + th + 4, bw, 18, t.dim ? [120, 52, 52] : [52, 92, 160]);
      drawText(buf, W, cx + tw - bw - 1, cy + th + 6, t.badge, [255, 255, 255], 2);
      right = tw - bw - 10;
    }
    drawText(buf, W, cx + 10 + nw, cy + th + 6, t.label, [235, 235, 240], 2, right - nw - 10);
  });
  return encodeJpeg(buf, W, H);
}

/** Frames side by side (JPEG), each fitted into tw x th, with time labels. */
export async function frameStrip(frames: { path: string; label?: string }[], opts: { tileW?: number; tileH?: number; cols?: number } = {}): Promise<Buffer> {
  return contactSheet(
    frames.map((f) => ({ image: f.path, label: f.label ?? "" })),
    { cols: opts.cols ?? Math.min(frames.length, 4), tileW: opts.tileW ?? 480, tileH: opts.tileH ?? 270 },
  );
}
