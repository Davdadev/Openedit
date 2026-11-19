/**
 * Is a shot usable in a finished edit? A conservative, explainable gate over the shot analysis.
 *
 * "reject" is for frames no edit wants: blank or lens-capped, blown out to white, crushed to
 * black, or a fraction of a second. "caution" is for shots that can work only on purpose
 * (very soft = abstract/background only, dark, whip-pan camera moves, very short). Thresholds
 * were calibrated on real macro/product footage where heavy bokeh is intentional, so
 * shallow depth of field alone never rejects a shot.
 *
 * With the local vision model (insight.ts) it also knows what is IN the frame: production gear,
 * a shot with no subject or missed focus are rejected; a visible rig or hands are cautions.
 * Without it, those are for the editor to spot on the contact sheet.
 */
import type { Shot } from "./analyze.js";
import { isBareSubject, type ShotInsight } from "./insight.js";

export type Usability = "good" | "caution" | "reject";

export interface UsabilityVerdict {
  status: Usability;
  reasons: string[];
}

type ShotLike = Pick<Shot, "duration" | "brightness" | "exposure" | "motion" | "shake"> & { sharpness?: number; insight?: ShotInsight };

export function shotUsability(s: ShotLike): UsabilityVerdict {
  const reject: string[] = [];
  const caution: string[] = [];
  const sharp = s.sharpness;
  if (s.brightness >= 0.93) reject.push("blown out to white");
  else if (s.brightness <= 0.06) reject.push("black (lens cap / no light)");
  else if (sharp !== undefined && sharp < 4) reject.push("blank: no detail at all (out-of-focus wall, lens cap, missed focus)");
  if (s.duration < 0.3) reject.push(`only ${s.duration.toFixed(2)}s long`);
  // What the vision model saw (when set up).
  const i = s.insight;
  // Very soft frames of light (bokeh) are often misread as lamps: only a caution there.
  const bokeh = sharp !== undefined && sharp < 12;
  if (i?.gear && !bokeh) reject.push("production gear in frame (light / camera / cable)");
  if (i?.noSubject || isBareSubject(i?.subject)) reject.push("no subject: only ground, wall or sky");
  if (i?.focus === "missed") reject.push("focus missed on the subject");
  if (!reject.length) {
    if (sharp !== undefined && sharp < 12) caution.push("very soft: only as an abstract background or transition");
    if (s.exposure === "clipped") caution.push("highlights clipped");
    if (s.exposure === "dark" || s.exposure === "crushed") caution.push("dark");
    if (s.shake > 1.2 && s.motion > 0.08) caution.push("camera whipping: only as a whip transition");
    else if (s.shake > 1.2) caution.push("shaky handheld");
    if (s.duration < 0.6) caution.push("very short");
    if (i?.rig) caution.push("rig visible (stick / stand / wire holding the subject): remove it in VFX or crop it out, never ship it");
    if (i?.hands) caution.push("hands in frame: fine if intended");
    if (i?.gear && bokeh) caution.push("may show a light or other gear (or just bokeh): check the frame");
  }
  if (reject.length) return { status: "reject", reasons: [...reject, ...caution] };
  if (caution.length) return { status: "caution", reasons: caution };
  return { status: "good", reasons: [] };
}

/** Short tag for shot lists: "" for good shots. */
export function usabilityTag(s: ShotLike): string {
  const v = shotUsability(s);
  if (v.status === "good") return "";
  return ` ${v.status === "reject" ? "✗ REJECT" : "⚠"} ${v.reasons.join("; ")}`;
}
