// Renders each MCP Apps view inside a minimal fake host (the host side of the SEP-1865
// postMessage protocol), feeds fixture tool results in dark and light themes, and saves
// screenshots to test-results/ui/.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { probe } from "../../src/engine/media.js";
import { cardFromOutcome, renderView } from "../../src/ui/data.js";
import { loadViewHtml, type UiView } from "../../src/ui/resources.js";
import { fixtureCutPlan, fixtureMediaAudio, fixtureMediaFind, fixtureRevised, fixtureStatus, fixtureTranscriptView } from "../ui-fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHOTS = join(ROOT, "test-results", "ui");
const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];

// Claude-like host style variables (light-dark() values, as the spec recommends).
const HOST_VARS: Record<string, string> = {
  "--color-background-primary": "light-dark(#ffffff, #262624)",
  "--color-background-secondary": "light-dark(#f5f4ef, #30302e)",
  "--color-background-tertiary": "light-dark(#ecebe4, #3a3936)",
  "--color-text-primary": "light-dark(#141413, #faf9f5)",
  "--color-text-secondary": "light-dark(#5e5d59, #c2c0b6)",
  "--color-text-tertiary": "light-dark(#87867f, #8b8a84)",
  "--color-border-primary": "light-dark(rgba(31,30,29,0.18), rgba(222,220,209,0.18))",
  "--color-border-secondary": "light-dark(rgba(31,30,29,0.11), rgba(222,220,209,0.11))",
  "--color-border-tertiary": "light-dark(rgba(31,30,29,0.07), rgba(222,220,209,0.07))",
  "--font-sans": 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  "--border-radius-md": "10px",
  "--border-radius-lg": "14px",
};

interface HostOptions {
  view: UiView;
  theme: Theme;
  tool: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  /** tools/call responses by tool name. */
  responses?: Record<string, unknown>;
  width?: number;
  serverTools?: boolean;
  /** Hold the tool result back (to capture the loading state). */
  holdResult?: boolean;
}

const HOST_SCRIPT = `
(() => {
  const iframe = document.getElementById("view");
  const log = (window.__host = { messages: [], calls: [], sizes: [], initialized: false, resultSent: false });
  const send = (m) => iframe.contentWindow.postMessage(Object.assign({ jsonrpc: "2.0" }, m), "*");
  window.__sendResult = () => { log.resultSent = true; send({ method: "ui/notifications/tool-result", params: window.__opts.result }); };
  window.__setTheme = (theme) => {
    document.documentElement.style.colorScheme = theme;
    document.body.dataset.theme = theme;
    send({ method: "ui/notifications/host-context-changed", params: { theme } });
  };
  window.addEventListener("message", (e) => {
    if (e.source !== iframe.contentWindow) return;
    const m = e.data, o = window.__opts;
    if (!m || m.jsonrpc !== "2.0") return;
    log.messages.push(m);
    switch (m.method) {
      case "ui/initialize":
        send({ id: m.id, result: {
          protocolVersion: "2026-01-26",
          hostInfo: { name: "fake-host", version: "1.0.0" },
          hostCapabilities: Object.assign({ openLinks: {}, logging: {} }, o.serverTools === false ? {} : { serverTools: {} }),
          hostContext: {
            theme: o.theme, displayMode: "inline", availableDisplayModes: ["inline"], platform: "web", locale: "en-US",
            containerDimensions: { width: o.width, maxHeight: 640 },
            styles: { variables: o.vars },
            toolInfo: { id: 1, tool: { name: o.tool, inputSchema: { type: "object" } } },
          },
        }});
        break;
      case "ui/notifications/initialized":
        log.initialized = true;
        send({ method: "ui/notifications/tool-input-partial", params: { arguments: {} } });
        send({ method: "ui/notifications/tool-input", params: { arguments: o.input } });
        if (!o.holdResult) setTimeout(window.__sendResult, 30);
        break;
      case "ui/notifications/size-changed":
        log.sizes.push(m.params);
        iframe.style.height = Math.min(640, m.params.height) + "px";
        break;
      case "tools/call": {
        log.calls.push(m.params);
        const r = (o.responses || {})[m.params.name];
        setTimeout(() => send(r ? { id: m.id, result: r } : { id: m.id, error: { code: -32601, message: "no fixture for " + m.params.name } }), 150);
        break;
      }
      default:
        if (m.id !== undefined && m.method) send({ id: m.id, result: {} });
    }
  });
})();`;

