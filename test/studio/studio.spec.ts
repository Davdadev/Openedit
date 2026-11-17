import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHOTS = join(ROOT, "test-results", "studio");
let proc: ChildProcess;
let home: string;
let base: string;
let token: string;
let video: string;
let image: string;
let audio: string;

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

async function emit(events: object | object[]): Promise<void> {
  const r = await fetch(`${base}emit`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-openedit-token": token },
    body: JSON.stringify(events),
  });
  expect(r.status).toBe(200);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** The cursor ring has glided onto the element (centres within a few px). */
async function expectCursorOn(page: Page, selector: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const t = await page.locator(selector).first().boundingBox();
        const c = await page.locator("#cursor-ring").boundingBox();
        if (!t || !c) return 9999;
        return Math.hypot(t.x + t.width / 2 - (c.x + c.width / 2), t.y + t.height / 2 - (c.y + c.height / 2));
      },
      { timeout: 5000 },
    )
    .toBeLessThan(6);
  await expect(page.locator("#cursor")).toHaveClass(/visible/);
}

const glowOpacity = (page: Page) => page.locator("#glow").evaluate((el) => Number(getComputedStyle(el).opacity));

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  home = mkdtempSync(join(tmpdir(), "openedit-studio-"));
  const media = join(home, "renders");
  mkdirSync(media, { recursive: true });
  video = join(media, "broll-city.webm");
  image = join(media, "thumbnail.png");
  audio = join(media, "lofi-bed.mp3");
  const ff = (args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=480x270:rate=24:duration=2", "-c:v", "libvpx-vp9", "-b:v", "300k", video]);
  ff(["-f", "lavfi", "-i", "gradients=size=480x270:duration=1", "-frames:v", "1", image]);
  ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", audio]);
  const port = await freePort();
  base = `http://127.0.0.1:${port}/`;
  proc = spawn(process.execPath, ["--import", "tsx", join(ROOT, "src", "cli.ts"), "studio", "--port", String(port)], {
    cwd: ROOT,
    env: { ...process.env, OPENEDIT_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((ok, fail) => {
    const t = setTimeout(() => fail(new Error("studio did not start")), 30_000);
    proc.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("listening")) {
        clearTimeout(t);
        ok();
      }
    });
    proc.stderr!.on("data", (d: Buffer) => process.stderr.write(d));
  });
  token = readFileSync(join(home, "token"), "utf8").trim();
});

test.afterAll(async () => {
  proc?.kill();
  rmSync(home, { recursive: true, force: true });
});

test("server guards: token, media allow-list, health, overlay", async () => {
  expect((await (await fetch(`${base}health`)).json()).app).toBe("openedit-studio");
  const bad = await fetch(`${base}emit`, { method: "POST", headers: { "x-openedit-token": "nope" }, body: "{}" });
  expect(bad.status).toBe(401);
  expect((await fetch(`${base}media?path=${encodeURIComponent("/etc/hosts")}`)).status).toBe(403);
  expect((await fetch(`${base}media?path=${encodeURIComponent(video)}`)).status).toBe(200);
  const ov = await fetch(`${base}overlay.js`);
  expect(ov.headers.get("access-control-allow-origin")).toBe("*");
  expect(await ov.text()).toContain(base.slice(0, -1));
});

