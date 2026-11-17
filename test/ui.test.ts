// MCP Apps inline views: tool <-> ui:// resource wiring, self-contained HTML, structuredContent shapes.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "openedit-ui-test-"));
process.env.OPENEDIT_HOME = join(TMP, "home");
process.env.OPENEDIT_HOST = "standalone";
process.env.OPENEDIT_STUDIO = "off";

const { createServer } = await import("../src/mcp/server.js");
const { RESOURCE_MIME_TYPE, TOOL_VIEWS, UI_VIEWS, loadViewHtml, uiUri, MEDIA_RESOURCE_DOMAINS } = await import("../src/ui/resources.js");
const { cutTexts, renderView, statusView } = await import("../src/ui/data.js");
const { revisePlan } = await import("../src/ui/tools.js");
const { savePlan } = await import("../src/mcp/plans.js");
const { probe } = await import("../src/engine/media.js");
const fx = await import("./ui-fixtures.js");

let client: Client;

beforeAll(async () => {
  const server = createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: "ui-test", version: "0" });
  await client.connect(ct);
});
afterAll(async () => {
  await client?.close();
});

describe("tool <-> ui:// resource wiring", () => {
  it("every UI tool advertises a registered ui:// resource served as text/html;profile=mcp-app", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const { resources } = await client.listResources();
    const listed = new Map(resources.map((r) => [r.uri, r]));
    for (const [tool, view] of Object.entries(TOOL_VIEWS)) {
      const t = byName.get(tool);
      expect(t, `tool ${tool} registered`).toBeDefined();
      const meta = t!._meta as { ui?: { resourceUri?: string }; "ui/resourceUri"?: string } | undefined;
      const uri = meta?.ui?.resourceUri;
      expect(uri, `${tool} has _meta.ui.resourceUri`).toBe(uiUri(view));
      expect(uri).toMatch(/^ui:\/\//);
      expect(meta?.["ui/resourceUri"]).toBe(uri); // legacy flat key for older hosts
      expect(listed.get(uri!)?.mimeType).toBe(RESOURCE_MIME_TYPE);
      const read = await client.readResource({ uri: uri! });
      expect(read.contents).toHaveLength(1);
      expect(read.contents[0].uri).toBe(uri);
      expect(read.contents[0].mimeType).toBe("text/html;profile=mcp-app");
      expect(String((read.contents[0] as { text?: string }).text)).toMatch(/^<!doctype html>/i);
    }
  });

  it("tools without a view stay plain, and every view is linked from some tool", async () => {
    const { tools } = await client.listTools();
    const withUi = tools.filter((t) => (t._meta as { ui?: unknown } | undefined)?.ui).map((t) => t.name).sort();
    expect(withUi).toEqual(Object.keys(TOOL_VIEWS).sort());
    expect(new Set(Object.values(TOOL_VIEWS))).toEqual(new Set(UI_VIEWS));
  });

  it("the media view declares the provider CDNs in its CSP; others need no external origins", async () => {
    const media = await client.readResource({ uri: uiUri("media") });
    const csp = (media.contents[0]._meta as { ui?: { csp?: { resourceDomains?: string[]; connectDomains?: string[] } } })?.ui?.csp;
    expect(csp?.resourceDomains).toEqual(MEDIA_RESOURCE_DOMAINS);
    expect(csp?.connectDomains).toBeUndefined();
    for (const d of ["https://images.pexels.com", "https://cdn.pixabay.com", "https://images.unsplash.com", "https://upload.wikimedia.org", "https://images-assets.nasa.gov", "https://cdn.freesound.org", "https://api.openverse.org"]) {
      expect(csp!.resourceDomains).toContain(d);
    }
    for (const v of UI_VIEWS.filter((x) => x !== "media")) {
      const r = await client.readResource({ uri: uiUri(v) });
      expect((r.contents[0]._meta as { ui?: { csp?: unknown } })?.ui?.csp).toBeUndefined();
    }
  });
});

