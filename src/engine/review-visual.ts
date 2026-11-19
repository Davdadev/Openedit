/**
 * Picture checks for review_edit, by analysing the RENDER itself (no plan needed): unusable
 * shots that made it into the cut, metronome pacing, back-to-back shots that look the same,
 * and a weak opening (near-black for over a second). These are the failures of montage, ad
 * and promo edits that loudness and dialogue checks cannot see.
 */
import type { Shot } from "./analysis/analyze.js";
import { cosine } from "./analysis/shots.js";
import { shotVector } from "./analysis/analyze.js";
import { shotUsability } from "./analysis/usable.js";

const fmt = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
};

export interface VisualStats {
  shots: number;
  meanShot: number;
  /** Coefficient of variation of shot lengths (last shot excluded). */
  pacingVariation: number;
  /** Share of shots within ±10% of the median length (1 = every shot the same length). */
  sameLength: number;
  medianShot: number;
  /** Longest run of consecutive shots within ±10% of the same length, and that length. */
  sameRun: { count: number; length: number; at: number };
  rejected: { at: number; reasons: string[] }[];
  soft: number[];
  duplicates: number[];
  darkOpening?: number;
  /** Shots where the vision model saw a rig / hands (cautions an ad cannot ship with). */
  rig: number[];
  hands: number[];
}

/** Pure: stats over the shots detected in a render. */
export function visualStats(shots: Shot[]): VisualStats {
  const body = shots.length > 2 ? shots.slice(0, -1) : shots;
  const lens = body.map((s) => s.duration);
  const mean = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, lens.length));
  const rejected: VisualStats["rejected"] = [];
  const soft: number[] = [];
  for (const s of shots) {
    const v = shotUsability(s);
    if (v.status === "reject" && s.duration >= 0.3) rejected.push({ at: s.start, reasons: v.reasons });
    else if (s.sharpness !== undefined && s.sharpness < 12 && s.duration >= 0.6) soft.push(s.start);
  }
  const duplicates: number[] = [];
  for (let i = 1; i < shots.length; i++) {
    const a = shotVector(shots[i - 1], "last");
    const b = shotVector(shots[i], "first");
    if (a && b && cosine(a, b) > 0.95 && shots[i].transition === "cut") duplicates.push(shots[i].start);
  }
  // Opening: any near-black stretch over 1 s within the first 3 s (a title over black, a fade that lingers).
  const dark = shots.filter((s) => s.start < 3 && s.brightness < 0.2 && s.duration > 1);
  const darkOpening = dark.length ? dark.reduce((a, s) => a + s.duration, 0) : undefined;
  const sorted = [...lens].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const sameLength = lens.length ? lens.filter((x) => Math.abs(x - median) <= median * 0.1).length / lens.length : 0;
  let sameRun = { count: 0, length: 0, at: 0 };
  for (let i = 0; i < body.length; i++) {
    let j = i;
    while (j + 1 < body.length && Math.abs(body[j + 1].duration - body[i].duration) <= body[i].duration * 0.1) j++;
    if (j - i + 1 > sameRun.count) sameRun = { count: j - i + 1, length: body[i].duration, at: body[i].start };
  }
  const rig = shots.filter((s) => s.insight?.rig && s.duration >= 0.3).map((s) => s.start);
  const hands = shots.filter((s) => s.insight?.hands && s.duration >= 0.3).map((s) => s.start);
  return { rig, hands, sameRun, shots: shots.length, meanShot: mean, medianShot: median, pacingVariation: mean ? sd / mean : 0, sameLength, rejected, soft, duplicates, darkOpening };
}

export function visualWarnings(v: VisualStats, o: { dialogue?: boolean } = {}): string[] {
  const w: string[] = [];
  for (const r of v.rejected) w.push(`unusable picture at ${fmt(r.at)}: ${r.reasons.join("; ")} — replace the shot`);
  if (!o.dialogue && v.shots >= 7 && (v.pacingVariation < 0.15 || v.sameLength >= 0.6)) {
    w.push(`metronome pacing: ${Math.round(v.sameLength * 100)}% of the ${v.shots} shots are ~${v.medianShot.toFixed(2)}s long. It reads as a slideshow: hold the hero shots longer, quicken the build, land the payoff.`);
  } else if (!o.dialogue && v.sameRun.count >= 5) {
    w.push(`metronome pacing: ${v.sameRun.count} shots in a row are all ~${v.sameRun.length.toFixed(2)}s from ${fmt(v.sameRun.at)}. Vary it: let a hero shot breathe, then quicken into the payoff.`);
  }
  if (v.rig.length) w.push(`rig visible (stick / stand / wire holding the subject) at ${v.rig.map(fmt).join(", ")}: remove it in VFX, crop it out, or replace the shot`);
  if (v.duplicates.length) w.push(`back-to-back shots look the same at ${v.duplicates.map(fmt).join(", ")}: a jump cut or a wasted shot; cut away or use a different angle`);
  if (v.darkOpening) w.push(`${v.darkOpening.toFixed(1)}s of near-black picture in the first 3 s: a weak hook. Open on the best image (titles over picture, not over black).`);
  if (v.soft.length > Math.max(2, v.shots / 3)) w.push(`${v.soft.length} very soft shots (${v.soft.slice(0, 5).map(fmt).join(", ")}): fine as deliberate bokeh, not for the product or the payoff`);
  return w;
}

/**
 * Seconds of near-silence at the end of the edit (pure). Measured against the edit's own
 * loud level so a quiet piece is not flagged: the tail is "silent" below (p90 - 35 dB).
 */
export function trailingSilence(env: { hop: number; db: number[] }): number {
  const finite = env.db.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!finite.length) return 0;
  const loud = finite[Math.floor(finite.length * 0.9)];
  const floor = Math.max(-70, loud - 35);
  let i = env.db.length - 1;
  while (i >= 0 && !(env.db[i] > floor)) i--;
  return (env.db.length - 1 - i) * env.hop;
}
