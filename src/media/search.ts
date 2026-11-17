import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../engine/paths.js";
import { getKey, KEY_SPECS } from "./keys.js";
import { isRestricted, licenseScore } from "./license.js";
import { getProvider, providersFor } from "./providers/index.js";
import { globalId, type MediaKind, type MediaProvider, type MediaResult, type Orientation, type ProviderId } from "./types.js";

export interface FindOptions {
  query: string;
  kind: MediaKind;
  /** How many ranked results to return (default 5). */
  count?: number;
  orientation?: Orientation;
  minDuration?: number;
  maxDuration?: number;
  minWidth?: number;
  /** Restrict to these providers (default: every provider that offers `kind`). */
  providers?: ProviderId[];
  /** Include NonCommercial / NoDerivatives licenses (excluded by default). */
  allowNonCommercial?: boolean;
  /** Per-provider timeout, ms (default 10000). */
  timeoutMs?: number;
  /** Use the on-disk search cache (default true). */
  useCache?: boolean;
}

export interface RankedResult extends MediaResult {
  /** Global id `provider:id`, accepted by download_media. */
  gid: string;
  score: number;
  reason: string;
}

export type ProviderStatus = "ok" | "cached" | "skipped" | "error" | "timeout";
export interface ProviderReport {
  provider: ProviderId;
  status: ProviderStatus;
  count: number;
  detail?: string;
}

export interface FindResponse {
  query: string;
  kind: MediaKind;
  results: RankedResult[];
  providers: ProviderReport[];
  /** Candidates considered after filtering. */
  considered: number;
}

// ---------------------------------------------------------------------------------------------
// Text relevance

const STOP = new Set(
  "a an and the of in on at to for with by from or is are be this that it its as into over under near some any clip footage video shot stock image photo picture sound effect sfx music track of".split(
    " ",
  ),
);

/** Tiny suffix stemmer: good enough to match city/cities, walking/walk, waves/wave, rained/rain. */
export function stem(w: string): string {
  let s = w.toLowerCase();
  if (s.length <= 3) return s;
  if (s.endsWith("ies") && s.length > 4) return `${s.slice(0, -3)}y`;
  if (s.endsWith("sses")) return s.slice(0, -2);
  if (s.endsWith("ing") && s.length > 5) {
    s = s.slice(0, -3);
    if (/(.)\1$/.test(s) && !/(ll|ss|zz)$/.test(s)) s = s.slice(0, -1);
    return s;
  }
  if (s.endsWith("ed") && s.length > 4) {
    s = s.slice(0, -2);
    if (/(.)\1$/.test(s) && !/(ll|ss|zz)$/.test(s)) s = s.slice(0, -1);
    return s;
  }
  if (/(ches|shes|xes|zes)$/.test(s)) return s.slice(0, -2);
  if (s.endsWith("ly") && s.length > 5) return s.slice(0, -2);
  if (s.endsWith("s") && !s.endsWith("ss") && !s.endsWith("us") && !s.endsWith("is")) return s.slice(0, -1);
  return s;
}

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOP.has(t)).map(stem);
}

/** 0..1: share of query terms found in title (1.0) or tags/description (0.8), prefix matches 0.5. */
export function relevance(query: string, r: Pick<MediaResult, "title" | "tags">): { score: number; matched: number; total: number } {
  const q = [...new Set(tokens(query))];
  if (!q.length) return { score: 0.5, matched: 0, total: 0 };
  const title = new Set(tokens(r.title));
  const tags = new Set(r.tags.flatMap((t) => tokens(t)));
  const all = [...title, ...tags];
  let sum = 0;
  let matched = 0;
  for (const t of q) {
    let v = 0;
    if (title.has(t)) v = 1;
    else if (tags.has(t)) v = 0.8;
    else if (t.length >= 4 && all.some((x) => x.length >= 4 && (x.startsWith(t) || t.startsWith(x)))) v = 0.5;
    if (v > 0) matched++;
    sum += v;
  }
  let score = sum / q.length;
  if (q.length > 1 && r.title.toLowerCase().includes(query.toLowerCase().trim())) score = Math.min(1, score + 0.1);
  return { score, matched, total: q.length };
}

// ---------------------------------------------------------------------------------------------
// Quality

function durationFit(d: number | undefined, o: FindOptions): number {
  if (d === undefined || !Number.isFinite(d)) return 0.6;
  const { minDuration: lo, maxDuration: hi } = o;
  if (lo !== undefined || hi !== undefined) {
    const min = lo ?? 0;
    const max = hi ?? Number.POSITIVE_INFINITY;
    if (d >= min && d <= max) return 1;
    const dist = d < min ? min - d : d - max;
    return Math.max(0, 1 - dist / Math.max(5, (Number.isFinite(max) ? max : min * 2) - min || 10));
  }
  switch (o.kind) {
    case "video":
      return d >= 4 && d <= 60 ? 1 : d < 4 ? 0.5 : 0.75;
    case "sfx":
      return d <= 15 ? 1 : d <= 60 ? 0.7 : 0.4;
    case "music":
      return d >= 60 && d <= 420 ? 1 : 0.7;
    default:
      return 0.8;
  }
}

