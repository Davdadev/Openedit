import { downloadFile, fetchJson } from "../http.js";
import { attributionRequiredFor, licenseLabel, licenseUrlFor, normalizeLicense } from "../license.js";
import type { MediaProvider, MediaResult, SearchQuery } from "../types.js";

// Docs: https://freesound.org/docs/api/  (token auth: "Authorization: Token <key>"; GET /apiv2/search/, page_size<=150)
// Downloading the ORIGINAL file needs OAuth2 (per-user login), so OpenEdit downloads the
// high-quality MP3 preview (previews.preview-hq-mp3, ~128 kbps) which token auth can access.
const API = "https://freesound.org/apiv2";

interface FSSound {
  id: number;
  name: string;
  tags: string[];
  license: string;
  username: string;
  url: string;
  duration: number;
  description?: string;
  previews: Record<string, string>;
  images?: Record<string, string>;
}

export const freesound: MediaProvider = {
  id: "freesound",
  name: "Freesound",
  kinds: ["sfx", "audio"],
  keyEnv: "FREESOUND_API_KEY",
  homepage: "https://freesound.org/docs/api/",
  licenseSummary:
    "Freesound: per-sound CC0, CC BY 4.0/3.0, CC BY-NC (excluded by default). OpenEdit downloads the HQ MP3 preview (originals need OAuth2).",

  async search(q: SearchQuery, ctx) {
    const filters: string[] = [];
    if (q.minDuration !== undefined || q.maxDuration !== undefined)
      filters.push(`duration:[${q.minDuration ?? 0} TO ${q.maxDuration ?? "*"}]`);
    const data = await fetchJson<{ results: FSSound[] }>(`${API}/search/`, {
      params: {
        query: q.query,
        filter: filters.join(" ") || undefined,
        fields: "id,name,tags,license,username,url,duration,previews,images,description",
        page_size: Math.min(150, Math.max(1, q.limit)),
        sort: "score",
      },
      headers: { Authorization: `Token ${ctx.key ?? ""}` },
      signal: ctx.signal,
    });
    return (data.results ?? []).flatMap((s): MediaResult[] => {
      const dl = s.previews?.["preview-hq-mp3"] ?? s.previews?.["preview-lq-mp3"];
      if (!dl) return [];
      const code = normalizeLicense(s.license);
      const version = /\/(\d\.\d)\//.exec(s.license)?.[1] ?? (code === "cc0" ? undefined : "4.0");
      const license = licenseLabel(code, version);
      const licenseUrl = s.license.startsWith("http") ? s.license : licenseUrlFor(code, version);
      const title = s.name.replace(/\.(wav|aiff?|mp3|flac|ogg)$/i, "");
      const authorUrl = `https://freesound.org/people/${encodeURIComponent(s.username)}/`;
      return [
        {
          id: String(s.id),
          provider: "freesound",
          kind: q.kind,
          title,
          url: s.url,
          downloadUrl: dl,
          previewUrl: dl,
          duration: s.duration,
          tags: s.tags ?? [],
          author: s.username,
          authorUrl,
          license,
          licenseCode: code,
          licenseUrl,
          attributionRequired: attributionRequiredFor(code),
          attributionText: `"${title}" by ${s.username} (${s.url}) on Freesound, ${license}${licenseUrl ? ` (${licenseUrl})` : ""}`,
          extra: { quality: "hq-mp3-preview" },
        },
      ];
    });
  },

  download(r, dir, base, ctx) {
    return downloadFile(r.downloadUrl, dir, base, { signal: ctx.signal, ext: ".mp3" });
  },
};