async function mount(page: Page, o: HostOptions): Promise<void> {
  const width = o.width ?? 720;
  await page.setViewportSize({ width: width + 48, height: 760 });
  const bg = o.theme === "dark" ? "#262624" : "#ffffff";
  await page.setContent(
    `<!doctype html><html><head><style>html,body{margin:0;background:${bg};color-scheme:${o.theme}}#wrap{padding:24px}iframe{display:block;border:0;width:${width}px;height:120px;background:transparent;transition:height .2s}</style></head>` +
      `<body><div id="wrap"><iframe id="view" sandbox="allow-scripts allow-same-origin"></iframe></div></body></html>`,
  );
  await page.evaluate(
    ([opts, script, html]) => {
      (window as unknown as { __opts: unknown }).__opts = opts;
      new Function(script as string)();
      (document.getElementById("view") as HTMLIFrameElement).srcdoc = html as string;
    },
    [{ ...o, width, vars: HOST_VARS }, HOST_SCRIPT, loadViewHtml(o.view)] as const,
  );
  await expect.poll(() => page.evaluate(() => (window as unknown as { __host: { initialized: boolean } }).__host.initialized)).toBe(true);
}

const frame = (page: Page) => page.frameLocator("#view");

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(1300); // let entrance animations settle
  const box = await page.locator("#view").boundingBox();
  await page.screenshot({ path: join(SHOTS, `${name}.png`), clip: { x: 0, y: 0, width: (box?.width ?? 720) + 48, height: (box?.height ?? 400) + 48 } });
}

let renderFixture: Record<string, unknown>;
let motionFixture: Record<string, unknown>;
let downloadFixture: Record<string, unknown>;
let thumbJpeg: Buffer;
let thumbJpeg2: Buffer;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "openedit-ui-"));
  const ff = (args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);
  const video = join(dir, "how-i-edit-locally-final.mp4");
  ff(["-f", "lavfi", "-i", "gradients=size=1280x720:rate=30:duration=6:speed=0.02:c0=0x14324a:c1=0x2a9d8f:c2=0xe9c46a:c3=0xe76f51:n=4:x0=0:y0=0:x1=1280:y1=720,drawbox=x=0:y=0:w=1280:h=720:color=black@0.12:t=fill,drawbox=x=420:y=588:w=440:h=64:color=black@0.55:t=fill,drawbox=x=452:y=612:w=250:h=16:color=white@0.95:t=fill,drawbox=x=712:y=612:w=116:h=16:color=0xf7b23b@1:t=fill", "-f", "lavfi", "-i", "sine=frequency=220:duration=6", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", video]);
  const motion = join(dir, "lower-third-1731850000.mov");
  ff(["-f", "lavfi", "-i", "color=c=black@0.0:size=1920x1080:rate=30:duration=3,format=rgba,drawbox=x=120:y=820:w=820:h=150:color=0x2a9d8f@0.92:t=fill:replace=1,drawbox=x=120:y=820:w=14:h=150:color=white@1:t=fill:replace=1,drawbox=x=170:y=860:w=520:h=34:color=white@1:t=fill:replace=1,drawbox=x=170:y=910:w=320:h=20:color=white@0.7:t=fill:replace=1", "-c:v", "qtrle", motion]);
  const thumb = join(dir, "thumb.jpg");
  ff(["-f", "lavfi", "-i", "gradients=size=640x360:speed=0.01:c0=0x0b132b:c1=0x3a506b:c2=0xf2a541:n=3", "-frames:v", "1", thumb]);
  thumbJpeg = readFileSync(thumb);
  const thumb2 = join(dir, "thumb2.jpg");
  ff(["-f", "lavfi", "-i", "gradients=size=640x360:speed=0.01:c0=0x1d1a39:c1=0x7b2cbf:c2=0xff6d00:n=3:type=radial", "-frames:v", "1", thumb2]);
  thumbJpeg2 = readFileSync(thumb2);

  renderFixture = { ...(await renderView({ kind: "render", output: video, host: "standalone", warnings: [], studioUrl: "http://127.0.0.1:47822/" }, probe)) };
  motionFixture = { ...(await renderView({ kind: "motion", output: motion, detail: "lower-third", placed: "and placed at 00:04.0 on V3 in standalone", studioUrl: "http://127.0.0.1:47822/" }, probe)) };
  const local = join(dir, "aerial-view-of-a-city-at-night-pexels-3129671.mp4");
  ff(["-f", "lavfi", "-i", "gradients=size=960x540:rate=24:duration=2:speed=0.02:c0=0x0b132b:c1=0x1c2541:c2=0xf2a541:n=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", local]);
  const find = fixtureMediaFind();
  const first = find.items[0];
  const card = await cardFromOutcome(
    { gid: first.gid, provider: first.provider, id: "3129671", kind: "video", title: first.title, author: first.author, sourceUrl: first.url ?? "", license: first.license, attributionRequired: false, attributionText: "Video by Kelly Lacy on Pexels", path: local, downloadedAt: new Date().toISOString(), existing: false },
    undefined,
  );
  downloadFixture = { view: "media", mode: "download", items: [card], creditsPath: join(dir, "CREDITS.md") };
});

