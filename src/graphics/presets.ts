/**
 * Motion preset library (TypeScript side): names, defaults and docs for the presets
 * implemented in templates/_shared/motion.js, plus validation and craft checks for the
 * `motion` spec of create_motion_template. Keep both files in sync.
 */

export type PresetKind = "entrance" | "emphasis" | "continuous";

export interface PresetDef {
  kind: PresetKind;
  duration: number;
  easing: string;
  description: string;
  /** Typical split for kinetic type. */
  split?: "chars" | "words" | "lines";
  options?: string;
}

export const PRESETS: Record<string, PresetDef> = {
  fade: { kind: "entrance", duration: 0.5, easing: "outCubic", description: "Opacity 0→1. The quiet default for secondary text." },
  rise: { kind: "entrance", duration: 0.6, easing: "outExpo", description: "Fade + move up from 4rem below.", options: "distance (rem)" },
  drop: { kind: "entrance", duration: 0.6, easing: "outExpo", description: "Fade + move down from above.", options: "distance (rem)" },
  "slide-left": { kind: "entrance", duration: 0.7, easing: "outExpo", description: "Slide in from the left (8rem).", options: "distance (rem)" },
  "slide-right": { kind: "entrance", duration: 0.7, easing: "outExpo", description: "Slide in from the right (8rem).", options: "distance (rem)" },
  "scale-in": { kind: "entrance", duration: 0.6, easing: "outExpo", description: "Scale 0.86→1 + fade. Cards, panels.", options: "from" },
  pop: { kind: "entrance", duration: 0.55, easing: "outBack", description: "Scale 0.5→1 with overshoot. Badges, icons, stickers (sparingly).", options: "from" },
  "spring-in": { kind: "entrance", duration: 0.9, easing: "spring", description: "Scale from 0 on a damped spring. Playful UI elements.", options: "from" },
  "blur-in": { kind: "entrance", duration: 0.7, easing: "outQuart", description: "Defocus → sharp with a slight scale-down. Cinematic titles.", options: "distance (blur rem)" },
  "rotate-in": { kind: "entrance", duration: 0.7, easing: "outExpo", description: "Small rotation + rise. Energetic kinetic type.", options: "angle (deg), distance" },
  "flip-up": { kind: "entrance", duration: 0.7, easing: "outExpo", description: "3D flip from 85° on the X axis, hinged at the bottom.", options: "angle" },
  "mask-up": { kind: "entrance", duration: 0.7, easing: "outExpo", description: "Rises from behind an invisible baseline mask (no wrapper needed). The classic title reveal; per word/line/char with split.", split: "words" },
  "mask-down": { kind: "entrance", duration: 0.7, easing: "outExpo", description: "Drops in from behind a top mask." },
  "mask-left": { kind: "entrance", duration: 0.7, easing: "outExpo", description: "Slides in leftwards from behind a right-hand mask." },
  "mask-right": { kind: "entrance", duration: 0.7, easing: "outExpo", description: "Slides in rightwards from behind a left-hand mask." },
  "wipe-right": { kind: "entrance", duration: 0.7, easing: "inOutQuart", description: "Clip wipe revealing left→right. Panels, bars, lower-third plates." },
  "wipe-left": { kind: "entrance", duration: 0.7, easing: "inOutQuart", description: "Clip wipe revealing right→left." },
  "wipe-up": { kind: "entrance", duration: 0.6, easing: "inOutQuart", description: "Clip wipe revealing bottom→top." },
  "wipe-down": { kind: "entrance", duration: 0.6, easing: "inOutQuart", description: "Clip wipe revealing top→bottom." },
  iris: { kind: "entrance", duration: 0.7, easing: "inOutQuart", description: "Circular reveal from the centre. Avatars, logos." },
  "grow-x": { kind: "entrance", duration: 0.6, easing: "outExpo", description: "Scale X from 0 (origin left). Accent bars, dividers, progress lines.", options: "origin" },
  "grow-y": { kind: "entrance", duration: 0.6, easing: "outExpo", description: "Scale Y from 0 (origin bottom). Vertical accent bars, chart bars.", options: "origin" },
  grow: { kind: "entrance", duration: 0.6, easing: "outBack", description: "Uniform scale from 0. Dots, markers.", options: "origin" },
  "line-draw": { kind: "entrance", duration: 0.9, easing: "inOutQuart", description: "SVG strokes draw on (stroke-dashoffset) for every path/line/shape inside the selector. Underlines, arrows, outlines, signatures." },
  "tracking-in": { kind: "entrance", duration: 0.9, easing: "outQuart", description: "Letter-spacing closes from wide with a soft blur. Elegant titles, uppercase labels.", options: "from (em), tracking (em)" },
  type: { kind: "entrance", duration: 1, easing: "linear", description: "Typewriter: characters appear one by one (split chars, stagger = speed).", split: "chars" },
  "count-up": { kind: "entrance", duration: 1.4, easing: "outQuart", description: "Number counts from 0 to the element's number (keeps prefix/suffix, separators, decimals). Stats.", options: "from, to, decimals, prefix, suffix, separator" },
  highlight: { kind: "entrance", duration: 0.5, easing: "inOutQuart", description: "Marker sweep behind the text (accent colour). Key words.", options: "color, height, position" },
  underline: { kind: "entrance", duration: 0.5, easing: "outExpo", description: "Underline draws left→right under the text.", options: "color, height" },
  morph: { kind: "entrance", duration: 0.8, easing: "inOutQuart", description: "SVG path d interpolation to `to` (same command structure: morph-lite). Shape changes.", options: "to (path d)" },
  pulse: { kind: "emphasis", duration: 0.5, easing: "linear", description: "One scale pulse (6%). Draw the eye once, never loop it.", options: "amount, count" },
  shake: { kind: "emphasis", duration: 0.5, easing: "linear", description: "Decaying horizontal shake. Errors, 'no'.", options: "distance, count" },
  float: { kind: "continuous", duration: 0, easing: "linear", description: "Gentle sine bob over the whole graphic. Stickers, floating UI.", options: "distance, period" },
  drift: { kind: "continuous", duration: 0, easing: "inOutSine", description: "Slow parallax drift across the whole duration (x/y in rem). Give background/foreground layers different amounts for depth.", options: "x, y (rem)" },
  "ken-burns": { kind: "continuous", duration: 0, easing: "linear", description: "Slow push-in over the whole duration. Photos, backgrounds.", options: "scale" },
  spin: { kind: "emphasis", duration: 1, easing: "inOutCubic", description: "Rotation by `turns`. Loaders, badges.", options: "turns" },
  breathe: { kind: "continuous", duration: 0, easing: "linear", description: "Opacity breathing. Live dots, recording indicators.", options: "min, period" },
};

