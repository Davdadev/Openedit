/**
 * Parse a .mogrt (Motion Graphics template) definition.json into a clean parameter
 * schema. A .mogrt is a ZIP holding definition.json (the Essential Graphics controls,
 * "clientControls"), the After Effects / Premiere project and thumbnails.
 *
 * clientControls[].type (After Effects capsule property types):
 *   1 checkbox, 2 slider, 3 angle, 4 color (RGBA 0..1), 5 point (comp pixels),
 *   6 source text, 7 dropdown, 8 spacer/comment, 9 media replacement, 10 group.
 */
import type { TemplateParam } from "./types.js";

type Loc = { strDB?: { localeString?: string; str?: string }[] } | string | undefined | null;

export function localized(v: Loc): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  const db = v.strDB ?? [];
  return (db.find((s) => s.localeString === "en_US") ?? db[0])?.str ?? "";
}

export interface MogrtInfo {
  name: string;
  /** "aefx" (After Effects) or "ppro" (Premiere). */
  authorApp: string;
  tags: string[];
  duration?: number;
  fps?: number;
  width?: number;
  height?: number;
  fonts: string[];
  params: TemplateParam[];
  groups: { name: string; params: string[] }[];
  effects: string[];
  /** Controls that could not be mapped (type numbers). */
  skipped: number[];
}

export function slug(s: string): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "x"
  );
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** RGBA 0..1 array → "#RRGGBB" (alpha dropped when 1) or "#RRGGBBAA". */
export function rgbaToHex(v: unknown): string | undefined {
  if (!Array.isArray(v) || v.length < 3) return undefined;
  const c = v.map((x) => Math.max(0, Math.min(255, Math.round(Number(x) * 255))));
  const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  const a = v.length > 3 ? c[3]! : 255;
  return `#${hex(c[0]!)}${hex(c[1]!)}${hex(c[2]!)}${a < 255 ? hex(a) : ""}`;
}

/** "#RGB", "#RRGGBB", "#RRGGBBAA" → [r,g,b,a] 0..255 (Premiere setColorValue order is a,r,g,b). */
export function hexToRgba255(hex: string): [number, number, number, number] | undefined {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return undefined;
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) : 255];
}

function menuItems(c: Record<string, unknown>): string[] | undefined {
  for (const k of ["menuItems", "dropdownItems", "items", "popupItems"]) {
    const v = c[k];
    if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : localized(x as Loc) || String((x as { name?: string }).name ?? ""))).filter(Boolean);
  }
  const dd = c.dropdownMenuItems ?? (c.dropdown as { items?: unknown } | undefined)?.items;
  if (Array.isArray(dd)) return dd.map((x) => (typeof x === "string" ? x : localized(x as Loc))).filter(Boolean);
  return undefined;
}

type Control = Record<string, unknown> & { id?: string; type?: number; uiName?: Loc; value?: unknown };

/** Parse definition.json (object or JSON text). */
export function parseMogrtDefinition(def: unknown): MogrtInfo {
  const d = (typeof def === "string" ? JSON.parse(def) : def) as Record<string, unknown>;
  if (!d || typeof d !== "object" || !Array.isArray(d.clientControls)) throw new Error("not a .mogrt definition (no clientControls)");
  const controls = d.clientControls as Control[];
  const byId = new Map<string, Control>();
  for (const c of controls) if (c.id) byId.set(String(c.id), c);

  // Group membership: a group control's value lists the ids of its children.
  const groupOf = new Map<string, string>();
  const groups: { name: string; params: string[] }[] = [];
  for (const c of controls) {
    if (c.type === 10 && Array.isArray(c.value)) {
      const name = localized(c.uiName) || "Group";
      for (const child of c.value as string[]) groupOf.set(String(child), name);
    }
  }

  const params: TemplateParam[] = [];
  const used = new Set<string>();
  const skipped: number[] = [];
  const idFor = (name: string) => {
    const base = slug(name);
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
    used.add(id);
    return id;
  };

  for (const c of controls) {
    const name = localized(c.uiName).trim();
    const group = c.id ? groupOf.get(String(c.id)) : undefined;
    let p: TemplateParam | null = null;
    switch (c.type) {
      case 10:
        groups.push({ name: name || "Group", params: [] });
        continue;
      case 8:
        continue; // spacer / comment line
      case 6: {
        const fe = (c.fonteditinfo ?? {}) as { fontEditValue?: string; fontSizeEditValue?: number };
        const val = typeof c.value === "object" && c.value && !Array.isArray(c.value) ? localized(c.value as Loc) : String(c.value ?? "");
        p = { id: "", name: name || "Text", type: "text", default: val };
        if (fe.fontEditValue) p.font = fe.fontEditValue;
        if (typeof fe.fontSizeEditValue === "number") p.fontSize = fe.fontSizeEditValue;
        break;
      }
      case 4:
        p = { id: "", name: name || "Color", type: "color", default: rgbaToHex(c.value) };
        break;
      case 2:
        p = { id: "", name: name || "Slider", type: "slider", default: typeof c.value === "number" ? r4(c.value) : c.value };
        if (typeof c.min === "number") p.min = c.min;
        if (typeof c.max === "number") p.max = c.max;
        break;
      case 3:
        p = { id: "", name: name || "Angle", type: "angle", default: typeof c.value === "number" ? c.value : 0 };
        break;
      case 1:
        p = { id: "", name: name || "Checkbox", type: "checkbox", default: !!c.value };
        break;
      case 5: {
        const v = c.value as { x?: number; y?: number } | number[] | undefined;
        const pt = Array.isArray(v) ? [v[0], v[1]] : v && typeof v === "object" ? [v.x, v.y] : undefined;
        p = { id: "", name: name || "Position", type: "point", default: pt };
        break;
      }
      case 7: {
        p = { id: "", name: name || "Menu", type: "dropdown", default: typeof c.value === "number" ? c.value : 0 };
        const opts = menuItems(c);
        if (opts?.length) p.options = opts;
        break;
      }
      case 9:
        p = { id: "", name: name || "Media", type: "image", description: "Media replacement (drop footage/image in Premiere's Essential Graphics panel)" };
        break;
      default:
        if (typeof c.type === "number") skipped.push(c.type);
        continue;
    }
    if (!p) continue;
    p.id = idFor(p.name);
    if (group) p.group = group;
    params.push(p);
  }
  for (const g of groups) g.params = params.filter((p) => p.group === g.name).map((p) => p.id);

  const src = ((d.sourceInfoLocalized as Record<string, Record<string, unknown>> | undefined)?.en_US ??
    Object.values((d.sourceInfoLocalized as Record<string, Record<string, unknown>>) ?? {})[0] ??
    {}) as Record<string, unknown>;
  const dur = src.duration as { scale?: number; value?: number } | undefined;
  const fr = src.framerate as { ticksperframe?: number } | undefined;
  const fsz = (src.framesize as { size?: { x?: number; y?: number } } | undefined)?.size;
  const fontsLoc = d.usedFontsLocalized as Record<string, string[]> | undefined;
  const fonts = fontsLoc ? (fontsLoc.en_US ?? Object.values(fontsLoc)[0] ?? []) : [];
  for (const p of params) if (p.font && !fonts.includes(p.font)) fonts.push(p.font);

  return {
    name: localized(d.capsuleNameLocalized as Loc) || String(d.capsuleName ?? "Untitled"),
    authorApp: String(d.authorApp ?? ""),
    tags: Array.isArray(d.capsuleTags) ? (d.capsuleTags as unknown[]).map(String) : [],
    duration: dur && dur.scale && typeof dur.value === "number" ? Math.round((dur.value / dur.scale) * 1000) / 1000 : undefined,
    fps: fr?.ticksperframe ? Math.round((254016000000 / fr.ticksperframe) * 1000) / 1000 : undefined,
    width: fsz?.x,
    height: fsz?.y,
    fonts,
    params,
    groups: groups.filter((g) => g.params.length),
    effects: Array.isArray(d.usedEffects) ? (d.usedEffects as unknown[]).map(String) : [],
    skipped,
  };
}