function orientationOf(w?: number, h?: number): Orientation | undefined {
  if (!w || !h) return undefined;
  const a = w / h;
  return a > 1.1 ? "landscape" : a < 0.9 ? "portrait" : "square";
}

export function quality(r: MediaResult, o: FindOptions): number {
  const visual = o.kind === "video" || o.kind === "image";
  const dur = durationFit(r.duration, o);
  if (!visual) return dur;
  const target = o.minWidth ?? 1920;
  const side = Math.max(r.width ?? 0, r.height ?? 0);
  let res = side ? Math.min(1, side / target) : 0.5;
  const orient = orientationOf(r.width, r.height);
  if (o.orientation && orient && orient !== o.orientation) res *= 0.5;
  return o.kind === "video" ? 0.6 * res + 0.4 * dur : res;
}

/** Providers whose catalogue is curated stock for this kind get a small prior. */
function curated(p: ProviderId, kind: MediaKind): number {
  if ((kind === "video" || kind === "image") && (p === "pexels" || p === "pixabay" || p === "unsplash")) return 1;
  if (kind === "sfx" && p === "freesound") return 1;
  if (kind === "music" && p === "jamendo") return 1;
  return 0.5;
}

const fmtDur = (d: number) => (d >= 60 ? `${Math.floor(d / 60)}m${Math.round(d % 60)}s` : `${d.toFixed(d < 10 ? 1 : 0)}s`);

/** Score, filter and diversify candidates. Exported for tests. */
export function rank(candidates: MediaResult[], o: FindOptions): { results: RankedResult[]; considered: number } {
  const count = o.count ?? 5;
  // Dedupe by global id and by file URL.
  const seen = new Set<string>();
  let pool = candidates.filter((r) => {
    const k1 = globalId(r);
    if (seen.has(k1) || seen.has(r.downloadUrl)) return false;
    seen.add(k1);
    seen.add(r.downloadUrl);
    return true;
  });
  if (!o.allowNonCommercial) pool = pool.filter((r) => !isRestricted(r.licenseCode));

  // Hard filters on known duration / width; relaxed if they would empty the list.
  const strict = pool.filter((r) => {
    if (r.duration !== undefined && o.minDuration !== undefined && r.duration < o.minDuration) return false;
    if (r.duration !== undefined && o.maxDuration !== undefined && r.duration > o.maxDuration) return false;
    if (o.minWidth && r.width && Math.max(r.width, r.height ?? 0) < o.minWidth) return false;
    return true;
  });
  if (strict.length) pool = strict;

  const scored = pool.map((r) => {
    const rel = relevance(o.query, r);
    const q = quality(r, o);
    const lic = licenseScore(r.licenseCode);
    const score = 0.55 * rel.score + 0.25 * q + 0.15 * lic + 0.05 * curated(r.provider, o.kind);
    const bits = [
      rel.total ? `matches ${rel.matched}/${rel.total} terms` : "",
      r.width && r.height ? `${r.width}x${r.height}` : "",
      r.duration !== undefined ? fmtDur(r.duration) : "",
      r.license,
    ].filter(Boolean);
    return { r, score, reason: bits.join(", ") };
  });

  // Greedy pick with a per-provider diversity penalty.
  const picked: RankedResult[] = [];
  const perProvider = new Map<ProviderId, number>();
  const rest = [...scored];
  while (picked.length < count && rest.length) {
    let best = 0;
    let bestVal = -Infinity;
    rest.forEach((s, i) => {
      const v = s.score - 0.06 * (perProvider.get(s.r.provider) ?? 0);
      if (v > bestVal) {
        bestVal = v;
        best = i;
      }
    });
    const [s] = rest.splice(best, 1);
    perProvider.set(s.r.provider, (perProvider.get(s.r.provider) ?? 0) + 1);
    picked.push({ ...s.r, gid: globalId(s.r), score: Math.round(s.score * 1000) / 1000, reason: s.reason });
  }
  return { results: picked, considered: pool.length };
}

// ---------------------------------------------------------------------------------------------
// Cache (on disk, short TTL; Pixabay requires 24h caching of API responses)

const TTL_MS: Partial<Record<ProviderId, number>> = { pixabay: 24 * 3600_000 };
const DEFAULT_TTL_MS = 30 * 60_000;

function mediaCacheDir(): string {
  const d = join(paths.cache(), "media");
  mkdirSync(d, { recursive: true });
  return d;
}

function cacheFile(provider: ProviderId, payload: object): string {
  const h = createHash("sha1").update(JSON.stringify(payload)).digest("hex").slice(0, 20);
  return join(mediaCacheDir(), `search-${provider}-${h}.json`);
}

