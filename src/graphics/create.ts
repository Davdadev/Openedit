/**
 * create_motion_template: turn a design (HTML/SVG/CSS — typically converted from Figma's
 * get_design_context output) plus editable fields and a declarative motion spec into a
 * HyperFrames composition under OPENEDIT_HOME/graphics/user/<id>/, registered in the
 * graphics catalog and renderable in every host.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { missingFonts } from "./fonts.js";
import { graphicsPaths } from "./library.js";
import { slug } from "./mogrt.js";
import { type MotionEntry, validateMotion } from "./presets.js";
import { sanitizeFragment } from "./sanitize.js";
import type { TemplateParam } from "./types.js";

export interface FieldSpec {
  /** Param name used in {{id}} placeholders and place_graphic params. Letters, digits, underscore. */
  id: string;
  type?: "text" | "color" | "number" | "image" | "checkbox" | "dropdown";
  label?: string;
  default?: unknown;
  /** Element(s) the value is bound to. Omit for pure {{id}} placeholders or a :root CSS variable. */
  selector?: string;
  /** Bind to an attribute (e.g. "fill", "stroke", "href"). */
  attr?: string;
  /** Bind to a CSS property or custom property (e.g. "background-color", "--accent"). */
  style?: string;
  /** Bind to the text content. */
  text?: boolean;
  options?: string[];
  min?: number;
  max?: number;
}

export interface CreateTemplateInput {
  name: string;
  id?: string;
  html?: string;
  svg?: string;
  css?: string;
  assets?: { path: string; name?: string }[];
  fields?: FieldSpec[];
  motion?: MotionEntry[];
  autoExit?: boolean;
  exitDuration?: number;
  fit?: { selector: string; maxLines?: number; maxWidth?: number; minScale?: number }[];
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  background?: string;
  category?: string;
  description?: string;
  tags?: string[];
  /** Provenance, e.g. "figma:FILEKEY:1-23". */
  source?: string;
  overwrite?: boolean;
}

export interface CreateTemplateResult {
  id: string;
  dir: string;
  warnings: string[];
  fields: TemplateParam[];
  fonts: string[];
  missingFonts: string[];
}

