import { downloadFile, fetchJson, stripHtml } from "../http.js";
import { attributionRequiredFor, normalizeLicense } from "../license.js";
import type { MediaProvider, MediaResult, SearchQuery } from "../types.js";

// MediaWiki Action API on Wikimedia Commons: https://www.mediawiki.org/wiki/API:Search , API:Imageinfo, API:Videoinfo
// No key. Etiquette: descriptive User-Agent, modest request rate. License/author come from extmetadata
// (LicenseShortName, LicenseUrl, Artist, AttributionRequired), which is HTML.
const API = "https://commons.wikimedia.org/w/api.php";
/** Above this the original is skipped in favour of a ~1080p transcode. */
const MAX_ORIGINAL_BYTES = 400 * 1024 * 1024;

interface ExtValue {
  value: string;
}
interface WMInfo {
  size: number;
  width: number;
  height: number;
  duration?: number;
  url: string;
  thumburl?: string;
  descriptionurl: string;
  mime: string;
  mediatype?: string;
  extmetadata?: Record<string, ExtValue | undefined>;
  derivatives?: { src: string; type: string; width: number; height: number }[];
}
interface WMPage {
  pageid: number;
  title: string;
  imageinfo?: WMInfo[];
  videoinfo?: WMInfo[];
}

const FILETYPE: Record<string, string> = { image: "bitmap", video: "video", audio: "audio", music: "audio", sfx: "audio" };

function cleanTitle(t: string): string {
  return t.replace(/^File:/, "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/_/g, " ").trim();
}

function pickVideoUrl(info: WMInfo, target = 1920): { url: string; width: number; height: number } {
  if (info.size <= MAX_ORIGINAL_BYTES || !info.derivatives?.length)
    return { url: info.url, width: info.width, height: info.height };
  const d = [...info.derivatives].sort((a, b) => a.width - b.width);
  const pick = d.find((x) => x.width >= target) ?? d.at(-1)!;
  return { url: pick.src, width: pick.width, height: pick.height };
}

export const wikimedia: MediaProvider = {
  id: "wikimedia",
  name: "Wikimedia Commons",
  kinds: ["image", "video", "audio", "music", "sfx"],
  homepage: "https://commons.wikimedia.org",
  licenseSummary:
    "Wikimedia Commons hosts only free content: public domain, CC0, CC BY, CC BY-SA, GFDL (no NC/ND). License and author are per file.",

  async search(q: SearchQuery, ctx) {
    const video = q.kind === "video";
    const prop = video ? "videoinfo" : "imageinfo";
    const p = video ? "vi" : "ii";
    let search = `${q.query} filetype:${FILETYPE[q.kind]}`;
    if (q.minWidth && (q.kind === "image" || video)) search += ` filew:>${Math.floor(q.minWidth) - 1}`;
    const params: Record<string, string | number> = {
      action: "query",
      format: "json",
      formatversion: 2,
      generator: "search",
      gsrnamespace: 6,
      gsrsearch: search,
      gsrlimit: Math.min(50, Math.max(1, q.limit)),
      prop,
      [`${p}prop`]: `url|size|mime|mediatype|extmetadata${video ? "|derivatives" : ""}`,
      [`${p}urlwidth`]: 640,
      [`${p}extmetadatafilter`]: "LicenseShortName|LicenseUrl|Artist|ImageDescription|ObjectName|AttributionRequired|UsageTerms|License",
      origin: "*",
    };
    const data = await fetchJson<{ query?: { pages?: (WMPage & { index?: number })[] } }>(API, { params, signal: ctx.signal });
    const pages = [...(data.query?.pages ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return pages.flatMap((pg): MediaResult[] => {
      const info = (video ? pg.videoinfo : pg.imageinfo)?.[0];
      if (!info) return [];
      const em = info.extmetadata ?? {};
      const licName = stripHtml(em.LicenseShortName?.value) || stripHtml(em.UsageTerms?.value) || stripHtml(em.License?.value);
      const code = normalizeLicense(licName || em.LicenseUrl?.value);
      const author = stripHtml(em.Artist?.value) || undefined;
      const authorHref = /href="([^"]+)"/.exec(em.Artist?.value ?? "")?.[1];
      const title = stripHtml(em.ObjectName?.value) || cleanTitle(pg.title);
      const description = stripHtml(em.ImageDescription?.value);
      const file = video ? pickVideoUrl(info, q.minWidth ?? 1920) : { url: info.url, width: info.width, height: info.height };
      const attrRequiredField = em.AttributionRequired?.value;
      const attributionRequired = attrRequiredField ? attrRequiredField === "true" : attributionRequiredFor(code);
      const licenseUrl = em.LicenseUrl?.value || undefined;
      const license = licName || "See file page";
      return [
        {
          id: String(pg.pageid),
          provider: "wikimedia",
          kind: q.kind,
          title,
          url: info.descriptionurl,
          downloadUrl: file.url,
          previewUrl: info.thumburl,
          width: file.width || undefined,
          height: file.height || undefined,
          duration: info.duration,
          tags: description ? description.split(/[\s,.;:]+/).filter((w) => w.length > 3).slice(0, 25) : [],
          author,
          authorUrl: authorHref?.startsWith("//") ? `https:${authorHref}` : authorHref,
          license,
          licenseCode: code,
          licenseUrl,
          attributionRequired,
          attributionText: `"${title}"${author ? ` by ${author}` : ""}, Wikimedia Commons (${info.descriptionurl}), ${license}${licenseUrl ? ` (${licenseUrl})` : ""}`,
        },
      ];
    });
  },

  download(r, dir, base, ctx) {
    return downloadFile(r.downloadUrl, dir, base, { signal: ctx.signal });
  },
};
