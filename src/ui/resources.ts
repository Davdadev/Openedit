// MCP Apps (SEP-1865, spec 2026-01-26): inline HTML views rendered by hosts such as
// Claude.ai / Claude Desktop next to tool results. Tools link a view with
// `_meta.ui.resourceUri`; the view receives the tool input/result over postMessage
// (JSON-RPC) and renders `structuredContent`. Hosts without MCP Apps support (e.g. the
// Claude Code CLI) ignore the metadata and show the tool's text content as before.
//
// Views are hand-written, self-contained HTML files in src/ui/views/ (no bundler). The
// shared stylesheet and host bridge are inlined at read time, so each served document is
// a single file with no external scripts or styles.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY, registerAppResource } from "@modelcontextprotocol/ext-apps/server";

export { RESOURCE_MIME_TYPE };

export const UI_VIEWS = ["cut-plan", "transcript", "media", "render", "status", "graphics"] as const;
export type UiView = (typeof UI_VIEWS)[number];

export const VIEW_TITLES: Record<UiView, string> = {
  "cut-plan": "OpenEdit cut plan",
  transcript: "OpenEdit transcript",
  media: "OpenEdit stock media",
  render: "OpenEdit render",
  status: "OpenEdit editor status",
  graphics: "OpenEdit motion graphics",
};

/** Which tools render with which view. */
export const TOOL_VIEWS: Record<string, UiView> = {
  plan_cuts: "cut-plan",
  show_plan: "cut-plan",
  apply_cuts: "cut-plan",
  revise_plan: "cut-plan",
  transcribe: "transcript",
  find_media: "media",
  get_media: "media",
  download_media: "media",
  render: "render",
  render_motion: "render",
  render_caption_overlay: "render",
  editor_status: "status",
  select_host: "status",
  graphics_catalog: "graphics",
  preview_template: "graphics",
  create_motion_template: "graphics",
  place_graphic: "graphics",
  import_template_pack: "graphics",
};

export const uiUri = (view: UiView) => `ui://openedit/${view}.html`;

/**
 * Thumbnail / audio-preview origins of the stock media providers (CSP resourceDomains ->
 * img-src/media-src). Without these the host's default CSP blocks remote previews.
 */
export const MEDIA_RESOURCE_DOMAINS = [
  "https://images.pexels.com",
  "https://videos.pexels.com",
  "https://*.pexels.com",
  "https://cdn.pixabay.com",
  "https://*.pixabay.com",
  "https://i.vimeocdn.com",
  "https://images.unsplash.com",
  "https://plus.unsplash.com",
  "https://api.openverse.org",
  "https://*.openverse.org",
  "https://upload.wikimedia.org",
  "https://*.wikimedia.org",
  "https://images-assets.nasa.gov",
  "https://*.nasa.gov",
  "https://cdn.freesound.org",
  "https://*.freesound.org",
  "https://*.jamendo.com",
];

const CSP: Partial<Record<UiView, { resourceDomains?: string[] }>> = {
  media: { resourceDomains: MEDIA_RESOURCE_DOMAINS },
};

/** `_meta` for a tool rendered by `view` (new nested key + deprecated flat key for older hosts). */
export function uiMeta(view: UiView): { ui: { resourceUri: string }; [RESOURCE_URI_META_KEY]: string } {
  const uri = uiUri(view);
  return { ui: { resourceUri: uri }, [RESOURCE_URI_META_KEY]: uri };
}

/** `_meta` for a tool by name (undefined when the tool has no view). */
export function uiMetaFor(tool: string): ReturnType<typeof uiMeta> | undefined {
  const v = TOOL_VIEWS[tool];
  return v ? uiMeta(v) : undefined;
}

/** src/ui/views, both from src (tsx) and from dist (compiled). */
export function viewsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "views"), resolve(here, "..", "..", "src", "ui", "views")];
  return candidates.find((d) => existsSync(join(d, "shared.js"))) ?? candidates[0];
}

const cache = new Map<UiView, string>();

/** The complete, self-contained HTML document for a view. */
export function loadViewHtml(view: UiView): string {
  const hit = cache.get(view);
  if (hit && !process.env.OPENEDIT_UI_DEV) return hit;
  const root = viewsRoot();
  const read = (f: string) => readFileSync(join(root, f), "utf8");
  // Inline the shared CSS/JS. Function replacers so "$" in the sources is never special.
  const html = read(`${view}.html`)
    .replace("<!--#shared-css-->", () => `<style>\n${read("shared.css")}\n</style>`)
    .replace("<!--#shared-js-->", () => `<script>\n${read("shared.js")}\n</script>`);
  cache.set(view, html);
  return html;
}

export function resourceMeta(view: UiView): { ui: { prefersBorder: boolean; csp?: { resourceDomains?: string[] } } } {
  return { ui: { prefersBorder: false, ...(CSP[view] ? { csp: CSP[view] } : {}) } };
}

/** Register every ui:// view as an MCP resource (mimeType text/html;profile=mcp-app). */
export function registerUiResources(server: McpServer): void {
  for (const view of UI_VIEWS) {
    const uri = uiUri(view);
    registerAppResource(
      server,
      VIEW_TITLES[view],
      uri,
      { description: `Inline view for OpenEdit tool results (${view})`, _meta: resourceMeta(view) },
      async () => ({
        contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: loadViewHtml(view), _meta: resourceMeta(view) }],
      }),
    );
  }
}
