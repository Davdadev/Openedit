// Central instrumentation: every MCP tool registered on the server emits
// tool_start / tool_end (plus timeline/media snapshots) to the studio bus.
import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runWithSignal } from "../engine/exec.js";
import { loadPlan } from "../mcp/plans.js";
import { emitStudio, newCallId, runInToolContext, type StudioMediaItem, type StudioTarget } from "./events.js";

/** Friendly, present-tense titles for the status panel. */
export const TOOL_TITLES: Record<string, string> = {
  editor_status: "Checking the editor",
  select_host: "Switching editor",
  get_timeline: "Reading the timeline",
  probe_media: "Inspecting media",
  transcribe: "Transcribing speech",
  find_silences: "Finding silences",
  plan_cuts: "Planning cuts",
  show_plan: "Reviewing the cut plan",
  apply_cuts: "Cutting silences",
  make_captions: "Writing captions",
  add_markers: "Adding markers",
  add_zooms: "Adding punch-ins",
  auto_zooms: "Placing auto zooms",
  import_media: "Importing media",
  place_clips: "Placing clips",
  render: "Rendering the edit",
  motion_templates: "Listing motion templates",
  render_motion: "Rendering motion graphics",
  render_caption_overlay: "Rendering caption overlay",
  open_studio: "Opening OpenEdit Studio",
  studio_overlay_snippet: "Preparing overlay snippet",
};

const VERBS: Record<string, string> = {
  add: "Adding", apply: "Applying", create: "Creating", download: "Downloading", fetch: "Fetching", find: "Finding",
  generate: "Generating", get: "Reading", import: "Importing", list: "Listing", make: "Making", open: "Opening",
  place: "Placing", plan: "Planning", probe: "Probing", remove: "Removing", render: "Rendering", search: "Searching",
  select: "Selecting", set: "Setting", show: "Showing", transcribe: "Transcribing", upload: "Uploading", save: "Saving",
  check: "Checking", delete: "Deleting", update: "Updating", export: "Exporting", license: "Checking license",
};

