import type { LicenseCode, MediaResult } from "./types.js";

/**
 * Normalize a license name, short code or URL ("CC BY-SA 4.0", "by-nc", "Creative Commons 0",
 * "https://creativecommons.org/licenses/by/4.0/", "Public domain") to a LicenseCode.
 */
export function normalizeLicense(raw: string | undefined | null): LicenseCode {
  if (!raw) return "unknown";
  const s = raw.toLowerCase().trim();
  if (/publicdomain\/zero|\bcc0\b|cc-zero|creative commons 0|^zero$/.test(s)) return "cc0";
  if (/public ?domain|publicdomain\/mark|^pdm?$|^pd[- ]|no restrictions|no known copyright/.test(s)) return "pd";
  if (/gfdl|gnu free documentation/.test(s)) return "gfdl";
  // Creative Commons by URL path segment or by name.
  const m = /licenses\/([a-z-]+)\//.exec(s);
  let parts = m ? m[1] : s.replace(/creative commons|cc|licen[cs]e|international|unported|generic|[\d.]+/g, " ");
  parts = parts.replace(/attribution/g, "by").replace(/share ?alike/g, "sa").replace(/non ?commercial/g, "nc").replace(/no ?deriv(ative)?s?/g, "nd");
  const tok = new Set(parts.split(/[^a-z]+/).filter(Boolean));
  if (!tok.has("by")) return "unknown";
  const nc = tok.has("nc");
  const nd = tok.has("nd");
  const sa = tok.has("sa");
  if (nc && nd) return "cc-by-nc-nd";
  if (nc && sa) return "cc-by-nc-sa";
  if (nc) return "cc-by-nc";
  if (nd) return "cc-by-nd";
  if (sa) return "cc-by-sa";
  return "cc-by";
}

/** Human label for a LicenseCode (+ optional version). */
export function licenseLabel(code: LicenseCode, version?: string): string {
  const v = version ? ` ${version}` : "";
  switch (code) {
    case "cc0":
      return "CC0 1.0";
    case "pd":
      return "Public Domain";
    case "stock":
      return "Stock license";
    case "gfdl":
      return "GFDL";
    case "unknown":
      return "Unknown license";
    default:
      return `CC ${code.slice(3).toUpperCase()}${v}`;
  }
}

export function licenseUrlFor(code: LicenseCode, version = "4.0"): string | undefined {
  if (code === "cc0") return "https://creativecommons.org/publicdomain/zero/1.0/";
  if (code === "pd") return "https://creativecommons.org/publicdomain/mark/1.0/";
  if (code.startsWith("cc-by")) return `https://creativecommons.org/licenses/${code.slice(3)}/${version}/`;
  return undefined;
}

/** NonCommercial or NoDerivatives: unusable for most edits (commercial channels, any cut = derivative). */
export function isRestricted(code: LicenseCode): boolean {
  return code === "cc-by-nc" || code === "cc-by-nc-sa" || code === "cc-by-nd" || code === "cc-by-nc-nd";
}

export function attributionRequiredFor(code: LicenseCode): boolean {
  return !(code === "cc0" || code === "pd" || code === "stock");
}

/** License preference score in 0..1: CC0/PD/stock > CC BY > CC BY-SA > GFDL > unknown > NC/ND. */
export function licenseScore(code: LicenseCode): number {
  switch (code) {
    case "cc0":
    case "pd":
    case "stock":
      return 1;
    case "cc-by":
      return 0.8;
    case "cc-by-sa":
      return 0.6;
    case "gfdl":
      return 0.45;
    case "unknown":
      return 0.3;
    default:
      return 0.1;
  }
}

/** Standard TASL attribution: Title by Author (source) is licensed under X. */
export function buildAttribution(r: Pick<MediaResult, "title" | "author" | "url" | "license" | "licenseUrl">, via: string): string {
  const by = r.author ? ` by ${r.author}` : "";
  const lic = r.licenseUrl ? `${r.license} (${r.licenseUrl})` : r.license;
  return `"${r.title}"${by}, ${via} (${r.url}), ${lic}`;
}
