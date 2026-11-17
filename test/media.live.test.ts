import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { downloadResult, readCredits } from "../src/media/download.js";
import { findMedia } from "../src/media/search.js";

// Real network smoke test against keyless providers. Run with: OPENEDIT_LIVE=1 npx vitest run test/media.live.test.ts
const live = process.env.OPENEDIT_LIVE === "1";
const home = mkdtempSync(join(tmpdir(), "oe-live-home-"));
const lib = mkdtempSync(join(tmpdir(), "oe-live-lib-"));
process.env.OPENEDIT_HOME = home;

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(lib, { recursive: true, force: true });
});

describe.skipIf(!live)("live: Openverse + Wikimedia Commons", () => {
  it("Openverse image search + download", async () => {
    const res = await findMedia({ query: "mountain lake", kind: "image", count: 3, providers: ["openverse"], useCache: false, timeoutMs: 20000 });
    console.log("openverse:", res.providers, res.results.map((r) => `${r.gid} | ${r.title} | ${r.license} | ${r.score} | ${r.reason}`));
    expect(res.results.length).toBeGreaterThan(0);
    for (const r of res.results) expect(["cc0", "pd", "cc-by", "cc-by-sa"]).toContain(r.licenseCode);
    let ok = false;
    for (const r of res.results) {
      try {
        const out = await downloadResult(r, { dir: lib });
        console.log("downloaded:", out.path, statSync(out.path).size, "bytes");
        ok = existsSync(out.path) && statSync(out.path).size > 1000;
        if (ok) break;
      } catch (e) {
        console.log("download failed, trying next:", (e as Error).message);
      }
    }
    expect(ok).toBe(true);
  });

  it("Openverse sfx search", async () => {
    const res = await findMedia({ query: "rain", kind: "sfx", count: 3, providers: ["openverse"], useCache: false, timeoutMs: 20000 });
    console.log("openverse sfx:", res.results.map((r) => `${r.gid} | ${r.title} | ${r.duration?.toFixed(1)}s | ${r.license}`));
    expect(res.results.length).toBeGreaterThan(0);
  });

  it("Wikimedia Commons video search + image download with credits", async () => {
    const vids = await findMedia({ query: "ocean waves", kind: "video", count: 3, providers: ["wikimedia"], useCache: false, timeoutMs: 20000 });
    console.log("wikimedia video:", vids.providers, vids.results.map((r) => `${r.gid} | ${r.title} | ${r.width}x${r.height} ${r.duration?.toFixed(1)}s | ${r.license} | by ${r.author}`));
    expect(vids.results.length).toBeGreaterThan(0);
    const imgs = await findMedia({ query: "lighthouse", kind: "image", count: 2, providers: ["wikimedia"], useCache: false, timeoutMs: 20000 });
    expect(imgs.results.length).toBeGreaterThan(0);
    const out = await downloadResult(imgs.results[0], { dir: lib });
    console.log("downloaded:", out.path, statSync(out.path).size, "bytes", "|", out.attributionText);
    expect(statSync(out.path).size).toBeGreaterThan(1000);
    expect(readCredits(lib).length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(lib, "CREDITS.md"))).toBe(true);
  });
});