test.beforeEach(async ({ page }) => {
  // Remote preview thumbnails -> local gradients (tests never hit the network).
  await page.route(/^https:\/\/(images\.pexels|cdn\.pixabay|api\.openverse|upload\.wikimedia|images-assets\.nasa)/, (route) =>
    route.fulfill({ status: 200, contentType: "image/jpeg", body: /pixabay|wikimedia/.test(route.request().url()) ? thumbJpeg2 : thumbJpeg }),
  );
  await page.route(/^https:\/\/(cdn\.freesound|prod-1\.storage\.jamendo)/, (route) => route.fulfill({ status: 404, body: "" }));
});

const textResult = (text: string, sc: object) => ({ content: [{ type: "text", text }], structuredContent: sc });

for (const theme of THEMES) {
  test(`cut plan view (${theme})`, async ({ page }) => {
    const plan = await fixtureCutPlan();
    const revised = await fixtureRevised(plan, [1]);
    const applied = { ...revised, applied: { host: "standalone", sequence: "how-i-edit-locally (OpenEdit cut)" } };
    await mount(page, {
      view: "cut-plan",
      theme,
      tool: "plan_cuts",
      input: { path: plan.source, removeRetakes: true },
      result: textResult(`planId: ${plan.planId}`, plan),
      responses: { revise_plan: textResult("planId: x", revised), apply_cuts: textResult("{}", applied) },
    });
    const f = frame(page);
    await expect(f.locator(".cut")).toHaveCount(plan.cuts.length);
    await expect(f.locator(".row")).toHaveCount(plan.cuts.length);
    await expect(f.locator(".legend .chip")).toHaveCount(Object.values(plan.cutsByReason).filter((r) => r.count).length);
    await expect(f.locator("#to")).toHaveText(/\d:\d\d\.\d/);
    await expect(f.locator("#saved-text")).toContainText("shorter");
    await expect(f.locator("#apply")).toBeEnabled();
    // Hover a filler cut: tooltip with its transcript text.
    const fillerIdx = plan.cuts.findIndex((c) => c.reason === "filler" && c.text);
    await f.locator(`.cut[data-i="${fillerIdx}"]`).hover();
    await expect(f.locator("#tip")).toHaveClass(/show/);
    await expect(f.locator("#tip")).toContainText(plan.cuts[fillerIdx].text!);
    await shot(page, `cut-plan-${theme}`);

    // Toggle a cut: totals update and "Update plan" appears; then apply through revise_plan + apply_cuts.
    await f.locator(`.row[data-i="1"] .tog`).click();
    await expect(f.locator('.row[data-i="1"]')).toHaveClass(/restored/);
    await expect(f.locator("#update")).toBeVisible();
    await expect(f.locator("#status")).toContainText("1 cut");
    await page.mouse.move(0, 0);
    await shot(page, `cut-plan-toggled-${theme}`);
    await f.locator("#apply").click();
    await expect(f.locator(".applied")).toBeVisible();
    await expect(f.locator("#apply")).toBeDisabled();
    const calls = await page.evaluate(() => (window as unknown as { __host: { calls: { name: string; arguments: Record<string, unknown> }[] } }).__host.calls);
    expect(calls.map((c) => c.name)).toEqual(["revise_plan", "apply_cuts"]);
    expect(calls[0].arguments).toEqual({ planId: plan.planId, restore: [1] });
    expect(calls[1].arguments).toEqual({ planId: revised.planId });
    const ctxUpdates = await page.evaluate(() => (window as unknown as { __host: { messages: { method?: string }[] } }).__host.messages.filter((m) => m.method === "ui/update-model-context").length);
    expect(ctxUpdates).toBeGreaterThanOrEqual(2);
    await shot(page, `cut-plan-applied-${theme}`);
  });

  test(`transcript view (${theme})`, async ({ page }) => {
    const tv = fixtureTranscriptView();
    await mount(page, { view: "transcript", theme, tool: "transcribe", input: { path: tv.source }, result: textResult("Transcript of …", tv) });
    const f = frame(page);
    await expect(f.locator(".w")).toHaveCount(tv.segments.reduce((n, s) => n + s.words.length, 0));
    await expect(f.locator(".w.filler")).toHaveCount(tv.fillerCount);
    await expect(f.locator(".seg")).toHaveCount(tv.segments.length);
    await f.locator(".w").nth(14).click();
    await expect(f.locator("#sel")).toBeVisible();
    await expect(f.locator("#sel")).toContainText(tv.segments[1].words[14 - tv.segments[0].words.length][0]);
    await shot(page, `transcript-${theme}`);
    await f.locator("#q").fill("first thing");
    await expect(f.locator(".w.match")).toHaveCount(4);
    await shot(page, `transcript-search-${theme}`);
  });

  test(`media results view (${theme})`, async ({ page }) => {
    const mv = fixtureMediaFind();
    await mount(page, {
      view: "media",
      theme,
      tool: "find_media",
      input: { query: mv.query, kind: "video" },
      result: textResult("Found 6 …", mv),
      responses: { download_media: textResult("- /Users/demo/OpenEdit Media/video/…", downloadFixture) },
    });
    const f = frame(page);
    await expect(f.locator(".card")).toHaveCount(mv.items.length);
    await expect(f.locator(".card .lic").first()).toBeVisible();
    await expect.poll(() => f.locator(".card img").evaluateAll((imgs) => imgs.filter((i) => (i as HTMLImageElement).naturalWidth > 0).length)).toBe(mv.items.length);
    await shot(page, `media-${theme}`);
    await f.locator(".card").first().locator(".use").click();
    await expect(f.locator(".card").first()).toHaveClass(/got/);
    await expect(f.locator(".card").first()).toContainText("In library");
    const calls = await page.evaluate(() => (window as unknown as { __host: { calls: { name: string; arguments: unknown }[] } }).__host.calls);
    expect(calls).toEqual([{ name: "download_media", arguments: { ids: [mv.items[0].gid] } }]);
    await shot(page, `media-downloaded-${theme}`);
  });

  test(`render view (${theme})`, async ({ page }) => {
    await mount(page, { view: "render", theme, tool: "render", input: { output: renderFixture.output }, result: textResult("{…}", renderFixture) });
    const f = frame(page);
    await expect(f.locator(".thumb img")).toBeVisible();
    await expect(f.locator(".meta")).toContainText("1280×720");
    await expect(f.locator(".strip img")).toHaveCount((renderFixture.frames as string[]).length);
    await expect(f.locator("#studio")).toBeVisible();
    await f.locator("#studio").click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __host: { messages: { method?: string; params?: { url?: string } }[] } }).__host.messages.find((m) => m.method === "ui/open-link")?.params?.url))
      .toBe("http://127.0.0.1:47822/");
    await shot(page, `render-${theme}`);
  });

  test(`status view (${theme})`, async ({ page }) => {
    const sv = fixtureStatus();
    await mount(page, { view: "status", theme, tool: "editor_status", input: {}, result: textResult("{…}", sv) });
    const f = frame(page);
    await expect(f.locator(".host")).toHaveCount(3);
    await expect(f.locator(".host.active")).toContainText("DaVinci Resolve");
    await expect(f.locator(".host.active")).toContainText("Channel Ep. 42");
    await shot(page, `status-${theme}`);
  });
}

