/**
 * OpenEdit motion graphics: animated titles, lower thirds, callouts and
 * caption overlays rendered from HTML compositions with HyperFrames
 * (https://github.com/heygen-com/hyperframes, Apache-2.0).
 *
 * - Templates live in `<repo>/templates/<id>/` (template.json + composition.html).
 * - Compositions use the HyperFrames seek protocol (`hf-seek`) with a tiny
 *   in-house runtime (templates/_shared/runtime.js): no GSAP, no network scripts.
 * - Output: `.mov` → ProRes 4444 with alpha, `.webm` → VP9 with alpha,
 *   `.mp4` → opaque H.264 on the template's `background` colour.
 * - Captions fall back to an ASS subtitle file burned onto a transparent canvas
 *   with ffmpeg/libass when HyperFrames is unavailable.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CaptionCue, Word } from "../hosts/types.js";

/** Pinned HyperFrames CLI used through `npx` when no local install is found. */
export const HYPERFRAMES_VERSION = "0.9.59";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Template discovery
// ---------------------------------------------------------------------------

interface TemplateManifest {
  id: string;
  description: string;
  duration?: number;
  params: Record<string, string>;
  defaults?: Record<string, unknown>;
}

/** Locate `<repo>/templates` (works from src/motion and dist/motion). */
export function templatesDir(): string {
  const env = process.env.OPENEDIT_TEMPLATES_DIR;
  if (env && existsSync(env)) return resolve(env);
  const candidates = [
    resolve(HERE, "../../templates"),
    resolve(HERE, "../../../templates"),
    resolve(process.cwd(), "templates"),
  ];
  for (const c of candidates) if (existsSync(join(c, "_shared", "shell.html"))) return c;
  throw new Error(`OpenEdit templates folder not found (looked in ${candidates.join(", ")}). Set OPENEDIT_TEMPLATES_DIR.`);
}

function readManifest(dir: string): TemplateManifest | null {
  const file = join(dir, "template.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as TemplateManifest;
}

function allManifests(): TemplateManifest[] {
  const root = templatesDir();
  return readdirSync(root)
    .filter((d) => !d.startsWith("_") && !d.startsWith("."))
    .map((d) => join(root, d))
    .filter((d) => statSync(d).isDirectory())
    .map(readManifest)
    .filter((m): m is TemplateManifest => !!m)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function listTemplates(): { id: string; description: string; params: Record<string, string> }[] {
  return allManifests().map((m) => ({ id: m.id, description: m.description, params: { ...m.params } }));
}

/** Caption overlay styles accepted by renderCaptionOverlay (`style`). */
export const CAPTION_STYLES: Record<string, string> = {
  "bold-pop": "Big uppercase words, 1–3 at a time; the spoken word turns accent-coloured with a scale pop.",
  clean: "Sentence-case, up to two lines on soft dark rounded boxes; gentle fade/rise per phrase.",
  karaoke: "Whole phrase visible; each word fills with the accent colour as it is spoken (sweep).",
  minimal: "Small, quiet white text with a soft shadow; fades between phrases.",
};

// ---------------------------------------------------------------------------
// Composition building
// ---------------------------------------------------------------------------

interface ComposeOptions {
  width: number;
  height: number;
  fps: number;
  duration: number;
  opaque: boolean;
}

const SAFE_COLOR = /^[#a-zA-Z0-9(),.%\s-]{1,64}$/;
const SAFE_FONT = /^[\w\s'-]{1,48}$/;

function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON safe to embed inside a <script> element. */
function scriptJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function color(v: unknown, fallback: string): string {
  return typeof v === "string" && SAFE_COLOR.test(v) && !/url|expression/i.test(v) ? v.trim() : fallback;
}

function fill(tpl: string, map: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, k: string) => (k in map ? map[k]! : m));
}

/** Build a complete HyperFrames index.html for a template fragment. */
function compose(fragment: string, params: Record<string, unknown>, o: ComposeOptions): string {
  const root = templatesDir();
  const shell = readFileSync(join(root, "_shared", "shell.html"), "utf8");
  const runtime = readFileSync(join(root, "_shared", "runtime.js"), "utf8");

  // {{param}} placeholders inside the fragment → HTML-escaped values.
  const textMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || typeof v === "object") continue;
    textMap[k] = escapeHtml(v);
  }
  let body = fill(fragment, textMap).replace(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g, "");
  // Move fragment scripts after the runtime.
  const scripts: string[] = [];
  body = body.replace(/<script>([\s\S]*?)<\/script>/g, (_m, js: string) => {
    scripts.push(js);
    return "";
  });

  const accent = color(params.accent, "#7C5CFF");
  const font = typeof params.font === "string" && SAFE_FONT.test(params.font) ? params.font : "Inter";
  const vars = [
    `--accent: ${accent};`,
    `--accent2: ${color(params.accent2, accent)};`,
    `--fg: ${color(params.color, "#FFFFFF")};`,
    `--font: '${font.replace(/'/g, "")}';`,
  ]
    .map((l) => "        " + l)
    .join("\n");
  const rem = (Math.min(o.width, o.height) / 1080) * 10;
  const data = { params, duration: o.duration, width: o.width, height: o.height, fps: o.fps, rem };

  return fill(shell, {
    WIDTH: String(o.width),
    HEIGHT: String(o.height),
    DURATION: String(o.duration),
    FPS: String(o.fps),
    REM: rem.toFixed(4),
    VARS: vars,
    BACKGROUND: o.opaque ? color(params.background, "#0B0B10") : "transparent",
    BODY: body,
    DATA: scriptJson(data),
    RUNTIME: runtime,
    SCRIPT: scripts.join("\n"),
  });
}

