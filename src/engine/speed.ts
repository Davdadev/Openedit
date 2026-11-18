/**
 * Speed ramps, freeze frames and reverse on a cut plan: the time map between source and edit.
 *
 * A ramp covers a SOURCE range inside one kept range and plays it at a constant `speed`, or
 * changes speed from `from` to `to` along an easing curve. Variable speed is rendered as a
 * piecewise-constant approximation fine enough to look continuous (one step per ~2 source frames,
 * up to 48 per ramp): the output time of source time s is the integral of 1/speed, so the
 * setpts expression is a sum of clipped linear terms (no nested ifs) and stays exact at every
 * step boundary. Freeze frames hold one source frame; reverse plays a range backwards.
 *
 * Everything here is pure: remap.ts uses it to keep captions, markers and zooms on the right
 * picture after a ramp, render.ts uses the pieces to build the filter graph.
 */
import type { CutPlan, FreezeFrame, SpeedRamp, TimeRange } from "../hosts/types.js";

export type RampCurve = NonNullable<SpeedRamp["curve"]>;
export const RAMP_CURVES: RampCurve[] = ["linear", "ease-in", "ease-out", "ease-in-out"];

/** Fastest / slowest speed accepted (16x, 1/20x). */
export const MAX_SPEED = 16;
export const MIN_SPEED = 0.05;

const EPS = 1e-6;

export interface SpeedStep {
  /** Source range (seconds) played at constant speed v. */
  s0: number;
  s1: number;
  v: number;
}

export interface TimePiece {
  /** Index into plan.keep. */
  keep: number;
  kind: "normal" | "speed" | "freeze" | "reverse";
  srcStart: number;
  srcEnd: number;
  editStart: number;
  editEnd: number;
  /** "speed": constant-speed steps covering [srcStart, srcEnd]. "reverse": one step. */
  steps?: SpeedStep[];
  quality?: SpeedRamp["quality"];
  audio?: SpeedRamp["audio"];
}

/** Has the plan anything that changes playback speed (ramps, freezes, reverse)? */
export function hasRetiming(plan: Partial<Pick<CutPlan, "ramps" | "freezes">>): boolean {
  return Boolean(plan.ramps?.length || plan.freezes?.length);
}

/** Easing 0..1 -> 0..1. */
export function ease(curve: RampCurve | undefined, u: number): number {
  const x = Math.max(0, Math.min(1, u));
  switch (curve) {
    case "ease-in":
      return x * x;
    case "ease-out":
      return 1 - (1 - x) * (1 - x);
    case "ease-in-out":
      return x * x * (3 - 2 * x);
    default:
      return x;
  }
}

/** Speed of a ramp at normalised source position u (0..1). */
export function rampSpeedAt(r: SpeedRamp, u: number): number {
  if (r.speed !== undefined && r.from === undefined && r.to === undefined) return r.speed;
  const a = r.from ?? r.speed ?? 1;
  const b = r.to ?? r.speed ?? 1;
  return a + (b - a) * ease(r.curve, u);
}

const clampSpeed = (v: number) => Math.max(MIN_SPEED, Math.min(MAX_SPEED, v));

/**
 * Constant-speed steps for the part [a, b] of ramp r (source seconds). Each step's speed is the
 * harmonic mean of the curve over it (Simpson's rule on 1/v), so step output lengths sum to the
 * exact integral.
 */
export function rampSteps(r: SpeedRamp, a: number, b: number, fps = 30): SpeedStep[] {
  const len = r.end - r.start;
  const constant = r.from === undefined && r.to === undefined;
  if (constant || len <= EPS) return [{ s0: a, s1: b, v: clampSpeed(r.speed ?? 1) }];
  const n = Math.max(4, Math.min(48, Math.ceil(((b - a) * fps) / 2)));
  const out: SpeedStep[] = [];
  for (let i = 0; i < n; i++) {
    const s0 = a + ((b - a) * i) / n;
    const s1 = a + ((b - a) * (i + 1)) / n;
    const inv = (s: number) => 1 / clampSpeed(rampSpeedAt(r, (s - r.start) / len));
    const outLen = ((s1 - s0) / 6) * (inv(s0) + 4 * inv((s0 + s1) / 2) + inv(s1));
    out.push({ s0, s1, v: (s1 - s0) / outLen });
  }
  return out;
}

const stepsLen = (steps: SpeedStep[]) => steps.reduce((acc, st) => acc + (st.s1 - st.s0) / st.v, 0);

