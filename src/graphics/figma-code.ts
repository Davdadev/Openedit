/**
 * Convert the React + Tailwind code returned by Figma's MCP `get_design_context` into
 * plain HTML with inline CSS, ready for create_motion_template.
 *
 * Robust path (chosen over the Tailwind play CDN): compositions must render offline and
 * deterministically, so Tailwind utilities are mapped to inline CSS here (the subset
 * Figma emits: absolute layout, flex auto-layout, arbitrary values, fonts, colours, radii,
 * borders, shadows, transforms). Unknown classes are kept and reported.
 *
 * Layer-name conventions (Figma layer name → data-name) become editable fields:
 *   "#title"           text field `title` (default = the layer's text)
 *   "#color:accent"    colour field `accent` bound to the layer's fill/background/text colour
 *   "#image:logo"      image field `logo` (src/href)
 *   "#toggle:badge"    checkbox field `badge` (shows/hides the layer)
 * CSS variables from Figma variables, e.g. var(--brand-primary,#7c5cff), become colour
 * fields on :root (id brand_primary).
 */
import type { FieldSpec } from "./create.js";

export interface FigmaConvertResult {
  html: string;
  fields: FieldSpec[];
  /** Asset constants found (name → URL, e.g. http://localhost:3845/assets/x.svg). Download them and pass as assets. */
  assets: { name: string; url: string; file: string }[];
  unknownClasses: string[];
  warnings: string[];
  width?: number;
  height?: number;
}

// ------------------------------------------------------------------ Tailwind → CSS

const SPACING = (v: string): string | null => {
  if (v === "px") return "1px";
  if (v === "full") return "100%";
  if (v === "auto") return "auto";
  if (v === "screen") return "100vw";
  if (/^\d+(\.\d+)?$/.test(v)) return `${parseFloat(v) * 4}px`;
  if (/^\d+\/\d+$/.test(v)) {
    const [a, b] = v.split("/").map(Number);
    return `${((a! / b!) * 100).toFixed(4).replace(/\.?0+$/, "")}%`;
  }
  return null;
};

function arb(v: string): string {
  // [12px] → 12px; underscores are spaces; strip type hints like length: / color:
  return v
    .slice(1, -1)
    .replace(/_/g, " ")
    .replace(/^(length|color|number|percentage|url|family-name|image|position|size):/, "");
}

