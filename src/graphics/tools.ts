/**
 * MCP tools for motion graphics: template packs, the graphics catalog (with contact-sheet
 * images so Claude sees the styles), previews, Figma → motion templates, and placement in
 * Premiere (native MOGRT), Resolve (alpha overlay or editable Fusion title) and standalone.
 */
import { existsSync, readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { activeHost } from "../hosts/index.js";
import { loadMotion } from "../motion-loader.js";
import { uiMeta } from "../ui/resources.js";
import { createMotionTemplate, type FieldSpec } from "./create.js";
import { convertFigmaCode } from "./figma-code.js";
import { contactSheet } from "./images.js";
import { allTemplates, getTemplate, importTemplatePack, loadLibrary, searchCatalog, setTemplatesRoot, summarize } from "./library.js";
import { placeGraphic } from "./place.js";
import { presetDocs, PRESETS } from "./presets.js";
import { previewTemplate } from "./preview.js";
import type { CatalogItem, GraphicsApp } from "./types.js";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean; structuredContent?: Record<string, unknown> };

export const GRAPHICS_INSTRUCTIONS = `Motion graphics: graphics_catalog shows every template (the user's packs, OpenEdit's own, the user's Figma-made ones) with a contact sheet — LOOK at it before choosing. preview_template {id} shows frames + editable fields; place_graphic {id, at, params} places it (Premiere: native MOGRT; Resolve/standalone: alpha overlay, or editable:true for a Fusion title in Resolve). For custom/brand graphics from Figma: get_design_context (Figma MCP) → create_motion_template {figmaCode, motion} → preview → place. Packs from marketplaces are licensed to the user only: never copy or redistribute them. See the openedit-motion-design skill.`;

