import { downloadFile, fetchJson } from "../http.js";
import { attributionRequiredFor, licenseLabel, normalizeLicense } from "../license.js";
import type { MediaProvider, MediaResult, SearchQuery } from "../types.js";

// Docs: https://api.openverse.org/v1/  (no key; anonymous limit 20 req/min, 200/day; page_size<=20 anonymous)
// license_type=commercial,modification keeps only works usable commercially AND modifiable (CC0, PDM, BY, BY-SA).
const API = "https://api.openverse.org/v1";

interface OVItem {
  id: string;
  title: string | null;
  foreign_landing_url: string;
  url: string;
  creator: string | null;
  creator_url: string | null;
  license: string;
  license_version: string | null;
  license_url: string | null;
  provider: string;
  source: string;
  tags: { name: string }[] | null;
  attribution: string | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null; // milliseconds (audio)
  filetype?: string | null;
  thumbnail?: string | null;
  category?: string | null;
  genres?: string[] | null;
}

const ASPECT = { landscape: "wide", portrait: "tall", square: "square" } as const;

export const openverse: MediaProvider = {
  id: "openverse",
  name: "Openverse",
  kinds: ["image", "audio", "music", "sfx"],
  homepage: "https://openverse.org",
  licenseSummary:
    "Openverse indexes openly licensed works (CC0, PDM, CC BY, CC BY-SA ...); license is per item. We request commercial+modification-safe licenses only unless allowNonCommercial.",

  async search(q: SearchQuery, ctx) {
    const audio = q.kind !== "image";
    const params: Record<string, string | number | undefined> = {
      q: q.query,
      page_size: Math.min(20, Math.max(1, q.limit)),
      license_type: q.allowNonCommercial ? undefined : "commercial,modification",
      mature: "false",
    };
    if (!audio) {
      params.aspect_ratio = q.orientation ? ASPECT[q.orientation] : undefined;
      if (q.minWidth && q.minWidth >= 1600) params.size = "large";
    } else if (q.kind === "music") params.category = "music";

    const data = await fetchJson<{ results: OVItem[] }>(`${API}/${audio ? "audio" : "images"}/`, { params, signal: ctx.signal });
    return (data.results ?? [])
      .filter((it) => it.url)
      .map((it): MediaResult => {
        const code = normalizeLicense(it.license);
        const version = it.license_version ?? undefined;
        const title = (it.title ?? "").trim() || `Openverse ${audio ? "audio" : "image"} ${it.id}`;
        const license = licenseLabel(code, version);
        return {
          id: it.id,
          provider: "openverse",
          kind: q.kind,
          title,
          url: it.foreign_landing_url,
          downloadUrl: it.url,
          previewUrl: it.thumbnail ?? (audio ? it.url : undefined),
          width: it.width ?? undefined,
          height: it.height ?? undefined,
          duration: it.duration ? it.duration / 1000 : undefined,
          tags: [...(it.tags ?? []).map((t) => t.name), ...(it.genres ?? [])].filter((t, i, a) => a.indexOf(t) === i),
          author: it.creator ?? undefined,
          authorUrl: it.creator_url ?? undefined,
          license,
          licenseCode: code,
          licenseUrl: it.license_url ?? undefined,
          attributionRequired: attributionRequiredFor(code),
          attributionText:
            it.attribution ??
            `"${title}"${it.creator ? ` by ${it.creator}` : ""} (${it.foreign_landing_url}) is licensed under ${license}`,
          extra: { source: it.source, filetype: it.filetype ?? "" },
        };
      });
  },

  download(r, dir, base, ctx) {
    const ext = r.extra?.filetype ? `.${r.extra.filetype.replace(/^jpeg$/, "jpg")}` : undefined;
    return downloadFile(r.downloadUrl, dir, base, { signal: ctx.signal, ext });
  },
};
