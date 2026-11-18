// A cancelled/failed motion render must never leave a partial file at the cache path that later renders reuse.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "openedit-cache-"));
process.env.OPENEDIT_HOME = join(TMP, "home");

const outputs: string[] = [];
vi.mock("../src/motion-loader.js", () => ({
  loadMotion: async () => ({
    listTemplates: () => [],
    renderTemplate: async () => {
      throw new Error("not used");
    },
    // Simulates HyperFrames killed mid-render: a partial file at the requested path, then an error.
    renderCaptionOverlay: async (o: { output: string }) => {
      outputs.push(o.output);
      writeFileSync(o.output, "partial");
      throw new Error("killed");
    },
  }),
}));

const { StandaloneHost } = await import("../src/hosts/standalone.js");
const { paths } = await import("../src/engine/paths.js");

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe.skipIf(!hasFfmpeg)("standalone caption overlay cache", () => {
  it("a failed overlay render leaves nothing at the cache path", async () => {
    const src = join(TMP, "src.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x90:r=10:d=1", "-f", "lavfi", "-i", "sine=d=1", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", src]);
    const host = new StandaloneHost(join(TMP, "proj.json"));
    await host.applyCutPlan({ source: src, duration: 1, keep: [{ start: 0, end: 1 }], cuts: [] });
    await host.addCaptions([{ start: 0, end: 0.8, text: "hello" }]);
    await host.renderTimeline({ output: join(TMP, "out.mp4"), quality: "draft" });
    expect(outputs.length).toBe(1);
    const left = readdirSync(paths.renders()).filter((f) => f.startsWith("captions-") && f.endsWith(".mov"));
    expect(left).toEqual([]);
  });
});
