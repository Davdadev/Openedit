/**
 * Installed-font lookup, to warn when a template uses fonts this machine lacks.
 * Sources (first that works): fc-list (fontconfig), macOS system_profiler
 * SPFontsDataType. Cached for 24 h in OPENEDIT_HOME/graphics/fonts.json.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openeditHome } from "../engine/paths.js";

export const normFont = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

interface FontCache {
  source: string;
  names: string[];
}

let memo: Set<string> | null | undefined;

function cacheFile(): string {
  return join(openeditHome(), "graphics", "fonts.json");
}

function scan(): FontCache | null {
  const fc = spawnSync("fc-list", [":", "family", "postscriptname", "fullname"], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (fc.status === 0 && fc.stdout) {
    const names = new Set<string>();
    for (const line of fc.stdout.split("\n")) {
      // "Family A,Family B:postscriptname=PS:fullname=Full"
      const [fams, ...rest] = line.split(":");
      for (const f of (fams ?? "").split(",")) if (f.trim()) names.add(normFont(f.replace(/\\-/g, "-")));
      for (const r of rest) {
        const v = r.split("=")[1];
        if (v) for (const x of v.split(",")) names.add(normFont(x));
      }
    }
    if (names.size) return { source: "fc-list", names: [...names] };
  }
  if (process.platform === "darwin") {
    const sp = spawnSync("system_profiler", ["SPFontsDataType", "-json"], { encoding: "utf8", timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
    if (sp.status === 0 && sp.stdout) {
      try {
        const j = JSON.parse(sp.stdout) as { SPFontsDataType?: { typefaces?: { family?: string; fullname?: string; _name?: string }[] }[] };
        const names = new Set<string>();
        for (const f of j.SPFontsDataType ?? []) {
          for (const t of f.typefaces ?? []) for (const v of [t.family, t.fullname, t._name]) if (v) names.add(normFont(v));
        }
        if (names.size) return { source: "system_profiler", names: [...names] };
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}

/** Normalised names of installed fonts (family, PostScript and full names), or null if unknown. */
export function installedFonts(): Set<string> | null {
  if (memo !== undefined) return memo;
  const file = cacheFile();
  try {
    if (existsSync(file) && Date.now() - statSync(file).mtimeMs < 24 * 3600_000) {
      memo = new Set((JSON.parse(readFileSync(file, "utf8")) as FontCache).names);
      return memo;
    }
  } catch {
    /* rescan */
  }
  const found = scan();
  if (found) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(found));
    } catch {
      /* cache optional */
    }
  }
  memo = found ? new Set(found.names) : null;
  return memo;
}

/** Test hook: forget the in-memory cache (and optionally inject a font list). */
export function setInstalledFontsForTest(names: string[] | null | undefined): void {
  memo = names === undefined ? undefined : names === null ? null : new Set(names.map(normFont));
}

/** Family of a PostScript name: "ArchivoItalic-BlackItalic" → "Archivo", "Unbounded-Bold" → "Unbounded". */
export function familyOf(ps: string): string {
  const base = ps.split("-")[0] ?? ps;
  return base.replace(/(Italic|Roman|Oblique|Upright|Regular|VF|Variable)$/i, "") || base;
}

/** Fonts from `fonts` that are not installed (empty when the installed list is unknown). */
export function missingFonts(fonts: string[]): string[] {
  const have = installedFonts();
  if (!have) return [];
  return fonts.filter((f) => {
    const n = normFont(f);
    if (!n || have.has(n)) return false;
    const fam = normFont(familyOf(f));
    if (fam && have.has(fam)) return false;
    // "Inter:Bold" style names (Figma) and "Family Style".
    const head = normFont(f.split(/[:,]/)[0] ?? "");
    return !(head && have.has(head));
  });
}
