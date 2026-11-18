// OpenEdit Studio HTTP server: static page + SSE event stream + guarded media preview.
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { openeditHome } from "../engine/paths.js";
import { ensureToken } from "../hosts/premiere.js";
import type { StudioEvent } from "./events.js";
import { timingSafeEqual } from "node:crypto";

/** Constant-time token check, so the token can't be guessed byte by byte from response timing. */
function tokenMatches(given: string | string[] | undefined, token: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const STUDIO_DEFAULT_PORT = 47822;
export const STUDIO_APP_ID = "openedit-studio";
const REPLAY = 200;
const STICKY = new Set(["timeline", "media", "session"]);

export function studioPort(): number {
  const p = Number(process.env.OPENEDIT_STUDIO_PORT);
  return Number.isInteger(p) && p >= 0 && p < 65536 && process.env.OPENEDIT_STUDIO_PORT ? p : STUDIO_DEFAULT_PORT;
}

/** Static web assets live in src/studio/web (shipped in the npm package; no build step). */
export function webRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "web"), resolve(here, "..", "..", "src", "studio", "web")];
  return candidates.find((d) => existsSync(join(d, "index.html"))) ?? candidates[0];
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".ass": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export interface StudioServerOptions {
  port?: number;
  host?: string;
  token?: string;
  /** Extra directories /media may serve from. */
  allowDirs?: string[];
}

export interface StudioServer {
  url: string;
  port: number;
  token: string;
  /** Publish an event to connected pages (and the replay buffer). */
  publish(evt: StudioEvent): void;
  /** Mark a file as previewable through /media. */
  allowPath(p: string): void;
  close(): Promise<void>;
  server: Server;
}

