import { createWriteStream, renameSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

export const USER_AGENT = "OpenEdit/0.1 (+https://github.com/Davdadev/openedit)";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function withQuery(url: string, params?: Record<string, string | number | boolean | undefined>): string {
  if (!params) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
  return u.toString();
}

export async function fetchJson<T = unknown>(
  url: string,
  opts: { params?: Record<string, string | number | boolean | undefined>; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<T> {
  const full = withQuery(url, opts.params);
  const res = await fetch(full, { headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...opts.headers }, signal: opts.signal });
  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    const host = new URL(full).host;
    throw new HttpError(res.status, `${host} HTTP ${res.status}${body ? `: ${body}` : ""}`);
  }
  return (await res.json()) as T;
}

const TYPE_EXT: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/ogg": ".ogv",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/tiff": ".tif",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/flac": ".flac",
  "audio/mp4": ".m4a",
  "audio/webm": ".webm",
};

const KNOWN_EXT = /^\.(mp4|webm|mov|m4v|ogv|jpe?g|png|webp|gif|svg|tiff?|mp3|ogg|oga|opus|wav|flac|m4a|aac)$/i;

/** Pick a file extension from the URL path, falling back to the response content type. */
export function extensionFor(url: string, contentType?: string | null, fallback = ".bin"): string {
  try {
    const e = extname(new URL(url).pathname).toLowerCase();
    if (KNOWN_EXT.test(e)) return e === ".jpeg" ? ".jpg" : e;
  } catch {
    /* not a URL */
  }
  const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return TYPE_EXT[ct] ?? fallback;
}

/** Stream `url` to `<dir>/<base><ext>` atomically. Returns the final path. */
export async function downloadFile(
  url: string,
  dir: string,
  base: string,
  opts: { headers?: Record<string, string>; signal?: AbortSignal; ext?: string } = {},
): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, ...opts.headers }, signal: opts.signal, redirect: "follow" });
  if (!res.ok || !res.body) throw new HttpError(res.status, `download failed: HTTP ${res.status} for ${url}`);
  const ext = opts.ext ?? extensionFor(res.url || url, res.headers.get("content-type"), extensionFor(url, null));
  const dest = join(dir, `${base}${ext}`);
  const tmp = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(tmp));
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return dest;
}

/** Strip HTML tags/entities from provider metadata (Wikimedia extmetadata is HTML). */
export function stripHtml(s: string | undefined): string {
  if (!s) return "";
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