// ---------------------------------------------------------------------------
// HyperFrames invocation
// ---------------------------------------------------------------------------

type Format = "mov" | "webm" | "mp4";

function formatFor(output: string): Format {
  const ext = extname(output).toLowerCase();
  if (ext === ".mov") return "mov";
  if (ext === ".webm") return "webm";
  if (ext === ".mp4" || ext === ".m4v") return "mp4";
  throw new Error(`Unsupported motion output extension "${ext}". Use .mov (ProRes 4444 + alpha), .webm (VP9 + alpha) or .mp4 (opaque).`);
}

interface Cmd {
  cmd: string;
  args: string[];
}

function hyperframesCommand(): Cmd {
  const env = process.env.OPENEDIT_HYPERFRAMES_BIN;
  if (env) return env.endsWith(".js") || env.endsWith(".mjs") ? { cmd: process.execPath, args: [env] } : { cmd: env, args: [] };
  const bases = [import.meta.url, join(process.cwd(), "package.json")];
  for (const base of bases) {
    try {
      const pkgPath = createRequire(base).resolve("hyperframes/package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
      const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.hyperframes;
      if (rel) {
        const bin = join(dirname(pkgPath), rel);
        if (existsSync(bin)) return { cmd: process.execPath, args: [bin] };
      }
    } catch {
      /* not installed here */
    }
  }
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  return { cmd: npx, args: ["--yes", `hyperframes@${HYPERFRAMES_VERSION}`] };
}

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; out: string }> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let out = "";
    const keep = (b: Buffer) => {
      out += b.toString();
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          rej(new Error(`${cmd} timed out after ${opts.timeoutMs} ms\n${out.slice(-4000)}`));
        }, opts.timeoutMs)
      : null;
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      rej(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      res({ code: code ?? 1, out });
    });
  });
}

