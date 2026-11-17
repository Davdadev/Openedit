import { downloadFile, fetchJson } from "../http.js";
import type { MediaProvider, MediaResult, SearchQuery } from "../types.js";

// Docs: https://pixabay.com/api/docs/  (key param; /api/ images, /api/videos/; per_page 3..200;
// results must be cached 24h; no permanent hotlinking -> we download). No audio/music API is documented.
const API = "https://pixabay.com/api/";
const LICENSE = "Pixabay Content License";
const LICENSE_URL = "https://pixabay.com/service/license-summary/";

interface PixabayBase {
  id: number;
  pageURL: string;
  tags: string;
  user: string;
  user_id: number;
}
interface PixabayImage extends PixabayBase {
  largeImageURL: string;
  webformatURL: string;
  previewURL: string;
  imageWidth: number;
  imageHeight: number;
}
interface PixabayRendition {
  url: string;
  width: number;
  height: number;
  size: number;
  thumbnail?: string;
}
interface PixabayVideo extends PixabayBase {
  duration: number;
  videos: Partial<Record<"large" | "medium" | "small" | "tiny", PixabayRendition>>;
}

const ORIENT = { landscape: "horizontal", portrait: "vertical", square: undefined } as const;

function titleFrom(tags: string[], fallback: string): string {
  if (!tags.length) return fallback;
  const t = tags.slice(0, 4).join(", ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function common(h: PixabayBase, kind: "video" | "image") {
  const tags = h.tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const title = titleFrom(tags, `Pixabay ${kind} ${h.id}`);
  return {
    id: String(h.id),
    provider: "pixabay" as const,
    kind,
    title,
    url: h.pageURL,
    tags,
    author: h.user,
    authorUrl: `https://pixabay.com/users/${encodeURIComponent(h.user)}-${h.user_id}/`,
    license: LICENSE,
    licenseCode: "stock" as const,
    licenseUrl: LICENSE_URL,
    attributionRequired: false,
    attributionText: `"${title}" by ${h.user} on Pixabay (${h.pageURL}), Pixabay Content License`,
  };
}

export const pixabay: MediaProvider = {
  id: "pixabay",
  name: "Pixabay",
  kinds: ["video", "image"],
  keyEnv: "PIXABAY_API_KEY",
  homepage: "https://pixabay.com/api/docs/",
  licenseSummary: "Pixabay Content License: free for commercial use and modification, no attribution required; no standalone redistribution/resale.",

  async search(q: SearchQuery, ctx) {
    const params = {
      key: ctx.key,
      q: q.query.slice(0, 100),
      per_page: Math.min(200, Math.max(3, q.limit)),
      orientation: q.orientation ? ORIENT[q.orientation] : undefined,
      min_width: q.minWidth,
      safesearch: "true",
    };
    if (q.kind === "video") {
      const data = await fetchJson<{ hits: PixabayVideo[] }>(`${API}videos/`, { params, signal: ctx.signal });
      return (data.hits ?? []).flatMap((h): MediaResult[] => {
        const v = h.videos;
        const best = [v.large, v.medium, v.small, v.tiny].find((x) => x?.url);
        if (!best) return [];
        return [
          {
            ...common(h, "video"),
            downloadUrl: best.url,
            previewUrl: best.thumbnail ?? v.tiny?.thumbnail,
            width: best.width,
            height: best.height,
            duration: h.duration,
          },
        ];
      });
    }
    const data = await fetchJson<{ hits: PixabayImage[] }>(API, { params: { ...params, image_type: "photo" }, signal: ctx.signal });
    return (data.hits ?? []).map((h): MediaResult => {
      // largeImageURL is scaled to max 1280px (full-res needs approved full API access).
      const s = Math.min(1, 1280 / Math.max(h.imageWidth || 1, h.imageHeight || 1));
      return {
        ...common(h, "image"),
        downloadUrl: h.largeImageURL || h.webformatURL,
        previewUrl: h.webformatURL || h.previewURL,
        width: Math.round(h.imageWidth * s),
        height: Math.round(h.imageHeight * s),
      };
    });
  },

  download(r, dir, base, ctx) {
    return downloadFile(r.downloadUrl, dir, base, { signal: ctx.signal });
  },
};