test("live edit session renders glow, cursor, status, timeline and media", async ({ page }) => {
  const src = "/Users/demo/Videos/talk.mp4";
  await page.goto(base);
  await expect(page.locator("#conn")).toHaveAttribute("data-state", "live");
  await expect(page.locator("body")).toHaveClass(/idle/);
  await shot(page, "00-idle");
  expect(await glowOpacity(page)).toBe(0);

  // 1. transcribe -> progress
  await emit({ type: "session", session: "demo42", version: "0.1.0" });
  await emit({ type: "tool_start", id: "t1", tool: "transcribe", title: "Transcribing speech", args: "path: talk.mp4", target: { kind: "file", label: "talk.mp4", path: src } });
  await expect(page.locator("body")).toHaveClass(/working/);
  await expect(page.locator("#st-title")).toHaveText("Transcribing speech");
  await expect(page.locator("#progress")).toHaveAttribute("data-mode", "indeterminate");
  await expectCursorOn(page, "#source-chip");
  await expect.poll(() => glowOpacity(page)).toBe(1);
  await emit({ type: "progress", id: "t1", fraction: 0.42, detail: "whisper base · 42%" });
  await expect(page.locator("#progress")).toHaveAttribute("data-mode", "determinate");
  await expect(page.locator("#progress-pct")).toHaveText("42%");
  await expect(page.locator("#progress-detail")).toHaveText("whisper base · 42%");
  await shot(page, "01-transcribing");
  await emit({ type: "tool_end", id: "t1", tool: "transcribe", ok: true, summary: "Transcript of talk.mp4 (en, 96s, 214 words)", outputs: [], ms: 5400 });
  await expect(page.locator(".step.done")).toHaveCount(1);

  // 2. plan_cuts with a plan
  const cuts = [
    { start: 0, end: 1.2, reason: "silence" },
    { start: 8.4, end: 9.1, reason: "filler", label: "um" },
    { start: 15, end: 17.5, reason: "silence" },
    { start: 22.2, end: 27.9, reason: "retake" },
    { start: 40.1, end: 40.6, reason: "filler", label: "uh" },
    { start: 51, end: 54.2, reason: "silence" },
    { start: 63.3, end: 66, reason: "manual", label: "tangent" },
    { start: 80, end: 82.6, reason: "silence" },
    { start: 94.5, end: 96, reason: "silence" },
  ];
  const keep: { start: number; end: number }[] = [];
  let t = 0;
  for (const c of cuts) {
    if (c.start > t) keep.push({ start: t, end: c.start });
    t = c.end;
  }
  if (t < 96) keep.push({ start: t, end: 96 });
  await emit({ type: "tool_start", id: "t2", tool: "plan_cuts", title: "Planning cuts", args: "removeSilences: true · removeFillers: true", target: { kind: "timeline", label: "Source" } });
  await emit({ type: "timeline", plan: { id: "talk-abc", source: src, duration: 96, keep, cuts } });
  await expect(page.locator("#segs-source .seg.cut")).toHaveCount(cuts.length);
  await expect(page.locator("#segs-source .seg.keep")).toHaveCount(keep.length);
  await expect(page.locator('#segs-source .seg.cut[data-reason="filler"]')).toHaveCount(2);
  const colors = await page.locator("#segs-source .seg.cut").evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).getPropertyValue("--c").trim()))]);
  expect(colors.length).toBe(4); // silence / filler / retake / manual each colored
  await expectCursorOn(page, "#lane-source");
  await emit({ type: "tool_end", id: "t2", tool: "plan_cuts", ok: true, summary: "96s -> 74.9s (saves 21.1s, 22%)", outputs: [], ms: 2100 });
  await expect(page.locator("#edit-badge")).toContainText("not applied");
  await shot(page, "02-plan");

  // 3. apply_cuts: cut pieces collapse out of the edit lane
  await emit({ type: "tool_start", id: "t3", tool: "apply_cuts", title: "Cutting silences", args: "planId: talk-abc", target: { kind: "timeline", label: "Edit" } });
  await expectCursorOn(page, "#lane-edit");
  await emit({ type: "timeline", plan: { id: "talk-abc", source: src, duration: 96, keep, cuts }, applied: true });
  await expect(page.locator("#segs-edit")).toHaveClass(/applied/);
  await page.waitForTimeout(2200);
  const cutWidths = await page.locator("#segs-edit .piece.cut").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  expect(Math.max(...cutWidths)).toBeLessThan(1);
  await expect(page.locator("#edit-badge")).toHaveText("Applied");
  await emit({ type: "tool_end", id: "t3", tool: "apply_cuts", ok: true, summary: "New sequence talk (edit) · 74.9s", outputs: [], ms: 1300 });

  // 4. captions + zooms
  await emit({ type: "tool_start", id: "t4", tool: "make_captions", title: "Writing captions", args: "style: bold-pop", target: { kind: "caption", label: "bold-pop captions" } });
  await expectCursorOn(page, "#lane-captions");
  const words = ["So here's the thing", "nobody tells you", "about editing video", "it's mostly cutting", "the boring parts", "out of the middle", "and keeping energy", "high all the way", "through to the end", "so let's do that"];
  await emit({ type: "timeline", captions: words.map((text, i) => ({ start: i * 7.2, end: i * 7.2 + 6.4, text })) });
  await expect(page.locator("#lane-captions .cap")).toHaveCount(words.length);
  await emit({ type: "tool_end", id: "t4", tool: "make_captions", ok: true, summary: "10 captions added in standalone (style bold-pop)", outputs: [], ms: 800 });
  await emit({ type: "tool_start", id: "t5", tool: "add_zooms", title: "Adding punch-ins", args: "zooms: 3 items", target: { kind: "range", label: "Zoom 115%", start: 12, end: 20 } });
  await expectCursorOn(page, "#range-hi");
  await emit({ type: "timeline", zooms: [{ start: 12, end: 20, scale: 115 }, { start: 33, end: 41, scale: 112 }, { start: 58, end: 66, scale: 120 }] });
  await expect(page.locator("#lane-zooms .zoom")).toHaveCount(3);
  await shot(page, "03-captions-zooms");
  await emit({ type: "tool_end", id: "t5", tool: "add_zooms", ok: true, summary: "3 zooms added in standalone", outputs: [], ms: 120 });

  // 5. media download: pending card, progress ring, then real cards with license badges
  await emit({ type: "tool_start", id: "t6", tool: "download_media", title: "Downloading media", args: 'query: "city at night"', target: { kind: "media", label: "city at night" } });
  await expectCursorOn(page, "#pending-t6");
  await emit({ type: "progress", id: "t6", fraction: 0.6, detail: "broll-city.webm · 3.1 MB" });
  await expect(page.locator("#progress-pct")).toHaveText("60%");
  await shot(page, "04-downloading");
  await emit({
    type: "media",
    items: [
      { path: video, kind: "video", title: "City at night (b-roll)", license: "Pexels", source: "pexels" },
      { path: image, kind: "image", title: "Thumbnail", license: "CC0" },
      { path: audio, kind: "audio", title: "Lo-fi bed", license: "CC BY 4.0", source: "freesound" },
    ],
  });
  await emit({ type: "timeline", clips: [{ path: video, at: 10, duration: 6, track: 2 }, { path: audio, at: 0, duration: 74, track: 2 }] });
  await emit({ type: "tool_end", id: "t6", tool: "download_media", ok: true, summary: "Downloaded 3 files", outputs: [video, image, audio], ms: 3300 });
  await expect(page.locator(".mcard:not(.pending)")).toHaveCount(3);
  await expect(page.locator("#pending-t6")).toHaveCount(0);
  await expect(page.locator(".mcard .badge.lic-free")).toHaveCount(2);
  await expect(page.locator(".mcard .badge.lic-attr")).toHaveCount(1);
  await expect(page.locator(".mcard video")).toHaveCount(1);
  await expect.poll(() => page.locator(".mcard img").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator(".clip")).toHaveCount(2);

  // 6. idle: glow fades out
  await expect(page.locator("body")).toHaveClass(/idle/, { timeout: 5000 });
  await expect.poll(() => glowOpacity(page), { timeout: 5000 }).toBe(0);
  await expect(page.locator(".step.done")).toHaveCount(6);
  await expect(page.locator("#stat-steps")).toHaveText("6");
  await shot(page, "05-done");

  // A late joiner gets the replay.
  const p2 = await page.context().newPage();
  await p2.goto(base);
  await expect(p2.locator(".step.done")).toHaveCount(6);
  await expect(p2.locator("#segs-edit")).toHaveClass(/applied/);
  await expect(p2.locator(".mcard")).toHaveCount(3);
  await p2.close();
});