/** Validate and normalise ramps / freezes against the kept ranges. Returns problems found (pure). */
export function retimingProblems(plan: Pick<CutPlan, "keep"> & Partial<Pick<CutPlan, "ramps" | "freezes">>): string[] {
  const problems: string[] = [];
  const inKeep = (a: number, b: number) => plan.keep.findIndex((k) => a >= k.start - EPS && b <= k.end + EPS);
  const ramps = [...(plan.ramps ?? [])].sort((x, y) => x.start - y.start);
  ramps.forEach((r, i) => {
    if (!(r.end > r.start)) problems.push(`ramp ${i}: end must be after start`);
    else if (inKeep(r.start, r.end) < 0) problems.push(`ramp ${i} (${r.start}–${r.end}) is not inside one kept range`);
    const speeds = [r.speed, r.from, r.to].filter((v): v is number => v !== undefined);
    if (!speeds.length && !r.reverse) problems.push(`ramp ${i}: give speed, or from/to`);
    for (const v of speeds) if (!(v >= MIN_SPEED && v <= MAX_SPEED)) problems.push(`ramp ${i}: speed ${v} outside ${MIN_SPEED}–${MAX_SPEED} (use a freeze frame for 0)`);
    if (r.reverse && (r.from !== undefined || r.to !== undefined)) problems.push(`ramp ${i}: reverse takes a constant speed only`);
    if (i > 0 && r.start < ramps[i - 1].end - EPS) problems.push(`ramp ${i} overlaps ramp ${i - 1}`);
  });
  for (const f of plan.freezes ?? []) {
    if (!(f.duration > 0)) problems.push(`freeze at ${f.at}: duration must be > 0`);
    if (inKeep(f.at, f.at) < 0) problems.push(`freeze at ${f.at} is not inside a kept range`);
    if (ramps.some((r) => f.at > r.start + EPS && f.at < r.end - EPS)) problems.push(`freeze at ${f.at} is inside a ramp`);
  }
  return problems;
}

const cache = new WeakMap<object, { key: string; pieces: TimePiece[] }>();

/**
 * The edit as pieces of constant behaviour, in edit order: each kept range split at ramp
 * boundaries and freeze points. Pure; cached per plan object.
 */
export function timePieces(plan: Pick<CutPlan, "keep"> & Partial<Pick<CutPlan, "ramps" | "freezes">>, fps = 30): TimePiece[] {
  const key = JSON.stringify([plan.keep, plan.ramps, plan.freezes, fps]);
  const hit = cache.get(plan);
  if (hit && hit.key === key) return hit.pieces;
  const ramps = [...(plan.ramps ?? [])].sort((a, b) => a.start - b.start);
  const freezes = [...(plan.freezes ?? [])].sort((a, b) => a.at - b.at);
  const pieces: TimePiece[] = [];
  let t = 0;
  plan.keep.forEach((k, ki) => {
    let s = k.start;
    const push = (p: Omit<TimePiece, "editStart" | "editEnd" | "keep">, len: number) => {
      if (len <= EPS && p.kind !== "freeze") return;
      pieces.push({ ...p, keep: ki, editStart: t, editEnd: t + len });
      t += len;
    };
    const events: ({ at: number; ramp: SpeedRamp } | { at: number; freeze: FreezeFrame })[] = [
      ...ramps.filter((r) => r.end > k.start + EPS && r.start < k.end - EPS).map((r) => ({ at: Math.max(r.start, k.start), ramp: r })),
      ...freezes.filter((f) => f.at >= k.start - EPS && f.at <= k.end + EPS).map((f) => ({ at: f.at, freeze: f })),
    ].sort((a, b) => a.at - b.at);
    for (const ev of events) {
      if (ev.at > s + EPS) push({ kind: "normal", srcStart: s, srcEnd: ev.at }, ev.at - s);
      s = Math.max(s, ev.at);
      if ("freeze" in ev) {
        push({ kind: "freeze", srcStart: ev.at, srcEnd: ev.at }, ev.freeze.duration);
        continue;
      }
      const r = ev.ramp;
      const b = Math.min(r.end, k.end);
      if (b <= s + EPS) continue;
      if (r.reverse) {
        const v = clampSpeed(r.speed ?? 1);
        push({ kind: "reverse", srcStart: s, srcEnd: b, steps: [{ s0: s, s1: b, v }], quality: r.quality, audio: r.audio }, (b - s) / v);
      } else {
        const steps = rampSteps(r, s, b, fps);
        push({ kind: "speed", srcStart: s, srcEnd: b, steps, quality: r.quality, audio: r.audio }, stepsLen(steps));
      }
      s = b;
    }
    if (k.end > s + EPS) push({ kind: "normal", srcStart: s, srcEnd: k.end }, k.end - s);
  });
  cache.set(plan, { key, pieces });
  return pieces;
}

