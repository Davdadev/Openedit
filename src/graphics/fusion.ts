/**
 * DaVinci Resolve: editable Fusion Text+ titles.
 *
 * buildFusionTitle() produces
 *  - `setting`: a Fusion macro/.setting file (Lua table text). Paste it into a Fusion comp,
 *    or save it under …/Fusion/Templates/Edit/Titles/ to get an Edit-page title;
 *  - `spec`: the same title as JSON inputs + keyframes for the Resolve bridge
 *    (`addFusionTitle`), which inserts a native Text+ title with
 *    Timeline.InsertFusionTitleIntoTimeline("Text+") and sets the Text+ tool's inputs
 *    through the Fusion API (SetInput / AddModifier), so the title stays editable in
 *    Resolve's Inspector.
 *
 * Text+ input IDs follow Developer/Fusion/FusionToolReference.md (StyledText, Font, Style,
 * Size, Center, Red1/Green1/Blue1/Alpha1, shading element 2 = border fill plate,
 * element 3 = shadow, Write On End, HorizontalLeftCenterRight …).
 */
import { hexToRgba255 } from "./mogrt.js";

export interface FusionTitleOptions {
  lines: string[];
  font?: string;
  style?: string;
  /** Text size relative to frame width (Text+ Size), default 0.05. */
  size?: number;
  color?: string;
  /** Plate (border fill) behind the text; omit or "none" for no plate. */
  plate?: string;
  plateOpacity?: number;
  shadow?: boolean;
  /** Text+ Center, 0..1 (Fusion y is bottom-up). */
  center?: [number, number];
  align?: "left" | "center" | "right";
  /** fade | write-on | pop. */
  animation?: "fade" | "write-on" | "pop";
  inSec?: number;
  outSec?: number;
  duration: number;
  fps: number;
  width?: number;
  height?: number;
  tracking?: number;
  name?: string;
}

export interface FusionTitleSpec {
  tool: "TextPlus";
  inputs: Record<string, number | string | number[]>;
  keys: Record<string, [number, number][]>;
  durationFrames: number;
}

const r5 = (n: number) => Math.round(n * 100000) / 100000;

function rgb01(hex: string | undefined, fallback: [number, number, number, number]): [number, number, number, number] {
  const c = hex ? hexToRgba255(hex) : undefined;
  return c ? [r5(c[0] / 255), r5(c[1] / 255), r5(c[2] / 255), r5(c[3] / 255)] : fallback;
}

/** Lua string literal. */
function lua(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/[^\x20-\x7e\\]/g, (c) => `\\${c.charCodeAt(0) <= 255 ? c.charCodeAt(0) : "?"}`)}"`;
}

export function fusionTitleSpec(o: FusionTitleOptions): FusionTitleSpec {
  const fps = o.fps || 30;
  const total = Math.max(1, Math.round(o.duration * fps));
  const inF = Math.max(1, Math.round((o.inSec ?? 0.5) * fps));
  const outF = Math.max(1, Math.round((o.outSec ?? 0.35) * fps));
  const [r, g, b, a] = rgb01(o.color, [1, 1, 1, 1]);
  const align = o.align ?? "left";
  const inputs: FusionTitleSpec["inputs"] = {
    StyledText: o.lines.filter((l) => l !== undefined && l !== null).join("\n"),
    Font: o.font ?? "Open Sans",
    Style: o.style ?? "Bold",
    Size: r5(o.size ?? 0.05),
    Center: o.center ?? (align === "left" ? [0.1, 0.18] : align === "right" ? [0.9, 0.18] : [0.5, 0.5]),
    HorizontalLeftCenterRight: align === "left" ? -1 : align === "right" ? 1 : 0,
    VerticalTopCenterBottom: 0,
    Red1: r,
    Green1: g,
    Blue1: b,
    Alpha1: a,
    LineSpacingClone: 1.05,
  };
  if (o.tracking !== undefined) inputs.CharacterSpacingClone = r5(o.tracking);
  if (o.plate && o.plate !== "none") {
    const [pr, pg, pb] = rgb01(o.plate, [0.05, 0.05, 0.07, 1]);
    Object.assign(inputs, {
      Enabled2: 1,
      ElementShape2: 2, // Border Fill
      Level2: 0, // around the whole text
      Red2: pr,
      Green2: pg,
      Blue2: pb,
      Alpha2: 1,
      Opacity2: r5(o.plateOpacity ?? 0.86),
      ExtendHorizontal2: 0.035,
      ExtendVertical2: 0.03,
      Round2: 0.25,
      PriorityBack2: 9,
    });
  }
  if (o.shadow !== false) Object.assign(inputs, { Enabled3: 1, SoftnessX3: 6, SoftnessY3: 6, Opacity3: 0.45, Offset3: [0.004, -0.006] });

  const keys: FusionTitleSpec["keys"] = {};
  const env = (peak: number): [number, number][] => [
    [0, 0],
    [inF, peak],
    [Math.max(inF + 1, total - outF), peak],
    [total, 0],
  ];
  const anim = o.animation ?? "fade";
  keys.Opacity1 = env(1);
  if (inputs.Enabled2) keys.Opacity2 = env(Number(inputs.Opacity2));
  if (inputs.Enabled3) keys.Opacity3 = env(0.45);
  if (anim === "write-on") keys.End = [[0, 0], [Math.round(inF * 1.6), 1]];
  if (anim === "pop") {
    const s = Number(inputs.Size);
    keys.Size = [[0, r5(s * 0.92)], [inF, s], [Math.max(inF + 1, total - outF), s], [total, r5(s * 0.97)]];
  }
  return { tool: "TextPlus", inputs, keys, durationFrames: total };
}

