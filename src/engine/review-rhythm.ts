/**
 * Rhythm review: does the edit move with its music, are split edits sane, do speed ramps read.
 *  - beat alignment: share of picture cuts within +-40 ms (or +-1 frame, whichever is larger)
 *    of a beat of the music under them; cuts that land 2-6 frames late are called out (the
 *    classic "late cut" that feels sloppy), cuts on downbeats counted;
 *  - J/L counts and warnings (sound bridges, long single-camera splits);
 *  - ramp sanity: no > 8x speed jumps, no sub-4-frame ramp pieces (stutter), no unblended
 *    deep slow motion.
 * rhythmStats / rhythmWarnings are pure; measureCuts runs ffmpeg's scene detector on a render.
 */
import type { CutPlan } from "../hosts/types.js";
import { type BeatAnalysis, nearest } from "./beats.js";
import { run } from "./exec.js";
import { splitCounts, splitWarnings } from "./jl.js";
import { rampSanity, type RampSanity } from "./speed.js";

export interface MusicUnder {
  /** Beat / downbeat times on the EDIT timeline. */
  beats: number[];
  downbeats: number[];
  tempo?: number;
  source?: string;
}

export interface RhythmStats {
  music?: { source?: string; tempo?: number };
  cuts: number;
  /** Share of cuts within tolerance of a beat (0..1), when music is present. */
  beatAligned?: number;
  onDownbeat?: number;
  tolerance: number;
  /** Mean absolute cut-to-beat offset (ms) and the late cuts (2-6 frames after a beat). */
  meanOffsetMs?: number;
  lateCuts: { at: number; ms: number }[];
  splits: { J: number; L: number; meanSeconds: number };
  ramps?: RampSanity;
}

/** Map a music file's beats onto the edit timeline for a placement at `at` (edit s) starting at `sourceIn`. */
export function beatsOnTimeline(a: Pick<BeatAnalysis, "beats" | "downbeats">, at = 0, sourceIn = 0, end = Infinity, loop = false, duration = Infinity): MusicUnder {
  const map = (ts: number[]) => {
    const out: number[] = [];
    const period = loop && Number.isFinite(duration) ? duration : Infinity;
    for (let rep = 0; rep < (Number.isFinite(period) ? 50 : 1); rep++) {
      for (const t of ts) {
        const e = at + (t - sourceIn) + (Number.isFinite(period) ? rep * (period - sourceIn) : 0);
        if (t >= sourceIn && e >= 0 && e <= end) out.push(e);
      }
      if (at + (rep + 1) * (period - sourceIn) > end) break;
    }
    return out.sort((x, y) => x - y);
  };
  return { beats: map(a.beats), downbeats: map(a.downbeats) };
}

/** Rhythm statistics for cut times (edit s) over the music (pure). */
export function rhythmStats(cuts: number[], o: { music?: MusicUnder; plan?: Pick<CutPlan, "keep"> & Partial<Pick<CutPlan, "splits" | "ramps" | "freezes">>; fps?: number }): RhythmStats {
  const fps = o.fps ?? 30;
  const tol = Math.max(0.04, 1 / fps);
  const stats: RhythmStats = { cuts: cuts.length, tolerance: tol, lateCuts: [], splits: splitCounts(o.plan ?? {}) };
  if (o.music?.beats.length && cuts.length) {
    const offs = cuts.map((c) => {
      const b = nearest(o.music!.beats, c) as number;
      return { c, d: c - b };
    });
    stats.music = { source: o.music.source, tempo: o.music.tempo };
    stats.beatAligned = round3(offs.filter((x) => Math.abs(x.d) <= tol + 1e-9).length / cuts.length);
    stats.onDownbeat = round3(cuts.filter((c) => Math.abs((nearest(o.music!.downbeats, c) ?? Infinity) - c) <= tol + 1e-9).length / cuts.length);
    stats.meanOffsetMs = Math.round((offs.reduce((a, x) => a + Math.abs(x.d), 0) / offs.length) * 1000);
    stats.lateCuts = offs.filter((x) => x.d > 1.5 / fps && x.d <= 6 / fps).map((x) => ({ at: round3(x.c), ms: Math.round(x.d * 1000) }));
  }
  if (o.plan && (o.plan.ramps?.length || o.plan.freezes?.length)) stats.ramps = rampSanity(o.plan, fps);
  return stats;
}

/** Warnings an editor would raise about rhythm (pure). */
export function rhythmWarnings(s: RhythmStats, o: { plan?: Pick<CutPlan, "keep"> & Partial<Pick<CutPlan, "splits">>; dialogue?: boolean; singleCamera?: boolean } = {}): string[] {
  const w: string[] = [];
  if (s.beatAligned !== undefined && !o.dialogue) {
    if (s.beatAligned < 0.6 && s.cuts >= 4) w.push(`only ${Math.round(s.beatAligned * 100)}% of cuts land on a beat (±${Math.round(s.tolerance * 1000)} ms): snap them (snap_to_beats) or cut deliberately against the beat`);
    if (s.lateCuts.length >= Math.max(2, s.cuts * 0.2)) w.push(`${s.lateCuts.length} cuts land 2-6 frames AFTER the beat (${s.lateCuts.slice(0, 4).map((x) => `${x.at.toFixed(2)}s +${x.ms}ms`).join(", ")}): late cuts feel sloppy; cut on or a frame before the beat`);
  }
  if (o.plan) w.push(...splitWarnings(o.plan, { singleCamera: o.singleCamera }));
  if (s.ramps) w.push(...s.ramps.warnings);
  return w;
}

/** One-line summary for review reports. */
export function formatRhythm(s: RhythmStats): string {
  const parts: string[] = [];
  if (s.beatAligned !== undefined)
    parts.push(
      `beat alignment ${Math.round(s.beatAligned * 100)}% of ${s.cuts} cuts within ±${Math.round(s.tolerance * 1000)} ms (${Math.round((s.onDownbeat ?? 0) * 100)}% on downbeats, mean offset ${s.meanOffsetMs} ms${s.music?.tempo ? `, ${s.music.tempo} BPM` : ""})`,
    );
  if (s.splits.J || s.splits.L) parts.push(`split edits: ${s.splits.J} J, ${s.splits.L} L (mean ${s.splits.meanSeconds}s)`);
  if (s.ramps) parts.push(`speed: ${s.ramps.ramps} ramps, ${s.ramps.freezes} freezes, ${s.ramps.reverses} reverse; ${s.ramps.slowest}x–${s.ramps.fastest}x, max jump ${s.ramps.maxJump}x`);
  return parts.join("; ");
}

/** Hard cuts actually present in a rendered video (ffmpeg scene detection), seconds. */
export async function measureCuts(path: string, threshold = 0.3): Promise<number[]> {
  const r = await run(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", path, "-map", "0:v:0", "-vf", `scale=320:-2,select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"],
    { timeoutMs: 20 * 60_000, allowFailure: true },
  );
  const out: number[] = [];
  for (const m of r.stderr.matchAll(/pts_time:([\d.]+)/g)) out.push(Number(m[1]));
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