/** Render a composed index.html with HyperFrames. */
async function renderHtml(html: string, output: string, fps: number): Promise<void> {
  const format = formatFor(output);
  const out = resolve(output);
  mkdirSync(dirname(out), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "openedit-motion-"));
  try {
    writeFileSync(join(work, "index.html"), html);
    const hf = hyperframesCommand();
    const args = [...hf.args, "render", work, "--format", format, "-o", out, "--fps", String(fps), "--quality", "looks", "--quiet"];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HYPERFRAMES_NO_TELEMETRY: "1",
      HYPERFRAMES_NO_UPDATE_CHECK: "1",
      DO_NOT_TRACK: "1",
      CI: process.env.CI ?? "1",
    };
    const timeoutMs = Number(process.env.OPENEDIT_MOTION_TIMEOUT_MS) || 15 * 60_000;
    const r = await run(hf.cmd, args, { cwd: work, env, timeoutMs });
    if (r.code !== 0 || !existsSync(out) || statSync(out).size === 0) {
      throw new Error(`HyperFrames render failed (exit ${r.code}).\n${r.out.slice(-4000)}`);
    }
  } finally {
    if (!process.env.OPENEDIT_MOTION_KEEP) rmSync(work, { recursive: true, force: true });
  }
}

/** Write the composition only (debug / preview): returns the HTML string. */
export function buildTemplateHtml(o: {
  template: string;
  params?: Record<string, unknown>;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  opaque?: boolean;
}): string {
  const root = templatesDir();
  const m = readManifest(join(root, o.template));
  if (!m || o.template.startsWith("_") || /[\\/]/.test(o.template)) {
    throw new Error(`Unknown motion template "${o.template}". Available: ${allManifests().map((x) => x.id).join(", ")}`);
  }
  const fragment = readFileSync(join(root, o.template, "composition.html"), "utf8");
  const params = { ...(m.defaults ?? {}), ...stripUndefined(o.params ?? {}) };
  return compose(fragment, params, {
    width: even(o.width ?? 1920),
    height: even(o.height ?? 1080),
    fps: o.fps ?? 30,
    duration: positive(o.duration ?? m.duration ?? 4),
    opaque: !!o.opaque,
  });
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
function even(n: number): number {
  const v = Math.max(16, Math.round(n));
  return v % 2 ? v + 1 : v;
}
function positive(n: number): number {
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid duration ${n}`);
  return Math.round(n * 1000) / 1000;
}

export async function renderTemplate(o: {
  template: string;
  params: Record<string, unknown>;
  output: string;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
}): Promise<{ output: string }> {
  const format = formatFor(o.output);
  const fps = o.fps ?? 30;
  const html = buildTemplateHtml({ ...o, fps, opaque: format === "mp4" });
  await renderHtml(html, o.output, fps);
  return { output: resolve(o.output) };
}

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

interface CaptionStyleSpec {
  name: string;
  accent?: string;
  position?: "top" | "middle" | "bottom";
  font?: string;
}

/** Parse "bold-pop" or "bold-pop:accent=#00E0FF,position=top,font=Montserrat". */
export function parseCaptionStyle(style: string | undefined): CaptionStyleSpec {
  const raw = (style ?? "bold-pop").trim();
  const [nameRaw, rest] = raw.split(/[:?]/, 2) as [string, string | undefined];
  const name = nameRaw.trim().toLowerCase() || "bold-pop";
  if (!(name in CAPTION_STYLES)) {
    throw new Error(`Unknown caption style "${name}". Available: ${Object.keys(CAPTION_STYLES).join(", ")}`);
  }
  const spec: CaptionStyleSpec = { name };
  for (const kv of (rest ?? "").split(/[,&;]/)) {
    const [k, v] = kv.split("=").map((s) => s?.trim());
    if (!k || !v) continue;
    if (k === "accent" && SAFE_COLOR.test(v)) spec.accent = v;
    if (k === "position" && (v === "top" || v === "middle" || v === "bottom")) spec.position = v;
    if (k === "font" && SAFE_FONT.test(v)) spec.font = v;
  }
  return spec;
}

const STYLE_DEFAULT_ACCENT: Record<string, string> = {
  "bold-pop": "#FFE14D",
  clean: "#FFFFFF",
  karaoke: "#38E1FF",
  minimal: "#FFFFFF",
};

function normalizeCues(cues: CaptionCue[]): CaptionCue[] {
  return cues
    .filter((c) => c && typeof c.start === "number" && typeof c.end === "number" && c.end > c.start && String(c.text ?? "").trim())
    .map((c) => ({
      start: c.start,
      end: c.end,
      text: String(c.text).replace(/\s+/g, " ").trim(),
      words: c.words?.filter((w) => w && String(w.text ?? "").trim() && w.end >= w.start),
    }))
    .sort((a, b) => a.start - b.start);
}

/** Word timings for a cue: given words, or synthesized proportional to length. */
export function cueWords(c: CaptionCue): Word[] {
  if (c.words && c.words.length) return c.words.map((w) => ({ text: String(w.text).trim(), start: w.start, end: w.end }));
  const parts = c.text.split(/\s+/).filter(Boolean);
  const weights = parts.map((p) => p.length + 2);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const span = c.end - c.start;
  let acc = c.start;
  return parts.map((p, i) => {
    const d = (span * weights[i]!) / total;
    const w = { text: p, start: acc, end: acc + d };
    acc += d;
    return w;
  });
}

export async function renderCaptionOverlay(o: {
  cues: CaptionCue[];
  style?: string;
  output: string;
  width: number;
  height: number;
  fps: number;
}): Promise<{ output: string }> {
  const format = formatFor(o.output);
  const spec = parseCaptionStyle(o.style);
  const cues = normalizeCues(o.cues ?? []);
  if (!cues.length) throw new Error("renderCaptionOverlay: no valid cues");
  const width = even(o.width);
  const height = even(o.height);
  const fps = o.fps || 30;
  const duration = positive(Math.max(...cues.map((c) => c.end)) + 0.05);
  const accent = spec.accent ?? STYLE_DEFAULT_ACCENT[spec.name]!;
  const out = resolve(o.output);

  let hfError: unknown = null;
  if (!process.env.OPENEDIT_MOTION_FORCE_FALLBACK) {
    try {
      const fragment = readFileSync(join(templatesDir(), "_captions", "composition.html"), "utf8");
      const params = {
        style: spec.name,
        position: spec.position ?? "",
        accent,
        font: spec.font ?? (spec.name === "bold-pop" ? "Montserrat" : "Inter"),
        background: "#000000",
        pages: paginate(cues, spec.name).map((pg) => ({ start: pg.start, end: pg.end, words: pg.words.map((w) => ({ text: w.text, start: w.start, end: w.end })) })),
      };
      const html = compose(fragment, params, { width, height, fps, duration, opaque: format === "mp4" });
      await renderHtml(html, out, fps);
      return { output: out };
    } catch (e) {
      hfError = e;
    }
  }

  // Fallback: ASS subtitles burned onto a transparent canvas with ffmpeg/libass.
  const assPath = out.replace(/\.[^.]+$/, "") + ".ass";
  writeFileSync(assPath, buildAss(cues, spec, { width, height, accent }));
  try {
    await burnAss(assPath, out, { width, height, fps, duration, format });
    return { output: out };
  } catch (e) {
    const why = hfError ? `HyperFrames: ${(hfError as Error).message.split("\n")[0]}\n` : "";
    throw new Error(
      `Caption overlay render failed.\n${why}ffmpeg/libass fallback: ${(e as Error).message}\n` +
        `An ASS subtitle file was written to ${assPath} (import it in Resolve, or burn it with an ffmpeg built with libass).`,
    );
  }
}

// ---------------------------------------------------------------------------
// ASS fallback
// ---------------------------------------------------------------------------

function assTime(s: number): string {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** CSS hex → ASS &HAABBGGRR (alpha 00 = opaque). */
function assColor(hex: string, alpha = 0): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const h = m ? m[1]! : "FFFFFF";
  const r = h.slice(0, 2),
    g = h.slice(2, 4),
    b = h.slice(4, 6);
  return `&H${alpha.toString(16).padStart(2, "0")}${b}${g}${r}`.toUpperCase();
}

function assEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\n/g, " ");
}

interface Page {
  words: Word[];
  start: number;
  end: number;
}

/** Split cues into on-screen pages (same rules as the HTML caption composition). */
export function paginate(cues: CaptionCue[], style: string): Page[] {
  const lim: Record<string, [number, number]> = {
    "bold-pop": [3, 18],
    karaoke: [7, 38],
    clean: [14, 64],
    minimal: [8, 44],
  };
  const [maxWords, maxChars] = lim[style] ?? [7, 40];
  const pages: Page[] = [];
  for (const c of cues) {
    const local: Page[] = [];
    let cur: Word[] = [];
    let chars = 0;
    const flush = () => {
      if (cur.length) local.push({ words: cur, start: cur[0]!.start, end: c.end });
      cur = [];
      chars = 0;
    };
    for (const w of cueWords(c)) {
      const len = w.text.length + (cur.length ? 1 : 0);
      if (cur.length && (cur.length >= maxWords || chars + len > maxChars)) flush();
      cur.push(w);
      chars += len;
      if (/[.!?;:]$/.test(w.text) || (style === "bold-pop" && /,$/.test(w.text))) flush();
    }
    flush();
    // Within a cue a page stays up until the next one starts; the first starts with the cue.
    if (local.length) local[0]!.start = Math.min(local[0]!.start, c.start);
    for (let i = 0; i < local.length - 1; i++) local[i]!.end = local[i + 1]!.start;
    pages.push(...local);
  }
  pages.sort((a, b) => a.start - b.start);
  for (let i = 0; i < pages.length - 1; i++) {
    const next = pages[i + 1]!;
    if (next.start > pages[i]!.start) pages[i]!.end = Math.min(pages[i]!.end, next.start);
  }
  for (const pg of pages) if (pg.end <= pg.start) pg.end = pg.start + 0.1;
  return pages;
}

export function buildAss(cues: CaptionCue[], spec: CaptionStyleSpec, o: { width: number; height: number; accent: string }): string {
  const { width: W, height: H, accent } = o;
  const u = Math.min(W, H) / 1080;
  const portrait = H > W;
  const font = spec.font ?? (spec.name === "bold-pop" ? "Montserrat" : "Inter");
  const pos = spec.position ?? (spec.name === "bold-pop" ? "middle-low" : "bottom");
  const align = pos === "top" ? 8 : 2;
  const marginV =
    pos === "top" ? Math.round(H * 0.08) : pos === "middle" ? Math.round(H * 0.45) : pos === "middle-low" ? Math.round(H * (portrait ? 0.3 : 0.18)) : Math.round(H * (portrait ? 0.2 : 0.08));
  const marginH = Math.round(W * 0.08);
  const white = assColor("#FFFFFF");
  const black = assColor("#000000");
  const styles: Record<string, string> = {
    // Name,Fontname,Fontsize,Primary,Secondary,Outline,Back,Bold,Italic,Underline,Strike,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
    "bold-pop": `Style: Main,${font},${Math.round(92 * u)},${white},${white},${black},${assColor("#000000", 0x60)},-1,0,0,0,100,100,1,0,1,${(5 * u).toFixed(1)},${(3 * u).toFixed(1)},${align},${marginH},${marginH},${marginV},1`,
    clean: `Style: Main,${font},${Math.round(46 * u)},${white},${white},${assColor("#08080C", 0x5a)},${assColor("#08080C", 0x5a)},-1,0,0,0,100,100,0,0,3,${(14 * u).toFixed(1)},0,${align},${marginH},${marginH},${marginV},1`,
    karaoke: `Style: Main,${font},${Math.round(64 * u)},${assColor(accent)},${white},${black},${assColor("#000000", 0x80)},-1,0,0,0,100,100,0,0,1,${(3 * u).toFixed(1)},${(2 * u).toFixed(1)},${align},${marginH},${marginH},${marginV},1`,
    minimal: `Style: Main,${font},${Math.round(38 * u)},${white},${white},${assColor("#000000", 0x90)},${assColor("#000000", 0x80)},0,0,0,0,100,100,0,0,1,${(1.5 * u).toFixed(1)},${(1.5 * u).toFixed(1)},${align},${marginH},${marginH},${marginV},1`,
  };
  const lines: string[] = [];
  const pages = paginate(cues, spec.name);
  const ev = (s: number, e: number, text: string) => lines.push(`Dialogue: 0,${assTime(s)},${assTime(e)},Main,,0,0,0,,${text}`);
  for (const pg of pages) {
    const words = pg.words.map((w) => assEscape(spec.name === "bold-pop" ? w.text.toUpperCase() : w.text));
    if (spec.name === "bold-pop") {
      pg.words.forEach((w, i) => {
        const s = i === 0 ? pg.start : w.start;
        const e = i < pg.words.length - 1 ? pg.words[i + 1]!.start : pg.end;
        if (e <= s) return;
        const txt = words
          .map((t, j) =>
            j === i ? `{\\c${assColor(accent)}\\fscx118\\fscy118\\t(0,90,\\fscx108\\fscy108)}${t}{\\c${white}\\fscx100\\fscy100}` : t,
          )
          .join(" ");
        ev(s, e, (i === 0 ? "{\\fad(60,0)}" : "") + txt);
      });
    } else if (spec.name === "karaoke") {
      let cursor = pg.start;
      const parts = pg.words.map((w, i) => {
        const lead = Math.max(0, w.start - cursor);
        const dur = Math.max(0.01, (i < pg.words.length - 1 ? pg.words[i + 1]!.start : w.end) - w.start);
        cursor = w.start + dur;
        return (lead > 0.005 ? `{\\k${Math.round(lead * 100)}}` : "") + `{\\kf${Math.round(dur * 100)}}${words[i]}`;
      });
      ev(pg.start, pg.end, `{\\fad(100,100)}` + parts.join(" "));
    } else {
      ev(pg.start, pg.end, `{\\fad(${spec.name === "clean" ? 140 : 200},120)}` + words.join(" "));
    }
  }
  return [
    "[Script Info]",
    "; Generated by OpenEdit motion (fallback renderer)",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    styles[spec.name]!,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...lines,
    "",
  ].join("\n");
}

async function ffmpegHasFilter(name: string): Promise<boolean> {
  try {
    const r = await run(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-filters"], { timeoutMs: 20_000 });
    return new RegExp(`\\s${name}\\s+V->V`).test(r.out);
  } catch {
    return false;
  }
}

function ffFilterPath(p: string): string {
  // Escape for use inside a filtergraph option value.
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,");
}

async function burnAss(
  assPath: string,
  output: string,
  o: { width: number; height: number; fps: number; duration: number; format: Format },
): Promise<void> {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const filter = (await ffmpegHasFilter("ass")) ? "ass" : (await ffmpegHasFilter("subtitles")) ? "subtitles" : null;
  if (!filter) throw new Error("this ffmpeg build has no libass (neither the 'ass' nor the 'subtitles' filter is available)");
  const opaque = o.format === "mp4";
  const src = `color=c=${opaque ? "black" : "black@0.0"}:s=${o.width}x${o.height}:r=${o.fps}:d=${o.duration}`;
  const alphaOpt = opaque ? "" : ":alpha=1";
  const vf = `format=${opaque ? "yuv420p" : "yuva420p"},${filter}=filename='${ffFilterPath(assPath)}'${alphaOpt}`;
  const codec =
    o.format === "mov"
      ? ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0"]
      : o.format === "webm"
        ? ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "24", "-row-mt", "1", "-metadata:s:v:0", "alpha_mode=1"]
        : ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-movflags", "+faststart"];
  const r = await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", src, "-vf", vf, ...codec, "-an", output], {
    timeoutMs: 15 * 60_000,
  });
  if (r.code !== 0 || !existsSync(output)) throw new Error(`ffmpeg exited ${r.code}: ${r.out.slice(-2000)}`);
}
