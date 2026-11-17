import { downloadFile, fetchJson } from "../http.js";
import type { MediaProvider, MediaResult, SearchQuery } from "../types.js";

// NASA Image and Video Library API: https://images.nasa.gov/docs/images.nasa.gov_api_docs.pdf
// GET https://images-api.nasa.gov/search?q=&media_type=image|video|audio  (no key)
// Each item's `href` is a collection.json listing the asset renditions (~orig, ~large, ~medium ...).
// Usage: https://www.nasa.gov/nasa-brand-center/images-and-media/ — generally not copyrighted;
// do not imply NASA endorsement; some items include third-party material (check the description).
const API = "https://images-api.nasa.gov";
const LICENSE = "NASA Media Usage Guidelines (public domain)";
const LICENSE_URL = "https://www.nasa.gov/nasa-brand-center/images-and-media/";

interface NasaItem {
  href: string;
  data: { nasa_id: string; title: string; description?: string; keywords?: string[]; center?: string; photographer?: string; secondary_creator?: string; media_type: string }[];
  links?: { href: string; rel: string; render?: string; width?: number; height?: number }[];
}

const MEDIA: Record<string, string> = { image: "image", video: "video", audio: "audio", music: "audio", sfx: "audio" };

const https = (u: string) => u.replace(/^http:\/\//, "https://");

/** Choose a rendition from collection.json: editing-friendly size first, original as fallback. */
export function pickNasaAsset(files: string[], kind: string): string | undefined {
  const order =
    kind === "video"
      ? ["~large.mp4", "~orig.mp4", "~medium.mp4", "~orig.mov", "~small.mp4", ".mp4"]
      : kind === "image"
        ? ["~orig.jpg", "~large.jpg", "~orig.png", "~orig.tif", ".jpg"]
        : ["~orig.wav", "~orig.mp3", "~128k.mp3", ".mp3", ".m4a", ".wav"];
  for (const suffix of order) {
    const hit = files.find((f) => f.toLowerCase().endsWith(suffix));
    if (hit) return https(hit);
  }
  return undefined;
}

export const nasa: MediaProvider = {
  id: "nasa",
  name: "NASA Image and Video Library",
  kinds: ["image", "video", "audio", "sfx"],
  homepage: "https://images.nasa.gov",
  licenseSummary: "NASA media: generally public domain (US Government work); credit NASA, don't imply endorsement, watch for third-party content.",

  async search(q: SearchQuery, ctx) {
    const data = await fetchJson<{ collection: { items: NasaItem[] } }>(`${API}/search`, {
      params: { q: q.query, media_type: MEDIA[q.kind], page_size: Math.min(100, Math.max(1, q.limit)) },
      signal: ctx.signal,
    });
    return (data.collection?.items ?? []).flatMap((it): MediaResult[] => {
      const d = it.data?.[0];
      if (!d) return [];
      const preview = it.links?.find((l) => l.rel === "preview") ?? it.links?.[0];
      const page = `https://images.nasa.gov/details/${encodeURIComponent(d.nasa_id)}`;
      const author = d.photographer || d.secondary_creator || (d.center ? `NASA ${d.center}` : "NASA");
      return [
        {
          id: d.nasa_id,
          provider: "nasa",
          kind: q.kind,
          title: d.title,
          url: page,
          downloadUrl: https(it.href), // collection.json; resolved in download()
          previewUrl: preview?.href ? https(preview.href) : undefined,
          tags: d.keywords ?? [],
          author,
          license: LICENSE,
          licenseCode: "pd",
          licenseUrl: LICENSE_URL,
          attributionRequired: false,
          attributionText: `"${d.title}" — Credit: ${author === "NASA" ? "NASA" : `NASA / ${author}`} (${page})`,
          extra: { collection: https(it.href) },
        },
      ];
    });
  },

  async download(r, dir, base, ctx) {
    const files = await fetchJson<string[]>(r.extra?.collection ?? r.downloadUrl, { signal: ctx.signal });
    const url = pickNasaAsset(files, r.kind === "video" || r.kind === "image" ? r.kind : "audio");
    if (!url) throw new Error(`NASA item ${r.id} has no downloadable ${r.kind} rendition`);
    return downloadFile(url, dir, base, { signal: ctx.signal });
  },
};
