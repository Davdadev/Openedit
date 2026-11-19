/**
 * Figma motion → seekable CSS animation for HyperFrames.
 *
 * The Figma MCP's get_motion_context returns, per animated node, keyframe tracks plus
 * pre-computed CSS @keyframes and motion.dev snippets. HyperFrames seeks CSS animations frame
 * by frame on its own, provided every animation is FINITE and holds its end state. This module
 * pulls the CSS out of whatever shape the response has (object, JSON text, or markdown with
 * code fences), and normalises it:
 *  - `infinite` iteration counts → enough whole cycles to cover the template's duration;
 *  - a fill mode of `both` on every animation (first frame before the delay, last after);
 *  - selectors that name Figma node ids (e.g. `[data-node-id="1:23"]`) are left as they are,
 *    and an optional map rewrites them to the ids/classes of the imported design.
 * Everything here is pure and unit-tested.
 */

export interface FigmaMotionCss {
  css: string;
  keyframes: string[];
  rules: number;
  warnings: string[];
}

/** Collect every string inside an object (the response can nest CSS anywhere). */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

/** Balanced-brace blocks starting at each match of `head` (e.g. "@keyframes name"). */
function blocks(text: string, head: RegExp): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  head.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = head.exec(text))) {
    const open = text.indexOf("{", m.index);
    if (open < 0) break;
    let depth = 0;
    let i = open;
    for (; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) break;
    }
    if (depth !== 0) break;
    out.push({ start: m.index, end: i + 1, text: text.slice(m.index, i + 1) });
    head.lastIndex = i + 1;
  }
  return out;
}

const TIME = /(-?\d*\.?\d+)(ms|s)\b/;
const sec = (v: string, u: string) => (u === "ms" ? Number(v) / 1000 : Number(v));

/** Make one `animation` shorthand finite and filled; returns [value, warning?]. */
export function normalizeAnimationValue(value: string, duration: number): [string, string?] {
  // Several comma-separated animations (commas inside cubic-bezier(...) are not separators).
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  let warn: string | undefined;
  const fixed = parts.map((p) => {
    let a = p.trim();
    const m = TIME.exec(a);
    const cycle = m ? sec(m[1], m[2]) : 0;
    if (/\binfinite\b/.test(a)) {
      const n = cycle > 0 ? Math.max(1, Math.ceil(duration / cycle)) : 1;
      a = a.replace(/\binfinite\b/, String(n));
      warn = `looping animation made finite (${n} cycles cover the ${duration}s template)`;
    }
    if (!/\b(both|forwards|backwards)\b/.test(a)) a = `${a} both`;
    else a = a.replace(/\b(forwards|backwards)\b/, "both");
    return a;
  });
  return [fixed.join(", "), warn];
}

/** Normalise a CSS text: finite, filled animations; optional selector rewrite map. */
export function normalizeAnimationCss(css: string, duration: number, selectorMap: Record<string, string> = {}): { css: string; warnings: string[] } {
  const warnings = new Set<string>();
  let out = css.replace(/(^|[;{\s])animation\s*:\s*([^;}]+)/g, (_m, pre: string, v: string) => {
    const [val, w] = normalizeAnimationValue(v, duration);
    if (w) warnings.add(w);
    return `${pre}animation: ${val}`;
  });
  out = out.replace(/animation-iteration-count\s*:\s*infinite/g, () => {
    warnings.add("animation-iteration-count: infinite made finite");
    return `animation-iteration-count: ${Math.max(1, Math.ceil(duration))}`;
  });
  out = out.replace(/animation-fill-mode\s*:\s*(none|forwards|backwards)/g, "animation-fill-mode: both");
  for (const [from, to] of Object.entries(selectorMap)) out = out.split(from).join(to);
  return { css: out, warnings: [...warnings] };
}

/**
 * Extract the animation CSS from a get_motion_context response (pure). Returns the
 * @keyframes blocks and the rules that apply an animation, normalised for seeking.
 */
export function figmaMotionToCss(response: unknown, o: { duration: number; selectorMap?: Record<string, string> }): FigmaMotionCss {
  let raw: unknown = response;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      /* plain text / markdown */
    }
  }
  const text = strings(raw)
    .map((s) => s.replace(/```[a-z]*\n?/gi, "\n"))
    .join("\n");
  const kf = blocks(text, /@(?:-webkit-)?keyframes\s+[\w-]+/g);
  const names = new Set<string>();
  const keyframes: string[] = [];
  for (const b of kf) {
    const name = /keyframes\s+([\w-]+)/.exec(b.text)![1];
    if (names.has(name)) continue;
    names.add(name);
    keyframes.push(b.text.trim());
  }
  // Rules that use an animation: "selector { ... animation... }" outside @keyframes.
  let rest = text;
  for (const b of [...kf].reverse()) rest = rest.slice(0, b.start) + rest.slice(b.end);
  const rules: string[] = [];
  for (const m of rest.matchAll(/([^{}]+)\{([^{}]*\banimation(?:-name)?\s*:[^{}]*)\}/g)) {
    const sel = m[1].trim().split("\n").pop()!.trim();
    if (!sel || /^@/.test(sel)) continue;
    rules.push(`${sel} {${m[2]}}`);
  }
  const warnings: string[] = [];
  if (!keyframes.length) warnings.push("no CSS @keyframes found in the motion context: pass the CSS snippet itself, or describe the motion with `motion` presets");
  for (const n of names) if (!rules.some((r) => r.includes(n))) warnings.push(`@keyframes ${n} is not applied by any rule: add "animation: ${n} <duration> <easing>" to its element`);
  const norm = normalizeAnimationCss([...keyframes, ...rules].join("\n\n"), o.duration, o.selectorMap);
  return { css: norm.css, keyframes: [...names], rules: rules.length, warnings: [...warnings, ...norm.warnings] };
}
