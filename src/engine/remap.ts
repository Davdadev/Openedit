import type { CutPlan, TimeRange } from "../hosts/types.js";

const EPS = 1e-6;

/** Total length of the edited result. */
export function editDuration(plan: Pick<CutPlan, "keep">): number {
  return plan.keep.reduce((acc, k) => acc + (k.end - k.start), 0);
}

/** Map a time on the source media to the edited timeline, or null if it was cut. */
export function mapTime(plan: Pick<CutPlan, "keep">, sourceTime: number): number | null {
  let acc = 0;
  for (const k of plan.keep) {
    if (sourceTime < k.start - EPS) return null;
    if (sourceTime <= k.end + EPS) return acc + Math.min(Math.max(sourceTime - k.start, 0), k.end - k.start);
    acc += k.end - k.start;
  }
  return null;
}

/** Map a time on the edited timeline back to the source media, or null if out of range. */
export function unmapTime(plan: Pick<CutPlan, "keep">, editTime: number): number | null {
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
export function mapRange(plan: Pick<CutPlan, "keep">, range: TimeRange): TimeRange[] {
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
export function editSegments(plan: Pick<CutPlan, "keep">): (TimeRange & { sourceStart: number; sourceEnd: number })[] {
  let acc = 0;
  return plan.keep.map((k) => {
    const seg = { start: acc, end: acc + (k.end - k.start), sourceStart: k.start, sourceEnd: k.end };
    acc = seg.end;
    return seg;
  });
}
