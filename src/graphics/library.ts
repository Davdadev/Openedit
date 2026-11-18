/**
 * OpenEdit graphics library: one catalog for
 *  - the user's template packs (Motion Bro .mbr / .zip / folders / single .mogrt or .aep),
 *    indexed IN PLACE: library.json stores paths (or archive entry names) plus small cached
 *    thumbnails (<= 320 px) under OPENEDIT_HOME/graphics/thumbs. Heavy files are never copied;
 *    a .mogrt inside an archive is extracted to the cache only when it is placed.
 *  - OpenEdit's own HyperFrames templates (templates/<id>/template.json),
 *  - user templates made with create_motion_template (OPENEDIT_HOME/graphics/user/<id>/).
 *
 * Commercial packs are licensed to the user: nothing from them is redistributed or
 * copied into the repo; previews and thumbnails stay in the user's OPENEDIT_HOME.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { openeditHome } from "../engine/paths.js";
import { missingFonts } from "./fonts.js";
import { makeThumb } from "./images.js";
import { parseMogrtDefinition, slug, type MogrtInfo } from "./mogrt.js";
import type { CatalogItem, FileRef, GraphicsApp, LibraryFile, PackRecord, TemplateParam } from "./types.js";
import { listZip, readZipBufferEntry, readZipEntry, type ZipEntry } from "./zip.js";

// ------------------------------------------------------------------ paths

export const graphicsPaths = {
  root: () => mk(join(openeditHome(), "graphics")),
  library: () => join(graphicsPaths.root(), "library.json"),
  thumbs: () => mk(join(graphicsPaths.root(), "thumbs")),
  user: () => mk(join(graphicsPaths.root(), "user")),
  cache: () => mk(join(graphicsPaths.root(), "cache")),
  renders: () => mk(join(graphicsPaths.root(), "renders")),
};

function mk(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

// ------------------------------------------------------------------ sources (folder or archive)

interface SourceEntry {
  rel: string;
  size: number;
  zip?: ZipEntry;
}

interface PackSource {
  type: "folder" | "archive";
  root: string;
  entries: SourceEntry[];
  ref(rel: string): FileRef;
  read(rel: string, maxBytes?: number): Buffer;
}

const SKIP_DIRS = /^(node_modules|\.git|__MACOSX)$/;

function folderSource(root: string): PackSource {
  const entries: SourceEntry[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (SKIP_DIRS.test(n) || n === ".DS_Store") continue;
      const p = join(dir, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else entries.push({ rel: relative(root, p).split(sep).join("/"), size: st.size });
    }
  };
  walk(root, 0);
  return {
    type: "folder",
    root,
    entries,
    ref: (rel) => ({ path: join(root, ...rel.split("/")) }),
    read: (rel) => readFileSync(join(root, ...rel.split("/"))),
  };
}

function archiveSource(path: string): PackSource {
  const zip = listZip(path).filter((e) => !e.dir && !e.name.startsWith("__MACOSX/"));
  const byName = new Map(zip.map((e) => [e.name, e]));
  return {
    type: "archive",
    root: path,
    entries: zip.map((e) => ({ rel: e.name, size: e.size, zip: e })),
    ref: (rel) => ({ archive: path, path: rel }),
    read: (rel, maxBytes) => readZipEntry(path, byName.get(rel) ?? rel, maxBytes),
  };
}

/** A local file for a FileRef: the path itself, or the archive entry extracted to the cache (once). */
export function materialize(ref: FileRef): string {
  if (!ref.archive) return ref.path;
  const dir = mk(join(graphicsPaths.cache(), "extract", sha(`${ref.archive}|${ref.path}`)));
  const out = join(dir, basename(ref.path));
  if (!existsSync(out)) {
    const tmp = `${out}.part`;
    writeFileSync(tmp, readZipEntry(ref.archive, ref.path));
    renameSync(tmp, out);
  }
  return out;
}

export function refExists(ref: FileRef | undefined): boolean {
  if (!ref) return false;
  return existsSync(ref.archive ?? ref.path);
}

// ------------------------------------------------------------------ library file

