import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { getKey } from "./keys.js";
import { getProvider } from "./providers/index.js";
import { globalId, type MediaResult } from "./types.js";

export interface CreditEntry {
  gid: string;
  provider: string;
  id: string;
  kind: string;
  title: string;
  author?: string;
  authorUrl?: string;
  sourceUrl: string;
  license: string;
  licenseUrl?: string;
  attributionRequired: boolean;
  attributionText: string;
  path: string;
  downloadedAt: string;
  note?: string;
}

/** Media library root: explicit dir (e.g. the project folder), else $OPENEDIT_MEDIA_DIR, else ~/OpenEdit Media. */
export function mediaRoot(dir?: string): string {
  const root = resolve(dir || process.env.OPENEDIT_MEDIA_DIR || join(homedir(), "OpenEdit Media"));
  mkdirSync(root, { recursive: true });
  return root;
}

export function slugify(s: string, max = 50): string {
  const slug = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return slug || "untitled";
}

export function fileBase(r: Pick<MediaResult, "title" | "provider" | "id">): string {
  return `${slugify(r.title, 50)}-${r.provider}-${slugify(r.id, 24)}`;
}

const creditsJson = (root: string) => join(root, "credits.json");
const creditsMd = (root: string) => join(root, "CREDITS.md");

export function readCredits(root: string): CreditEntry[] {
  const f = creditsJson(root);
  if (!existsSync(f)) return [];
  try {
    const v = JSON.parse(readFileSync(f, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function renderCreditsMarkdown(entries: CreditEntry[]): string {
  const lines = [
    "# Media credits",
    "",
    "Stock media downloaded by OpenEdit. Items marked **attribution required** must be credited",
    "(e.g. in the video description or end credits) using the attribution line given.",
    "",
  ];
  for (const e of entries) {
    lines.push(`## ${e.title}`);
    lines.push("");
    lines.push(`- Author: ${e.author ? (e.authorUrl ? `[${e.author}](${e.authorUrl})` : e.author) : "unknown"}`);
    lines.push(`- Source: ${e.sourceUrl} (${e.provider})`);
    lines.push(`- License: ${e.licenseUrl ? `[${e.license}](${e.licenseUrl})` : e.license}${e.attributionRequired ? " — **attribution required**" : ""}`);
    lines.push(`- Attribution: ${e.attributionText}`);
    lines.push(`- File: \`${e.path}\``);
    lines.push(`- Downloaded: ${e.downloadedAt}`);
    if (e.note) lines.push(`- Note: ${e.note}`);
    lines.push("");
  }
  return lines.join("\n");
}

function writeCredits(root: string, entries: CreditEntry[]): void {
  writeFileSync(creditsJson(root), `${JSON.stringify(entries, null, 2)}\n`);
  writeFileSync(creditsMd(root), renderCreditsMarkdown(entries));
}

export interface DownloadOutcome extends CreditEntry {
  /** True when the item was already in the library and not downloaded again. */
  existing: boolean;
}

/** Download one result into <root>/<kind>/, dedupe by provider+id, and record the credit. */
export async function downloadResult(r: MediaResult, opts: { dir?: string; timeoutMs?: number } = {}): Promise<DownloadOutcome> {
  const root = mediaRoot(opts.dir);
  const gid = globalId(r);
  const credits = readCredits(root);
  const prior = credits.find((c) => c.gid === gid && existsSync(c.path));
  if (prior) return { ...prior, existing: true };

  const provider = getProvider(r.provider);
  if (!provider) throw new Error(`unknown provider ${r.provider}`);
  const kindDir = join(root, r.kind);
  mkdirSync(kindDir, { recursive: true });
  const key = provider.keyEnv ? getKey(provider.keyEnv) : undefined;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10 * 60_000);
  let path: string;
  try {
    path = await provider.download(r, kindDir, fileBase(r), { key, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
  const entry: CreditEntry = {
    gid,
    provider: r.provider,
    id: r.id,
    kind: r.kind,
    title: r.title,
    author: r.author,
    authorUrl: r.authorUrl,
    sourceUrl: r.url,
    license: r.license,
    licenseUrl: r.licenseUrl,
    attributionRequired: r.attributionRequired,
    attributionText: r.attributionText,
    path,
    downloadedAt: new Date().toISOString(),
    note: r.provider === "freesound" ? "HQ MP3 preview (original download requires Freesound OAuth2)" : undefined,
  };
  const next = credits.filter((c) => c.gid !== gid);
  next.push(entry);
  writeCredits(root, next);
  return { ...entry, existing: false };
}

export function creditsSummary(dir?: string): { root: string; markdown: string; entries: CreditEntry[] } {
  const root = mediaRoot(dir);
  const entries = readCredits(root);
  return { root, entries, markdown: entries.length ? renderCreditsMarkdown(entries) : "No media downloaded yet." };
}

export const relativeTo = (root: string, p: string) => relative(root, p) || p;