/** Output seconds from the start of a piece to source time s inside it. */
function intoPiece(p: TimePiece, s: number): number {
  switch (p.kind) {
    case "normal":
      return s - p.srcStart;
    case "freeze":
      return 0;
    case "reverse":
      return (p.srcEnd - s) / (p.steps?.[0].v ?? 1);
    case "speed": {
      let acc = 0;
      for (const st of p.steps ?? []) {
        if (s <= st.s0) break;
        acc += (Math.min(s, st.s1) - st.s0) / st.v;
      }
      return acc;
    }
  }
}

/** Source time at `d` output seconds into a piece. */
function outOfPiece(p: TimePiece, d: number): number {
  switch (p.kind) {
    case "normal":
      return p.srcStart + d;
    case "freeze":
      return p.srcStart;
    case "reverse":
      return p.srcEnd - d * (p.steps?.[0].v ?? 1);
    case "speed": {
      let acc = 0;
      for (const st of p.steps ?? []) {
        const len = (st.s1 - st.s0) / st.v;
        if (d <= acc + len + EPS) return st.s0 + (d - acc) * st.v;
        acc += len;
      }
      return p.srcEnd;
    }
  }
}

type Timed = Pick<CutPlan, "keep"> & Partial<Pick<CutPlan, "ramps" | "freezes">>;

/** Edit duration with retiming. */
export function retimedDuration(plan: Timed): number {
  const p = timePieces(plan);
  return p.length ? p[p.length - 1].editEnd : 0;
}

/** Source -> edit time through cuts and retiming, or null if the time was cut. */
export function retimedMap(plan: Timed, s: number): number | null {
  for (const p of timePieces(plan)) {
    if (p.kind === "freeze") {
      if (Math.abs(s - p.srcStart) <= EPS) return p.editStart;
      continue;
    }
    if (s >= p.srcStart - EPS && s <= p.srcEnd + EPS) return p.editStart + Math.max(0, Math.min(p.editEnd - p.editStart, intoPiece(p, Math.max(p.srcStart, Math.min(p.srcEnd, s)))));
  }
  return null;
}

/** Edit -> source time through cuts and retiming, or null if out of range. */
export function retimedUnmap(plan: Timed, t: number): number | null {
  if (t < -EPS) return null;
  for (const p of timePieces(plan)) if (t <= p.editEnd + EPS) return outOfPiece(p, Math.max(0, Math.min(p.editEnd - p.editStart, t - p.editStart)));
  return null;
}

/** Source range -> edit ranges (one per piece touched; reversed pieces give a forward range). */
export function retimedRange(plan: Timed, range: TimeRange): TimeRange[] {
  const out: TimeRange[] = [];
  for (const p of timePieces(plan)) {
    if (p.kind === "freeze") continue;
    const a = Math.max(range.start, p.srcStart);
    const b = Math.min(range.end, p.srcEnd);
    if (b <= a + EPS) continue;
    const x = p.editStart + intoPiece(p, a);
    const y = p.editStart + intoPiece(p, b);
    out.push({ start: Math.min(x, y), end: Math.max(x, y) });
  }
  return out;
}

/** Edit-time span of each kept range with retiming. */
export function retimedSegments(plan: Timed): (TimeRange & { sourceStart: number; sourceEnd: number })[] {
  const pieces = timePieces(plan);
  return plan.keep.map((k, i) => {
    const mine = pieces.filter((p) => p.keep === i);
    const start = mine[0]?.editStart ?? 0;
    const end = mine.length ? mine[mine.length - 1].editEnd : start;
    return { start, end, sourceStart: k.start, sourceEnd: k.end };
  });
}

/**
 * Move edit-time items (captions, markers, zooms, placements) from the timing of `before` to the
 * timing of `after` (same cuts, different retiming): edit -> source under `before`, then
 * source -> edit under `after`. Items whose source time is no longer in the edit are dropped.
 */
export function remapEditTime(before: Timed, after: Timed, t: number): number | null {
  const src = before.ramps?.length || before.freezes?.length ? retimedUnmap(before, t) : plainUnmap(before, t);
  if (src === null) return null;
  return after.ramps?.length || after.freezes?.length ? retimedMap(after, src) : plainMap(after, src);
}

function plainUnmap(plan: Pick<CutPlan, "keep">, t: number): number | null {
  let acc = 0;
  for (const k of plan.keep) {
    const len = k.end - k.start;
    if (t <= acc + len + EPS) return k.start + Math.max(0, Math.min(len, t - acc));
    acc += len;
  }
  return null;
}
function plainMap(plan: Pick<CutPlan, "keep">, s: number): number | null {
  let acc = 0;
  for (const k of plan.keep) {
    if (s < k.start - EPS) return null;
    if (s <= k.end + EPS) return acc + Math.max(0, Math.min(k.end - k.start, s - k.start));
    acc += k.end - k.start;
  }
  return null;
}