export function loadLibrary(): LibraryFile {
  const f = graphicsPaths.library();
  if (existsSync(f)) {
    try {
      const j = JSON.parse(readFileSync(f, "utf8")) as LibraryFile;
      if (j && Array.isArray(j.items)) return j;
    } catch {
      /* rebuild */
    }
  }
  return { version: 1, packs: [], items: [] };
}

function saveLibrary(lib: LibraryFile): void {
  const f = graphicsPaths.library();
  writeFileSync(`${f}.tmp`, JSON.stringify(lib, null, 1));
  renameSync(`${f}.tmp`, f);
}

// ------------------------------------------------------------------ pack import

const ITEM_EXT = new Set([".mogrt", ".aep", ".demo"]);
const PREVIEW_DIR = /^\(preview\)$/i;
const THUMB_DIR = /^\(thumbnails?\)$/i;

function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([\w.-]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

const stripNum = (s: string) => s.replace(/^\d+\s*[.)_-]\s*/, "").trim();

function packIdFromName(name: string): string {
  const short = name.split(/\s+(?:for|-|–|—)\s+/i)[0] ?? name;
  return slug(short).slice(0, 40) || "pack";
}

function describeMogrt(info: MogrtInfo, category: string, missing: string[]): string {
  const colors = info.params.filter((p) => p.type === "color" && typeof p.default === "string").map((p) => p.default as string);
  const texts = info.params.filter((p) => p.type === "text").map((p) => `"${String(p.default ?? "").slice(0, 40)}"`);
  const bits = [
    `${category ? `${category} ` : ""}${info.authorApp === "aefx" ? "After Effects-authored" : "Premiere"} MOGRT`,
    info.duration ? `${info.duration}s` : "",
    info.width ? `${info.width}x${info.height}${info.fps ? ` @${info.fps}fps` : ""}` : "",
    texts.length ? `text ${texts.join(", ")}` : "",
    info.fonts.length ? `fonts ${info.fonts.join(", ")}${missing.length ? ` (MISSING: ${missing.join(", ")})` : ""}` : "",
    colors.length ? `colours ${colors.join(" ")}` : "",
  ];
  return bits.filter(Boolean).join("; ");
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

/** Thumbnail cache file for a source image/video ref (made once). */
async function thumbFor(ref: FileRef, src: PackSource | null, at?: number): Promise<string | undefined> {
  const key = sha(`${ref.archive ?? ""}|${ref.path}|${at ?? ""}`);
  const out = join(graphicsPaths.thumbs(), `${key}.jpg`);
  if (existsSync(out)) return out;
  try {
    let file = ref.path;
    let tmp: string | undefined;
    if (ref.archive && src) {
      tmp = join(mk(join(graphicsPaths.cache(), "tmp")), `${key}${extname(ref.path)}`);
      writeFileSync(tmp, src.read(ref.path, 64 * 1024 * 1024));
      file = tmp;
    }
    await makeThumb(file, out, { width: 320, at });
    if (tmp) {
      try {
        (await import("node:fs")).rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
    }
    return out;
  } catch {
    return undefined;
  }
}

/** Thumbnail from a buffer (e.g. thumb.png inside a .mogrt). */
async function thumbFromBuffer(key: string, buf: Buffer, ext: string): Promise<string | undefined> {
  const out = join(graphicsPaths.thumbs(), `${sha(key)}.jpg`);
  if (existsSync(out)) return out;
  const tmp = join(mk(join(graphicsPaths.cache(), "tmp")), `${sha(key)}${ext}`);
  try {
    writeFileSync(tmp, buf);
    await makeThumb(tmp, out, { width: 320 });
    return out;
  } catch {
    return undefined;
  } finally {
    try {
      (await import("node:fs")).rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
  }
}

export interface ImportResult {
  pack: PackRecord;
  items: CatalogItem[];
  warnings: string[];
}

/**
 * Index a template pack: .mbr / .zip archive, a folder (Motion Bro layout, any folder of
 * .mogrt/.aep files, or an unpacked .mogrt with definition.json), or a single .mogrt/.aep.
 */
export async function importTemplatePack(input: string, opts: { id?: string; name?: string; thumbs?: boolean } = {}): Promise<ImportResult> {
  const path = resolve(input.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
  if (!existsSync(path)) throw new Error(`Not found: ${path}`);
  const st = statSync(path);
  const ext = extname(path).toLowerCase();
  const warnings: string[] = [];
  let src: PackSource;
  let single: string | null = null;
  if (st.isDirectory()) {
    src = folderSource(path);
    if (src.entries.some((e) => e.rel === "definition.json")) single = "definition.json"; // unpacked .mogrt
  } else if (ext === ".mbr" || ext === ".zip") {
    src = archiveSource(path);
  } else if (ext === ".mogrt" || ext === ".aep") {
    src = folderSource(dirname(path));
    src.entries = src.entries.filter((e) => e.rel === basename(path) || /\((preview|thumbnails?)\)\//i.test(e.rel));
    single = basename(path);
  } else throw new Error(`Unsupported template pack "${path}". Pass a .mbr, .zip, .mogrt, .aep or a folder.`);

  const info = src.entries.find((e) => /(^|\/)pack\.info$/i.test(e.rel) && e.rel.split("/").length <= 2);
  const meta = info ? parseKv(src.read(info.rel).toString("utf8")) : {};
  const packName = opts.name ?? meta.packName ?? (single ? basename(single === "definition.json" ? path : single, extname(single)) : basename(path, extname(path)));
  const packId = opts.id ? slug(opts.id) : packIdFromName(packName === "x" ? basename(dirname(path)) : packName);
  const prefix = info ? info.rel.replace(/pack\.info$/i, "") : "";

  // Previews/thumbnails by stem, keyed with their folder (the folder that holds "(Preview)").
  const media = new Map<string, { dir: string; rel: string; kind: "preview" | "image" }[]>();
  for (const e of src.entries) {
    const parts = e.rel.split("/");
    if (parts.length < 2) continue;
    const folder = parts[parts.length - 2]!;
    const kind = PREVIEW_DIR.test(folder) ? "preview" : THUMB_DIR.test(folder) ? "image" : null;
    if (!kind) continue;
    const e2 = extname(e.rel).toLowerCase();
    if (kind === "preview" && ![".mp4", ".mov", ".webm", ".m4v"].includes(e2)) continue;
    if (kind === "image" && ![".jpg", ".jpeg", ".png", ".webp"].includes(e2)) continue;
    const stem = basename(e.rel, extname(e.rel)).toLowerCase();
    const list = media.get(stem) ?? [];
    list.push({ dir: parts.slice(0, -2).join("/"), rel: e.rel, kind });
    media.set(stem, list);
  }
  const settings = new Map<string, Record<string, string>>();
  for (const e of src.entries) if (/(^|\/)\.settings$/.test(e.rel)) settings.set(dirname(e.rel) === "." ? "" : dirname(e.rel), parseKv(src.read(e.rel).toString("utf8")));

  const nearest = (stem: string, dir: string, kind: "preview" | "image") => {
    const list = (media.get(stem.toLowerCase()) ?? []).filter((m) => m.kind === kind);
    let d = dir;
    for (;;) {
      const hit = list.find((m) => m.dir === d);
      if (hit) return hit.rel;
      if (!d) break;
      d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "";
    }
    return list[0]?.rel;
  };

  const itemEntries = single ? src.entries.filter((e) => e.rel === single) : src.entries.filter((e) => ITEM_EXT.has(extname(e.rel).toLowerCase()) && !/\((assets|preview|thumbnails?)\)\//i.test(e.rel));
  const items: CatalogItem[] = [];
  const usedIds = new Set<string>();
  const counts: Record<string, number> = { mogrt: 0, aep: 0, demo: 0 };

  for (const e of itemEntries) {
    const rel = e.rel;
    const isDef = rel === "definition.json";
    const ext2 = isDef ? ".mogrt" : extname(rel).toLowerCase();
    const stem = isDef ? basename(path) : basename(rel, extname(rel));
    const relDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const catDir = prefix && relDir.startsWith(prefix.replace(/\/$/, "")) ? relDir.slice(prefix.length) : relDir;
    const category = catDir.split("/").filter(Boolean).map(stripNum).join(" / ") || (isDef || single ? "Templates" : "Templates");
    let id = `${packId}/${slug(stem)}`;
    if (usedIds.has(id)) id = `${packId}/${slug(category)}-${slug(stem)}`;
    for (let i = 2; usedIds.has(id); i++) id = `${packId}/${slug(stem)}-${i}`;
    usedIds.add(id);
    const set = settings.get(relDir) ?? {};
    const item: CatalogItem = {
      id,
      name: stem,
      kind: ext2 === ".mogrt" ? "mogrt" : ext2 === ".aep" ? "aep" : "demo",
      pack: packId,
      packName,
      category,
      apps: [],
      usable: false,
      params: [],
      tags: Object.entries(set).map(([k, v]) => `${k}=${v}`),
    };
    const pv = nearest(stem, relDir, "preview");
    const im = nearest(stem, relDir, "image");
    if (pv) item.preview = src.ref(pv);
    if (im) item.image = src.ref(im);
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;

    if (item.kind === "mogrt") {
      try {
        let def: Buffer | undefined;
        let thumbPng: Buffer | undefined;
        if (isDef) {
          def = src.read(rel);
          item.source = { path };
          const tp = src.entries.find((x) => x.rel === "thumb.png");
          if (tp) thumbPng = src.read(tp.rel);
        } else {
          const buf = src.read(rel, 256 * 1024 * 1024);
          def = readZipBufferEntry(buf, "definition.json");
          thumbPng = readZipBufferEntry(buf, "thumb.png");
          item.source = src.ref(rel);
        }
        if (!def) throw new Error("no definition.json");
        const m = parseMogrtDefinition(def.toString("utf8"));
        const missing = missingFonts(m.fonts);
        Object.assign(item, {
          name: m.name || stem,
          params: m.params,
          groups: m.groups,
          duration: m.duration,
          width: m.width,
          height: m.height,
          fps: m.fps,
          fonts: m.fonts,
          missingFonts: missing,
          usable: true,
          apps: ["premiere"] as GraphicsApp[],
          note:
            "Premiere MOGRT: placed natively with place_graphic (editable in Essential Graphics). Not usable in Resolve/standalone (needs Premiere's renderer)." +
            (missing.length ? ` Missing fonts: ${missing.join(", ")} (Premiere substitutes them; install for the intended look).` : ""),
          description: describeMogrt(m, category, missing),
        });
        if (m.tags.length) item.tags = [...(item.tags ?? []), ...m.tags];
        if (missing.length) warnings.push(`${item.id}: missing fonts ${missing.join(", ")}`);
        if (thumbPng && !item.image) item.thumb = await thumbFromBuffer(`${id}|${item.source.archive ?? ""}|${item.source.path}|thumb`, thumbPng, ".png");
      } catch (err) {
        item.usable = false;
        item.note = `Could not read the .mogrt (${(err as Error).message}).`;
        warnings.push(`${item.id}: ${(err as Error).message}`);
      }
    } else if (item.kind === "aep") {
      item.source = src.ref(rel);
      item.apps = ["aftereffects"];
      item.note = "After Effects project: needs After Effects to render, so it cannot be placed directly. Use it as a style reference: look at its preview and recreate the idea with create_motion_template.";
      item.description = `${category} After Effects project (style reference)`;
    } else {
      item.locked = true;
      item.note = "Locked demo placeholder (in the pack's full version only): preview only, not usable.";
      item.description = `${category} (locked, full version only)`;
    }
    items.push(item);
  }

  if (opts.thumbs !== false) {
    await pool(items, 6, async (it) => {
      if (it.thumb) return;
      if (it.image) it.thumb = await thumbFor(it.image, src);
      if (!it.thumb && it.preview) it.thumb = await thumbFor(it.preview, src, 1);
    });
  }

  const pack: PackRecord = {
    id: packId,
    name: packName,
    author: meta.author,
    apps: meta.apps,
    source: path,
    type: src.type === "archive" ? "archive" : single ? "file" : "folder",
    importedAt: new Date().toISOString(),
    counts: { ...counts, items: items.length, usable: items.filter((i) => i.usable).length },
  };
  const lib = loadLibrary();
  lib.packs = [...lib.packs.filter((p) => p.id !== packId), pack];
  lib.items = [...lib.items.filter((i) => i.pack !== packId), ...items];
  saveLibrary(lib);
  return { pack, items, warnings };
}

export function removePack(id: string): boolean {
  const lib = loadLibrary();
  const before = lib.packs.length;
  lib.packs = lib.packs.filter((p) => p.id !== id);
  lib.items = lib.items.filter((i) => i.pack !== id);
  saveLibrary(lib);
  return lib.packs.length < before;
}

// ------------------------------------------------------------------ own + user templates

/** Infer a field type/options from an own template's param description and default. */
export function inferParam(id: string, desc: string, def: unknown): TemplateParam {
  const p: TemplateParam = { id, name: id, type: "text", description: desc };
  if (def !== undefined) p.default = def;
  const quoted = [...desc.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  if (typeof def === "string" && /^#[0-9a-f]{3,8}$/i.test(def)) p.type = "color";
  else if (/colou?r/i.test(desc) && /hex/i.test(desc)) p.type = "color";
  else if (typeof def === "number") p.type = "number";
  else if (typeof def === "boolean") p.type = "checkbox";
  else if (quoted.length >= 2 && /^'/.test(desc.trim())) {
    p.type = "dropdown";
    p.options = quoted;
  }
  return p;
}

interface OwnManifest {
  id: string;
  name?: string;
  description: string;
  duration?: number;
  category?: string;
  params: Record<string, string>;
  defaults?: Record<string, unknown>;
  tags?: string[];
}

const OWN_CATEGORY: Record<string, string> = {
  "lower-third": "Lower thirds",
  "title-card": "Titles",
  chapter: "Titles",
  quote: "Text",
  callout: "Callouts",
  counter: "Stats",
  subscribe: "Social",
};

export function ownTemplates(templatesRoot: string): CatalogItem[] {
  if (!existsSync(templatesRoot)) return [];
  const out: CatalogItem[] = [];
  for (const d of readdirSync(templatesRoot).sort()) {
    if (d.startsWith("_") || d.startsWith(".")) continue;
    const dir = join(templatesRoot, d);
    const mf = join(dir, "template.json");
    if (!existsSync(mf)) continue;
    let m: OwnManifest;
    try {
      m = JSON.parse(readFileSync(mf, "utf8")) as OwnManifest;
    } catch {
      continue;
    }
    const params = Object.entries(m.params ?? {}).map(([k, desc]) => inferParam(k, desc, m.defaults?.[k]));
    const thumb = ["thumb.jpg", "thumb.png"].map((f) => join(dir, f)).find((f) => existsSync(f));
    out.push({
      id: m.id,
      name: m.name ?? m.id,
      kind: "hyperframes",
      pack: "openedit",
      packName: "OpenEdit",
      category: m.category ?? OWN_CATEGORY[m.id] ?? "Graphics",
      apps: ["premiere", "resolve", "standalone"],
      usable: true,
      note: "OpenEdit HyperFrames template: rendered to alpha video (.mov ProRes 4444) and placed on an upper track in any host.",
      params,
      duration: m.duration,
      width: 1920,
      height: 1080,
      fps: 30,
      description: m.description,
      dir,
      tags: m.tags,
      ...(thumb ? { thumb } : cachedOwnThumb(m.id, dir)),
    });
  }
  return out;
}

/** Thumbnail rendered by preview_template for own/user templates (cache key = template content). */
export function ownThumbPath(id: string, dir: string): string {
  let sig = id;
  for (const f of ["template.json", "composition.html"]) {
    try {
      sig += `|${statSync(join(dir, f)).mtimeMs}`;
    } catch {
      /* missing */
    }
  }
  return join(graphicsPaths.thumbs(), `own-${slug(id)}-${sha(sig)}.jpg`);
}

function cachedOwnThumb(id: string, dir: string): { thumb?: string } {
  const p = ownThumbPath(id, dir);
  return existsSync(p) ? { thumb: p } : {};
}

export function userTemplates(): CatalogItem[] {
  const root = graphicsPaths.user();
  const out: CatalogItem[] = [];
  for (const d of readdirSync(root).sort()) {
    const dir = join(root, d);
    const mf = join(dir, "template.json");
    if (!existsSync(mf)) continue;
    try {
      const m = JSON.parse(readFileSync(mf, "utf8")) as {
        id: string;
        name?: string;
        description?: string;
        category?: string;
        duration?: number;
        width?: number;
        height?: number;
        fps?: number;
        fields?: TemplateParam[];
        fonts?: string[];
        tags?: string[];
        source?: string;
      };
      const thumb = join(dir, "thumb.jpg");
      out.push({
        id: m.id,
        name: m.name ?? m.id,
        kind: "user",
        pack: "user",
        packName: "My templates",
        category: m.category ?? "Custom",
        apps: ["premiere", "resolve", "standalone"],
        usable: true,
        note: `Your template${m.source ? ` (${m.source})` : ""}: rendered to alpha video and placed on an upper track in any host.`,
        params: m.fields ?? [],
        duration: m.duration,
        width: m.width,
        height: m.height,
        fps: m.fps,
        fonts: m.fonts,
        description: m.description,
        dir,
        tags: m.tags,
        ...(existsSync(thumb) ? { thumb } : {}),
      });
    } catch {
      /* skip broken */
    }
  }
  return out;
}

// ------------------------------------------------------------------ catalog queries

let ownRoot: (() => string) | null = null;
/** Set the templates/ folder resolver (motion module), lazily so graphics never hard-fails without it. */
export function setTemplatesRoot(fn: () => string): void {
  ownRoot = fn;
}

export function allTemplates(): CatalogItem[] {
  let own: CatalogItem[] = [];
  try {
    if (ownRoot) own = ownTemplates(ownRoot());
  } catch {
    own = [];
  }
  return [...userTemplates(), ...own, ...loadLibrary().items];
}

export interface CatalogFilter {
  query?: string;
  category?: string;
  app?: GraphicsApp;
  usable?: boolean;
  pack?: string;
  kind?: string;
}

export function searchCatalog(f: CatalogFilter = {}): CatalogItem[] {
  const tokens = (f.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return allTemplates().filter((it) => {
    if (f.usable !== undefined && it.usable !== f.usable) return false;
    if (f.app && !it.apps.includes(f.app)) return false;
    if (f.pack && it.pack !== f.pack) return false;
    if (f.kind && it.kind !== f.kind) return false;
    if (f.category && !it.category.toLowerCase().includes(f.category.toLowerCase())) return false;
    if (tokens.length) {
      const hay = [it.id, it.name, it.category, it.packName, it.kind, it.description ?? "", ...(it.tags ?? []), ...it.params.map((p) => p.name)].join(" ").toLowerCase();
      return tokens.every((t) => hay.includes(t));
    }
    return true;
  });
}

export function getTemplate(id: string): CatalogItem {
  const all = allTemplates();
  const it = all.find((x) => x.id === id) ?? all.find((x) => x.id.toLowerCase() === id.toLowerCase()) ?? all.find((x) => x.name.toLowerCase() === id.toLowerCase());
  if (!it) {
    const near = all
      .filter((x) => x.id.includes(slug(id).split("-")[0] ?? "") || x.name.toLowerCase().includes(id.toLowerCase()))
      .slice(0, 5)
      .map((x) => x.id);
    throw new Error(`Unknown graphics template "${id}".${near.length ? ` Did you mean: ${near.join(", ")}?` : " Call graphics_catalog to list templates."}`);
  }
  return it;
}

/** One-line summary for text output. */
export function summarize(it: CatalogItem, n?: number): string {
  const flags = [it.kind, it.locked ? "LOCKED" : it.usable ? "usable" : "not usable", it.apps.join("/")].join(", ");
  const dims = it.duration ? ` ${it.duration}s` : "";
  const fields = it.params.length ? ` fields: ${it.params.slice(0, 8).map((p) => `${p.id}(${p.type})`).join(", ")}${it.params.length > 8 ? "…" : ""}` : "";
  const miss = it.missingFonts?.length ? ` MISSING FONTS: ${it.missingFonts.join(", ")}` : "";
  return `${n !== undefined ? `${n}. ` : ""}${it.id} — ${it.name} [${it.category}; ${flags}${dims}]${fields}${miss}`;
}
