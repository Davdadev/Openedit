// structuredContent builders for the inline MCP Apps views. Every tool keeps its text
// content (what the model and text-only hosts see); these objects are for rendering only.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { DEFAULT_FILLERS, normalizeWord, summarizePlan } from "../engine/cutplan.js";
import { paths } from "../engine/paths.js";
import { editDuration } from "../engine/remap.js";
import type { Cut, CutPlan, HostName, HostStatus, Transcript } from "../hosts/types.js";

const r3 = (n: number) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------------------------------------
// ffmpeg helpers (best effort: views degrade gracefully when these fail)

function ffmpegBuffer(args: string[], timeoutMs: number, maxBytes = 64 * 1024 * 1024): Promise<Buffer | undefined> {
  return new Promise((ok) => {
    let child;
    try {
      child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return ok(undefined);
    }
    const out: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size > maxBytes) child.kill("SIGKILL");
      else out.push(d);
    });
    child.on("error", () => {
      clearTimeout(timer);
      ok(undefined);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      ok(code === 0 && size <= maxBytes ? Buffer.concat(out) : undefined);
    });
  });
}

function fileSig(p: string): string | undefined {
  try {
    const st = statSync(p);
    return createHash("sha1").update(`${p}|${st.size}|${st.mtimeMs}`).digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}

/** ~`buckets` normalised peak values (0..1) of a file's audio, cached on disk. */
export async function waveformPeaks(path: string, buckets = 480): Promise<number[] | undefined> {
  const sig = fileSig(path);
  if (!sig) return undefined;
  const dir = join(paths.cache(), "peaks");
  const file = join(dir, `${sig}-${buckets}.json`);
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as number[];
    } catch {
      /* recompute */
    }
  }
  const pcm = await ffmpegBuffer(["-i", path, "-vn", "-ac", "1", "-ar", "2000", "-f", "s16le", "-acodec", "pcm_s16le", "-"], 90_000);
  if (!pcm || pcm.length < 4) return undefined;
  const n = Math.floor(pcm.length / 2);
  const per = Math.max(1, Math.floor(n / buckets));
  const peaks: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const from = b * per;
    if (from >= n) break;
    const to = Math.min(n, from + per);
    let sum = 0;
    let max = 0;
    for (let i = from; i < to; i++) {
      const v = Math.abs(pcm.readInt16LE(i * 2)) / 32768;
      sum += v * v;
      if (v > max) max = v;
    }
    // Blend RMS and peak for a natural-looking envelope.
    peaks.push(Math.sqrt(sum / (to - from)) * 0.65 + max * 0.35);
  }
  const top = Math.max(1e-6, ...peaks);
  const norm = peaks.map((p) => Math.round(Math.min(1, Math.pow(p / top, 0.7)) * 1000) / 1000);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(norm));
  } catch {
    /* cache is optional */
  }
  return norm;
}

/** A still frame as a data: URI (JPEG, or PNG to keep alpha). */
export async function frameDataUri(path: string, at: number, opts: { width?: number; png?: boolean } = {}): Promise<string | undefined> {
  const width = opts.width ?? 480;
  const args = ["-ss", String(Math.max(0, at)), "-i", path, "-frames:v", "1", "-vf", `scale=${width}:-2`];
  const buf = opts.png
    ? await ffmpegBuffer([...args, "-f", "image2pipe", "-vcodec", "png", "-"], 20_000, 4 * 1024 * 1024)
    : await ffmpegBuffer([...args, "-q:v", "5", "-f", "image2pipe", "-vcodec", "mjpeg", "-"], 20_000, 4 * 1024 * 1024);
  if (!buf?.length) return undefined;
  return `data:image/${opts.png ? "png" : "jpeg"};base64,${buf.toString("base64")}`;
}

// ---------------------------------------------------------------------------------------------
// Cut plan

export interface CutPlanView {
  view: "cut-plan";
  planId: string;
  source: string;
  sourceName: string;
  duration: number;
  editedDuration: number;
  timeSaved: number;
  percentSaved: number;
  keptSegments: number;
  cutsByReason: Record<Cut["reason"], { count: number; seconds: number }>;
  keep: { start: number; end: number }[];
  cuts: { start: number; end: number; reason: Cut["reason"]; label?: string; text?: string }[];
  waveform?: number[];
  revisedFrom?: string;
  applied?: { host: string; sequence?: string; output?: string };
}

function loadTranscript(p?: string): Transcript | undefined {
  if (!p) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Transcript;
  } catch {
    return undefined;
  }
}

/** What was said inside each cut (words whose midpoint falls in the cut). */
export function cutTexts(cuts: Cut[], transcript?: Transcript): (string | undefined)[] {
  const words = transcript?.segments.flatMap((s) => s.words) ?? [];
  return cuts.map((c) => {
    const said = words
      .filter((w) => (w.start + w.end) / 2 >= c.start && (w.start + w.end) / 2 <= c.end)
      .map((w) => w.text.trim())
      .join(" ");
    return said ? (said.length > 220 ? `${said.slice(0, 217)}…` : said) : undefined;
  });
}

