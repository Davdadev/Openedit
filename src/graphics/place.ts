/**
 * place_graphic: put a catalog template on the timeline of the active host.
 *   Premiere + .mogrt          → native MOGRT (importMGT, Essential Graphics params set).
 *   own / user templates        → rendered to alpha video (ProRes 4444 .mov) with HyperFrames,
 *                                 then placed on an upper video track (any host).
 *   Resolve + editable:true     → native Fusion Text+ title (editable in the Inspector), plus a
 *                                 .setting file for reuse.
 *   .mogrt elsewhere / .aep / locked demo → explained, with the closest usable templates.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join, resolve } from "node:path";
import type { EditorHost, HostName } from "../hosts/types.js";
import { loadMotion } from "../motion-loader.js";
import { buildFusionTitle, fusionFromParams } from "./fusion.js";
import { graphicsPaths, materialize, searchCatalog } from "./library.js";
import { mogrtBridgeParams, slug } from "./mogrt.js";
import type { CatalogItem, GraphicsApp } from "./types.js";

export interface PlaceOptions {
  at: number;
  duration?: number;
  params?: Record<string, unknown>;
  track?: number;
  output?: string;
  width?: number;
  height?: number;
  fps?: number;
  editable?: boolean;
}

export interface PlaceResult {
  host: HostName;
  method: "mogrt" | "rendered-overlay" | "fusion-title";
  text: string;
  output?: string;
  settingPath?: string;
  details?: Record<string, unknown>;
}

const appFor = (h: HostName): GraphicsApp => h;

/** Usable templates for this host that resemble `it` (category/name words). */
export function alternatives(it: CatalogItem, host: HostName, n = 3): CatalogItem[] {
  const words = new Set(`${it.category} ${it.name} ${it.description ?? ""}`.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3));
  const hints: Record<string, string[]> = { title: ["title", "titles"], lower: ["lower", "third", "name"], kinetic: ["title", "kinetic"], minimal: ["title", "lower"], typography: ["title", "quote"] };
  for (const w of [...words]) for (const h of hints[w] ?? []) words.add(h);
  return searchCatalog({ usable: true, app: appFor(host) })
    .filter((c) => c.kind === "hyperframes" || c.kind === "user")
    .map((c) => ({ c, score: `${c.category} ${c.name} ${c.id} ${c.description ?? ""}`.toLowerCase().split(/[^a-z]+/).filter((w) => words.has(w)).length + (c.kind === "user" ? 0.5 : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.c);
}

function unusable(it: CatalogItem, host: HostName): Error {
  const alts = alternatives(it, host);
  const alt = alts.length ? `\nClosest usable templates here: ${alts.map((a) => `${a.id} (${a.category})`).join(", ")}.` : "";
  if (it.kind === "mogrt") {
    return new Error(
      `${it.id} is a Premiere MOGRT; ${host} cannot render it (MOGRTs need Premiere's renderer). ` +
        `Use one of OpenEdit's templates, or recreate the look as your own with create_motion_template (preview_template shows its frames as reference; do not copy it 1:1).${alt}`,
    );
  }
  if (it.kind === "aep") return new Error(`${it.id} is an After Effects project: it needs After Effects to render. Use it as a style reference only.${alt}`);
  if (it.locked) return new Error(`${it.id} is a locked demo placeholder of a commercial pack (full version only).${alt}`);
  return new Error(`${it.id} is not usable: ${it.note ?? "unknown reason"}${alt}`);
}

async function timelineFrame(host: EditorHost): Promise<{ width?: number; height?: number; fps?: number }> {
  try {
    const tl = await host.getTimeline();
    return { width: tl.width, height: tl.height, fps: tl.fps };
  } catch {
    return {};
  }
}

/** Copy local image params into the template's assets so the composition can load them. */
function stageImageParams(it: CatalogItem, params: Record<string, unknown>): Record<string, unknown> {
  if (!it.dir) return params;
  const out = { ...params };
  for (const p of it.params) {
    if (p.type !== "image") continue;
    const v = out[p.id];
    if (typeof v !== "string" || !v || v.startsWith("assets/")) continue;
    const src = resolve(v.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
    if (!existsSync(src)) throw new Error(`${p.id}: image not found: ${v}`);
    const dir = join(it.dir, "assets", "params");
    mkdirSync(dir, { recursive: true });
    const name = `${createHash("sha1").update(src).digest("hex").slice(0, 12)}${extname(src).toLowerCase()}`;
    copyFileSync(src, join(dir, name));
    out[p.id] = `assets/params/${name}`;
  }
  return out;
}

export async function renderGraphic(
  it: CatalogItem,
  o: { params?: Record<string, unknown>; output?: string; width?: number; height?: number; fps?: number; duration?: number },
): Promise<string> {
  if (it.kind !== "hyperframes" && it.kind !== "user") throw new Error(`${it.id} cannot be rendered by OpenEdit (${it.kind}).`);
  const motion = await loadMotion();
  const output = o.output
    ? resolve(o.output.replace(/^~(?=\/)/, process.env.HOME ?? "~"))
    : join(graphicsPaths.renders(), `${slug(it.id)}-${Date.now()}.mov`);
  const params = stageImageParams(it, o.params ?? {});
  const r = await motion.renderTemplate({
    template: it.id,
    dir: it.kind === "user" ? it.dir : undefined,
    params,
    output,
    width: o.width,
    height: o.height,
    fps: o.fps,
    duration: o.duration,
  });
  return r.output;
}

export async function placeGraphic(it: CatalogItem, host: EditorHost, o: PlaceOptions): Promise<PlaceResult> {
  if (!it.usable) throw unusable(it, host.name);
  const params = o.params ?? {};

  if (it.kind === "mogrt") {
    if (host.name !== "premiere") throw unusable(it, host.name);
    const { params: list, unknown } = mogrtBridgeParams(it.params, params, { width: it.width, height: it.height });
    if (unknown.length) throw new Error(`Unknown field(s) for ${it.id}: ${unknown.join(", ")}. Fields: ${it.params.map((p) => `${p.id} ("${p.name}", ${p.type})`).join(", ")}`);
    const path = materialize(it.source!);
    const prem = host as EditorHost & { applyMogrt?: (a: Record<string, unknown>) => Promise<Record<string, unknown>>; rpc?: (c: string, a: Record<string, unknown>) => Promise<unknown> };
    const args = { path, at: o.at, duration: o.duration, track: o.track ?? 2, params: list };
    const res = (prem.applyMogrt ? await prem.applyMogrt(args) : ((await prem.rpc!("applyMogrt", args)) as Record<string, unknown>)) as {
      track: number;
      set: number;
      missing: string[];
      errors: string[];
      duration?: number;
    };
    const warn = [
      ...(res.missing?.length ? [`not found in the MOGRT: ${res.missing.join(", ")}`] : []),
      ...(res.errors ?? []),
      ...(it.missingFonts?.length ? [`fonts missing on this machine: ${it.missingFonts.join(", ")} (Premiere substitutes them)`] : []),
    ];
    return {
      host: host.name,
      method: "mogrt",
      text:
        `Placed MOGRT ${it.name} on V${res.track} at ${o.at.toFixed(2)}s in Premiere (${res.set}/${list.length} fields set${res.duration ? `, ${res.duration}s` : ""}). ` +
        `It stays editable in Essential Graphics.${warn.length ? `\nWarnings: ${warn.join("; ")}` : ""}`,
      details: res as unknown as Record<string, unknown>,
    };
  }

  const frame = await timelineFrame(host);
  const sa = host as EditorHost & { outputSize?: (a?: unknown) => { width: number; height: number } | undefined };
  const out = sa.outputSize?.() ?? undefined;
  const width = o.width ?? out?.width ?? frame.width;
  const height = o.height ?? out?.height ?? frame.height;
  const fps = o.fps ?? frame.fps;
  const duration = o.duration ?? it.duration;

  if (o.editable && host.name === "resolve") {
    const defaults = Object.fromEntries(it.params.filter((p) => p.default !== undefined).map((p) => [p.id, p.default]));
    const kind = /lower|third|name/i.test(`${it.id} ${it.category}`) ? "lower-third" : "title";
    const opts = fusionFromParams(params, defaults, { kind, duration: duration ?? 5, fps: fps ?? 25, width, height });
    const { setting, spec } = buildFusionTitle(opts);
    const settingPath = join(graphicsPaths.renders(), `${slug(it.id)}-${Date.now()}.setting`);
    writeFileSync(settingPath, setting);
    const rh = host as EditorHost & { rpc: (c: string, a: Record<string, unknown>) => Promise<Record<string, unknown>> };
    const res = (await rh.rpc("addFusionTitle", { at: o.at, track: o.track ?? 2, duration, spec, settingPath })) as { timecode?: string; notes?: string[]; duration?: number };
    return {
      host: host.name,
      method: "fusion-title",
      settingPath,
      text:
        `Inserted an editable Fusion Text+ title (${opts.lines.join(" / ")}) at ${o.at.toFixed(2)}s${res.timecode ? ` (${res.timecode})` : ""} on V${o.track ?? 2} in Resolve. ` +
        `Edit it in the Inspector or the Fusion page. Reusable macro: ${settingPath}` +
        (res.notes?.length ? `\nNotes: ${res.notes.join("; ")}` : "") +
        `\nNote: the Fusion version is a simplified Text+ title (fade/write-on); use the rendered overlay (editable:false) for the full HyperFrames motion.`,
      details: res,
    };
  }

  const output = await renderGraphic(it, { params, output: o.output, width, height, fps, duration });
  const track = o.track ?? 3;
  await host.placeClips([{ path: output, at: o.at, track }]);
  if (it.kind === "hyperframes") {
    const reg = host as EditorHost & { registerMotionRender?: (p: string, s: Record<string, unknown>) => void };
    reg.registerMotionRender?.(output, { template: it.id, params, width, height, fps, duration });
  }
  return {
    host: host.name,
    method: "rendered-overlay",
    output,
    text:
      `Rendered ${it.name} (${width ?? "default"}x${height ?? ""}, alpha ProRes 4444) to ${output} and placed it on V${track} at ${o.at.toFixed(2)}s in ${host.name}.` +
      (host.name === "resolve" && /title|lower|third/i.test(`${it.category} ${it.id}`) ? " For a title editable inside Resolve, call again with editable: true (Fusion Text+)." : ""),
  };
}