/**
 * Convert place_graphic values for a .mogrt into the bridge's typed list.
 * Colours → [r,g,b,a] 0..255; points in template pixels → normalised [0..1]
 * (Premiere's MOGRT point params are fractions of the frame); numbers clamped.
 */
export function mogrtBridgeParams(
  schema: TemplateParam[],
  values: Record<string, unknown>,
  frame?: { width?: number; height?: number },
): { params: { name: string; type: string; value: unknown }[]; unknown: string[] } {
  const out: { name: string; type: string; value: unknown }[] = [];
  const unknown: string[] = [];
  for (const [key, raw] of Object.entries(values)) {
    const p = schema.find((x) => x.id === key) ?? schema.find((x) => x.name === key) ?? schema.find((x) => x.name.toLowerCase() === key.toLowerCase());
    if (!p || p.type === "group" || p.type === "image") {
      unknown.push(key);
      continue;
    }
    let value: unknown = raw;
    if (p.type === "color") {
      const rgba = typeof raw === "string" ? hexToRgba255(raw) : Array.isArray(raw) ? (raw.map(Number) as number[]) : undefined;
      if (!rgba) throw new Error(`${p.name}: colour must be "#RRGGBB" (got ${JSON.stringify(raw)})`);
      value = rgba.length === 3 ? [...rgba, 255] : rgba;
    } else if (p.type === "point") {
      const pt = Array.isArray(raw) ? raw.map(Number) : raw && typeof raw === "object" ? [Number((raw as { x: number }).x), Number((raw as { y: number }).y)] : null;
      if (!pt || pt.length < 2 || pt.some((n) => !Number.isFinite(n))) throw new Error(`${p.name}: point must be [x, y]`);
      // Values > 1.5 are template pixels; convert to fractions of the template frame.
      const w = frame?.width ?? 1920;
      const h = frame?.height ?? 1080;
      value = pt[0]! > 1.5 || pt[1]! > 1.5 ? [r4(pt[0]! / w), r4(pt[1]! / h)] : [pt[0], pt[1]];
    } else if (p.type === "slider" || p.type === "angle" || p.type === "number") {
      let n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${p.name}: number expected`);
      if (typeof p.min === "number") n = Math.max(p.min, n);
      if (typeof p.max === "number") n = Math.min(p.max, n);
      value = n;
    } else if (p.type === "checkbox") value = raw === true || raw === "true" || raw === 1;
    else if (p.type === "dropdown") {
      const idx = typeof raw === "number" ? raw : p.options ? p.options.findIndex((o) => o.toLowerCase() === String(raw).toLowerCase()) : Number(raw);
      if (!(idx >= 0)) throw new Error(`${p.name}: option must be one of ${(p.options ?? []).join(", ")}`);
      value = idx;
    } else value = String(raw ?? "");
    out.push({ name: p.name, type: p.type, value });
  }
  return { params: out, unknown };
}
