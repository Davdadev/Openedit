import { downloadFile, fetchJson } from "../http.js";
import { attributionRequiredFor, licenseLabel, normalizeLicense } from "../license.js";
import type { MediaProvider, MediaResult, SearchQuery } from "../types.js";

// Docs: https://developer.jamendo.com/v3.0/tracks  (client_id param; limit<=200; durationbetween=a_b;
// ccnc/ccnd/ccsa filters; audiodownload empty unless audiodownload_allowed).
// API terms (https://devportal.jamendo.com/api_terms_of_use): free for NON-COMMERCIAL use of the API;
// each track is CC-licensed individually and many are NC/ND — those are filtered out by default.
const API = "https://api.jamendo.com/v3.0";

interface JTrack {
  id: string;
  name: string;
  duration: number;
  artist_name: string;
  artist_id: string;
  album_name?: string;
  license_ccurl: string;
  shareurl: string;
  shorturl?: string;
  audio: string;
  audiodownload: string;
  audiodownload_allowed?: boolean;
  image?: string;
  musicinfo?: { tags?: { genres?: string[]; instruments?: string[]; vartags?: string[] } };
}

export const jamendo: MediaProvider = {
  id: "jamendo",
  name: "Jamendo",
  kinds: ["music", "audio"],
  keyEnv: "JAMENDO_CLIENT_ID",
  homepage: "https://developer.jamendo.com/v3.0",
  licenseSummary:
    "Jamendo: per-track Creative Commons (BY, BY-SA, and many NC/ND which are excluded by default). API itself is free for non-commercial apps.",

  async search(q: SearchQuery, ctx) {
    const data = await fetchJson<{ headers: { status: string; error_message?: string }; results: JTrack[] }>(`${API}/tracks/`, {
      params: {
        client_id: ctx.key,
        format: "json",
        limit: Math.min(200, Math.max(1, q.limit)),
        search: q.query,
        include: "licenses musicinfo",
        audioformat: "mp32",
        audiodlformat: "mp32",
        durationbetween:
          q.minDuration !== undefined || q.maxDuration !== undefined
            ? `${Math.floor(q.minDuration ?? 0)}_${Math.ceil(q.maxDuration ?? 3600)}`
            : undefined,
        ccnc: q.allowNonCommercial ? undefined : "false",
        ccnd: q.allowNonCommercial ? undefined : "false",
        boost: "popularity_total",
      },
      signal: ctx.signal,
    });
    if (data.headers?.status && data.headers.status !== "success") throw new Error(`Jamendo: ${data.headers.error_message ?? data.headers.status}`);
    return (data.results ?? []).flatMap((t): MediaResult[] => {
      const dl = t.audiodownload_allowed !== false && t.audiodownload ? t.audiodownload : "";
      if (!dl) return [];
      const code = normalizeLicense(t.license_ccurl);
      const version = /\/(\d\.\d)\//.exec(t.license_ccurl)?.[1];
      const license = licenseLabel(code, version);
      const tags = t.musicinfo?.tags ?? {};
      const title = t.name;
      return [
        {
          id: String(t.id),
          provider: "jamendo",
          kind: q.kind,
          title,
          url: t.shareurl,
          downloadUrl: dl,
          previewUrl: t.audio,
          duration: t.duration,
          tags: [...(tags.genres ?? []), ...(tags.instruments ?? []), ...(tags.vartags ?? [])],
          author: t.artist_name,
          authorUrl: `https://www.jamendo.com/artist/${t.artist_id}`,
          license,
          licenseCode: code,
          licenseUrl: t.license_ccurl,
          attributionRequired: attributionRequiredFor(code),
          attributionText: `"${title}" by ${t.artist_name} (${t.shareurl}) via Jamendo, ${license} (${t.license_ccurl})`,
        },
      ];
    });
  },

  download(r, dir, base, ctx) {
    return downloadFile(r.downloadUrl, dir, base, { signal: ctx.signal, ext: ".mp3" });
  },
};
