import { createHash } from "node:crypto";
import { existsSync, renameSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { MediaInfo } from "../hosts/types.js";
import { run } from "./exec.js";
import { paths } from "./paths.js";

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

function parseRate(rate?: string): number | undefined {
  if (!rate) return undefined;
  const [n, d] = rate.split("/").map(Number);
  if (!n || !d) return undefined;
  return Math.round((n / d) * 1000) / 1000;
}

/** Resolve "~" and relative paths; throw a clear error when the file is missing. */
export function resolveMediaPath(p: string): string {
  const expanded = p.startsWith("~/") ? join(process.env.HOME ?? "", p.slice(2)) : p;
  const abs = resolve(expanded);
  if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);
  return abs;
}

/** Inspect a media file with ffprobe. */
export async function probe(path: string): Promise<MediaInfo> {
  const abs = resolveMediaPath(path);
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    abs,
  ]);
  const data = JSON.parse(stdout) as FfprobeOutput;
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === "audio");
  const duration =
    Number(data.format?.duration) || Number(video?.duration) || Number(audio?.duration) || 0;
  const info: MediaInfo = {
    path: abs,
    duration,
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
  };
  if (video) {
    info.width = video.width;
    info.height = video.height;
    info.fps = parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate);
    if (video.codec_name) info.videoCodec = video.codec_name;
  }
  return info;
}

/**
 * Stable cache key for a file: content-addressed by path, size, mtime and a
 * hash of the first/last 64KB (cheap even for multi-GB camera files).
 */
export async function fileKey(path: string): Promise<string> {
  const abs = resolveMediaPath(path);
  const st = statSync(abs);
  const h = createHash("sha1");
  h.update(`${abs}|${st.size}|${st.mtimeMs}`);
  const { open } = await import("node:fs/promises");
  const fh = await open(abs, "r");
  try {
    const chunk = Buffer.alloc(Math.min(65536, st.size));
    await fh.read(chunk, 0, chunk.length, 0);
    h.update(chunk);
    if (st.size > chunk.length) {
      await fh.read(chunk, 0, chunk.length, Math.max(0, st.size - chunk.length));
      h.update(chunk);
    }
  } finally {
    await fh.close();
  }
  const stem = basename(abs, extname(abs)).replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40);
  return `${stem}-${h.digest("hex").slice(0, 12)}`;
}

/** Extract 16 kHz mono PCM WAV (what whisper.cpp wants) into the cache. */
export async function extractAudio(path: string): Promise<string> {
  const abs = resolveMediaPath(path);
  const out = join(paths.audioCache(), `${await fileKey(abs)}.wav`);
  if (existsSync(out)) return out;
  const tmp = `${out}.part.wav`;
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", abs,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    tmp,
  ]);
  renameSync(tmp, out);
  return out;
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".aif", ".aiff"]);

export function mediaKind(path: string): "image" | "audio" | "video" {
  const ext = extname(path).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  return "video";
}