export function toolTitle(tool: string): string {
  if (TOOL_TITLES[tool]) return TOOL_TITLES[tool];
  const [first, ...rest] = tool.split(/[_\-\s]+/).filter(Boolean);
  if (!first) return tool;
  const verb = VERBS[first.toLowerCase()];
  const tail = rest.join(" ");
  if (verb) return tail ? `${verb} ${tail}` : verb;
  const words = [first, ...rest].join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const short = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const looksPath = (s: string) => /^(~|\/|[A-Za-z]:\\)/.test(s);

/** One-line, human-sized summary of tool arguments. */
export function summarizeArgs(args: unknown, max = 140): string {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    let val: string;
    if (typeof v === "string") val = looksPath(v) ? basename(v) : `"${short(v, 40)}"`;
    else if (typeof v === "number" || typeof v === "boolean") val = String(v);
    else if (Array.isArray(v)) val = `${v.length} item${v.length === 1 ? "" : "s"}`;
    else val = "{…}";
    parts.push(`${k}: ${val}`);
  }
  const s = parts.join(" · ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const MEDIA_TOOL = /media|stock|download|music|sfx|sound|image|photo|footage|broll|b_roll|keys|asset/i;

/** Where the studio cursor should go for a given call. */
export function deriveTarget(tool: string, args: Record<string, unknown>): StudioTarget | undefined {
  const path = typeof args.path === "string" ? args.path : undefined;
  const file = (p: string, label?: string): StudioTarget => ({ kind: "file", label: label ?? basename(p), path: p });
  switch (tool) {
    case "transcribe":
    case "probe_media":
    case "find_silences":
      return path ? file(path) : { kind: "timeline", label: "Source media" };
    case "plan_cuts":
    case "show_plan":
    case "apply_cuts":
    case "get_timeline":
      return { kind: "timeline", label: tool === "apply_cuts" ? "Edit" : "Source" };
    case "make_captions":
    case "render_caption_overlay":
      return { kind: "caption", label: `${(args.style as string) ?? "bold-pop"} captions` };
    case "add_zooms": {
      const z = (args.zooms as { start: number; end: number; scale: number }[] | undefined)?.[0];
      return z ? { kind: "range", label: `Zoom ${z.scale}%`, start: z.start, end: z.end } : { kind: "timeline", label: "Zooms" };
    }
    case "auto_zooms":
      return { kind: "timeline", label: "Zooms" };
    case "add_markers": {
      const m = (args.markers as { time: number; name: string }[] | undefined)?.[0];
      return m ? { kind: "range", label: m.name, start: m.time, end: m.time } : undefined;
    }
    case "place_clips": {
      const c = (args.clips as { path: string; at: number }[] | undefined)?.[0];
      return c ? { kind: "clip", label: basename(c.path), path: c.path, start: c.at } : undefined;
    }
    case "import_media": {
      const p = (args.paths as string[] | undefined)?.[0];
      return p ? { kind: "media", label: basename(p), path: p } : undefined;
    }
    case "render":
    case "render_motion":
      return typeof args.output === "string" ? file(args.output) : { kind: "file", label: String(args.template ?? "render") };
  }
  if (MEDIA_TOOL.test(tool)) {
    const label = [args.query, args.title, args.url, args.id, path].find((v) => typeof v === "string") as string | undefined;
    return { kind: "media", label: label ? short(looksPath(label) ? basename(label) : label, 40) : toolTitle(tool), path };
  }
  return path ? file(path) : undefined;
}

const MEDIA_EXT: Record<string, StudioMediaItem["kind"]> = {
  ".mp4": "video", ".mov": "video", ".webm": "video", ".m4v": "video", ".mkv": "video",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image",
  ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".aac": "audio", ".flac": "audio", ".ogg": "audio",
  ".srt": "caption", ".vtt": "caption", ".ass": "caption",
  ".json": "data",
};

export function mediaKind(p: string): StudioMediaItem["kind"] {
  return MEDIA_EXT[extname(p).toLowerCase()] ?? "other";
}

/** Absolute file paths mentioned in a tool result that exist on disk. */
export function extractPaths(text: string): string[] {
  const out = new Set<string>();
  const home = process.env.HOME ?? "";
  for (const m of text.matchAll(/(?:~|\/)[^\s"'`,<>()[\]{}]*\.[A-Za-z0-9]{2,5}\b/g)) {
    const p = m[0].replace(/^~(?=\/)/, home).replace(/[.:;]+$/, "");
    if (p.startsWith("/") && existsSync(p)) out.add(p);
  }
  return [...out];
}

function resultText(res: unknown): string {
  const content = (res as { content?: { type: string; text?: string }[] } | undefined)?.content;
  return Array.isArray(content) ? content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n") : "";
}

/** "mm:ss.s" or "h:mm:ss.s" -> seconds. */
function parseClock(s: string): number {
  return s.split(":").reduce((a, p) => a * 60 + Number(p), 0);
}

export function parseSrt(text: string): { start: number; end: number; text: string }[] {
  const t = (s: string) => {
    const [h, m, rest] = s.trim().split(":");
    return Number(h) * 3600 + Number(m) * 60 + Number(rest.replace(",", "."));
  };
  return text
    .replace(/\r/g, "")
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.trim().split("\n");
      const i = lines.findIndex((l) => l.includes("-->"));
      if (i < 0) return undefined;
      const [a, b] = lines[i].split("-->");
      return { start: t(a), end: t(b), text: lines.slice(i + 1).join(" ").replace(/<[^>]+>|\{[^}]*\}/g, "") };
    })
    .filter((c): c is { start: number; end: number; text: string } => !!c && Number.isFinite(c.start));
}

/** Pull media items (with license/title if present) out of a JSON tool result. */
function mediaFromJson(text: string): StudioMediaItem[] {
  const items: StudioMediaItem[] = [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return items;
  }
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 6) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    const p = [o.path, o.file, o.output, o.localPath].find((x) => typeof x === "string" && looksPath(x)) as string | undefined;
    if (p) {
      const lic = o.license;
      items.push({
        path: p.replace(/^~(?=\/)/, process.env.HOME ?? ""),
        title: typeof o.title === "string" ? o.title : undefined,
        license: typeof lic === "string" ? lic : lic && typeof lic === "object" ? String((lic as Record<string, unknown>).name ?? (lic as Record<string, unknown>).id ?? "") || undefined : undefined,
        source: typeof o.source === "string" ? o.source : typeof o.provider === "string" ? o.provider : undefined,
        url: typeof o.url === "string" ? o.url : typeof o.pageUrl === "string" ? o.pageUrl : undefined,
      });
    }
    for (const x of Object.values(o)) if (x && typeof x === "object") walk(x, depth + 1);
  };
  walk(data, 0);
  return items;
}

