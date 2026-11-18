/**
 * Match cuts: pairs of shots whose out frame (A) and in frame (B) rhyme visually —
 * same dominant shape / position (attention saliency + edge layout), same motion direction,
 * related colour — so a cut between them reads as intentional. Pure scoring; exported for tests.
 */
import { type Shot, fpVector } from "./analyze.js";
import { cosine, paletteSimilarity } from "./shots.js";

export type MatchKind = "graphic" | "motion" | "content" | "colour";

export interface MatchCut {
  a: Shot;
  b: Shot;
  /** Cut point: last frame of A to use, first frame of B to use (source seconds). */
  outA: number;
  inB: number;
  score: number;
  kind: MatchKind;
  parts: { shape: number; edges: number; motion: number; colour: number; content: number };
  reasons: string[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Pearson correlation of two grids (shape layout irrespective of brightness), mapped to 0..1. */
export function gridCorrelation(a?: number[], b?: number[]): number {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += (a[i] - ma) * (b[i] - mb);
    aa += (a[i] - ma) ** 2;
    bb += (b[i] - mb) ** 2;
  }
  if (aa < 1e-9 || bb < 1e-9) return 0;
  return Math.max(0, ab / Math.sqrt(aa * bb));
}

/** Centre-of-mass of a saliency grid (0..1). */
export function salCentre(g?: number[]): { x: number; y: number; spread: number } | undefined {
  if (!g || g.length !== 64) return undefined;
  let s = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < 64; i++) {
    s += g[i];
    x += g[i] * ((i % 8) + 0.5);
    y += g[i] * (Math.floor(i / 8) + 0.5);
  }
  if (s <= 1e-9) return undefined;
  const cx = x / s;
  const cy = y / s;
  let v = 0;
  for (let i = 0; i < 64; i++) v += g[i] * (((i % 8) + 0.5 - cx) ** 2 + (Math.floor(i / 8) + 0.5 - cy) ** 2);
  return { x: cx / 8, y: cy / 8, spread: Math.sqrt(v / s) / 8 };
}

/** Motion direction agreement 0..1 (0.5 when either side is still). */
export function motionAgreement(a: { dx: number; dy: number }, b: { dx: number; dy: number }): number {
  const ma = Math.hypot(a.dx, a.dy);
  const mb = Math.hypot(b.dx, b.dy);
  if (ma < 0.02 || mb < 0.02) return ma < 0.02 && mb < 0.02 ? 0.5 : 0.35;
  const c = (a.dx * b.dx + a.dy * b.dy) / (ma * mb);
  const speed = Math.min(ma, mb) / Math.max(ma, mb);
  return Math.max(0, c) * (0.6 + 0.4 * speed);
}

/** Score A(out) -> B(in). */
export function scoreMatch(a: Shot, b: Shot): MatchCut | null {
  const ra = a.reps[a.reps.length - 1];
  const rb = b.reps[0];
  if (!ra || !rb) return null;
  // Blank / near-empty frames (white cards, black) rhyme with everything: not a match.
  const busy = (e?: number[]) => !!e && e.reduce((x, y) => x + y, 0) / e.length >= 3;
  if (!busy(ra.edges) || !busy(rb.edges)) return null;
  const ca = salCentre(ra.sal);
  const cb = salCentre(rb.sal);
  const salCorr = gridCorrelation(ra.sal, rb.sal);
  const centre = ca && cb ? Math.max(0, 1 - Math.hypot(ca.x - cb.x, ca.y - cb.y) / 0.35) : 0;
  const shape = 0.6 * salCorr + 0.4 * centre;
  const edges = gridCorrelation(ra.edges, rb.edges);
  const motion = motionAgreement(a.tailMotion, b.headMotion);
  const colour = paletteSimilarity(a.palette, b.palette);
  const fp = cosine(fpVector(ra), fpVector(rb));
  const content = Math.max(0, Math.min(1, (fp - 0.25) / 0.6));
  // The same setup again is a jump cut, not a match cut: near-identical pictures anywhere,
  // or the same scene from the same file.
  if (fp > 0.82 || (a.file === b.file && fp > 0.65)) return null;
  const moving = Math.hypot(a.tailMotion.dx, a.tailMotion.dy) > 0.02 && Math.hypot(b.headMotion.dx, b.headMotion.dy) > 0.02;
  const score = 0.36 * shape + 0.22 * edges + (moving ? 0.22 : 0.1) * motion + 0.14 * colour + 0.06 * content;
  const parts = { shape: r3(shape), edges: r3(edges), motion: r3(motion), colour: r3(colour), content: r3(content) };
  const kind: MatchKind = moving && motion > 0.75 ? "motion" : shape > 0.6 || edges > 0.6 ? "graphic" : content >= 0.6 ? "content" : "colour";
  const reasons: string[] = [];
  if (shape > 0.6) reasons.push(`subject in the same place${ca ? ` (${Math.round(ca.x * 100)}%,${Math.round(ca.y * 100)}%)` : ""}`);
  if (edges > 0.5) reasons.push("similar line/edge layout");
  if (moving && motion > 0.7) reasons.push("movement continues in the same direction");
  if (colour > 0.75) reasons.push("matching palette");
  if (content > 0.6) reasons.push("similar subject (feature print)");
  // Normalise the weights for still pairs.
  return { a, b, outA: ra.t, inB: rb.t, score: r3(score / (moving ? 1 : 0.88)), kind, parts, reasons };
}

/** Best match-cut pairs among shots (no adjacent shots of the same file, each shot used once as A and once as B). */
export function findMatchCuts(shots: Shot[], o: { top?: number; minScore?: number; minShot?: number } = {}): MatchCut[] {
  const top = o.top ?? 8;
  const minScore = o.minScore ?? 0.55;
  const minShot = o.minShot ?? 0.8;
  const usable = shots.filter((s) => s.duration >= minShot && s.reps.length);
  const all: MatchCut[] = [];
  for (const a of usable) {
    for (const b of usable) {
      if (a === b) continue;
      if (a.file === b.file && Math.abs(a.index - b.index) <= 1) continue;
      const m = scoreMatch(a, b);
      if (m && m.score >= minScore) all.push(m);
    }
  }
  all.sort((x, y) => y.score - x.score || x.a.id.localeCompare(y.a.id) || x.b.id.localeCompare(y.b.id));
  const usedA = new Set<string>();
  const usedB = new Set<string>();
  const out: MatchCut[] = [];
  for (const m of all) {
    if (usedA.has(m.a.id) || usedB.has(m.b.id)) continue;
    // Skip the mirror of a pair already chosen.
    if (out.some((x) => x.a.id === m.b.id && x.b.id === m.a.id)) continue;
    out.push(m);
    usedA.add(m.a.id);
    usedB.add(m.b.id);
    if (out.length >= top) break;
  }
  return out;
}