function readCache(file: string, provider: ProviderId): MediaResult[] | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const c = JSON.parse(readFileSync(file, "utf8")) as { at: number; results: MediaResult[] };
    if (Date.now() - c.at < (TTL_MS[provider] ?? DEFAULT_TTL_MS)) return c.results;
  } catch {
    /* corrupt cache: ignore */
  }
  return undefined;
}

export function clearSearchCache(): void {
  const d = mediaCacheDir();
  for (const f of readdirSync(d)) if (f.startsWith("search-") || f === "registry.json") rmSync(join(d, f), { force: true });
  registry.clear();
}

// ---------------------------------------------------------------------------------------------
// Registry of results shown to Claude, so download_media can take ids from find_media.

const registry = new Map<string, MediaResult>();
const REGISTRY_MAX = 400;

function registryFile(): string {
  return join(mediaCacheDir(), "registry.json");
}

export function rememberResults(results: MediaResult[]): void {
  let disk: Record<string, MediaResult> = {};
  try {
    if (existsSync(registryFile())) disk = JSON.parse(readFileSync(registryFile(), "utf8"));
  } catch {
    disk = {};
  }
  for (const r of results) {
    const { gid: _g, score: _s, reason: _r, ...plain } = r as RankedResult;
    registry.set(globalId(r), plain);
    delete disk[globalId(r)];
    disk[globalId(r)] = plain;
  }
  const keys = Object.keys(disk);
  for (const k of keys.slice(0, Math.max(0, keys.length - REGISTRY_MAX))) delete disk[k];
  writeFileSync(registryFile(), JSON.stringify(disk));
}

export function lookupResult(gid: string): MediaResult | undefined {
  if (registry.has(gid)) return registry.get(gid);
  try {
    if (existsSync(registryFile())) return (JSON.parse(readFileSync(registryFile(), "utf8")) as Record<string, MediaResult>)[gid];
  } catch {
    /* ignore */
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Aggregated search

export function signupUrl(envName: string | undefined): string | undefined {
  return KEY_SPECS.find((k) => k.env === envName)?.signupUrl;
}

class TimeoutError extends Error {}

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new TimeoutError(`timed out after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([fn(ac.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function findMedia(o: FindOptions): Promise<FindResponse> {
  const count = Math.max(1, Math.min(50, o.count ?? 5));
  const perProvider = Math.min(40, Math.max(15, count * 3));
  const timeoutMs = o.timeoutMs ?? 10_000;
  const useCache = o.useCache !== false;

  let selected: MediaProvider[];
  const reports: ProviderReport[] = [];
  if (o.providers?.length) {
    selected = [];
    for (const id of o.providers) {
      const p = getProvider(id);
      if (!p) reports.push({ provider: id, status: "skipped", count: 0, detail: "unknown provider" });
      else if (!p.kinds.includes(o.kind)) reports.push({ provider: id, status: "skipped", count: 0, detail: `does not offer ${o.kind}` });
      else selected.push(p);
    }
  } else selected = providersFor(o.kind);

  const all: MediaResult[] = [];
  await Promise.all(
    selected.map(async (p) => {
      const key = p.keyEnv ? getKey(p.keyEnv) : undefined;
      if (p.keyEnv && !key) {
        reports.push({ provider: p.id, status: "skipped", count: 0, detail: `no key (set ${p.keyEnv}; free at ${signupUrl(p.keyEnv)}; or run \`openedit keys\`)` });
        return;
      }
      const q = {
        query: o.query,
        kind: o.kind,
        orientation: o.orientation,
        minDuration: o.minDuration,
        maxDuration: o.maxDuration,
        minWidth: o.minWidth,
        limit: perProvider,
        allowNonCommercial: o.allowNonCommercial,
      };
      const file = cacheFile(p.id, q);
      const cached = useCache ? readCache(file, p.id) : undefined;
      if (cached) {
        all.push(...cached);
        reports.push({ provider: p.id, status: "cached", count: cached.length });
        return;
      }
      try {
        const res = await withTimeout(timeoutMs, (signal) => p.search(q, { key, signal }));
        all.push(...res);
        reports.push({ provider: p.id, status: "ok", count: res.length });
        if (useCache) {
          try {
            writeFileSync(file, JSON.stringify({ at: Date.now(), results: res }));
          } catch {
            /* cache is best effort */
          }
        }
      } catch (e) {
        const timedOut = e instanceof TimeoutError;
        reports.push({ provider: p.id, status: timedOut ? "timeout" : "error", count: 0, detail: (e as Error).message.slice(0, 200) });
      }
    }),
  );

  const { results, considered } = rank(all, { ...o, count });
  rememberResults(results);
  const order = new Map(selected.map((p, i) => [p.id, i]));
  reports.sort((a, b) => (order.get(a.provider) ?? 99) - (order.get(b.provider) ?? 99));
  return { query: o.query, kind: o.kind, results, providers: reports, considered };
}