function real(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/** Every path an event mentions becomes previewable (the session produced or used it). */
function eventPaths(evt: StudioEvent): string[] {
  const out: string[] = [];
  switch (evt.type) {
    case "tool_start":
      if (evt.target?.path) out.push(evt.target.path);
      break;
    case "tool_end":
      out.push(...(evt.outputs ?? []));
      break;
    case "media":
      out.push(...evt.items.map((i) => i.path));
      break;
    case "timeline":
      if (evt.plan?.source) out.push(evt.plan.source);
      out.push(...(evt.clips ?? []).map((c) => c.path));
      break;
  }
  return out.filter((p) => typeof p === "string").map((p) => p.replace(/^~(?=\/)/, homedir()));
}

/** Replace absolute paths in free text by their file name. */
function scrubPaths(text: string | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  return text.replace(/(?<![\w.~])(?:~|[A-Za-z]:)?[\\/](?:[^\s"'`<>|]*[\\/])?([^\s"'`<>|\\/]*)/g, (m, name: string) => (/[\\/]/.test(m) ? name : m));
}

/**
 * What a page on another origin may see: just enough for the injectable overlay (titles,
 * progress, target labels/selectors). Never paths, arguments, outputs, transcripts or captions:
 * /events is CORS-open so the overlay works on any site, which also means any site can read it.
 */
export function redactForCrossOrigin(e: StudioEvent): StudioEvent | undefined {
  const base = { at: e.at, seq: e.seq };
  switch (e.type) {
    case "tool_start":
      return {
        ...base,
        type: "tool_start",
        id: e.id,
        tool: e.tool,
        title: e.title,
        target: e.target ? { kind: e.target.kind, label: scrubPaths(e.target.label) ?? "", ...(e.target.selector ? { selector: e.target.selector } : {}) } : undefined,
      };
    case "progress":
      return { ...base, type: "progress", id: e.id, fraction: e.fraction, detail: scrubPaths(e.detail) };
    case "tool_end":
      return { ...base, type: "tool_end", id: e.id, tool: e.tool, ok: e.ok, ms: e.ms, summary: scrubPaths(e.summary) };
    case "session":
      return { ...base, type: "session", session: e.session, version: e.version };
    default:
      return undefined;
  }
}

/** Files /media never serves even inside an allowed folder (bridge token, API keys, page code). */
const MEDIA_DENY_EXT = new Set([".html", ".htm", ".js", ".mjs", ".css", ".xhtml"]);
function mediaServable(file: string): boolean {
  const name = file.split(sep).pop() ?? "";
  if (name.startsWith(".") || name === "token") return false;
  return !MEDIA_DENY_EXT.has(extname(name).toLowerCase());
}

export async function startStudioServer(opts: StudioServerOptions = {}): Promise<StudioServer> {
  const host = opts.host ?? "127.0.0.1";
  const token = opts.token ?? ensureToken();
  const root = webRoot();
  const buffer: StudioEvent[] = [];
  const clients = new Map<ServerResponse, { redact: boolean }>();
  const allowed = new Set<string>();
  const allowDirs = [openeditHome(), join(homedir(), "OpenEdit Media"), ...(opts.allowDirs ?? [])]
    .map((d) => real(d) ?? resolve(d))
    .map((d) => (d.endsWith(sep) ? d : d + sep));
  let seq = 0;
  let port = opts.port ?? studioPort();

  const allowPath = (p: string) => {
    const r = real(p);
    if (r) allowed.add(r);
  };

  const publish = (evt: StudioEvent) => {
    const e = { ...evt, at: evt.at ?? Date.now(), seq: ++seq } as StudioEvent;
    for (const p of eventPaths(e)) allowPath(p);
    buffer.push(e);
    if (buffer.length > REPLAY) {
      // Drop the oldest transient event; keep timeline/media/session state for late joiners.
      const i = buffer.findIndex((x) => !STICKY.has(x.type));
      buffer.splice(i < 0 || buffer.length > REPLAY * 2 ? 0 : i, 1);
    }
    const line = `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`;
    const red = redactForCrossOrigin(e);
    const redLine = red ? `id: ${e.seq}\ndata: ${JSON.stringify(red)}\n\n` : undefined;
    for (const [c, o] of clients) {
      if (!o.redact) c.write(line);
      else if (redLine) c.write(redLine);
    }
  };

  const okHost = (req: IncomingMessage) => {
    // DNS-rebinding guard: only accept loopback Host headers.
    const h = (req.headers.host ?? "").replace(/:\d+$/, "");
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
  };

  /** A request made by a page on another origin (the overlay injected into some site, or any site at all). */
  const crossOrigin = (req: IncomingMessage) => {
    const o = req.headers.origin;
    if (o === undefined) {
      const site = req.headers["sec-fetch-site"];
      return site !== undefined && site !== "same-origin" && site !== "none";
    }
    return o !== `http://127.0.0.1:${port}` && o !== `http://localhost:${port}` && o !== `http://[::1]:${port}`;
  };

  const send = (res: ServerResponse, status: number, body: string | object, type = "application/json") => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  const serveFile = (req: IncomingMessage, res: ServerResponse, file: string, extra: Record<string, string> = {}) => {
    const st = statSync(file);
    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    const base = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-cache", ...extra };
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, st.size - 1);
      if (start > end) {
        res.writeHead(416, { "content-range": `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, { ...base, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": String(end - start + 1) });
      if (req.method === "HEAD") return res.end();
      return createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...base, "content-length": String(st.size) });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
  };

  const readBody = (req: IncomingMessage, limit = 2_000_000) =>
    new Promise<string>((ok, fail) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          fail(new Error("body too large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
      req.on("error", fail);
    });

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    if (!okHost(req)) return send(res, 403, { error: "bad host" });

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "content-type, x-openedit-token",
        "access-control-allow-private-network": "true",
      });
      return res.end();
    }

    if (path === "/health") return send(res, 200, { app: STUDIO_APP_ID, ok: true, pid: process.pid, events: seq, clients: clients.size });

    if (path === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
        "access-control-allow-private-network": "true",
      });
      res.write("retry: 1000\n\n");
      const redact = crossOrigin(req);
      const visible = redact ? buffer.map(redactForCrossOrigin).filter((e): e is StudioEvent => !!e) : buffer;
      const replay = visible.map((e) => ({ ...e, replay: true }));
      res.write(`event: replay\ndata: ${JSON.stringify(replay)}\n\n`);
      clients.set(res, { redact });
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (path === "/emit" && req.method === "POST") {
      if (!tokenMatches(req.headers["x-openedit-token"], token)) return send(res, 401, { error: "bad token" });
      try {
        const body = JSON.parse(await readBody(req)) as StudioEvent | StudioEvent[];
        const list = Array.isArray(body) ? body : [body];
        for (const e of list) if (e && typeof e === "object" && typeof (e as { type?: unknown }).type === "string") publish(e);
        return send(res, 200, { ok: true, count: list.length });
      } catch (e) {
        return send(res, 400, { error: (e as Error).message });
      }
    }

    if (path === "/media") {
      const raw = (url.searchParams.get("path") ?? "").replace(/^~(?=\/)/, homedir());
      const r = raw ? real(raw) : undefined;
      if (!r || !statSync(r).isFile()) return send(res, 404, { error: "not found" });
      const ok = allowed.has(r) || allowDirs.some((d) => r.startsWith(d));
      if (!ok) return send(res, 403, { error: "path not produced by this session" });
      if (!mediaServable(r)) return send(res, 403, { error: "not a media file" });
      // Downloaded media may be SVG/HTML-ish: never let it run script in the studio's origin.
      return serveFile(req, res, r, { "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'", "x-content-type-options": "nosniff" });
    }

    // Static assets (index, css, js, overlay).
    const name = path === "/" ? "index.html" : path.slice(1);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return send(res, 404, { error: "not found" });
    const file = join(root, name);
    if (!existsSync(file)) return send(res, 404, { error: "not found" });
    if (name === "overlay.js") {
      // Injected into arbitrary pages: bake in this server's origin.
      const src = readFileSync(file, "utf8").replace("__OPENEDIT_STUDIO_ORIGIN__", `http://127.0.0.1:${port}`);
      res.writeHead(200, { "content-type": TYPES[".js"], "access-control-allow-origin": "*", "cache-control": "no-store" });
      return res.end(src);
    }
    return serveFile(req, res, file);
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((e: unknown) => {
      if (!res.headersSent) send(res, 500, { error: (e as Error).message });
      else res.end();
    });
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => {
      server.off("error", fail);
      ok();
    });
  });
  const addr = server.address();
  if (addr && typeof addr === "object") port = addr.port;

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    token,
    publish,
    allowPath,
    server,
    close: () =>
      new Promise<void>((ok) => {
        for (const c of clients.keys()) c.end();
        clients.clear();
        server.close(() => ok());
      }),
  };
}