describe("view HTML", () => {
  for (const view of UI_VIEWS) {
    it(`${view} is a self-contained HTML5 document under 80 KB`, () => {
      const html = loadViewHtml(view);
      expect(html).toMatch(/^<!doctype html>/i);
      expect(html).toContain('<meta charset="utf-8" />');
      expect(html).toMatch(/<\/html>\s*$/);
      expect(html).not.toContain("<!--#shared");
      expect(html).not.toMatch(/<script[^>]+src=/i);
      expect(html).not.toMatch(/<link[^>]+rel=["']?stylesheet/i);
      expect(html).not.toMatch(/@import|url\(\s*["']?https?:/i);
      expect(html).not.toMatch(/(src|href)=["']https?:/i);
      expect(html).toContain('"ui/initialize"');
      expect(html).toContain("ui/notifications/tool-result");
      expect(html).toContain("ui/notifications/size-changed");
      expect(Buffer.byteLength(html)).toBeLessThan(80 * 1024);
      // Balanced script/style tags, and inline scripts at least parse.
      expect(html.match(/<script>/g)?.length).toBe(html.match(/<\/script>/g)?.length);
      expect(html.match(/<style>/g)?.length).toBe(html.match(/<\/style>/g)?.length);
      for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new Function(m[1])).not.toThrow();
    });
  }
});

describe("structuredContent", () => {
  it("cut-plan view: summary, keeps, cuts with transcript text, waveform", async () => {
    const v = await fx.fixtureCutPlan();
    expect(v.view).toBe("cut-plan");
    expect(v.planId).toBeTruthy();
    expect(v.sourceName).toBe("how-i-edit-locally.mp4");
    expect(v.editedDuration).toBeLessThan(v.duration);
    expect(v.timeSaved).toBeCloseTo(v.duration - v.editedDuration, 2);
    expect(Object.keys(v.cutsByReason).sort()).toEqual(["filler", "manual", "retake", "silence"]);
    expect(v.cuts.length).toBeGreaterThan(5);
    for (const c of v.cuts) {
      expect(c.end).toBeGreaterThan(c.start);
      expect(["silence", "filler", "retake", "manual"]).toContain(c.reason);
    }
    expect(v.cuts.find((c) => c.reason === "filler")?.text).toMatch(/uh|um/i);
    expect(v.cuts.find((c) => c.reason === "retake")?.text).toContain("first thing");
    expect(v.keep.reduce((n, k) => n + k.end - k.start, 0)).toBeCloseTo(v.editedDuration, 2);
    expect(v.waveform!.length).toBe(480);
    expect(Math.max(...v.waveform!)).toBeLessThanOrEqual(1);
    expect(JSON.stringify(v).length).toBeLessThan(40_000);
  });

  it("revise_plan restores cuts and returns a new cut-plan view", async () => {
    const v = await fx.fixtureCutPlan();
    const restored = revisePlan({ source: v.source, duration: v.duration, keep: v.keep, cuts: v.cuts }, [1, 2], [{ start: 70, end: 71.5, label: "extra" }]);
    expect(restored.cuts).toHaveLength(v.cuts.length - 2 + 1);
    expect(restored.cuts.some((c) => c.label === "extra" && c.reason === "manual")).toBe(true);

    const stored = savePlan({ source: v.source, duration: v.duration, keep: v.keep, cuts: v.cuts }, { path: v.source });
    const res = await client.callTool({ name: "revise_plan", arguments: { planId: stored.id, restore: [0] } });
    expect(res.isError).toBeFalsy();
    expect((res.content as { text: string }[])[0].text).toMatch(/^planId: /);
    const sc = res.structuredContent as { view: string; planId: string; revisedFrom: string; cuts: unknown[]; editedDuration: number };
    expect(sc.view).toBe("cut-plan");
    expect(sc.planId).not.toBe(stored.id);
    expect(sc.revisedFrom).toBe(stored.id);
    expect(sc.cuts).toHaveLength(v.cuts.length - 1);
    expect(sc.editedDuration).toBeGreaterThan(v.editedDuration);
  });

  it("cut texts quote the words inside each cut", () => {
    const t = fx.fixtureTranscript();
    const w = t.segments[1].words[0];
    expect(cutTexts([{ start: w.start - 0.01, end: w.end + 0.01, reason: "filler" }], t)).toEqual(["Um,"]);
    expect(cutTexts([{ start: 0, end: 0.1, reason: "silence" }], t)).toEqual([undefined]);
  });

  it("transcript view: compact words with filler flags", () => {
    const v = fx.fixtureTranscriptView();
    expect(v.view).toBe("transcript");
    expect(v.wordCount).toBe(v.segments.reduce((n, s) => n + s.words.length, 0));
    expect(v.fillerCount).toBe(5);
    const [text, start, end, f] = v.segments[1].words[0];
    expect(text).toBe("Um,");
    expect(end).toBeGreaterThan(start);
    expect(f).toBe(1);
    expect(v.segments[0].words.every((w) => w[3] === 0)).toBe(true);
  });

  it("media view: cards carry preview, license, score and provider", () => {
    const v = fx.fixtureMediaFind();
    expect(v.view).toBe("media");
    expect(v.mode).toBe("find");
    expect(v.items).toHaveLength(6);
    for (const it of v.items) {
      expect(it.gid).toMatch(/^[a-z]+:/);
      expect(it.previewUrl).toMatch(/^https:\/\//);
      expect(typeof it.license).toBe("string");
      expect(typeof it.attributionRequired).toBe("boolean");
      expect(it.score).toBeGreaterThan(0);
      // Every preview host is allowed by the view's CSP.
      const host = new URL(it.previewUrl!).origin;
      expect(MEDIA_RESOURCE_DOMAINS.some((d) => d === host || (d.includes("*.") && host.endsWith(d.split("*")[1])))).toBe(true);
    }
  });

  it("render view: probe data and embedded data: URI thumbnails", async () => {
    const dir = join(TMP, "render");
    mkdirSync(dir, { recursive: true });
    const out = join(dir, "final.mp4");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=3", "-pix_fmt", "yuv420p", out]);
    const v = await renderView({ kind: "render", output: out, host: "standalone", studioUrl: "http://127.0.0.1:47822/" }, probe);
    expect(v).toMatchObject({ view: "render", kind: "render", name: "final.mp4", exists: true, width: 640, height: 360, host: "standalone" });
    expect(v.duration).toBeCloseTo(3, 1);
    expect(v.sizeBytes).toBeGreaterThan(0);
    expect(v.thumbnail).toMatch(/^data:image\/jpeg;base64,/);
    expect(v.thumbnail!.length).toBeLessThan(120_000);
    expect(v.frames!.length).toBeGreaterThanOrEqual(3);
    const missing = await renderView({ kind: "render", output: join(dir, "queued.mp4"), host: "premiere" }, probe);
    expect(missing).toMatchObject({ exists: false, host: "premiere" });
    expect(missing.thumbnail).toBeUndefined();
  });

  it("status view: one card per host, active first-class", async () => {
    const v = fx.fixtureStatus();
    expect(v.hosts.map((h) => h.host)).toEqual(["premiere", "resolve", "standalone"]);
    expect(v.hosts.filter((h) => h.active)).toHaveLength(1);
    expect(statusView({ host: "standalone", connected: true }).hosts.find((h) => h.host === "premiere")?.connected).toBeNull();

    const res = await client.callTool({ name: "editor_status", arguments: {} });
    expect((res.content as { text: string }[])[0].text).toContain('"active"'); // text fallback unchanged
    const sc = res.structuredContent as { view: string; active: string; hosts: unknown[] };
    expect(sc.view).toBe("status");
    expect(sc.active).toBe("standalone");
    expect(sc.hosts).toHaveLength(3);
  });
});
