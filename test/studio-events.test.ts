import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { emitStudio, onStudio, reportProgress, type StudioEvent } from "../src/studio/events.js";
import { deriveTarget, instrumentServer, parseSrt, summarizeArgs, toolTitle } from "../src/studio/instrument.js";
import { startStudioServer, type StudioServer } from "../src/studio/server.js";

type Handler = (...a: unknown[]) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

function collect(): { events: StudioEvent[]; stop: () => void } {
  const events: StudioEvent[] = [];
  const stop = onStudio((e) => events.push(e));
  return { events, stop };
}

/** Call a registered tool's (wrapped) handler directly. */
function handlerOf(server: McpServer, name: string): Handler {
  const tools = (server as unknown as { _registeredTools: Record<string, { handler?: Handler; callback?: Handler }> })._registeredTools;
  const t = tools[name];
  return (t.handler ?? t.callback) as Handler;
}

describe("studio event bus", () => {
  it("stamps, sequences and fans out events; listeners can unsubscribe", () => {
    const { events, stop } = collect();
    const a = emitStudio({ type: "log", message: "one" });
    emitStudio({ type: "log", message: "two" });
    stop();
    emitStudio({ type: "log", message: "three" });
    expect(events.map((e) => (e as { message: string }).message)).toEqual(["one", "two"]);
    expect(a.at).toBeTypeOf("number");
    expect(events[1].seq).toBe((events[0].seq ?? 0) + 1);
  });

  it("a throwing listener does not break emit", () => {
    const stop = onStudio(() => {
      throw new Error("boom");
    });
    expect(() => emitStudio({ type: "log", message: "x" })).not.toThrow();
    stop();
  });

  it("titles, arg summaries and targets are human friendly", () => {
    expect(toolTitle("apply_cuts")).toBe("Cutting silences");
    expect(toolTitle("download_stock_video")).toBe("Downloading stock video");
    expect(summarizeArgs({ path: "/a/b/talk.mp4", removeSilences: true, manualCuts: [1, 2] })).toBe("path: talk.mp4 · removeSilences: true · manualCuts: 2 items");
    expect(deriveTarget("transcribe", { path: "/a/talk.mp4" })).toEqual({ kind: "file", label: "talk.mp4", path: "/a/talk.mp4" });
    expect(deriveTarget("add_zooms", { zooms: [{ start: 1, end: 2, scale: 115 }] })).toMatchObject({ kind: "range", start: 1, end: 2 });
    expect(deriveTarget("search_stock_media", { query: "city at night" })).toMatchObject({ kind: "media", label: "city at night" });
  });

  it("parses SRT cues", () => {
    expect(parseSrt("1\n00:00:01,000 --> 00:00:02,500\nHello <b>there</b>\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n")).toEqual([
      { start: 1, end: 2.5, text: "Hello there" },
      { start: 3, end: 4, text: "Bye" },
    ]);
  });
});

describe("registerTool instrumentation", () => {
  it("wraps tools registered after patching (including later modules) and reports start/progress/end", async () => {
    const server = instrumentServer(new McpServer({ name: "t", version: "0" }));
    instrumentServer(server); // idempotent
    server.registerTool("transcribe", { description: "x", inputSchema: { path: z.string() } }, async ({ path }) => {
      reportProgress(0.5, "halfway");
      return { content: [{ type: "text" as const, text: `done ${path}` }] };
    });
    server.registerTool("no_input", { description: "y" }, async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    server.registerTool("fails", { description: "z", inputSchema: {} }, async () => ({ content: [{ type: "text" as const, text: "Error: nope" }], isError: true }));
    server.registerTool("throws", { description: "z", inputSchema: {} }, async () => {
      throw new Error("kaboom");
    });

    const { events, stop } = collect();
    const res = await handlerOf(server, "transcribe")({ path: "/v/talk.mp4" }, {});
    expect(res.content[0].text).toBe("done /v/talk.mp4");
    await handlerOf(server, "no_input")({});
    await handlerOf(server, "fails")({}, {});
    await expect(handlerOf(server, "throws")({}, {})).rejects.toThrow("kaboom");
    stop();

    const starts = events.filter((e) => e.type === "tool_start");
    const ends = events.filter((e) => e.type === "tool_end");
    expect(starts.map((e) => e.type === "tool_start" && e.tool)).toEqual(["transcribe", "no_input", "fails", "throws"]);
    const s0 = starts[0] as Extract<StudioEvent, { type: "tool_start" }>;
    expect(s0.title).toBe("Transcribing speech");
    expect(s0.target).toMatchObject({ kind: "file", path: "/v/talk.mp4" });
    const prog = events.find((e) => e.type === "progress") as Extract<StudioEvent, { type: "progress" }>;
    expect(prog).toMatchObject({ id: s0.id, fraction: 0.5, detail: "halfway" });
    expect(ends.map((e) => e.type === "tool_end" && e.ok)).toEqual([true, true, false, false]);
    expect((ends[2] as Extract<StudioEvent, { type: "tool_end" }>).summary).toBe("nope");
    expect((ends[3] as Extract<StudioEvent, { type: "tool_end" }>).summary).toBe("kaboom");
  });
});

describe("studio server", () => {
  let s: StudioServer;
  beforeAll(async () => {
    process.env.OPENEDIT_HOME = mkdtempSync(join(tmpdir(), "oe-studio-unit-"));
    s = await startStudioServer({ port: 0, token: "t0k" });
  });
  afterAll(() => s.close());

  it("serves the page, health, and rejects emits without the token", async () => {
    expect((await fetch(s.url)).headers.get("content-type")).toMatch(/html/);
    expect((await (await fetch(`${s.url}health`)).json()).app).toBe("openedit-studio");
    expect((await fetch(`${s.url}emit`, { method: "POST", body: "{}" })).status).toBe(401);
    const ok = await fetch(`${s.url}emit`, { method: "POST", headers: { "x-openedit-token": "t0k" }, body: JSON.stringify({ type: "log", message: "hi" }) });
    expect(ok.status).toBe(200);
  });

  it("only previews files under allowed dirs or emitted by tools", async () => {
    expect((await fetch(`${s.url}media?path=${encodeURIComponent("/etc/hosts")}`)).status).toBe(403);
    s.publish({ type: "tool_end", id: "x", tool: "t", ok: true, outputs: ["/etc/hosts"] });
    expect((await fetch(`${s.url}media?path=${encodeURIComponent("/etc/hosts")}`)).status).toBe(200);
  });
});