/** After a tool succeeds, publish what the studio should draw (plan, captions, zooms, clips, media). */
export function emitDerived(tool: string, args: Record<string, unknown>, text: string, outputs: string[]): void {
  const planId = (typeof args.planId === "string" ? args.planId : undefined) ?? /planId: (\S+)/.exec(text)?.[1];
  if (planId && ["plan_cuts", "show_plan", "apply_cuts"].includes(tool)) {
    try {
      const { plan } = loadPlan(planId);
      emitStudio({ type: "timeline", plan: { id: planId, ...plan }, applied: tool === "apply_cuts" });
    } catch {
      /* plan missing: nothing to draw */
    }
  }
  if (tool === "make_captions") {
    const srt = outputs.find((p) => p.endsWith(".srt"));
    if (srt) {
      try {
        emitStudio({ type: "timeline", captions: parseSrt(readFileSync(srt, "utf8")) });
      } catch {
        /* unreadable */
      }
    }
  }
  if (tool === "add_zooms" && Array.isArray(args.zooms)) {
    emitStudio({ type: "timeline", zooms: args.zooms as { start: number; end: number; scale: number }[] });
  }
  if (tool === "auto_zooms") {
    const scale = typeof args.scale === "number" ? args.scale : 112;
    const zooms = [...text.matchAll(/- ([\d:.]+)–([\d:.]+)/g)].map((m) => ({ start: parseClock(m[1]), end: parseClock(m[2]), scale }));
    if (zooms.length) emitStudio({ type: "timeline", zooms });
  }
  if (tool === "place_clips" && Array.isArray(args.clips)) {
    const clips = (args.clips as { path: string; at: number; duration?: number; track?: number; sourceIn?: number; sourceOut?: number }[]).map((c) => ({
      path: c.path,
      at: c.at,
      track: c.track ?? 2,
      duration: c.duration ?? (c.sourceOut !== undefined ? c.sourceOut - (c.sourceIn ?? 0) : undefined),
    }));
    emitStudio({ type: "timeline", clips });
  }
  if (tool === "render_motion" && typeof args.placeAt === "number" && outputs[0]) {
    emitStudio({ type: "timeline", clips: [{ path: outputs[0], at: args.placeAt, track: (args.track as number) ?? 3, duration: args.duration as number | undefined }] });
  }
  const fromJson = mediaFromJson(text);
  const seen = new Set(fromJson.map((m) => m.path));
  const items: StudioMediaItem[] = [...fromJson];
  for (const p of outputs) if (!seen.has(p) && mediaKind(p) !== "data") items.push({ path: p });
  for (const it of items) it.kind ??= mediaKind(it.path);
  if (items.length) emitStudio({ type: "media", items });
}

type Handler = (...a: unknown[]) => unknown;

/** Wrap a tool handler so each call is reported to the studio bus. */
export function instrumentHandler(tool: string, hasInput: boolean, cb: Handler): Handler {
  return async (...a: unknown[]) => {
    const args = (hasInput ? a[0] : {}) as Record<string, unknown>;
    const id = newCallId();
    const t0 = Date.now();
    emitStudio({ type: "tool_start", id, tool, title: toolTitle(tool), args: summarizeArgs(args), target: safeTarget(tool, args) });
    try {
      // The SDK passes `extra` (with the request's AbortSignal) after the args: cancelling the
      // MCP request then kills the ffmpeg/whisper processes the call started.
      const extra = (hasInput ? a[1] : a[0]) as { signal?: AbortSignal } | undefined;
      const res = await runWithSignal(extra?.signal, () => runInToolContext({ id, tool }, () => cb(...a)));
      const text = resultText(res);
      const isError = !!(res as { isError?: boolean } | undefined)?.isError;
      const outputs = isError ? [] : extractPaths(text);
      if (!isError) {
        try {
          emitDerived(tool, args, text, outputs);
        } catch {
          /* derived views are best effort */
        }
      }
      const first = text.split("\n").find((l) => l.trim()) ?? "";
      emitStudio({ type: "tool_end", id, tool, ok: !isError, summary: short(first.replace(/^Error: /, ""), 180), outputs, ms: Date.now() - t0 });
      return res;
    } catch (e) {
      emitStudio({ type: "tool_end", id, tool, ok: false, summary: short((e as Error).message ?? String(e), 180), outputs: [], ms: Date.now() - t0 });
      throw e;
    }
  };
}

function safeTarget(tool: string, args: Record<string, unknown>): StudioTarget | undefined {
  try {
    return deriveTarget(tool, args ?? {});
  } catch {
    return undefined;
  }
}

const PATCHED = Symbol.for("openedit.studio.instrumented");

/**
 * Monkeypatch server.registerTool so every tool registered afterwards
 * (including ones added by other modules later) is instrumented.
 */
export function instrumentServer(server: McpServer): McpServer {
  const s = server as unknown as Record<string | symbol, unknown>;
  if (s[PATCHED]) return server;
  s[PATCHED] = true;
  const original = server.registerTool.bind(server) as (name: string, config: Record<string, unknown>, cb: Handler) => unknown;
  (server as unknown as { registerTool: unknown }).registerTool = (name: string, config: Record<string, unknown>, cb: Handler) =>
    original(name, config, instrumentHandler(name, config?.inputSchema !== undefined, cb));
  return server;
}