const FIELD_ID = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const CSS_PROP = /^(--[A-Za-z0-9_-]{1,40}|[a-z-]{2,40})$/;
const ATTR_OK = /^[a-z][a-z0-9:-]{0,30}$/i;
const SAFE_BG = /^(transparent|#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i;

function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Font families named in CSS (font-family / font shorthand), first family of each declaration. */
export function cssFonts(css: string): string[] {
  const out = new Set<string>();
  for (const m of css.matchAll(/font-family\s*:\s*([^;}"]+|"[^"]+"[^;}]*)/gi)) {
    const first = m[1]!.split(",")[0]!.trim().replace(/^['"]|['"]$/g, "");
    if (first && !/^(var\(|inherit|initial|sans-serif|serif|monospace|system-ui|-apple-system|ui-)/i.test(first)) out.add(first);
  }
  return [...out];
}

/** Download Google Fonts CSS + woff2 files into <dir>/assets/fonts and return local @font-face CSS. */
export async function localizeGoogleFonts(urls: string[], dir: string, timeoutMs = 15_000): Promise<{ css: string; files: number }> {
  let css = "";
  let files = 0;
  const fontsDir = join(dir, "assets", "fonts");
  for (const url of urls) {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Google Fonts ${res.status} for ${url}`);
    let text = await res.text();
    const remote = [...new Set([...text.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]!))];
    mkdirSync(fontsDir, { recursive: true });
    for (const r of remote) {
      const name = `${slug(r.replace(/^https:\/\/fonts\.gstatic\.com\//, "")).slice(-60)}${extname(new URL(r).pathname) || ".woff2"}`;
      const f = await fetch(r, { signal: AbortSignal.timeout(timeoutMs) });
      if (!f.ok) throw new Error(`font download ${f.status}`);
      writeFileSync(join(fontsDir, name), Buffer.from(await f.arrayBuffer()));
      text = text.split(r).join(`assets/fonts/${name}`);
      files++;
    }
    css += `${text}\n`;
  }
  return { css, files };
}

function toParam(f: FieldSpec): TemplateParam {
  const type = f.type ?? (f.style && /color|^--/.test(f.style) && /^#/.test(String(f.default ?? "")) ? "color" : "text");
  const p: TemplateParam = { id: f.id, name: f.label ?? f.id, type: type === "image" ? "image" : type, default: f.default };
  if (f.options) p.options = f.options;
  if (typeof f.min === "number") p.min = f.min;
  if (typeof f.max === "number") p.max = f.max;
  return p;
}

export async function createMotionTemplate(input: CreateTemplateInput): Promise<CreateTemplateResult> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("name is required");
  const id = slug(input.id ?? name).slice(0, 48);
  if (!input.html && !input.svg) throw new Error("Pass html and/or svg (the design), plus css if it is separate.");
  const width = Math.round(input.width ?? 1920);
  const height = Math.round(input.height ?? 1080);
  const duration = input.duration ?? 5;
  const fps = input.fps ?? 30;
  if (width < 16 || height < 16 || width > 7680 || height > 4320) errors.push(`invalid size ${width}x${height}`);
  if (!(duration > 0 && duration <= 120)) errors.push(`duration must be 0–120 s (got ${duration})`);
  const background = (input.background ?? "transparent").trim();
  if (!SAFE_BG.test(background)) errors.push(`background must be "transparent" or a colour (got ${background})`);

  // Design markup.
  const s = sanitizeFragment(`${input.html ?? ""}\n${input.svg ?? ""}`, input.css ?? "");
  warnings.push(...s.warnings);

  // Fields.
  const fields = input.fields ?? [];
  const seen = new Set<string>();
  for (const f of fields) {
    if (!FIELD_ID.test(f.id ?? "")) errors.push(`field id "${f.id}" must be letters/digits/underscore, starting with a letter (used as {{${f.id}}})`);
    if (seen.has(f.id)) errors.push(`duplicate field id "${f.id}"`);
    seen.add(f.id);
    if (f.style && !CSS_PROP.test(f.style)) errors.push(`field ${f.id}: invalid CSS property "${f.style}"`);
    if (f.attr && (!ATTR_OK.test(f.attr) || /^on/i.test(f.attr))) errors.push(`field ${f.id}: attribute "${f.attr}" not allowed`);
    if (f.selector && !/^[\w\s#.,:>+~*()\[\]="'-]{1,200}$/.test(f.selector)) errors.push(`field ${f.id}: invalid selector`);
    const bound = !!(f.selector || f.style) || s.html.includes(`{{${f.id}}}`) || s.css.includes(`{{${f.id}}}`);
    if (!bound) warnings.push(`field ${f.id} is not bound: give it a selector (+ text/attr/style) or put {{${f.id}}} in the markup`);
    if (f.selector && !/^:root$/.test(f.selector)) {
      const cls = /^[.#]([\w-]+)$/.exec(f.selector.trim());
      if (cls && !new RegExp(`(class|id)\\s*=\\s*["'][^"']*\\b${cls[1]}\\b`).test(s.html)) warnings.push(`field ${f.id}: selector ${f.selector} matches nothing in the markup`);
    }
  }
  const placeholders = [...new Set([...`${s.html}${s.css}`.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)].map((m) => m[1]!))];
  for (const p of placeholders) if (!seen.has(p)) fields.push({ id: p, type: "text", default: "" }), warnings.push(`placeholder {{${p}}} had no field: added a text field with an empty default`);

  // Motion.
  const motion = input.motion ?? [];
  const v = validateMotion(motion, duration);
  errors.push(...v.errors);
  warnings.push(...v.warnings);
  if (!motion.length) warnings.push("no motion given: the graphic will only fade in/out. Add presets (e.g. mask-up on the title, wipe-right on the plate).");

  // Assets.
  const assets = input.assets ?? [];
  for (const a of assets) {
    const p = resolve(String(a.path ?? "").replace(/^~(?=\/)/, process.env.HOME ?? "~"));
    if (!existsSync(p) || !statSync(p).isFile()) errors.push(`asset not found: ${a.path}`);
    else if (statSync(p).size > 50 * 1024 * 1024) errors.push(`asset too large (> 50 MB): ${a.path}`);
  }
  if (errors.length) throw new Error(`create_motion_template: ${errors.join("; ")}`);

  const dir = join(graphicsPaths.user(), id);
  if (existsSync(join(dir, "template.json")) && input.overwrite === false) throw new Error(`template "${id}" exists (pass overwrite: true or another id)`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "assets"), { recursive: true });
  let html = s.html;
  let css = s.css;
  for (const a of assets) {
    const src = resolve(String(a.path).replace(/^~(?=\/)/, process.env.HOME ?? "~"));
    const fname = (a.name ?? basename(src)).replace(/[^\w.-]+/g, "_");
    copyFileSync(src, join(dir, "assets", fname));
    // References by absolute path or bare file name → assets/<file>.
    for (const ref of [src, a.path, basename(src)]) {
      html = html.split(`"${ref}"`).join(`"assets/${fname}"`).split(`'${ref}'`).join(`'assets/${fname}'`);
      css = css.split(`(${ref})`).join(`(assets/${fname})`).split(`("${ref}")`).join(`("assets/${fname}")`);
    }
  }

  // Fonts: Google Fonts → downloaded into the template (deterministic, offline renders).
  let fontCss = "";
  if (s.googleFonts.length) {
    try {
      const r = await localizeGoogleFonts(s.googleFonts, dir);
      fontCss = r.css;
      warnings.push(`Google Fonts localised (${r.files} files) into the template`);
    } catch (e) {
      // Keep the link: Chrome loads it at render time when online.
      fontCss = s.googleFonts.map((u) => `@import url("${u}");`).join("\n");
      warnings.push(`could not download Google Fonts (${(e as Error).message}); renders will fetch them online`);
    }
  }
  const fonts = cssFonts(`${css}\n${html}`);
  const missing = s.googleFonts.length ? [] : missingFonts(fonts);
  if (missing.length) warnings.push(`fonts not installed: ${missing.join(", ")} — the render falls back to another face. Install them, or use Google Fonts via an @import/link (downloaded automatically)`);

  const bgDiv = background !== "transparent" ? `<div class="oe-bg" style="position:absolute;inset:0;background:${background}"></div>\n` : "";
  const spec = { fields, motion, autoExit: input.autoExit !== false, exitDuration: input.exitDuration, fit: input.fit };
  const composition =
    `<!-- ${name.replace(/--/g, "-")} — generated by OpenEdit create_motion_template -->\n` +
    `<style>\n${fontCss}\n${css}\n</style>\n${bgDiv}${html}\n` +
    `<script>\n  OE.motion.play(${scriptJson(spec)});\n</script>\n`;
  const params = fields.map(toParam);
  const defaults: Record<string, unknown> = {};
  for (const f of fields) if (f.default !== undefined) defaults[f.id] = f.default;
  const manifest = {
    id,
    name,
    description: input.description ?? `${name} (custom motion template)`,
    category: input.category ?? "Custom",
    duration,
    width,
    height,
    fps,
    background,
    params: Object.fromEntries(params.map((p) => [p.id, `${p.type}${p.name !== p.id ? ` — ${p.name}` : ""}`])),
    defaults,
    fields: params,
    bindings: fields,
    motion,
    fonts,
    tags: input.tags ?? [],
    source: input.source,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, "composition.html"), composition);
  writeFileSync(join(dir, "template.json"), JSON.stringify(manifest, null, 2));
  return { id, dir, warnings: [...new Set(warnings)], fields: params, fonts, missingFonts: missing };
}

export function readUserManifest(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "template.json"), "utf8")) as Record<string, unknown>;
}
