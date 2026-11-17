import { downloadFile, fetchJson } from "../http.js";
import type { MediaProvider, MediaResult, SearchQuery } from "../types.js";

// Docs: https://unsplash.com/documentation  (Authorization: Client-ID <key>; GET /search/photos, per_page<=30)
// Guidelines: https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines
//  - use the returned photo.urls (hotlinked, keep ixid) for display
//  - GET photo.links.download_location whenever the user "downloads"/uses a photo (we do, in download())
//  - credit photographer + Unsplash with utm_source=<app>&utm_medium=referral links
const API = "https://api.unsplash.com";
const UTM = "utm_source=openedit&utm_medium=referral";
const LICENSE = "Unsplash License";
const LICENSE_URL = "https://unsplash.com/license";

interface UnsplashPhoto {
  id: string;
  width: number;
  height: number;
  description: string | null;
  alt_description: string | null;
  urls: { raw: string; full: string; regular: string; small: string; thumb: string };
  links: { html: string; download: string; download_location: string };
  user: { name: string; username: string; links: { html: string } };
  tags?: { title: string }[];
}

const ORIENT = { landscape: "landscape", portrait: "portrait", square: "squarish" } as const;

export const withUtm = (url: string) => `${url}${url.includes("?") ? "&" : "?"}${UTM}`;

export const unsplash: MediaProvider = {
  id: "unsplash",
  name: "Unsplash",
  kinds: ["image"],
  keyEnv: "UNSPLASH_ACCESS_KEY",
  homepage: "https://unsplash.com/developers",
  licenseSummary:
    "Unsplash License: free for commercial use and modification, no attribution required (but the API guidelines require crediting photographer + Unsplash in-app); no selling unaltered copies.",

  async search(q: SearchQuery, ctx) {
    const data = await fetchJson<{ results: UnsplashPhoto[] }>(`${API}/search/photos`, {
      params: {
        query: q.query,
        per_page: Math.min(30, Math.max(1, q.limit)),
        orientation: q.orientation ? ORIENT[q.orientation] : undefined,
        content_filter: "high",
      },
      headers: { Authorization: `Client-ID ${ctx.key ?? ""}`, "Accept-Version": "v1" },
      signal: ctx.signal,
    });
    return (data.results ?? []).map((p): MediaResult => {
      const title = (p.description || p.alt_description || `Unsplash photo ${p.id}`).trim();
      const pageUrl = withUtm(p.links.html);
      const authorUrl = withUtm(p.user.links.html);
      return {
        id: p.id,
        provider: "unsplash",
        kind: "image",
        title: title.charAt(0).toUpperCase() + title.slice(1),
        url: pageUrl,
        downloadUrl: p.urls.full,
        previewUrl: p.urls.small,
        width: p.width,
        height: p.height,
        tags: (p.tags ?? []).map((t) => t.title),
        author: p.user.name,
        authorUrl,
        license: LICENSE,
        licenseCode: "stock",
        licenseUrl: LICENSE_URL,
        attributionRequired: false,
        attributionText: `Photo by ${p.user.name} (${authorUrl}) on Unsplash (${withUtm("https://unsplash.com/")})`,
        extra: { downloadLocation: p.links.download_location },
      };
    });
  },

  async download(r, dir, base, ctx) {
    // Required by the API guidelines: register the download before fetching the file.
    if (r.extra?.downloadLocation) {
      await fetchJson(r.extra.downloadLocation, { headers: { Authorization: `Client-ID ${ctx.key ?? ""}` }, signal: ctx.signal });
    }
    return downloadFile(r.downloadUrl, dir, base, { signal: ctx.signal, ext: ".jpg" });
  },
};