/** Lua value for a Fusion input. */
function luaValue(v: number | string | number[]): string {
  if (typeof v === "string") return lua(v);
  if (Array.isArray(v)) return `{ ${v.map((x) => r5(x)).join(", ")} }`;
  return String(r5(v));
}

/**
 * Fusion .setting text: a Text+ tool with BezierSpline-animated inputs. Ease-out on the
 * way in (handles approximate cubic-bezier(0.16,1,0.3,1)), ease-in on the way out.
 */
export function buildFusionTitle(o: FusionTitleOptions): { setting: string; spec: FusionTitleSpec } {
  const spec = fusionTitleSpec(o);
  const name = (o.name ?? "OpenEditTitle").replace(/[^A-Za-z0-9_]/g, "") || "OpenEditTitle";
  const lines: string[] = [];
  lines.push("{");
  lines.push("\tTools = ordered() {");
  lines.push(`\t\t${name} = TextPlus {`);
  lines.push("\t\t\tCtrlWZoom = false,");
  lines.push("\t\t\tInputs = {");
  lines.push(`\t\t\t\tGlobalOut = Input { Value = ${spec.durationFrames}, },`);
  if (o.width && o.height) {
    lines.push(`\t\t\t\tWidth = Input { Value = ${o.width}, },`);
    lines.push(`\t\t\t\tHeight = Input { Value = ${o.height}, },`);
  }
  lines.push("\t\t\t\tUseFrameFormatSettings = Input { Value = 1, },");
  for (const [k, v] of Object.entries(spec.inputs)) {
    if (spec.keys[k]) lines.push(`\t\t\t\t${k} = Input { SourceOp = "${name}${k}", Source = "Value", },`);
    else lines.push(`\t\t\t\t${k} = Input { Value = ${luaValue(v)}, },`);
  }
  for (const k of Object.keys(spec.keys)) {
    if (!(k in spec.inputs)) lines.push(`\t\t\t\t${k} = Input { SourceOp = "${name}${k}", Source = "Value", },`);
  }
  lines.push("\t\t\t},");
  lines.push("\t\t\tViewInfo = OperatorInfo { Pos = { 0, 0 } },");
  lines.push("\t\t},");
  for (const [k, ks] of Object.entries(spec.keys)) {
    lines.push(`\t\t${name}${k} = BezierSpline {`);
    lines.push("\t\t\tSplineColor = { Red = 225, Green = 120, Blue = 60 },");
    lines.push("\t\t\tKeyFrames = {");
    ks.forEach(([f, v], i) => {
      const prev = ks[i - 1];
      const next = ks[i + 1];
      const parts = [`${r5(v)}`];
      if (prev) {
        const d = f - prev[0];
        const rising = v >= prev[1];
        // Arriving: ease-out (flat handle at the key) when rising, ease-in otherwise.
        parts.push(`LH = { ${r5(f - d * (rising ? 0.7 : 0.33))}, ${r5(rising ? v : v + (prev[1] - v) * 0.4)} }`);
      }
      if (next) {
        const d = next[0] - f;
        const rising = next[1] >= v;
        parts.push(`RH = { ${r5(f + d * (rising ? 0.16 : 0.5))}, ${r5(rising ? v + (next[1] - v) * 0.95 : v)} }`);
      }
      lines.push(`\t\t\t\t[${f}] = { ${parts.join(", ")}, Flags = { Linear = false } },`);
    });
    lines.push("\t\t\t},");
    lines.push("\t\t},");
  }
  lines.push("\t},");
  lines.push(`\tActiveTool = "${name}"`);
  lines.push("}");
  return { setting: `${lines.join("\n")}\n`, spec };
}

/** Map a catalog template's params onto a Fusion title (simple titles / lower thirds). */
export function fusionFromParams(
  params: Record<string, unknown>,
  defaults: Record<string, unknown>,
  o: { kind: "lower-third" | "title"; duration: number; fps: number; width?: number; height?: number },
): FusionTitleOptions {
  const v = { ...defaults, ...params };
  const textKeys = Object.keys(v).filter((k) => typeof v[k] === "string" && !/^#|^(left|right|center|glass|none)$/i.test(String(v[k])) && !/colou?r|accent|background|font|position|panel|style/i.test(k));
  const lines = textKeys.map((k) => String(v[k])).filter((s) => s.trim()).slice(0, 3);
  const accent = [v.accent, v.brand_accent, v.color].find((c) => typeof c === "string" && /^#/.test(String(c))) as string | undefined;
  const lower = o.kind === "lower-third";
  return {
    lines: lines.length ? lines : ["Title"],
    font: typeof v.font === "string" ? v.font : "Open Sans",
    style: "Bold",
    size: lower ? 0.036 : 0.07,
    color: "#FFFFFF",
    plate: lower ? "#0C0D11" : undefined,
    align: lower ? "left" : "center",
    center: lower ? [0.09, 0.17] : [0.5, 0.5],
    animation: lower ? "fade" : "write-on",
    duration: o.duration,
    fps: o.fps,
    width: o.width,
    height: o.height,
    name: lower ? "OpenEditLowerThird" : "OpenEditTitle",
    ...(accent && lower ? { plate: "#0C0D11" } : {}),
  };
}
