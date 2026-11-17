// MCP tools for OpenEdit Studio: open the live view, and get the injectable overlay snippet.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureStudio, openInBrowser, overlaySnippet } from "./index.js";

const OVERLAY_API = `Overlay API (after injection, on the page): window.OpenEditOverlay.point(selectorOrElement, label?) glides the Claude cursor to an element; .working(title, detail?) / .progress(fraction|null, detail?) / .done(summary?) drive the glow border and status pill by hand; .hide() removes it. It also follows the live OpenEdit event stream on its own.`;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function registerStudioTools(server: McpServer): void {
  server.registerTool(
    "open_studio",
    {
      description:
        "Open OpenEdit Studio, a live visual view of what you are doing with OpenEdit (glowing border while working, an animated cursor gliding to the clip/caption/file being edited, the cut-plan timeline, captions, zooms, placed clips, and downloaded media with license badges). Returns the URL (http://127.0.0.1:47822/ by default) and opens it in the default browser. " +
        "To show the same overlay (glow border + cursor + status pill) on ANY web page you are driving with Claude in Chrome, run the snippet from studio_overlay_snippet with javascript_tool.",
      inputSchema: { open: z.boolean().optional().describe("Open in the default browser (default true)") },
    },
    async ({ open }) => {
      const s = await ensureStudio();
      if (!s) return { ...text("OpenEdit Studio could not start (see server stderr)."), isError: true };
      const opened = open === false ? false : openInBrowser(s.url);
      return text(
        `OpenEdit Studio: ${s.url}${opened ? " (opened in your browser)" : ""}\n` +
          `Overlay for any page (inject with Claude in Chrome's javascript_tool):\n${overlaySnippet(s.url)}`,
      );
    },
  );

  server.registerTool(
    "studio_overlay_snippet",
    {
      description:
        "Return a one-line JavaScript snippet that injects the OpenEdit Studio overlay (animated glowing viewport border while working, a gliding Claude cursor, and a status pill with progress) into any web page. Use it with Claude in Chrome: pass the snippet to javascript_tool on the tab you are working in. " +
        OVERLAY_API,
      inputSchema: {},
    },
    async () => {
      const s = await ensureStudio();
      if (!s) return { ...text("OpenEdit Studio could not start (see server stderr)."), isError: true };
      return text(
        `${overlaySnippet(s.url)}\n\n${OVERLAY_API}\nIf the page's Content-Security-Policy blocks the script, the overlay cannot load there; use ${s.url} instead.`,
      );
    },
  );
}