test("motion render with alpha (dark)", async ({ page }) => {
  await mount(page, { view: "render", theme: "dark", tool: "render_motion", input: { template: "lower-third" }, result: textResult("Rendered …", motionFixture) });
  await expect(frame(page).locator(".thumb.alpha")).toBeVisible();
  await shot(page, "render-motion-dark");
});

test("audio results and narrow width (light)", async ({ page }) => {
  await mount(page, { view: "media", theme: "light", tool: "find_media", input: { query: "upbeat lofi", kind: "music" }, result: textResult("Found 3 …", fixtureMediaAudio()), width: 420 });
  await expect(frame(page).locator(".card.audio")).toHaveCount(3);
  await shot(page, "media-audio-narrow-light");
});

test("loading state, error result and text-only fallback", async ({ page }) => {
  await mount(page, { view: "cut-plan", theme: "dark", tool: "plan_cuts", input: { path: "/x/interview.mp4" }, result: { content: [{ type: "text", text: "Error: File not found: /x/interview.mp4" }], isError: true }, holdResult: true });
  const f = frame(page);
  await expect(f.locator("#loading-text")).toHaveText("Planning cuts for interview.mp4…");
  await shot(page, "cut-plan-loading-dark");
  await page.evaluate(() => (window as unknown as { __sendResult: () => void }).__sendResult());
  await expect(f.locator(".error-box")).toContainText("File not found");
});