// ---------------------------------------------------------------- render helpers

const n6 = (n: number) => String(Math.round(n * 1e6) / 1e6);

/**
 * setpts expression (input T seconds from the piece start -> output PTS) for constant-speed
 * steps: sum of clip(T - a_k, 0, L_k) / v_k. Exact at every step boundary, monotone.
 */
export function setptsExpression(steps: SpeedStep[], origin: number): string {
  if (steps.length === 1) return `(T/${n6(steps[0].v)})/TB`;
  const terms = steps.map((st) => `clip(T-${n6(st.s0 - origin)},0,${n6(st.s1 - st.s0)})/${n6(st.v)}`);
  return `(${terms.join("+")})/TB`;
}

/** atempo chain for speed v (each instance limited to 0.5..100). */
export function atempoChain(v: number): string {
  const parts: string[] = [];
  let x = v;
  while (x < 0.5 - EPS) {
    parts.push("atempo=0.5");
    x /= 0.5;
  }
  while (x > 100 + EPS) {
    parts.push("atempo=100");
    x /= 100;
  }
  if (Math.abs(x - 1) > 1e-4 || !parts.length) parts.push(`atempo=${n6(x)}`);
  return parts.join(",");
}

/** Group speed steps into chunks of >= minLen source seconds for audio time-stretching (fewer, longer atempo runs). */
export function audioSteps(steps: SpeedStep[], minLen = 0.12): SpeedStep[] {
  const out: SpeedStep[] = [];
  let cur: SpeedStep | null = null;
  let outLen = 0;
  for (const st of steps) {
    if (!cur) {
      cur = { ...st };
      outLen = (st.s1 - st.s0) / st.v;
    } else {
      cur.s1 = st.s1;
      outLen += (st.s1 - st.s0) / st.v;
      cur.v = (cur.s1 - cur.s0) / outLen;
    }
    if (cur.s1 - cur.s0 >= minLen) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) {
    if (out.length && cur.s1 - cur.s0 < minLen / 2) {
      const last = out[out.length - 1];
      const lastOut = (last.s1 - last.s0) / last.v + (cur.s1 - cur.s0) / cur.v;
      last.s1 = cur.s1;
      last.v = (last.s1 - last.s0) / lastOut;
    } else out.push(cur);
  }
  return out;
}

// ---------------------------------------------------------------- review

export interface RampSanity {
  ramps: number;
  freezes: number;
  reverses: number;
  /** Largest speed ratio between adjacent steps / pieces (a "jump"). */
  maxJump: number;
  fastest: number;
  slowest: number;
  warnings: string[];
}

/** Ramp sanity for review: no >8x speed jumps between neighbours, no stutter (ramps shorter than ~4 frames). */
export function rampSanity(plan: Timed, fps = 30): RampSanity {
  const pieces = timePieces(plan, fps);
  const warnings: string[] = [];
  let maxJump = 1;
  let fastest = 1;
  let slowest = 1;
  let prevV: number | null = null;
  for (const p of pieces) {
    const vs = p.kind === "normal" ? [1] : p.kind === "freeze" ? [] : (p.steps ?? []).map((s) => s.v);
    for (const v of vs) {
      if (prevV !== null) maxJump = Math.max(maxJump, v / prevV, prevV / v);
      prevV = v;
      fastest = Math.max(fastest, v);
      slowest = Math.min(slowest, v);
    }
    if (p.kind === "freeze") prevV = null;
    const outFrames = (p.editEnd - p.editStart) * fps;
    if (p.kind !== "normal" && p.kind !== "freeze" && outFrames < 4) {
      warnings.push(`${p.kind} piece at ${p.editStart.toFixed(2)}s lasts ${outFrames.toFixed(1)} frames: reads as a stutter; make it longer or remove it`);
    }
    if (p.kind === "speed" && (p.steps ?? []).some((s) => s.v < 0.5) && !p.quality) {
      warnings.push(`slow motion below 50% at ${p.editStart.toFixed(2)}s without frame blending: duplicated frames judder (set quality "blend" or "optical", or shoot high frame rate)`);
    }
  }
  if (maxJump > 8) warnings.push(`speed jumps ${maxJump.toFixed(1)}x between neighbouring pieces: ease the ramp (from/to with curve "ease-in-out") instead of switching speed abruptly`);
  return {
    ramps: plan.ramps?.filter((r) => !r.reverse).length ?? 0,
    freezes: plan.freezes?.length ?? 0,
    reverses: plan.ramps?.filter((r) => r.reverse).length ?? 0,
    maxJump: Math.round(maxJump * 100) / 100,
    fastest: Math.round(fastest * 100) / 100,
    slowest: Math.round(slowest * 100) / 100,
    warnings,
  };
}
