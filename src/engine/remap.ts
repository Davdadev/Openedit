import type { CutPlan, TimeRange } from "../hosts/types.js";
import { hasRetiming, retimedDuration, retimedMap, retimedRange, retimedSegments, retimedUnmap } from "./speed.js";

const EPS = 1e-6;

/** Plans that may carry speed ramps / freeze frames (then every mapping goes through the time map). */
type Plan = Pick<CutPlan, "keep"> & Partial<Pick<CutPlan, "ramps" | "freezes">>;

/** Total length of the edited result. */
export function editDuration(plan: Plan): number {
  if (hasRetiming(plan)) return retimedDuration(plan);
  return plan.keep.reduce((acc, k) => acc + (k.end - k.start), 0);
}

/** Map a time on the source media to the edited timeline, or null if it was cut. */
export function mapTime(plan: Plan, sourceTime: number): number | null {
  if (hasRetiming(plan)) return retimedMap(plan, sourceTime);
  let acc = 0;
  for (const k of plan.keep) {
    if (sourceTime < k.start - EPS) return null;
    if (sourceTime <= k.end + EPS) return acc + Math.min(Math.max(sourceTime - k.start, 0), k.end - k.start);
    acc += k.end - k.start;
  }
  return null;
}

/** Map a time on the edited timeline back to the source media, or null if out of range. */
export function unmapTime(plan: Plan, editTime: number): number | null {
  if (hasRetiming(plan)) return retimedUnmap(plan, editTime);
  if (editTime < -EPS) return null;
  let acc = 0;
  for (const k of plan.keep) {
    const len = k.end - k.start;
    if (editTime <= acc + len + EPS) return k.start + Math.min(Math.max(editTime - acc, 0), len);
    acc += len;
  }
  return null;
}

/**
 * Map a source range into the edit. A range that straddles cuts becomes
 * several edit-time pieces (one per kept segment it touches).
 */
export function mapRange(plan: Plan, range: TimeRange): TimeRange[] {
  if (hasRetiming(plan)) return retimedRange(plan, range);
  const out: TimeRange[] = [];
  let acc = 0;
  for (const k of plan.keep) {
    const s = Math.max(range.start, k.start);
    const e = Math.min(range.end, k.end);
    if (e > s + EPS) out.push({ start: acc + (s - k.start), end: acc + (e - k.start) });
    acc += k.end - k.start;
  }
  return out;
}

/** Edit-time positions of every kept segment, in order. */
export function editSegments(plan: Plan): (TimeRange & { sourceStart: number; sourceEnd: number })[] {
  if (hasRetiming(plan)) return retimedSegments(plan);
  let acc = 0;
  return plan.keep.map((k) => {
    const seg = { start: acc, end: acc + (k.end - k.start), sourceStart: k.start, sourceEnd: k.end };
    acc = seg.end;
    return seg;
  });
}