test("live theme switch and no-serverTools fallback", async ({ page }) => {
  const plan = await fixtureCutPlan();
  await mount(page, { view: "cut-plan", theme: "dark", tool: "plan_cuts", input: {}, result: textResult("planId", plan), serverTools: false });
  const f = frame(page);
  await expect(f.locator(".cut").first()).toBeVisible();
  const darkBg = await f.locator("#app").evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.evaluate(() => (window as unknown as { __setTheme: (t: string) => void }).__setTheme("light"));
  await expect.poll(() => f.locator("#app").evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(darkBg);
  await f.locator("#apply").click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __host: { messages: { method?: string; params?: { content?: { text: string }[] } }[] } }).__host.messages.find((m) => m.method === "ui/message")?.params?.content?.[0].text))
    .toContain(`Apply cut plan ${plan.planId}`);
});

for (const theme of THEMES) {
  test(`graphics view: catalog, fields and place (${theme})`, async ({ page }) => {
    const uri = (b: Buffer) => `data:image/jpeg;base64,${b.toString("base64")}`;
    const item = (o: Record<string, unknown>) => ({ apps: ["premiere"], usable: true, locked: false, missingFonts: [], params: [], pack: "OpenEdit", ...o });
    const items = [
      item({ id: "speaker-lower-third", name: "Speaker lower third", kind: "user", category: "Lower thirds", pack: "My templates", duration: 5, thumb: uri(thumbJpeg), apps: ["premiere", "resolve", "standalone"],
        note: "Your template (figma): rendered to alpha video and placed on an upper track in any host.",
        params: [
          { id: "name", name: "name", type: "text", default: "Maya Okafor" },
          { id: "role", name: "role", type: "text", default: "Head of Product" },
          { id: "brand_accent", name: "brand_accent", type: "color", default: "#ff6a3d" },
        ] }),
      item({ id: "lower-third", name: "lower-third", kind: "hyperframes", category: "Lower thirds", duration: 5, thumb: uri(thumbJpeg2), params: [{ id: "position", name: "position", type: "dropdown", options: ["left", "right", "center"], default: "left" }] }),
      item({ id: "my-titles/clean-title-01", name: "Clean Title 01", kind: "mogrt", category: "Clean", pack: "My Titles", duration: 3.9, thumb: uri(thumbJpeg2), missingFonts: ["Archivo-Black"],
        params: [{ id: "scale", name: "Main Scale", type: "slider", default: 90, min: 0, max: 250, group: "Main Settings" }] }),
      item({ id: "my-titles/clean-title-02", name: "Clean Title 02", kind: "demo", category: "Clean", pack: "My Titles", usable: false, locked: true, apps: [], note: "Locked demo placeholder (full version only): preview only, not usable." }),
      item({ id: "moji/title-01", name: "Title 01", kind: "aep", category: "Titles", pack: "Moji", usable: false, apps: ["aftereffects"] }),
    ];
    const sc = { view: "graphics", mode: "catalog", host: "premiere", items, total: 5, offset: 0, query: "" };
    const placed = { view: "graphics", mode: "placed", host: "premiere", items: [items[0]], placed: { method: "rendered-overlay", text: "Rendered Speaker lower third and placed it on V3 at 4.00s in premiere." } };
    await mount(page, { view: "graphics", theme, tool: "graphics_catalog", input: {}, result: textResult("5 templates", sc), responses: { place_graphic: textResult("Placed", placed) } });
    const f = frame(page);
    await expect(f.locator(".tile")).toHaveCount(5);
    await expect(f.locator(".tile.off")).toHaveCount(2);
    await expect(f.locator(".tile .k-mogrt")).toHaveText("MOGRT");
    await expect(f.locator(".tile .fb")).toHaveCount(1);
    await shot(page, `graphics-catalog-${theme}`);
    await f.locator(".tile").first().click();
    await expect(f.locator("#detail")).toBeVisible();
    await expect(f.locator(".f")).toHaveCount(3);
    await f.locator("#f-name").fill("Ada Lovelace");
    await f.locator("#at").fill("4");
    await shot(page, `graphics-detail-${theme}`);
    await f.locator("#use").click();
    await expect(f.locator(".placed")).toContainText("placed it on V3");
    const calls = await page.evaluate(() => (window as unknown as { __host: { calls: { name: string; arguments: unknown }[] } }).__host.calls);
    expect(calls).toEqual([{ name: "place_graphic", arguments: { id: "speaker-lower-third", at: 4, params: { name: "Ada Lovelace" } } }]);
  });
}
