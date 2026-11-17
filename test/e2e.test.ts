import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = resolve("test/.tmp");
process.env.OPENEDIT_HOME = join(TMP, "home");
process.env.OPENEDIT_MODELS = process.env.OPENEDIT_MODELS || join(homedir(), ".openedit", "models");
process.env.OPENEDIT_HOST = "standalone";

const { probe } = await import("../src/engine/media.js");
const { detectSilences } = await import("../src/engine/silence.js");
const { transcribe } = await import("../src/engine/transcribe.js");
const { buildCutPlan, summarizePlan } = await import("../src/engine/cutplan.js");
const { cuesFromTranscript } = await import("../src/engine/captions.js");
const { StandaloneHost } = await import("../src/hosts/standalone.js");
const { createServer } = await import("../src/mcp/server.js");

const canRun = process.platform === "darwin" && hasBin("say") && hasBin("ffmpeg") && hasBin("whisper-cli");

function hasBin(b: string): boolean {
  try {
    execFileSync("which", [b], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const SAMPLE = join(TMP, "sample.mp4");

describe.skipIf(!canRun)("end to end (ffmpeg + whisper + say)", () => {
  beforeAll(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    const aiff = join(TMP, "speech.aiff");
    execFileSync("say", [
      "-o", aiff,
      "Hello there. [[slnc 1500]] This is a test. um [[slnc 1200]] of open edit. [[slnc 900]] This is a test of open edit. [[slnc 1400]] Goodbye.",
    ]);
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
      "-i", aiff,
      "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
      SAMPLE,
    ]);
  });
  afterAll(() => {
    if (!process.env.KEEP_TMP) rmSync(TMP, { recursive: true, force: true });
  });

  it("detects the inserted pauses", async () => {
    const silences = await detectSilences(SAMPLE, { thresholdDb: -35, minDuration: 0.5 });
    const long = silences.filter((s) => s.end - s.start > 0.8);
    expect(long.length).toBeGreaterThanOrEqual(4);
  });

  it("transcribes with word timestamps (tiny model) and caches", async () => {
    const a = await transcribe(SAMPLE, { model: "tiny", language: "en" });
    const words = a.transcript.segments.flatMap((s) => s.words);
    expect(words.length).toBeGreaterThan(8);
    expect(words.map((w) => w.text.toLowerCase()).join(" ")).toContain("test");
    for (const w of words) expect(w.end).toBeGreaterThan(w.start);
    const b = await transcribe(SAMPLE, { model: "tiny", language: "en" });
    expect(b.cached).toBe(true);
  });

  it("plans, applies and renders a shorter standalone edit", async () => {
    const info = await probe(SAMPLE);
    const silences = await detectSilences(SAMPLE);
    const { transcript } = await transcribe(SAMPLE, { model: "tiny", language: "en" });
    const plan = buildCutPlan({ source: SAMPLE, duration: info.duration, silences, transcript, removeFillers: true, removeRetakes: true });
    const sum = summarizePlan(plan);
    expect(sum.timeSaved).toBeGreaterThan(3);

    const host = new StandaloneHost(join(TMP, "project.json"));
    await host.applyCutPlan(plan, { sequenceName: "e2e" });
    await host.addCaptions(cuesFromTranscript(transcript, { plan }));
    await host.addZooms([{ start: 0.5, end: 1.5, scale: 115 }]);
    const out = join(TMP, "out.mp4");
    const r = await host.renderTimeline({ output: out, burnCaptions: false, loudnorm: true, preset: "ultrafast" });
    const outInfo = await probe(r.output);
    expect(outInfo.hasVideo && outInfo.hasAudio).toBe(true);
    expect(outInfo.duration).toBeLessThan(info.duration - 3);
    expect(Math.abs(outInfo.duration - sum.editedDuration)).toBeLessThan(0.25);
    expect(existsSync(join(TMP, "out.srt"))).toBe(true);

    const tl = await host.getTimeline();
    expect(tl.clips.filter((c) => c.kind === "video")).toHaveLength(plan.keep.length);
  });

  it.skipIf(process.env.OPENEDIT_SKIP_MOTION === "1")("burns animated captions via the motion overlay", async () => {
    const host = new StandaloneHost(join(TMP, "project.json"));
    expect(host.getProject().captions.length).toBeGreaterThan(0);
    const out = join(TMP, "captioned.mp4");
    const r = await host.renderTimeline({ output: out, preset: "ultrafast" });
    expect(r.warnings).toEqual([]);
    const outInfo = await probe(out);
    expect(outInfo.duration).toBeGreaterThan(1);
  });

  it("drives the whole workflow through the MCP server", async () => {
    const server = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(ct);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      const t = res.content.map((c) => c.text).join("\n");
      if (res.isError) throw new Error(`${name}: ${t}`);
      return t;
    };

    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["editor_status", "transcribe", "plan_cuts", "apply_cuts", "make_captions", "auto_zooms", "render", "render_motion"]));
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toContain("auto_edit");

    expect(await call("editor_status")).toContain('"host": "standalone"');
    expect(await call("transcribe", { path: SAMPLE, model: "tiny", language: "en" })).toMatch(/\[00:0\d\.\d\]/);
    const planText = await call("plan_cuts", { path: SAMPLE, removeRetakes: true, model: "tiny", language: "en" });
    const planId = /planId: (\S+)/.exec(planText)![1];
    expect(await call("show_plan", { planId })).toContain("Kept segments");
    expect(await call("apply_cuts", { planId })).toContain("standalone");
    expect(await call("make_captions", { planId, style: "bold-pop", model: "tiny", language: "en" })).toMatch(/captions added/);
    await call("add_markers", { markers: [{ time: 1, name: "Intro" }] });
    expect(await call("auto_zooms", { planId, every: 0.5 })).toContain("punch-ins");
    const out = join(TMP, "mcp-vertical.mp4");
    const rendered = JSON.parse(await call("render", { output: out, reframe: "9:16", burnCaptions: false, preset: "ultrafast" }));
    expect(rendered.width).toBe(202);
    expect(rendered.height).toBe(360);
    const outInfo = await probe(out);
    expect(outInfo.width).toBe(202);
    await client.close();
  });
});