const safeBase =
  <A>(fn: (a: A) => Promise<ToolResult>) =>
  async (a: A): Promise<ToolResult> => {
    try {
      return await fn(a);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  };

const BADGE: Record<string, string> = { mogrt: "MOGRT", aep: "AE", demo: "LOCKED", hyperframes: "OPENEDIT", user: "MINE" };

function sheetTiles(items: CatalogItem[]) {
  return items.map((it) => ({ image: it.thumb && existsSync(it.thumb) ? it.thumb : undefined, label: it.name, badge: BADGE[it.kind], dim: !it.usable }));
}

function dataUri(path?: string): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const buf = readFileSync(path);
    if (buf.length > 400_000) return undefined;
    return `data:image/${path.endsWith(".png") ? "png" : "jpeg"};base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

/** structuredContent for the inline graphics view. */
export function graphicsViewItem(it: CatalogItem) {
  return {
    id: it.id,
    name: it.name,
    kind: it.kind,
    category: it.category,
    pack: it.packName,
    usable: it.usable,
    locked: !!it.locked,
    note: it.note,
    apps: it.apps,
    duration: it.duration,
    width: it.width,
    height: it.height,
    thumb: dataUri(it.thumb),
    params: it.params.slice(0, 24),
    missingFonts: it.missingFonts ?? [],
    description: it.description,
  };
}

// Own/user templates without a cached thumbnail: render them in the background (one at a time).
let warming: Promise<void> | null = null;
function warmThumbs(items: CatalogItem[]): number {
  const todo = items.filter((i) => (i.kind === "hyperframes" || i.kind === "user") && !i.thumb);
  if (!todo.length || warming || process.env.OPENEDIT_GRAPHICS_NO_WARM) return todo.length;
  warming = (async () => {
    for (const it of todo.slice(0, 12)) {
      try {
        await previewTemplate(it, { count: 3 });
      } catch {
        /* HyperFrames missing or failing: keep the placeholder */
      }
    }
  })().finally(() => {
    warming = null;
  });
  return todo.length;
}

function hostApp(name: string): GraphicsApp {
  return name as GraphicsApp;
}

const fieldSchema = z.object({
  id: z.string().describe("Param name: letters/digits/underscore (used as {{id}} in the markup and in place_graphic params)"),
  type: z.enum(["text", "color", "number", "image", "checkbox", "dropdown"]).optional(),
  label: z.string().optional(),
  default: z.unknown().optional(),
  selector: z.string().optional().describe('CSS selector of the bound element(s), e.g. [data-name="#title"] or .name; ":root" for a CSS variable'),
  text: z.boolean().optional().describe("Bind to the text content"),
  attr: z.string().optional().describe('Bind to an attribute, e.g. "fill" on an SVG shape'),
  style: z.string().optional().describe('Bind to a CSS property or variable, e.g. "background-color" or "--accent"'),
  options: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

const motionSchema = z
  .object({
    selector: z.string().describe('CSS selector, e.g. [data-name="plate"] (Figma layer names become data-name)'),
    preset: z.string().optional().describe(`One of: ${Object.keys(PRESETS).join(", ")}`),
    delay: z.number().min(0).optional().describe("Seconds from the start"),
    duration: z.number().min(0).optional(),
    easing: z.string().optional().describe("outExpo (default for most), outQuart, outBack, spring, inOutQuart, cubic-bezier(x1,y1,x2,y2)…"),
    stagger: z.union([z.number(), z.object({ each: z.number().optional(), from: z.enum(["start", "end", "center", "random"]).optional(), seed: z.number().optional() })]).optional(),
    split: z.enum(["chars", "words", "lines"]).optional().describe("Kinetic type: animate each char/word/line"),
    exit: z.boolean().optional().describe("Play the preset out (default: entrances are mirrored out automatically at the end)"),
    keyframes: z.array(z.record(z.string(), z.unknown())).optional().describe("Instead of a preset: [{t, x, y, scale, rotate, opacity, blur, easing}] (t in seconds from delay; x/y px)"),
  })
  .passthrough();

export function registerGraphicsTools(server: McpServer): void {
  // Own templates come from the motion module (lazy: graphics never hard-fails without it).
  const ready = loadMotion()
    .then((m) => {
      if (m.templatesDir) setTemplatesRoot(m.templatesDir);
    })
    .catch(() => {});
  const safe =
    <A>(fn: (a: A) => Promise<ToolResult>) =>
    async (a: A): Promise<ToolResult> => {
      await ready;
      return safeBase(fn)(a);
    };

  server.registerTool(
    "import_template_pack",
    {
      description:
        "Index a motion-graphics template pack the user owns so it appears in graphics_catalog: a Motion Bro .mbr, a .zip, a folder (Motion Bro layout or any folder of .mogrt/.aep), or a single .mogrt/.aep. " +
        "Files stay where they are (only paths and small thumbnails are stored). .mogrt → usable in Premiere (fields parsed from Essential Graphics); .aep → After Effects only (style reference); locked .demo placeholders are listed but not usable. Warns about fonts not installed. Packs are licensed to the user: never copy or redistribute them.",
      inputSchema: {
        path: z.string().describe("Path to the .mbr/.zip/.mogrt/.aep or folder"),
        id: z.string().optional().describe("Short pack id (default from the pack name)"),
        name: z.string().optional(),
      },
      _meta: uiMeta("graphics"),
    },
    safe(async ({ path, id, name }) => {
      const r = await importTemplatePack(path, { id, name });
      const usable = r.items.filter((i) => i.usable);
      const show = [...usable, ...r.items.filter((i) => !i.usable)].slice(0, 24);
      const content: Content[] = [];
      if (show.length) content.push({ type: "image", data: (await contactSheet(sheetTiles(show))).toString("base64"), mimeType: "image/jpeg" });
      const cats = [...new Set(r.items.map((i) => i.category))];
      content.push({
        type: "text",
        text:
          `Imported pack "${r.pack.name}" (id ${r.pack.id}, ${r.pack.type}): ${r.items.length} items — ${r.pack.counts.mogrt ?? 0} .mogrt (usable in Premiere), ${r.pack.counts.aep ?? 0} .aep (After Effects only), ${r.pack.counts.demo ?? 0} locked demos.\n` +
          `Categories: ${cats.join(", ")}\n` +
          (r.warnings.length ? `Warnings:\n${r.warnings.slice(0, 15).map((w) => `- ${w}`).join("\n")}${r.warnings.length > 15 ? `\n… ${r.warnings.length - 15} more` : ""}\n` : "") +
          `\nContact sheet (numbered):\n${show.map((it, i) => summarize(it, i + 1)).join("\n")}`,
      });
      return { content, structuredContent: { view: "graphics", mode: "imported", pack: r.pack, items: show.map(graphicsViewItem), total: r.items.length } };
    }),
  );

  server.registerTool(
    "graphics_catalog",
    {
      description:
        "List motion-graphics templates — the user's imported packs, OpenEdit's own (HyperFrames) and the user's own (create_motion_template / Figma) — with a numbered CONTACT SHEET image of their previews so you can see each style. " +
        "Filter by query (words in name/category/description/fields), category, app (premiere | resolve | standalone — what can be placed there) and usable. Then preview_template {id} and place_graphic.",
      inputSchema: {
        query: z.string().optional(),
        category: z.string().optional(),
        app: z.enum(["premiere", "resolve", "standalone", "aftereffects"]).optional().describe("Only templates placeable in this host (default: all)"),
        usable: z.boolean().optional(),
        pack: z.string().optional(),
        kind: z.enum(["mogrt", "aep", "demo", "hyperframes", "user"]).optional(),
        limit: z.number().int().min(1).max(60).optional().describe("Default 24"),
        offset: z.number().int().min(0).optional(),
      },
      _meta: uiMeta("graphics"),
    },
    safe(async (a) => {
      const all = searchCatalog({ query: a.query, category: a.category, app: a.app as GraphicsApp | undefined, usable: a.usable, pack: a.pack, kind: a.kind });
      // Usable first, then by pack order.
      const sorted = [...all.filter((i) => i.usable), ...all.filter((i) => !i.usable)];
      const offset = a.offset ?? 0;
      const items = sorted.slice(offset, offset + (a.limit ?? 24));
      const warmingN = warmThumbs(allTemplates());
      const content: Content[] = [];
      if (items.length) content.push({ type: "image", data: (await contactSheet(sheetTiles(items))).toString("base64"), mimeType: "image/jpeg" });
      const lib = loadLibrary();
      let host = "";
      try {
        host = (await activeHost()).name;
      } catch {
        host = "";
      }
      const packs = lib.packs.map((p) => `${p.id} (${p.counts.items} items, ${p.counts.usable} usable)`).join(", ") || "none imported (import_template_pack {path})";
      content.push({
        type: "text",
        text:
          `${all.length} templates match (showing ${offset + 1}–${offset + items.length}). Active host: ${host || "unknown"}. Packs: ${packs}.\n` +
          (warmingN ? `(${warmingN} OpenEdit/user templates have no thumbnail yet: rendering them in the background; preview_template shows them now.)\n` : "") +
          `Contact sheet tiles are numbered like this list; badges: MOGRT (Premiere), AE (After Effects only), LOCKED (demo), OPENEDIT/MINE (render anywhere).\n\n` +
          items.map((it, i) => summarize(it, offset + i + 1)).join("\n"),
      });
      return {
        content,
        structuredContent: { view: "graphics", mode: "catalog", host, items: items.map(graphicsViewItem), total: all.length, offset, query: a.query ?? "", app: a.app ?? (host ? hostApp(host) : undefined) },
      };
    }),
  );

  server.registerTool(
    "preview_template",
    {
      description:
        "Show a template: a strip of frames across its animation (entrance, settled, hold, exit) plus its editable fields (id, type, default, range) and notes (fonts, host support). " +
        "For OpenEdit/user templates the frames are rendered with your params (try values before placing).",
      inputSchema: {
        id: z.string(),
        params: z.record(z.string(), z.unknown()).optional().describe("OpenEdit/user templates: field values to preview"),
        count: z.number().int().min(1).max(8).optional().describe("Frames (default 4)"),
      },
      _meta: uiMeta("graphics"),
    },
    safe(async ({ id, params, count }) => {
      const it = getTemplate(id);
      const p = await previewTemplate(it, { params, count });
      const fields = it.params
        .map((f) => `- ${f.id}${f.name !== f.id ? ` ("${f.name}")` : ""}: ${f.type}${f.default !== undefined ? ` = ${JSON.stringify(f.default)}` : ""}${f.min !== undefined || f.max !== undefined ? ` [${f.min ?? ""}..${f.max ?? ""}]` : ""}${f.options ? ` options ${f.options.join("|")}` : ""}${f.group ? ` (group ${f.group})` : ""}${f.font ? ` font ${f.font}` : ""}`)
        .join("\n");
      return {
        content: [
          { type: "image", data: p.strip.toString("base64"), mimeType: "image/jpeg" },
          {
            type: "text",
            text:
              `${summarize(it)}\n${it.description ?? ""}\n${it.note ?? ""}\nFrames (${p.source}): ${p.frames.map((f) => `${f.time}s`).join(", ")} — ${p.stripPath}\n\nFields:\n${fields || "(none)"}` +
              (it.usable ? `\n\nPlace with place_graphic {id: "${it.id}", at, params: {…}}` : ""),
          },
        ],
        structuredContent: {
          view: "graphics",
          mode: "preview",
          items: [graphicsViewItem(it)],
          preview: { id: it.id, strip: `data:image/jpeg;base64,${p.strip.toString("base64")}`, times: p.frames.map((f) => f.time) },
        },
      };
    }),
  );

  server.registerTool(
    "create_motion_template",
    {
      description:
        "Create a reusable, editable motion-graphics template from a design — usually a Figma frame: pass figmaCode = the React+Tailwind code from Figma's get_design_context (converted to HTML+inline CSS; layers named #title / #color:accent / #image:logo become fields, Figma variables var(--x,#hex) become colour fields), " +
        "or html/svg/css you write. Add `motion` = presets per layer (selectors like [data-name=\"plate\"] from Figma layer names): " +
        "entrances mask-up, rise, wipe-right, grow-x, tracking-in, line-draw, count-up, type… with professional easing; exits are mirrored automatically (faster, ease-in). " +
        "Validated and sanitised (no scripts, no remote assets: pass local files in assets; Google Fonts are downloaded into the template). Renders a preview strip (LOOK at it and iterate) and registers the template in graphics_catalog for place_graphic in any host.\n\n" +
        presetDocs(),
      inputSchema: {
        name: z.string(),
        id: z.string().optional(),
        figmaCode: z.string().optional().describe("Raw get_design_context output (React + Tailwind)"),
        html: z.string().optional(),
        svg: z.string().optional(),
        css: z.string().optional(),
        assets: z.array(z.object({ path: z.string(), name: z.string().optional() })).optional().describe("Local files (images, SVG, fonts) copied into the template; reference as assets/<name>"),
        fields: z.array(fieldSchema).optional().describe("Editable fields (merged over those detected from Figma layer names)"),
        motion: z.array(motionSchema).optional(),
        autoExit: z.boolean().optional().describe("Mirror entrances out at the end (default true)"),
        exitDuration: z.number().positive().optional(),
        duration: z.number().positive().max(120).optional().describe("Seconds (default 5)"),
        width: z.number().int().positive().optional().describe("Design width in px (default: the Figma frame, else 1920)"),
        height: z.number().int().positive().optional(),
        fps: z.number().positive().optional(),
        background: z.string().optional().describe('"transparent" (default, overlay) or a colour (full-frame card)'),
        category: z.string().optional().describe("Lower thirds, Titles, Callouts, Stats, Social…"),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        source: z.string().optional().describe('Provenance, e.g. "figma:<fileKey>:<nodeId>"'),
        preview: z.boolean().optional().describe("Render the preview strip (default true)"),
      },
      _meta: uiMeta("graphics"),
    },
    safe(async (a) => {
      let html = a.html ?? "";
      let fields: FieldSpec[] = (a.fields as FieldSpec[] | undefined) ?? [];
      let width = a.width;
      let height = a.height;
      const notes: string[] = [];
      let layers: string[] = [];
      if (a.figmaCode) {
        const c = convertFigmaCode(a.figmaCode);
        html = `${c.html}\n${html}`;
        const given = new Set(fields.map((f) => f.id));
        fields = [...c.fields.filter((f) => !given.has(f.id)), ...fields];
        width ??= c.width;
        height ??= c.height;
        notes.push(...c.warnings);
        if (c.assets.length) notes.push(`Figma assets referenced: ${c.assets.map((x) => `${x.file} <- ${x.url}`).join(", ")}`);
        layers = [...new Set([...c.html.matchAll(/data-name="([^"]+)"/g)].map((m) => m[1]!))];
      }
      const r = await createMotionTemplate({ ...a, html, fields, width, height, motion: a.motion as never });
      const content: Content[] = [];
      let strip: string | undefined;
      if (a.preview !== false) {
        try {
          const p = await previewTemplate(getTemplate(r.id), {});
          content.push({ type: "image", data: p.strip.toString("base64"), mimeType: "image/jpeg" });
          strip = `data:image/jpeg;base64,${p.strip.toString("base64")}`;
        } catch (e) {
          notes.push(`preview failed: ${(e as Error).message.split("\n")[0]}`);
        }
      }
      content.push({
        type: "text",
        text:
          `Created template ${r.id} in ${r.dir}\nFields: ${r.fields.map((f) => `${f.id} (${f.type}${f.default !== undefined ? ` = ${JSON.stringify(f.default)}` : ""})`).join(", ") || "none"}\n` +
          (layers.length ? `Layer selectors: ${layers.map((l) => `[data-name="${l}"]`).join(" ")}\n` : "") +
          (r.fonts.length ? `Fonts: ${r.fonts.join(", ")}${r.missingFonts.length ? ` (NOT INSTALLED: ${r.missingFonts.join(", ")})` : ""}\n` : "") +
          ([...r.warnings, ...notes].length ? `Notes:\n${[...r.warnings, ...notes].map((w) => `- ${w}`).join("\n")}\n` : "") +
          `\nLook at the preview: entrance (frame 1), settled (2–3), exit (4). Fix spacing/legibility/timing and call again with the same name (it is overwritten), then place_graphic {id: "${r.id}", at, params}.`,
      });
      return { content, structuredContent: { view: "graphics", mode: "created", items: [graphicsViewItem(getTemplate(r.id))], ...(strip ? { preview: { id: r.id, strip } } : {}) } };
    }),
  );

  server.registerTool(
    "place_graphic",
    {
      description:
        "Place a graphics template on the timeline at `at` (edited-timeline seconds) with field values. Premiere + .mogrt: native MOGRT (editable in Essential Graphics). " +
        "OpenEdit/user templates: rendered to an alpha .mov sized to the timeline and placed on V3 (any host). Resolve: editable:true inserts a native Fusion Text+ title instead (simple fade/write-on) and writes a reusable .setting. " +
        "A .mogrt cannot be used outside Premiere; you get the closest usable templates instead.",
      inputSchema: {
        id: z.string().describe("Template id from graphics_catalog"),
        at: z.number().min(0).describe("Edited-timeline seconds"),
        duration: z.number().positive().optional(),
        params: z.record(z.string(), z.unknown()).optional().describe("Field id (or display name) → value; colours as #RRGGBB, points as [x,y]"),
        track: z.number().int().min(1).optional().describe("Video track (default 2 for MOGRTs/Fusion titles, 3 for overlays)"),
        output: z.string().optional().describe("Overlay file path (default ~/.openedit/graphics/renders/…)"),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        fps: z.number().positive().optional(),
        editable: z.boolean().optional().describe("Resolve: insert an editable Fusion Text+ title instead of a rendered overlay"),
      },
      _meta: uiMeta("graphics"),
    },
    safe(async (a) => {
      const it = getTemplate(a.id);
      const host = await activeHost();
      const r = await placeGraphic(it, host, { at: a.at, duration: a.duration, params: a.params, track: a.track, output: a.output, width: a.width, height: a.height, fps: a.fps, editable: a.editable });
      return {
        content: [{ type: "text", text: r.text }],
        structuredContent: { view: "graphics", mode: "placed", host: r.host, items: [graphicsViewItem(it)], placed: { method: r.method, output: r.output, settingPath: r.settingPath, at: a.at, text: r.text } },
      };
    }),
  );
}