export async function cutPlanView(
  stored: { id: string; plan: CutPlan; transcriptPath?: string; options?: Record<string, unknown> },
  extra: { applied?: CutPlanView["applied"]; transcript?: Transcript; waveform?: boolean } = {},
): Promise<CutPlanView> {
  const { plan } = stored;
  const sum = summarizePlan(plan);
  const texts = cutTexts(plan.cuts, extra.transcript ?? loadTranscript(stored.transcriptPath));
  const waveform = extra.waveform === false || plan.duration > 3 * 3600 ? undefined : await waveformPeaks(plan.source);
  const revisedFrom = typeof stored.options?.revisedFrom === "string" ? stored.options.revisedFrom : undefined;
  return {
    view: "cut-plan",
    planId: stored.id,
    source: plan.source,
    sourceName: basename(plan.source),
    duration: r3(plan.duration),
    editedDuration: r3(editDuration(plan)),
    timeSaved: sum.timeSaved,
    percentSaved: sum.percentSaved,
    keptSegments: sum.keptSegments,
    cutsByReason: sum.cutsByReason,
    keep: plan.keep,
    cuts: plan.cuts.map((c, i) => ({ start: c.start, end: c.end, reason: c.reason, ...(c.label ? { label: c.label } : {}), ...(texts[i] ? { text: texts[i] } : {}) })),
    ...(waveform ? { waveform } : {}),
    ...(revisedFrom ? { revisedFrom } : {}),
    ...(extra.applied ? { applied: extra.applied } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Transcript

export interface TranscriptView {
  view: "transcript";
  source: string;
  sourceName: string;
  language: string;
  duration: number;
  wordCount: number;
  fillerCount: number;
  jsonPath: string;
  cached: boolean;
  /** Segments of [text, start, end, isFiller(0|1)] words. */
  segments: { start: number; end: number; words: [string, number, number, 0 | 1][] }[];
  truncated?: boolean;
}

export function transcriptView(src: string, t: Transcript, jsonPath: string, cached: boolean, maxWords = 8000): TranscriptView {
  const fillers = new Set(DEFAULT_FILLERS);
  let total = 0;
  let fillerCount = 0;
  let truncated = false;
  const segments: TranscriptView["segments"] = [];
  for (const s of t.segments) {
    if (total >= maxWords) {
      truncated = true;
      break;
    }
    const words = s.words.slice(0, maxWords - total).map((w): [string, number, number, 0 | 1] => {
      const f = fillers.has(normalizeWord(w.text)) ? 1 : 0;
      fillerCount += f;
      return [w.text.trim(), r3(w.start), r3(w.end), f];
    });
    total += words.length;
    if (words.length) segments.push({ start: r3(s.start), end: r3(s.end), words });
  }
  return {
    view: "transcript",
    source: src,
    sourceName: basename(src),
    language: t.language,
    duration: r3(t.duration),
    wordCount: t.segments.reduce((n, s) => n + s.words.length, 0),
    fillerCount,
    jsonPath,
    cached,
    segments,
    ...(truncated ? { truncated } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Stock media

export interface MediaCard {
  gid: string;
  provider: string;
  kind: string;
  title: string;
  author?: string;
  url?: string;
  previewUrl?: string;
  /** data: URI thumbnail of a downloaded local file. */
  thumb?: string;
  width?: number;
  height?: number;
  duration?: number;
  license: string;
  licenseCode?: string;
  attributionRequired: boolean;
  score?: number;
  reason?: string;
  /** Local path once downloaded. */
  path?: string;
  existing?: boolean;
}

export interface MediaView {
  view: "media";
  mode: "find" | "download";
  query?: string;
  kind?: string;
  considered?: number;
  items: MediaCard[];
  providers?: { provider: string; status: string; count: number; detail?: string }[];
  creditsPath?: string;
  errors?: string[];
}

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".m4v", ".mkv"]);

/** Small thumbnail for a downloaded local image/video. */
export async function localThumb(path: string): Promise<string | undefined> {
  const ext = extname(path).toLowerCase();
  if (!IMAGE_EXT.has(ext) && !VIDEO_EXT.has(ext)) return undefined;
  return frameDataUri(path, VIDEO_EXT.has(ext) ? 1 : 0, { width: 320 });
}

// ---------------------------------------------------------------------------------------------
// Render

export interface RenderView {
  view: "render";
  kind: "render" | "motion" | "caption-overlay";
  output: string;
  name: string;
  exists: boolean;
  host?: string;
  duration?: number;
  width?: number;
  height?: number;
  fps?: number;
  sizeBytes?: number;
  alpha?: boolean;
  thumbnail?: string;
  frames?: string[];
  detail?: string;
  placed?: string;
  warnings?: string[];
  studioUrl?: string;
}

interface ProbeLike {
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
}

export async function renderView(
  o: { kind: RenderView["kind"]; output: string; host?: string; detail?: string; placed?: string; warnings?: string[]; studioUrl?: string },
  probeFn: (p: string) => Promise<ProbeLike>,
): Promise<RenderView> {
  const exists = existsSync(o.output);
  const alpha = o.kind !== "render" && /\.(mov|webm)$/i.test(o.output);
  const v: RenderView = {
    view: "render",
    kind: o.kind,
    output: o.output,
    name: basename(o.output),
    exists,
    alpha,
    ...(o.host ? { host: o.host } : {}),
    ...(o.detail ? { detail: o.detail } : {}),
    ...(o.placed ? { placed: o.placed.replace(/^and\s+/, "") } : {}),
    ...(o.warnings?.length ? { warnings: o.warnings } : {}),
    ...(o.studioUrl ? { studioUrl: o.studioUrl } : {}),
  };
  if (!exists) return v;
  try {
    v.sizeBytes = statSync(o.output).size;
    const info = await probeFn(o.output);
    v.duration = r3(info.duration);
    v.width = info.width;
    v.height = info.height;
    v.fps = info.fps ? Math.round(info.fps * 100) / 100 : undefined;
    const d = info.duration || 0;
    const [thumb, ...frames] = await Promise.all([
      frameDataUri(o.output, d * (o.kind === "render" ? 0.35 : 0.5), { width: 640, png: alpha }),
      ...(d > 1 ? [0.08, 0.26, 0.44, 0.62, 0.8, 0.96].map((f) => frameDataUri(o.output, d * f, { width: 160, png: alpha })) : []),
    ]);
    if (thumb) v.thumbnail = thumb;
    const ok = frames.filter((f): f is string => !!f);
    if (ok.length >= 3) v.frames = ok;
  } catch {
    /* metadata is best effort */
  }
  return v;
}

// ---------------------------------------------------------------------------------------------
// Editor status

export interface StatusView {
  view: "status";
  active: HostName;
  hosts: { host: HostName; connected: boolean | null; active: boolean; version?: string; project?: string; sequence?: string; detail?: string }[];
  studioUrl?: string;
  warning?: string;
}

const HOST_ORDER: HostName[] = ["premiere", "resolve", "standalone"];

export function statusView(active: HostStatus, tried?: { host: HostName; connected: boolean; detail?: string }[], studioUrl?: string, warning?: string): StatusView {
  const hosts = HOST_ORDER.map((h) => {
    if (h === active.host) return { ...active, host: h, active: true };
    const t = tried?.find((x) => x.host === h);
    if (t) return { host: h, connected: t.connected, active: false, ...(t.detail ? { detail: t.detail } : {}) };
    if (h === "standalone") return { host: h, connected: true, active: false, detail: "ffmpeg, always available" };
    return { host: h, connected: null, active: false, detail: "not checked" };
  });
  return { view: "status", active: active.host, hosts, ...(studioUrl ? { studioUrl } : {}), ...(warning ? { warning } : {}) };
}

// Media card builders (type-only imports keep src/ui free of provider code).
type Ranked = import("../media/search.js").RankedResult;
type Outcome = import("../media/download.js").DownloadOutcome;
type FindResp = import("../media/search.js").FindResponse;

export function cardFromResult(r: Ranked): MediaCard {
  return {
    gid: r.gid,
    provider: r.provider,
    kind: r.kind,
    title: r.title,
    ...(r.author ? { author: r.author } : {}),
    url: r.url,
    ...(r.previewUrl ? { previewUrl: r.previewUrl } : {}),
    ...(r.width ? { width: r.width } : {}),
    ...(r.height ? { height: r.height } : {}),
    ...(r.duration !== undefined ? { duration: Math.round(r.duration * 10) / 10 } : {}),
    license: r.license,
    licenseCode: r.licenseCode,
    attributionRequired: r.attributionRequired,
    score: r.score,
    reason: r.reason,
  };
}

export async function cardFromOutcome(o: Outcome, from?: Ranked | import("../media/types.js").MediaResult): Promise<MediaCard> {
  const thumb = await localThumb(o.path).catch(() => undefined);
  const base: Partial<MediaCard> = {};
  if (from) {
    if (from.previewUrl) base.previewUrl = from.previewUrl;
    if (from.width) base.width = from.width;
    if (from.height) base.height = from.height;
    if (from.duration !== undefined) base.duration = Math.round(from.duration * 10) / 10;
    base.licenseCode = from.licenseCode;
    if ("score" in from) base.score = from.score;
  }
  return {
    ...base,
    gid: o.gid,
    provider: o.provider,
    kind: o.kind,
    title: o.title,
    ...(o.author ? { author: o.author } : {}),
    url: o.sourceUrl,
    license: o.license,
    attributionRequired: o.attributionRequired,
    path: o.path,
    existing: o.existing,
    ...(thumb ? { thumb } : {}),
  };
}

export function providerReports(r: FindResp): MediaView["providers"] {
  return r.providers.map((p) => ({ provider: p.provider, status: p.status, count: p.count, ...(p.detail ? { detail: p.detail } : {}) }));
}
