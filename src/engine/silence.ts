import type { TimeRange } from "../hosts/types.js";
import { run } from "./exec.js";
import { probe, resolveMediaPath } from "./media.js";

export interface SilenceOptions {
  /** Anything quieter than this (dBFS) counts as silence. Default -35. */
  thresholdDb?: number;
  /** Minimum silence length in seconds. Default 0.5. */
  minDuration?: number;
}

/**
 * Parse ffmpeg `silencedetect` log output into ranges. A trailing
 * `silence_start` with no matching end runs to `duration`.
 */
export function parseSilenceDetect(log: string, duration: number): TimeRange[] {
  const out: TimeRange[] = [];
  let open: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+(?:e-?\d+)?)/.exec(line);
    if (s) {
      open = Math.max(0, Number(s[1]));
      continue;
    }
    const e = /silence_end:\s*(-?[\d.]+(?:e-?\d+)?)/.exec(line);
    if (e) {
      const end = Number(e[1]);
      const start = open ?? 0;
      if (end > start) out.push({ start: round3(start), end: round3(end) });
      open = null;
    }
  }
  if (open !== null && duration > open) out.push({ start: round3(open), end: round3(duration) });
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Detect silent ranges in a media file's audio with ffmpeg silencedetect. */
export async function detectSilences(path: string, opts: SilenceOptions = {}): Promise<TimeRange[]> {
  const abs = resolveMediaPath(path);
  const thresholdDb = opts.thresholdDb ?? -35;
  const minDuration = opts.minDuration ?? 0.5;
  const info = await probe(abs);
  if (!info.hasAudio) throw new Error(`No audio stream in ${abs}`);
  const { stderr } = await run("ffmpeg", [
    "-hide_banner", "-nostats",
    "-i", abs,
    "-map", "0:a:0",
    "-af", `silencedetect=noise=${thresholdDb}dB:d=${minDuration}`,
    "-f", "null", "-",
  ]);
  return parseSilenceDetect(stderr, info.duration);
}
