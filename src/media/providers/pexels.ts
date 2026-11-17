import { downloadFile, fetchJson } from "../http.js";
import type { MediaProvider, MediaResult, SearchQuery } from "../types.js";

// Docs: https://www.pexels.com/api/documentation/  (Authorization: <key>; /v1/search, /v1/videos/search; per_page<=80)
const API = "https://api.pexels.com/v1";
const LICENSE = "Pexels License";
const LICENSE_URL = "https://www.pexels.com/license/";

interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  alt?: string;
  photographer: string;
  photographer_url: string;
  src: Record<string, string>;
}
interface PexelsVideoFile {
  id: number;
  quality: string | null;
  file_type: string;
  width: number | null;
  height: number | null;
  fps?: number;
  link: string;
}
interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  url: string;
  image: string;
  duration: number;
  user: { id: number; name: string; url: string };
  video_files: PexelsVideoFile[];
  tags?: string[];
}

/** Pexels page slugs carry the description: /video/aerial-view-of-city-at-night-123/ */
function titleFromUrl(url: string, fallback: string): string {
  const m = /\/(?:photo|video)\/([a-z0-9-]+?)-\d+\/?$/i.exec(url);
  if (!m) return fallback;
  const t = m[1].replace(/-/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Best rendition: smallest file that still meets target width (default 1920), else the largest. */
export function pickVideoFile(files: PexelsVideoFile[], targetWidth = 1920): PexelsVideoFile | undefined {
  const mp4 = files.filter((f) => f.link && (f.file_type === "video/mp4" || f.link.includes(".mp4")) && f.width);
  const pool = mp4.length ? mp4 : files.filter((f) => f.link);
  const sorted = [...pool].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  const longSide = (f: PexelsVideoFile) => Math.max(f.width ?? 0, f.height ?? 0);
  return sorted.find((f) => longSide(f) >= targetWidth) ?? sorted.at(-1);
}

function attribution(title: string, author: string, url: string): string {
  return `"${title}" by ${author} on Pexels (${url}), Pexels License`;
}

export const pexels: MediaProvider = {
  id: "pexels",
  name: "Pexels",
  kinds: ["video", "image"],
  keyEnv: "PEXELS_API_KEY",
  homepage: "https://www.pexels.com/api/",
  licenseSummary: "Pexels License: free for commercial use and modification, no attribution required (appreciated); no standalone resale.",

  async search(q: SearchQuery, ctx) {
    const headers = { Authorization: ctx.key ?? "" };
    const params = { query: q.query, per_page: Math.min(80, Math.max(1, q.limit)), orientation: q.orientation };
    if (q.kind === "video") {
      const data = await fetchJson<{ videos: PexelsVideo[] }>(`${API}/videos/search`, { params, headers, signal: ctx.signal });
      return (data.videos ?? []).flatMap((v): MediaResult[] => {
        const file = pickVideoFile(v.video_files, q.minWidth ?? 1920);
        if (!file) return [];
        const title = titleFromUrl(v.url, `Pexels video ${v.id}`);
        return [
          {
            id: String(v.id),
            provider: "pexels",
            kind: "video",
            title,
            url: v.url,
            downloadUrl: file.link,
            previewUrl: v.image,
            width: file.width ?? v.width,
            height: file.height ?? v.height,
            duration: v.duration,
            tags: v.tags ?? [],
            author: v.user?.name,
            authorUrl: v.user?.url,
            license: LICENSE,
            licenseCode: "stock",
            licenseUrl: LICENSE_URL,
            attributionRequired: false,
            attributionText: attribution(title, v.user?.name ?? "unknown", v.url),
          },
        ];
      });
    }
    const data = await fetchJson<{ photos: PexelsPhoto[] }>(`${API}/search`, { params, headers, signal: ctx.signal });
    return (data.photos ?? []).map((p): MediaResult => {
      const title = p.alt?.trim() || titleFromUrl(p.url, `Pexels photo ${p.id}`);
      return {
        id: String(p.id),
        provider: "pexels",
        kind: "image",
        title,
        url: p.url,
        downloadUrl: p.src.original ?? p.src.large2x ?? p.src.large,
        previewUrl: p.src.medium ?? p.src.small ?? p.src.tiny,
        width: p.width,
        height: p.height,
        tags: [],
        author: p.photographer,
        authorUrl: p.photographer_url,
        license: LICENSE,
        licenseCode: "stock",
        licenseUrl: LICENSE_URL,
        attributionRequired: false,
        attributionText: attribution(title, p.photographer, p.url),
      };
    });
  },

  download(r, dir, base, ctx) {
    return downloadFile(r.downloadUrl, dir, base, { signal: ctx.signal });
  },
};