export const EASINGS = [
  "linear",
  ...["Sine", "Quad", "Cubic", "Quart", "Quint", "Expo", "Circ", "Back"].flatMap((k) => [`in${k}`, `out${k}`, `inOut${k}`]),
  "outBackSoft",
  "outElastic",
  "spring",
  "springSoft",
  "springBouncy",
  "standard",
  "emphasized",
  "smooth",
];

export interface MotionEntry {
  selector: string;
  preset?: string;
  delay?: number;
  duration?: number;
  easing?: string;
  stagger?: number | { each?: number; from?: "start" | "end" | "center" | "random"; seed?: number };
  split?: "chars" | "words" | "lines";
  exit?: boolean;
  keyframes?: { t: number; x?: number; y?: number; scale?: number; rotate?: number; opacity?: number; blur?: number; easing?: string }[];
  [opt: string]: unknown;
}

const SELECTOR_OK = /^[\w\s#.,:>+~*()\[\]="'-]{1,200}$/;

export function isEasing(e: string): boolean {
  return EASINGS.includes(e) || /^cubic-bezier\(\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\)$/.test(e);
}

/** Validate a motion spec. Errors block creation; warnings are craft notes returned to Claude. */
export function validateMotion(entries: MotionEntry[], duration: number): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const entrancePresets = new Set<string>();
  let lastEnd = 0;
  entries.forEach((e, i) => {
    const where = `motion[${i}] (${e.selector})`;
    if (!e.selector || !SELECTOR_OK.test(e.selector)) errors.push(`${where}: invalid CSS selector`);
    if (e.keyframes) {
      if (!Array.isArray(e.keyframes) || e.keyframes.length < 2) errors.push(`${where}: keyframes needs at least 2 keys`);
      else if (e.keyframes.some((k) => typeof k.t !== "number")) errors.push(`${where}: every keyframe needs t (seconds from the entry start)`);
      return;
    }
    const name = e.preset ?? "fade";
    const def = PRESETS[name];
    if (!def) {
      errors.push(`${where}: unknown preset "${name}". Presets: ${Object.keys(PRESETS).join(", ")}`);
      return;
    }
    if (e.easing && !isEasing(e.easing)) errors.push(`${where}: unknown easing "${e.easing}" (use ${EASINGS.slice(0, 6).join(", ")}…, spring, or cubic-bezier(x1,y1,x2,y2))`);
    const d = e.duration ?? def.duration;
    if (def.kind === "entrance" && !e.exit) {
      entrancePresets.add(name);
      if (d > 1.6 && name !== "type" && name !== "count-up" && name !== "line-draw") warnings.push(`${where}: ${d}s entrance is slow; 0.3–0.8 s with an ease-out (expo/quart) reads as confident`);
      if (d < 0.15) warnings.push(`${where}: ${d}s is too fast to read as motion`);
      if (e.easing && /^(linear|in[A-Z])/.test(e.easing) && name !== "type") warnings.push(`${where}: entrances should decelerate (ease-out such as outExpo/outQuart), not ${e.easing}`);
    }
    if (e.exit && e.easing && /^out[A-Z]/.test(e.easing)) warnings.push(`${where}: exits should accelerate away (ease-in), not ${e.easing}`);
    const st = typeof e.stagger === "number" ? e.stagger : e.stagger?.each;
    if (e.split === "chars" && st !== undefined && st > 0.08) warnings.push(`${where}: per-character stagger ${st}s is sluggish; 0.015–0.04 s`);
    if (e.split === "words" && st !== undefined && st > 0.2) warnings.push(`${where}: per-word stagger ${st}s is slow; 0.04–0.12 s`);
    const start = e.delay ?? 0;
    if (start > duration) errors.push(`${where}: delay ${start}s is after the end (${duration}s)`);
    if (!e.exit && def.kind === "entrance") lastEnd = Math.max(lastEnd, start + d);
  });
  if (entrancePresets.size > 5) warnings.push(`${entrancePresets.size} different entrance presets: pick 2–3 and reuse them (one motion language per video)`);
  if (lastEnd > duration * 0.6 && duration >= 2) warnings.push(`entrances finish at ${lastEnd.toFixed(2)}s of ${duration}s: leave a hold long enough to read (>= 1.5 s or ~0.3 s per word)`);
  return { errors, warnings };
}

export function presetDocs(): string {
  const by = (k: PresetKind) =>
    Object.entries(PRESETS)
      .filter(([, d]) => d.kind === k)
      .map(([n, d]) => `- ${n} (${d.duration}s ${d.easing})${d.split ? ` [split ${d.split}]` : ""}: ${d.description}${d.options ? ` Options: ${d.options}.` : ""}`)
      .join("\n");
  return `Entrances (set exit:true to play out; autoExit mirrors them):\n${by("entrance")}\n\nEmphasis:\n${by("emphasis")}\n\nContinuous (whole duration):\n${by("continuous")}\n\nEasings: ${EASINGS.join(", ")}, cubic-bezier(x1,y1,x2,y2).`;
}
