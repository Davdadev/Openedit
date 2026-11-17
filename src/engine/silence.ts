import type { TimeRange } from "../hosts/types.js";
import { run } from "./exec.js";
import { probe, resolveMediaPath } from "./media.js";
import { type AdaptiveLevels, adaptiveLevels, analyzeEnergy, framesToSilences } from "./vad.js";

export interface SilenceOptions {
  /**
   * Anything quieter than this (dBFS) counts as silence. Omit for an adaptive
   * threshold measured from the clip (noise floor / speech level).
   */
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

export interface SilenceResult {
  silences: TimeRange[];
  /** Threshold actually used, dBFS. */
  thresholdDb: number;
  adaptive: boolean;
  levels?: AdaptiveLevels;
}

/**
 * Detect silent ranges. With an explicit `thresholdDb` this is ffmpeg
 * silencedetect; without one, the threshold adapts to the clip:
 * clamp(max(floor + 6, speech - 30), -60, -20) on the voice band's 50 ms RMS.
 */
export async function detectSilencesDetailed(path: string, opts: SilenceOptions = {}): Promise<SilenceResult> {
  const abs = resolveMediaPath(path);
  const minDuration = opts.minDuration ?? 0.5;
  const info = await probe(abs);
  if (!info.hasAudio) throw new Error(`No audio stream in ${abs}`);
  if (opts.thresholdDb === undefined) {
    const env = await analyzeEnergy(abs);
    const levels = adaptiveLevels(env.db);
    return {
      silences: framesToSilences(env, levels.thresholdDb, minDuration, info.duration),
      thresholdDb: levels.thresholdDb,
      adaptive: true,
      levels,
    };
  }
  const { stderr } = await run("ffmpeg", [
    "-hide_banner", "-nostats",
    "-i", abs,
    "-map", "0:a:0",
    "-af", `silencedetect=noise=${opts.thresholdDb}dB:d=${minDuration}`,
    "-f", "null", "-",
  ]);
  return { silences: parseSilenceDetect(stderr, info.duration), thresholdDb: opts.thresholdDb, adaptive: false };
}

/** Detect silent ranges (see detectSilencesDetailed). */
export async function detectSilences(path: string, opts: SilenceOptions = {}): Promise<TimeRange[]> {
  return (await detectSilencesDetailed(path, opts)).silences;
}