test("failed tool shows error state", async ({ page }) => {
  await page.goto(base);
  await emit({ type: "tool_start", id: "f1", tool: "render", title: "Rendering the edit", args: "output: final.mp4", target: { kind: "file", label: "final.mp4", path: "/tmp/final.mp4" } });
  await expectCursorOn(page, "#pending-f1");
  await emit({ type: "tool_end", id: "f1", tool: "render", ok: false, summary: "ffmpeg exited with code 1", outputs: [], ms: 900 });
  await expect(page.locator('.step.failed[data-id="f1"]')).toHaveCount(1);
  await expect(page.locator("#progress")).toHaveAttribute("data-mode", "error");
  await expect(page.locator("body")).toHaveClass(/idle/, { timeout: 5000 });
});

test("overlay injects into any page", async ({ page }) => {
  await page.setContent(`<main style="font:16px sans-serif;padding:40px;background:#fff"><h1>Some site</h1><button id="go" style="margin-top:300px">Upload</button></main>`);
  await page.evaluate(`(()=>{const s=document.createElement('script');s.src='${base}overlay.js';document.documentElement.appendChild(s)})()`);
  await page.waitForFunction(() => "OpenEditOverlay" in window);
  await page.waitForTimeout(500);
  await emit({ type: "tool_start", id: "o1", tool: "render", title: "Rendering the edit", args: "", target: { kind: "file", label: "final.mp4", selector: "#go" } });
  const glow = page.locator("#openedit-overlay").locator(".glow");
  await expect.poll(() => glow.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
  await expect
    .poll(async () => {
      const b = await page.locator("#go").boundingBox();
      const h = await page.locator("#openedit-overlay").locator(".hl").boundingBox();
      return b && h ? Math.hypot(b.x + b.width / 2 - (h.x + h.width / 2), b.y + b.height / 2 - (h.y + h.height / 2)) : 999;
    })
    .toBeLessThan(6);
  await shot(page, "06-overlay");
  await emit({ type: "tool_end", id: "o1", tool: "render", ok: true, summary: "done", outputs: [], ms: 10 });
  await expect.poll(() => glow.evaluate((el) => Number(getComputedStyle(el).opacity)), { timeout: 5000 }).toBe(0);
});
