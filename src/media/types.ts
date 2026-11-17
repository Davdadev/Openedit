/** Shared types for stock-media search and download. */

export const MEDIA_KINDS = ["video", "image", "audio", "music", "sfx"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export type Orientation = "landscape" | "portrait" | "square";

export type ProviderId = "pexels" | "pixabay" | "unsplash" | "openverse" | "wikimedia" | "freesound" | "jamendo" | "nasa";

export interface SearchQuery {
  query: string;
  kind: MediaKind;
  orientation?: Orientation;
  /** Seconds. */
  minDuration?: number;
  /** Seconds. */
  maxDuration?: number;
  minWidth?: number;
  limit: number;
  /** Let providers that can filter server-side include NC/ND material. */
  allowNonCommercial?: boolean;
}

/**
 * Normalized license families, best (most permissive) first.
 * "stock" = a provider's own free license (Pexels / Pixabay / Unsplash): commercial use and
 * modification allowed, no attribution required, no standalone resale.
 */
export type LicenseCode =
  | "cc0"
  | "pd"
  | "stock"
  | "cc-by"
  | "cc-by-sa"
  | "gfdl"
  | "cc-by-nc"
  | "cc-by-nc-sa"
  | "cc-by-nd"
  | "cc-by-nc-nd"
  | "unknown";

export interface MediaResult {
  /** Provider-local id. The global id is `${provider}:${id}`. */
  id: string;
  provider: ProviderId;
  kind: MediaKind;
  title: string;
  /** Human page for the item (credit link). */
  url: string;
  /** Direct file URL to download (may be resolved lazily by the provider's download()). */
  downloadUrl: string;
  previewUrl?: string;
  width?: number;
  height?: number;
  /** Seconds. */
  duration?: number;
  tags: string[];
  author?: string;
  authorUrl?: string;
  /** Human license label, e.g. "CC BY 4.0" or "Pexels License". */
  license: string;
  licenseCode: LicenseCode;
  licenseUrl?: string;
  attributionRequired: boolean;
  attributionText: string;
  /** Provider-specific data needed at download time (e.g. Unsplash download_location). */
  extra?: Record<string, string>;
}

export interface ProviderContext {
  /** API key / client id, when the provider needs one. */
  key?: string;
  signal?: AbortSignal;
}

export interface MediaProvider {
  id: ProviderId;
  name: string;
  kinds: MediaKind[];
  /** Env var holding the key; absent when no key is needed. */
  keyEnv?: string;
  homepage: string;
  /** Short license summary shown in media_sources. */
  licenseSummary: string;
  search(q: SearchQuery, ctx: ProviderContext): Promise<MediaResult[]>;
  /** Download `r` into `dir` with base filename `base` (no extension). Returns the file path. */
  download(r: MediaResult, dir: string, base: string, ctx: ProviderContext): Promise<string>;
}

export const globalId = (r: Pick<MediaResult, "provider" | "id">): string => `${r.provider}:${r.id}`;
