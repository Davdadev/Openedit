import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { creditsSummary, type DownloadOutcome, downloadResult, mediaRoot } from "./download.js";
import { getKey, keyStatus } from "./keys.js";
import { PROVIDER_IDS, PROVIDERS } from "./providers/index.js";
import { type FindOptions, type FindResponse, findMedia, lookupResult, type RankedResult } from "./search.js";
import { MEDIA_KINDS, type MediaKind } from "./types.js";
import { cardFromOutcome, cardFromResult, type MediaView, providerReports } from "../ui/data.js";
import { uiMeta } from "../ui/resources.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
/** Attach structuredContent for the inline media view (text stays for text-only hosts). */
const withView = (res: ToolResult, v: MediaView): ToolResult => ({ ...res, structuredContent: { ...v } });
const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
function safe<A>(fn: (a: A) => Promise<ToolResult>): (a: A) => Promise<ToolResult> {
  return async (a: A) => {
    try {
      return await fn(a);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  };
}

/** Appended to the MCP server instructions so Claude sources media on its own. */
export const MEDIA_INSTRUCTIONS = `Stock media: when an edit needs footage, b-roll, images, music or sound effects the user did not provide, call get_media yourself (e.g. get_media {query:"city at night", kind:"video"}) instead of asking the user where to find media. It searches free, commercially usable sources (Pexels, Pixabay, Unsplash, Openverse, Wikimedia Commons, NASA, Freesound, Jamendo), downloads the best match and records attribution in CREDITS.md. Use find_media + download_media when you want to compare options. Write short, visual queries (subject + setting + mood). Pass the downloaded path to import_media / place_clips. Before finishing, tell the user about any item whose attribution is required (media_credits).`;

const kindSchema = z.enum(MEDIA_KINDS as unknown as [MediaKind, ...MediaKind[]]).describe('"video" (b-roll/footage), "image", "music", "sfx" (sound effects) or "audio" (any audio)');
const searchShape = {
  query: z.string().min(1).describe('What to find, in plain words: subject + setting + mood, e.g. "aerial city at night", "whoosh transition", "upbeat lofi"'),
  kind: kindSchema,
  orientation: z.enum(["landscape", "portrait", "square"]).optional().describe("Visual orientation; use portrait for 9:16 edits"),
  minDuration: z.number().min(0).optional().describe("Seconds (video/audio)"),
  maxDuration: z.number().min(0).optional().describe("Seconds (video/audio)"),
  minWidth: z.number().int().min(1).optional().describe("Minimum pixel width, e.g. 1920 for 1080p, 3840 for 4K"),
  providers: z.array(z.enum(PROVIDER_IDS)).optional().describe("Limit to these sources (default: all that offer the kind)"),
  allowNonCommercial: z.boolean().optional().describe("Include CC NonCommercial/NoDerivatives media (default false; only for personal, non-monetized work)"),
};

let lastFind: FindResponse | undefined;

function fmtDur(d?: number): string {
  if (d === undefined) return "";
  return d >= 60 ? `${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, "0")}` : `${d.toFixed(1)}s`;
}

function providerLine(r: FindResponse): string {
  return r.providers.map((p) => `${p.provider}: ${p.status === "ok" || p.status === "cached" ? `${p.count}` : `${p.status}${p.detail ? ` (${p.detail})` : ""}`}`).join("; ");
}

function listing(r: FindResponse): string {
  if (!r.results.length) return `No ${r.kind} found for "${r.query}". Try a simpler or different query.\nSources: ${providerLine(r)}`;
  const lines = r.results.map((x: RankedResult, i) => {
    const dims = x.width && x.height ? ` ${x.width}x${x.height}` : "";
    const dur = x.duration !== undefined ? ` ${fmtDur(x.duration)}` : "";
    const by = x.author ? ` by ${x.author}` : "";
    return (
      `${i + 1}. [${x.gid}] ${x.title}${by} —${dims}${dur} · ${x.license}${x.attributionRequired ? " (attribution required)" : ""} · score ${x.score}\n` +
      `   ${x.reason}\n   page: ${x.url}${x.previewUrl ? `\n   preview: ${x.previewUrl}` : ""}`
    );
  });
  return `Found ${r.results.length} of ${r.considered} ${r.kind} candidates for "${r.query}":\n${lines.join("\n")}\nSources: ${providerLine(r)}\nDownload with download_media {ids:["${r.results[0].gid}"]}.`;
}

function outcomeText(o: DownloadOutcome): string {
  return `- ${o.path}${o.existing ? " (already in library)" : ""}\n  ${o.title}${o.author ? ` by ${o.author}` : ""} · ${o.license}${o.attributionRequired ? " · ATTRIBUTION REQUIRED" : ""}\n  credit: ${o.attributionText}`;
}

function toOptions(a: Record<string, unknown>, count: number): FindOptions {
  return {
    query: a.query as string,
    kind: a.kind as MediaKind,
    count,
    orientation: a.orientation as FindOptions["orientation"],
    minDuration: a.minDuration as number | undefined,
    maxDuration: a.maxDuration as number | undefined,
    minWidth: a.minWidth as number | undefined,
    providers: a.providers as FindOptions["providers"],
    allowNonCommercial: a.allowNonCommercial as boolean | undefined,
  };
}

/** Register the stock-media tools on an MCP server. */
export function registerMediaTools(server: McpServer): void {
  server.registerTool(
    "get_media",
    {
      title: "Get stock media (search + download)",
      description:
        "Use this whenever an edit needs footage, b-roll, images, music or sound effects the user didn't provide — do not ask the user where to find media. " +
        "Searches free, commercially usable stock sources in parallel, ranks by relevance, quality and license, downloads the best match(es) and records attribution in CREDITS.md. " +
        "Example: task needs 'a clip of a city at night' -> get_media({query:'city at night', kind:'video'}); background track -> get_media({query:'calm piano', kind:'music', minDuration:60}); " +
        "'whoosh' between scenes -> get_media({query:'whoosh', kind:'sfx', maxDuration:3}). Returns local file paths ready for import_media / place_clips.",
      inputSchema: {
        ...searchShape,
        count: z.number().int().min(1).max(10).optional().describe("How many different items to download (default 1)"),
        dir: z.string().optional().describe("Media library folder, e.g. the project folder (default ~/OpenEdit Media). Files go in <dir>/<kind>/"),
      },
      _meta: uiMeta("media"),
    },
    safe(async (a) => {
      const want = a.count ?? 1;
      const found = await findMedia(toOptions(a, Math.min(50, want + 4)));
      lastFind = found;
      if (!found.results.length) return { ...text(listing(found)), isError: true };
      const done: DownloadOutcome[] = [];
      const from: RankedResult[] = [];
      const errors: string[] = [];
      for (const r of found.results) {
        if (done.length >= want) break;
        try {
          done.push(await downloadResult(r, { dir: a.dir }));
          from.push(r);
        } catch (e) {
          errors.push(`${r.gid}: ${(e as Error).message}`);
        }
      }
      if (!done.length) return { ...text(`All downloads failed:\n${errors.join("\n")}`), isError: true };
      const view: MediaView = {
        view: "media",
        mode: "download",
        query: a.query,
        kind: a.kind,
        considered: found.considered,
        items: await Promise.all(done.map((o, i) => cardFromOutcome(o, from[i]))),
        providers: providerReports(found),
        creditsPath: `${mediaRoot(a.dir)}/CREDITS.md`,
        ...(errors.length ? { errors } : {}),
      };
      return withView(text(
        `Downloaded ${done.length} ${a.kind} item(s) for "${a.query}":\n${done.map(outcomeText).join("\n")}` +
          `${errors.length ? `\nSkipped after errors: ${errors.join("; ")}` : ""}\nCredits: ${mediaRoot(a.dir)}/CREDITS.md\nSources: ${providerLine(found)}`,
      ), view);
    }),
  );

  server.registerTool(
    "find_media",
    {
      title: "Find stock media",
      description:
        "Search free stock video, images, music and sound effects across Pexels, Pixabay, Unsplash, Openverse, Wikimedia Commons, NASA, Freesound and Jamendo, ranked by relevance, quality and license. " +
        "Use when you want to compare options before downloading (otherwise prefer get_media). Returns a numbered list with ids, previews and licenses; pass ids to download_media.",
      inputSchema: { ...searchShape, count: z.number().int().min(1).max(30).optional().describe("Results to return (default 8)") },
      _meta: uiMeta("media"),
    },
    safe(async (a) => {
      lastFind = await findMedia(toOptions(a, a.count ?? 8));
      return withView(text(listing(lastFind)), {
        view: "media",
        mode: "find",
        query: lastFind.query,
        kind: lastFind.kind,
        considered: lastFind.considered,
        items: lastFind.results.map(cardFromResult),
        providers: providerReports(lastFind),
      });
    }),
  );

  server.registerTool(
    "download_media",
    {
      title: "Download stock media",
      description:
        'Download items found by find_media into the media library and record attribution in CREDITS.md. ids are the "[provider:id]" values (or 1-based numbers from the last find_media list); omit ids to take the top result.',
      inputSchema: {
        ids: z.array(z.union([z.string(), z.number().int().min(1)])).optional().describe('e.g. ["pexels:123456", 2]'),
        dir: z.string().optional().describe("Media library folder (default ~/OpenEdit Media)"),
      },
      _meta: uiMeta("media"),
    },
    safe(async ({ ids, dir }) => {
      const wanted = ids?.length ? ids : [1];
      const out: string[] = [];
      const cards: MediaView["items"] = [];
      const errors: string[] = [];
      let failed = 0;
      for (const id of wanted) {
        const r = typeof id === "number" || /^\d+$/.test(id) ? lastFind?.results[Number(id) - 1] : lookupResult(id);
        if (!r) {
          out.push(`- ${id}: not found (run find_media first)`);
          errors.push(`${id}: not found (run find_media first)`);
          failed++;
          continue;
        }
        try {
          const o = await downloadResult(r, { dir });
          out.push(outcomeText(o));
          cards.push(await cardFromOutcome(o, r));
        } catch (e) {
          out.push(`- ${id}: ${(e as Error).message}`);
          errors.push(`${id}: ${(e as Error).message}`);
          failed++;
        }
      }
      const res = withView(text(`${out.join("\n")}\nCredits: ${mediaRoot(dir)}/CREDITS.md`), {
        view: "media",
        mode: "download",
        items: cards,
        creditsPath: `${mediaRoot(dir)}/CREDITS.md`,
        ...(errors.length ? { errors } : {}),
      });
      return failed === wanted.length ? { ...res, isError: true } : res;
    }),
  );

  server.registerTool(
    "media_credits",
    {
      title: "Media credits",
      description: "Return the CREDITS.md for downloaded stock media (title, author, source, license, attribution line). Use it to tell the user what must be credited, e.g. for a video description.",
      inputSchema: { dir: z.string().optional().describe("Media library folder (default ~/OpenEdit Media)") },
    },
    safe(async ({ dir }) => {
      const c = creditsSummary(dir);
      const req = c.entries.filter((e) => e.attributionRequired).length;
      return text(`${c.root}/CREDITS.md — ${c.entries.length} item(s), ${req} requiring attribution\n\n${c.markdown}`);
    }),
  );

  server.registerTool(
    "media_sources",
    {
      title: "Stock media sources",
      description: "List stock media providers, which media kinds each offers, whether its API key is configured, and its license terms.",
      inputSchema: {},
    },
    safe(async () => {
      const keys = new Map(keyStatus().map((k) => [k.env, k]));
      const lines = PROVIDERS.map((p) => {
        const state = !p.keyEnv ? "ready (no key needed)" : getKey(p.keyEnv) ? `ready (${p.keyEnv} set)` : `needs ${p.keyEnv} — free at ${keys.get(p.keyEnv)?.signupUrl}`;
        return `- ${p.name} [${p.id}] ${p.kinds.join("/")}: ${state}\n  ${p.licenseSummary}`;
      });
      return text(`${lines.join("\n")}\nAdd keys with \`openedit keys\` (stored in ~/.openedit/.env) or environment variables.`);
    }),
  );
}