const COLORS: Record<string, string> = { white: "#ffffff", black: "#000000", transparent: "transparent", current: "currentColor", inherit: "inherit" };
const isColor = (v: string) => /^(#|rgb|hsl|var\(|transparent|currentColor|color-mix|oklch|lab\()/i.test(v);

const WEIGHTS: Record<string, string> = {
  thin: "100", extralight: "200", light: "300", normal: "400", regular: "400", medium: "500", semibold: "600", bold: "700", extrabold: "800", black: "900",
};
const STYLE_WEIGHT: [RegExp, string][] = [
  [/thin|hairline/i, "100"], [/extra ?light|ultra ?light/i, "200"], [/light/i, "300"], [/medium/i, "500"], [/semi ?bold|demi ?bold/i, "600"],
  [/extra ?bold|ultra ?bold/i, "800"], [/black|heavy/i, "900"], [/bold/i, "700"], [/regular|normal|book|roman/i, "400"],
];
const TEXT_SIZES: Record<string, [string, string]> = {
  xs: ["12px", "16px"], sm: ["14px", "20px"], base: ["16px", "24px"], lg: ["18px", "28px"], xl: ["20px", "28px"], "2xl": ["24px", "32px"], "3xl": ["30px", "36px"],
  "4xl": ["36px", "40px"], "5xl": ["48px", "1"], "6xl": ["60px", "1"], "7xl": ["72px", "1"], "8xl": ["96px", "1"], "9xl": ["128px", "1"],
};
const RADII: Record<string, string> = { none: "0", sm: "2px", "": "4px", md: "6px", lg: "8px", xl: "12px", "2xl": "16px", "3xl": "24px", full: "9999px" };

function fontFamily(v: string): string[] {
  // 'Inter:Bold', sans-serif  → family Inter, weight 700
  const decls: string[] = [];
  const first = v.split(",")[0]!.trim().replace(/^['"]|['"]$/g, "");
  const [family, style] = first.split(":");
  const rest = v.split(",").slice(1).map((s) => s.trim()).filter(Boolean);
  decls.push(`font-family: '${family!.trim()}'${rest.length ? `, ${rest.join(", ")}` : ", sans-serif"}`);
  if (style) {
    const w = STYLE_WEIGHT.find(([re]) => re.test(style));
    if (w) decls.push(`font-weight: ${w[1]}`);
    if (/italic|oblique/i.test(style)) decls.push("font-style: italic");
  }
  return decls;
}

/** One Tailwind class → CSS declarations ([] = known no-op), or null if unknown. */
export function tailwindToCss(cls: string, grad: { from?: string; via?: string; to?: string; dir?: string }): string[] | null {
  if (cls.includes(":") && !cls.includes("[")) return []; // hover:, md: … (variants: ignored)
  const neg = cls.startsWith("-");
  const c = neg ? cls.slice(1) : cls;
  const sign = (v: string) => (neg ? (v.startsWith("calc") ? `calc(-1 * ${v})` : `-${v}`) : v);
  const m = /^([a-z-]+?)-(\[.+\]|[^-[\]\s]+)$/.exec(c);
  const exact: Record<string, string[]> = {
    absolute: ["position: absolute"], relative: ["position: relative"], fixed: ["position: fixed"], static: ["position: static"], sticky: ["position: sticky"],
    block: ["display: block"], "inline-block": ["display: inline-block"], inline: ["display: inline"], flex: ["display: flex"], "inline-flex": ["display: inline-flex"],
    grid: ["display: grid"], hidden: ["display: none"], contents: ["display: contents"],
    "flex-col": ["flex-direction: column"], "flex-row": ["flex-direction: row"], "flex-col-reverse": ["flex-direction: column-reverse"], "flex-row-reverse": ["flex-direction: row-reverse"],
    "flex-wrap": ["flex-wrap: wrap"], "flex-nowrap": ["flex-wrap: nowrap"], "flex-1": ["flex: 1 1 0%"], "flex-auto": ["flex: 1 1 auto"], "flex-none": ["flex: none"],
    grow: ["flex-grow: 1"], "grow-0": ["flex-grow: 0"], shrink: ["flex-shrink: 1"], "shrink-0": ["flex-shrink: 0"],
    "items-start": ["align-items: flex-start"], "items-center": ["align-items: center"], "items-end": ["align-items: flex-end"], "items-stretch": ["align-items: stretch"], "items-baseline": ["align-items: baseline"],
    "justify-start": ["justify-content: flex-start"], "justify-center": ["justify-content: center"], "justify-end": ["justify-content: flex-end"], "justify-between": ["justify-content: space-between"], "justify-around": ["justify-content: space-around"], "justify-evenly": ["justify-content: space-evenly"],
    "content-stretch": ["align-content: stretch"], "content-start": ["align-content: flex-start"], "content-center": ["align-content: center"], "content-end": ["align-content: flex-end"], "content-between": ["align-content: space-between"],
    "self-start": ["align-self: flex-start"], "self-center": ["align-self: center"], "self-end": ["align-self: flex-end"], "self-stretch": ["align-self: stretch"], "self-auto": ["align-self: auto"],
    "overflow-hidden": ["overflow: hidden"], "overflow-clip": ["overflow: clip"], "overflow-visible": ["overflow: visible"],
    "whitespace-nowrap": ["white-space: nowrap"], "whitespace-pre": ["white-space: pre"], "whitespace-pre-wrap": ["white-space: pre-wrap"], "text-nowrap": ["white-space: nowrap"], "text-wrap": ["white-space: normal"], "text-balance": ["text-wrap: balance"],
    "break-words": ["overflow-wrap: break-word"], "break-all": ["word-break: break-all"],
    uppercase: ["text-transform: uppercase"], lowercase: ["text-transform: lowercase"], capitalize: ["text-transform: capitalize"], "normal-case": ["text-transform: none"],
    italic: ["font-style: italic"], "not-italic": ["font-style: normal"], underline: ["text-decoration-line: underline"], "line-through": ["text-decoration-line: line-through"], "no-underline": ["text-decoration-line: none"],
    "text-left": ["text-align: left"], "text-center": ["text-align: center"], "text-right": ["text-align: right"], "text-justify": ["text-align: justify"], "text-start": ["text-align: start"], "text-end": ["text-align: end"],
    "box-border": ["box-sizing: border-box"], "box-content": ["box-sizing: content-box"], "max-w-none": ["max-width: none"], "size-full": ["width: 100%", "height: 100%"],
    "object-cover": ["object-fit: cover"], "object-contain": ["object-fit: contain"], "object-fill": ["object-fit: fill"], "object-center": ["object-position: center"],
    border: ["border-width: 1px", "border-style: solid"], "border-solid": ["border-style: solid"], "border-dashed": ["border-style: dashed"], "border-none": ["border-style: none"],
    rounded: ["border-radius: 4px"], "pointer-events-none": [], "select-none": [], "cursor-pointer": [], antialiased: [], truncate: ["overflow: hidden", "text-overflow: ellipsis", "white-space: nowrap"],
    "inset-0": ["inset: 0"], "mix-blend-multiply": ["mix-blend-mode: multiply"], "mix-blend-screen": ["mix-blend-mode: screen"], "mix-blend-overlay": ["mix-blend-mode: overlay"],
    "isolate": ["isolation: isolate"], "leading-none": ["line-height: 1"], "leading-tight": ["line-height: 1.25"], "leading-snug": ["line-height: 1.375"], "leading-normal": ["line-height: 1.5"], "leading-relaxed": ["line-height: 1.625"],
    "tracking-tighter": ["letter-spacing: -0.05em"], "tracking-tight": ["letter-spacing: -0.025em"], "tracking-normal": ["letter-spacing: 0"], "tracking-wide": ["letter-spacing: 0.025em"], "tracking-wider": ["letter-spacing: 0.05em"], "tracking-widest": ["letter-spacing: 0.1em"],
    "bg-clip-text": ["-webkit-background-clip: text", "background-clip: text", "color: transparent"], "bg-no-repeat": ["background-repeat: no-repeat"], "bg-cover": ["background-size: cover"], "bg-center": ["background-position: center"],
    "shadow": ["box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)"], "shadow-lg": ["box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)"],
    "shadow-none": ["box-shadow: none"],
  };
  if (exact[cls]) return exact[cls]!;
  if (exact[c] && !neg) return exact[c]!;
  if (/^bg-gradient-to-(t|tr|r|br|b|bl|l|tl)$/.test(c) || /^bg-linear-to-(t|tr|r|br|b|bl|l|tl)$/.test(c)) {
    const d = c.split("-").pop()!;
    const map: Record<string, string> = { t: "to top", tr: "to top right", r: "to right", br: "to bottom right", b: "to bottom", bl: "to bottom left", l: "to left", tl: "to top left" };
    grad.dir = map[d];
    return [];
  }
  if (!m) return null;
  const [, key, raw] = m as unknown as [string, string, string];
  const isArb = raw.startsWith("[");
  const val = isArb ? arb(raw) : raw;
  const space = isArb ? val : SPACING(raw);
  const color = isArb ? (isColor(val) ? val : null) : COLORS[raw] ?? null;

  switch (key) {
    case "w": return space ? [`width: ${space}`] : null;
    case "h": return space ? [`height: ${space}`] : null;
    case "size": return space ? [`width: ${space}`, `height: ${space}`] : null;
    case "min-w": return space ? [`min-width: ${space}`] : raw === "0" ? ["min-width: 0"] : null;
    case "min-h": return space ? [`min-height: ${space}`] : null;
    case "max-w": return space ? [`max-width: ${space}`] : null;
    case "max-h": return space ? [`max-height: ${space}`] : null;
    case "left": case "right": case "top": case "bottom": return space ? [`${key}: ${sign(space)}`] : null;
    case "inset": return space ? [`inset: ${sign(space)}`] : null;
    case "inset-x": return space ? [`left: ${sign(space)}`, `right: ${sign(space)}`] : null;
    case "inset-y": return space ? [`top: ${sign(space)}`, `bottom: ${sign(space)}`] : null;
    case "gap": return space ? [`gap: ${space}`] : null;
    case "gap-x": return space ? [`column-gap: ${space}`] : null;
    case "gap-y": return space ? [`row-gap: ${space}`] : null;
    case "p": return space ? [`padding: ${space}`] : null;
    case "px": return space ? [`padding-left: ${space}`, `padding-right: ${space}`] : null;
    case "py": return space ? [`padding-top: ${space}`, `padding-bottom: ${space}`] : null;
    case "pt": return space ? [`padding-top: ${space}`] : null;
    case "pr": return space ? [`padding-right: ${space}`] : null;
    case "pb": return space ? [`padding-bottom: ${space}`] : null;
    case "pl": return space ? [`padding-left: ${space}`] : null;
    case "m": return space ? [`margin: ${sign(space)}`] : null;
    case "mx": return space ? [`margin-left: ${sign(space)}`, `margin-right: ${sign(space)}`] : null;
    case "my": return space ? [`margin-top: ${sign(space)}`, `margin-bottom: ${sign(space)}`] : null;
    case "mt": return space ? [`margin-top: ${sign(space)}`] : null;
    case "mr": return space ? [`margin-right: ${sign(space)}`] : null;
    case "mb": return space ? [`margin-bottom: ${sign(space)}`] : null;
    case "ml": return space ? [`margin-left: ${sign(space)}`] : null;
    case "basis": return space ? [`flex-basis: ${space}`] : null;
    case "flex": return isArb ? [`flex: ${val}`] : null;
    case "z": return [`z-index: ${val}`];
    case "order": return [`order: ${val}`];
    case "opacity": return [`opacity: ${isArb ? val : Number(raw) / 100}`];
    case "aspect": return [`aspect-ratio: ${isArb ? val : raw === "video" ? "16 / 9" : raw === "square" ? "1 / 1" : raw}`];
    case "leading": return [`line-height: ${val}`];
    case "tracking": return [`letter-spacing: ${val}`];
    case "font": {
      if (WEIGHTS[raw]) return [`font-weight: ${WEIGHTS[raw]}`];
      if (isArb && /^\d{3}$/.test(val)) return [`font-weight: ${val}`];
      if (isArb) return fontFamily(val);
      if (raw === "sans") return ["font-family: ui-sans-serif, system-ui, sans-serif"];
      if (raw === "serif") return ["font-family: ui-serif, Georgia, serif"];
      if (raw === "mono") return ["font-family: ui-monospace, Menlo, monospace"];
      return null;
    }
    case "text": {
      if (TEXT_SIZES[raw]) return [`font-size: ${TEXT_SIZES[raw]![0]}`, `line-height: ${TEXT_SIZES[raw]![1]}`];
      if (color) return [`color: ${color}`];
      if (isArb) return [`font-size: ${val}`];
      return null;
    }
    case "bg": {
      if (color) return [`background-color: ${color}`];
      if (isArb && /^url\(/.test(val)) return [`background-image: ${val}`];
      if (isArb && /gradient\(/.test(val)) return [`background-image: ${val}`];
      if (isArb) return [`background: ${val}`];
      return null;
    }
    case "from": grad.from = color ?? val; return [];
    case "via": grad.via = color ?? val; return [];
    case "to": grad.to = color ?? val; return [];
    case "rounded": return isArb ? [`border-radius: ${val}`] : RADII[raw] !== undefined ? [`border-radius: ${RADII[raw]}`] : null;
    case "rounded-t": return [`border-top-left-radius: ${val}`, `border-top-right-radius: ${val}`];
    case "rounded-b": return [`border-bottom-left-radius: ${val}`, `border-bottom-right-radius: ${val}`];
    case "rounded-l": return [`border-top-left-radius: ${val}`, `border-bottom-left-radius: ${val}`];
    case "rounded-r": return [`border-top-right-radius: ${val}`, `border-bottom-right-radius: ${val}`];
    case "rounded-tl": return [`border-top-left-radius: ${val}`];
    case "rounded-tr": return [`border-top-right-radius: ${val}`];
    case "rounded-bl": return [`border-bottom-left-radius: ${val}`];
    case "rounded-br": return [`border-bottom-right-radius: ${val}`];
    case "border": {
      if (color) return [`border-color: ${color}`];
      if (isArb) return [`border-width: ${val}`, "border-style: solid"];
      if (/^\d+$/.test(raw)) return [`border-width: ${raw}px`, "border-style: solid"];
      return null;
    }
    case "border-t": case "border-r": case "border-b": case "border-l": {
      const side = { "border-t": "top", "border-r": "right", "border-b": "bottom", "border-l": "left" }[key]!;
      if (color) return [`border-${side}-color: ${color}`];
      return [`border-${side}-width: ${isArb ? val : `${raw}px`}`, `border-${side}-style: solid`];
    }
    case "shadow": return isArb ? [`box-shadow: ${val}`] : null;
    case "blur": return [`filter: blur(${isArb ? val : "8px"})`];
    case "backdrop-blur": return [`backdrop-filter: blur(${isArb ? val : "8px"})`];
    case "rotate": return [`rotate: ${sign(isArb ? val : `${raw}deg`)}`];
    case "scale": return [`scale: ${sign(isArb ? val : `${Number(raw) / 100}`)}`];
    case "scale-x": return [`scale: ${sign(isArb ? val : `${Number(raw) / 100}`)} 1`];
    case "scale-y": return [`scale: 1 ${sign(isArb ? val : `${Number(raw) / 100}`)}`];
    case "translate-x": return space ? [`translate: ${sign(space)} 0`] : null;
    case "translate-y": return space ? [`translate: 0 ${sign(space)}`] : null;
    case "origin": return [`transform-origin: ${isArb ? val : raw.replace("-", " ")}`];
    case "mix-blend": return [`mix-blend-mode: ${val}`];
    case "content": return isArb ? [`content: ${val}`] : null;
    case "line-clamp": return [`-webkit-line-clamp: ${val}`, "display: -webkit-box", "-webkit-box-orient: vertical", "overflow: hidden"];
    case "decoration": return color ? [`text-decoration-color: ${color}`] : null;
    case "stroke": return color ? [`stroke: ${color}`] : [`stroke-width: ${val}`];
    case "fill": return color ? [`fill: ${color}`] : null;
    case "grid-cols": return [`grid-template-columns: ${isArb ? val : `repeat(${raw}, minmax(0, 1fr))`}`];
    case "grid-rows": return [`grid-template-rows: ${isArb ? val : `repeat(${raw}, minmax(0, 1fr))`}`];
    case "col-span": return [`grid-column: span ${raw} / span ${raw}`];
    case "row-span": return [`grid-row: span ${raw} / span ${raw}`];
    default:
      return null;
  }
}

/** Translate+rotate+scale written as separate properties combine; Tailwind v3 `transform` class is a no-op. */
function classesToStyle(classes: string[], unknown: Set<string>): { style: string; keep: string[] } {
  const grad: { from?: string; via?: string; to?: string; dir?: string } = {};
  const decls: string[] = [];
  const keep: string[] = [];
  for (const cls of classes) {
    if (!cls || cls === "transform" || cls === "transform-gpu") continue;
    const d = tailwindToCss(cls, grad);
    if (d === null) {
      unknown.add(cls);
      keep.push(cls);
    } else decls.push(...d);
  }
  if (grad.from || grad.to) {
    const stops = [grad.from ?? "transparent", ...(grad.via ? [grad.via] : []), grad.to ?? "transparent"];
    decls.push(`background-image: linear-gradient(${grad.dir ?? "to right"}, ${stops.join(", ")})`);
  }
  return { style: decls.join("; "), keep };
}

// ------------------------------------------------------------------ JSX → HTML

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const SVG_ATTRS: Record<string, string> = {
  strokeWidth: "stroke-width", strokeLinecap: "stroke-linecap", strokeLinejoin: "stroke-linejoin", strokeMiterlimit: "stroke-miterlimit", strokeDasharray: "stroke-dasharray",
  strokeDashoffset: "stroke-dashoffset", strokeOpacity: "stroke-opacity", fillRule: "fill-rule", clipRule: "clip-rule", fillOpacity: "fill-opacity", stopColor: "stop-color",
  stopOpacity: "stop-opacity", clipPath: "clip-path", xlinkHref: "xlink:href", xmlnsXlink: "xmlns:xlink", colorInterpolationFilters: "color-interpolation-filters",
  floodOpacity: "flood-opacity", floodColor: "flood-color", textAnchor: "text-anchor", dominantBaseline: "dominant-baseline", fontFamily: "font-family", fontSize: "font-size",
  fontWeight: "font-weight", letterSpacing: "letter-spacing", maskType: "mask-type", vectorEffect: "vector-effect", htmlFor: "for", tabIndex: "tabindex",
};
const UNITLESS = new Set(["opacity", "zIndex", "fontWeight", "lineHeight", "flex", "flexGrow", "flexShrink", "order", "zoom", "scale"]);

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function styleObjectToCss(obj: string, consts: Map<string, string>): string {
  const out: string[] = [];
  for (const m of obj.matchAll(/([A-Za-z_$][\w$]*|"[^"]+"|'[^']+')\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`|-?[\d.]+|[A-Za-z_$][\w$.]*)/g)) {
    const key = m[1]!.replace(/^['"]|['"]$/g, "");
    let v = m[2]!;
    if (/^["'`]/.test(v)) v = v.slice(1, -1);
    else if (/^-?[\d.]+$/.test(v)) v = UNITLESS.has(key) || v === "0" ? v : `${v}px`;
    else v = consts.get(v) ?? "";
    if (v === "") continue;
    out.push(`${key.startsWith("--") ? key : kebab(key)}: ${v}`);
  }
  return out.join("; ");
}

function extractJsx(code: string): string {
  const ret = code.search(/return\s*\(/);
  if (ret < 0) {
    const first = code.indexOf("<");
    return first >= 0 ? code.slice(first) : code;
  }
  const start = code.indexOf("(", ret) + 1;
  // Walk to the matching ')' (ignoring parens inside strings/JSX text is good enough for generated code).
  let depth = 1;
  let i = start;
  let q: string | null = null;
  for (; i < code.length && depth > 0; i++) {
    const ch = code[i]!;
    if (q) {
      if (ch === q && code[i - 1] !== "\\") q = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") q = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  return code.slice(start, i - 1);
}

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Convert get_design_context output (React+Tailwind, or plain HTML with Tailwind classes) to HTML + fields. */
export function convertFigmaCode(code: string): FigmaConvertResult {
  const warnings: string[] = [];
  const unknown = new Set<string>();
  const consts = new Map<string, string>();
  const assets: FigmaConvertResult["assets"] = [];
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["'`]([^"'`]+)["'`]\s*;?/g)) {
    consts.set(m[1]!, m[2]!);
    if (/^(https?:\/\/|\/)/.test(m[2]!) && /\.(svg|png|jpe?g|webp|gif)(\?|$)/i.test(m[2]!)) {
      const file = `${m[1]!.replace(/^img/, "").replace(/^(.)/, (c) => c.toLowerCase()) || "asset"}${(/\.(svg|png|jpe?g|webp|gif)/i.exec(m[2]!)?.[0] ?? ".png").toLowerCase()}`;
      assets.push({ name: m[1]!, url: m[2]!, file });
    }
  }
  let jsx = extractJsx(code)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/<>|<\/>/g, "");

  // Attributes.
  jsx = jsx.replace(/\sclassName=/g, " class=");
  jsx = jsx.replace(/\sstyle=\{\{([\s\S]*?)\}\}/g, (_m, obj: string) => ` style="${escAttr(styleObjectToCss(obj, consts))}"`);
  jsx = jsx.replace(/\s([A-Za-z_:][\w:.-]*)=\{\s*(["'`])([\s\S]*?)\2\s*\}/g, (_m, attr: string, _q, v: string) => ` ${attr}="${escAttr(v)}"`);
  jsx = jsx.replace(/\s([A-Za-z_:][\w:.-]*)=\{\s*([A-Za-z_$][\w$.]*)\s*\}/g, (_m, attr: string, ident: string) => {
    const asset = assets.find((a) => a.name === ident);
    if (asset) return ` ${attr}="assets/${asset.file}"`;
    const v = consts.get(ident);
    if (v !== undefined) return ` ${attr}="${escAttr(v)}"`;
    warnings.push(`attribute ${attr}={${ident}} dropped (not a constant)`);
    return "";
  });
  jsx = jsx.replace(/\s([A-Za-z_:][\w:.-]*)=\{\s*(-?[\d.]+)\s*\}/g, (_m, attr: string, n: string) => ` ${attr}="${n}"`);
  jsx = jsx.replace(/\s([a-z]+[A-Z][A-Za-z]*)=/g, (m, attr: string) => (SVG_ATTRS[attr] ? ` ${SVG_ATTRS[attr]}=` : m));
  // Text expressions {"…"} / {'…'} / {`…`}.
  jsx = jsx.replace(/\{\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1\s*\}/g, (_m, _q, s: string) => escText(s.replace(/\\(["'`\\])/g, "$1").replace(/\\n/g, "\n")));
  jsx = jsx.replace(/\{[^{}<>]*\}/g, (m) => {
    warnings.push(`expression ${m.slice(0, 40)} dropped`);
    return "";
  });
  // Self-closing non-void tags.
  jsx = jsx.replace(/<([A-Za-z][\w:-]*)(\s[^<>]*?)?\s*\/>/g, (_m, tag: string, attrs = "") => (VOID.has(tag.toLowerCase()) ? `<${tag}${attrs}>` : `<${tag}${attrs}></${tag}>`));

  // Tailwind classes → inline style.
  jsx = jsx.replace(/<([A-Za-z][\w:-]*)(\s[^<>]*?)?>/g, (tagm, tag: string, attrs = "") => {
    const cm = /\sclass="([^"]*)"/.exec(attrs);
    if (!cm) return tagm;
    const { style, keep } = classesToStyle(cm[1]!.split(/\s+/), unknown);
    let a = attrs.replace(cm[0], keep.length ? ` class="${keep.join(" ")}"` : "");
    if (style) {
      const sm = /\sstyle="([^"]*)"/.exec(a);
      a = sm ? a.replace(sm[0], ` style="${escAttr(style)}; ${sm[1]}"`) : `${a} style="${escAttr(style)}"`;
    }
    return `<${tag}${a}>`;
  });

  // Fields from layer names: data-name="#title", "#color:accent", "#image:logo", "#toggle:badge".
  const fields: import("./create.js").FieldSpec[] = [];
  const ids = new Set<string>();
  jsx = jsx.replace(/<([A-Za-z][\w:-]*)((?:\s[^<>]*?)?\sdata-name="#([^"]+)"[^<>]*?)>/g, (tagm, tag: string, attrs: string, spec: string) => {
    const [kindRaw, nameRaw] = spec.includes(":") ? spec.split(":", 2) : ["text", spec];
    const id = nameRaw!.trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^(\d)/, "_$1");
    if (!id || ids.has(id)) return tagm;
    ids.add(id);
    const kind = kindRaw!.toLowerCase();
    const selector = `[data-oe-field="${id}"]`;
    const style = /\sstyle="([^"]*)"/.exec(attrs)?.[1] ?? "";
    if (kind === "color" || kind === "colour") {
      const bg = /background(?:-color)?:\s*([^;]+)/.exec(style)?.[1];
      const fill = /\sfill="([^"]+)"/.exec(attrs)?.[1];
      const col = /(?:^|;\s*)color:\s*([^;]+)/.exec(style)?.[1];
      if (fill && fill !== "none") fields.push({ id, type: "color", selector, attr: "fill", default: fill });
      else if (bg) fields.push({ id, type: "color", selector, style: "background-color", default: bg.trim() });
      else fields.push({ id, type: "color", selector, style: "color", default: col?.trim() ?? "#ffffff" });
    } else if (kind === "image" || kind === "img") {
      fields.push({ id, type: "image", selector, attr: tag.toLowerCase() === "image" ? "href" : "src" });
    } else if (kind === "toggle" || kind === "hide" || kind === "show") {
      fields.push({ id, type: "checkbox", selector, default: true });
    } else {
      fields.push({ id, type: "text", selector, text: true, default: "" });
    }
    return `<${tag}${attrs} data-oe-field="${id}">`;
  });
  // Text defaults: the layer's text content (innermost text of the element).
  for (const f of fields) {
    if (f.type !== "text") continue;
    const re = new RegExp(`data-oe-field="${f.id}"[^>]*>([\\s\\S]*?)<\\/`, "");
    const inner = re.exec(jsx)?.[1] ?? "";
    f.default = inner.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
  }
  // Figma variables (var(--name, fallback)) → :root colour fields.
  for (const m of jsx.matchAll(/var\(\s*--([A-Za-z0-9_-]+)\s*,\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))\s*\)/g)) {
    const id = m[1]!.replace(/-/g, "_").replace(/^(\d)/, "_$1");
    if (ids.has(id)) continue;
    ids.add(id);
    fields.push({ id, type: "color", selector: ":root", style: `--${m[1]}`, default: m[2] });
  }
  if (unknown.size) warnings.push(`kept ${unknown.size} unmapped Tailwind class(es) as classes: ${[...unknown].slice(0, 12).join(" ")}`);
  if (assets.some((a) => /localhost:3845/.test(a.url))) warnings.push("assets come from the Figma desktop server (localhost:3845): download them (curl or Figma download_assets) into a folder and pass them as create_motion_template assets with the listed file names");

  // Root size from the first element's width/height.
  const root = /^\s*<[A-Za-z][^>]*style="([^"]*)"/.exec(jsx)?.[1] ?? "";
  const width = Number(/(?:^|;\s*)width:\s*(\d+(?:\.\d+)?)px/.exec(root)?.[1]) || undefined;
  const height = Number(/(?:^|;\s*)height:\s*(\d+(?:\.\d+)?)px/.exec(root)?.[1]) || undefined;
  return { html: jsx.trim(), fields, assets, unknownClasses: [...unknown], warnings, width, height };
}
