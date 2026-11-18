// Regression tests for defects found in the bug-hunt pass (engine, studio, exec).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const TMP = mkdtempSync(join(tmpdir(), "openedit-bughunt-"));
process.env.OPENEDIT_HOME = join(TMP, "home");
process.env.OPENEDIT_MODELS = join(TMP, "models");

const { probe, extractAudio } = await import("../src/engine/media.js");
const { renderCutPlan, filterPath } = await import("../src/engine/render.js");
const { ffFilterPath } = await import("../src/motion/index.js");
const { stamp, ensureModel, modelPath } = await import("../src/engine/transcribe.js");
const { sidecarPath, paths } = await import("../src/engine/paths.js");
const { run } = await import("../src/engine/exec.js");
const { instrumentHandler } = await import("../src/studio/instrument.js");
const { startStudioServer } = await import("../src/studio/server.js");
const { StandaloneHost } = await import("../src/hosts/standalone.js");
const { PremiereHost } = await import("../src/hosts/premiere.js");
const { ResolveHost } = await import("../src/hosts/resolve.js");
const { createServer: createHttpServer } = await import("node:http");

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

function ff(args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

describe.skipIf(!hasFfmpeg)("media with ffmpeg", () => {
  const rotated = join(TMP, "rotated.mp4");
  const audio = join(TMP, "tone.m4a");
  beforeAll(() => {
    const coded = join(TMP, "coded.mp4");
    ff(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", coded]);
    // iPhone-style portrait: landscape coded frames + a 90° display matrix.
    ff(["-display_rotation", "90", "-i", coded, "-c", "copy", rotated]);
    ff(["-f", "lavfi", "-i", "sine=f=440:d=1:sample_rate=22050", "-ac", "1", "-c:a", "aac", audio]);
  });

  it("probe reports the displayed (rotated) frame size of phone video", async () => {
    const info = await probe(rotated);
    expect(info.width).toBe(180);
    expect(info.height).toBe(320);
    expect(info.rotation).toBe(90);
  });

  it("a rotated source renders upright, not squashed into the coded size", async () => {
    const info = await probe(rotated);
    const out = join(TMP, "rotated-out.mp4");
    const r = await renderCutPlan({ source: rotated, duration: info.duration, keep: [{ start: 0, end: 0.5 }], cuts: [] }, out, { preset: "ultrafast" });
    expect([r.width, r.height]).toEqual([180, 320]);
    const o = await probe(out);
    expect([o.width, o.height]).toEqual([180, 320]);
  });

  it("filtergraph path escaping survives quotes, commas, colons, brackets, semicolons and emoji", () => {
    const dir = join(TMP, "it's, a \"test\": [cut] 🎬;x=1");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "clip [1].mp4");
    ff(["-f", "lavfi", "-i", "testsrc2=s=64x64:r=10:d=0.3", "-c:v", "libx264", "-preset", "ultrafast", f]);
    for (const esc of [filterPath, ffFilterPath]) {
      const g = join(TMP, "graph.txt");
      writeFileSync(g, `movie=filename=${esc(f)},trim=end=0.1[o]`);
      expect(() => ff(["-/filter_complex", g, "-map", "[o]", "-f", "null", "-"])).not.toThrow();
    }
  });

  it("an edit shorter than one frame fails with a clear message instead of an encoder error", async () => {
    const info = await probe(rotated);
    await expect(renderCutPlan({ source: rotated, duration: info.duration, keep: [{ start: 0.5, end: 0.51 }], cuts: [] }, join(TMP, "tiny.mp4"), {})).rejects.toThrow(/shorter than one frame/);
  });

  it("an audio-only render reports no video encoder (not '-c:a')", async () => {
    const r = await renderCutPlan({ source: audio, duration: 1, keep: [{ start: 0, end: 0.5 }], cuts: [] }, join(TMP, "tone-out.m4a"), {});
    expect(r.encoder).not.toBe("-c:a");
    expect(r.encoder).toBeUndefined();
  });

  it("concurrent audio extraction of the same file does not race on one temp file", async () => {
    const results = await Promise.all([extractAudio(audio), extractAudio(audio), extractAudio(audio)]);
    expect(new Set(results).size).toBe(1);
    expect(existsSync(results[0])).toBe(true);
    expect(readdirSync(paths.audioCache()).filter((f) => f.includes(".part"))).toEqual([]);
  });
});

describe("timestamps and paths", () => {
  it("stamp never prints 60 seconds", () => {
    expect(stamp(59.97)).toBe("[01:00.0]");
    expect(stamp(119.96)).toBe("[02:00.0]");
    expect(stamp(61.24)).toBe("[01:01.2]");
  });

  it("sidecar paths only replace the file extension, never a dot in a folder name", () => {
    expect(sidecarPath("/Users/a.b/final", ".srt")).toBe("/Users/a.b/final.srt");
    expect(sidecarPath("/Users/a.b/final.mp4", ".srt")).toBe("/Users/a.b/final.srt");
    expect(sidecarPath("C:\\v.1\\out", ".srt")).toBe("C:\\v.1\\out.srt");
  });
});

describe("whisper model download", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("two concurrent first-run downloads both succeed and leave no partial file", async () => {
    const body = "x".repeat(1000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream({ start(c) { setTimeout(() => { c.enqueue(new TextEncoder().encode(body)); c.close(); }, 30); } }), { headers: { "content-length": "1000" } })),
    );
    const [a, b] = await Promise.all([ensureModel("tiny"), ensureModel("tiny")]);
    expect(a).toBe(modelPath("tiny"));
    expect(b).toBe(a);
    expect(readdirSync(paths.models()).filter((f) => f.includes(".part"))).toEqual([]);
  });

  it("a truncated download is not installed as the model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("short", { headers: { "content-length": "999999" } })),
    );
    await expect(ensureModel("small")).rejects.toThrow(/incomplete|truncated|size/i);
    expect(existsSync(modelPath("small"))).toBe(false);
  });
});

describe("cancellation", () => {
  it("run() kills the child when the tool call is cancelled", async () => {
    const ac = new AbortController();
    const handler = instrumentHandler("probe_media", true, async () => {
      await run("sleep", ["30"]);
      return { content: [{ type: "text", text: "done" }] };
    });
    const t0 = Date.now();
    const p = handler({}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    await expect(p).rejects.toThrow(/cancel/i);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("run() honours an explicit AbortSignal", async () => {
    const ac = new AbortController();
    const p = run("sleep", ["30"], { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toThrow(/cancel/i);
  });
});

describe("studio server hardening", () => {
  let s: Awaited<ReturnType<typeof startStudioServer>>;
  beforeAll(async () => {
    s = await startStudioServer({ port: 0, token: "t".repeat(32) });
  });
  afterAll(async () => {
    await s.close();
  });

  it("never serves the bridge token or API keys from the state dir", async () => {
    const home = paths.home();
    writeFileSync(join(home, "token"), "secret-token");
    writeFileSync(join(home, ".env"), "PEXELS_API_KEY=abc");
    mkdirSync(join(home, "plans"), { recursive: true });
    for (const f of ["token", ".env"]) {
      const r = await fetch(`${s.url}media?path=${encodeURIComponent(join(home, f))}`);
      expect(r.status).toBe(403);
    }
  });

  it("cross-origin pages get a redacted event stream (no paths, args or captions)", async () => {
    s.publish({ type: "tool_start", id: "x1", tool: "transcribe", title: "Transcribing speech", args: "path: secret-interview.mp4", target: { kind: "file", label: "secret-interview.mp4", path: "/Users/me/secret-interview.mp4" } });
    s.publish({ type: "timeline", captions: [{ start: 0, end: 1, text: "private words" }] });
    s.publish({ type: "tool_end", id: "x1", tool: "transcribe", ok: true, summary: "Transcript of /Users/me/secret-interview.mp4", outputs: ["/Users/me/secret-interview.json"] });
    const read = async (headers: Record<string, string>) => {
      const ac = new AbortController();
      const r = await fetch(`${s.url}events`, { headers, signal: ac.signal });
      const reader = r.body!.getReader();
      let txt = "";
      while (!txt.includes("event: replay")) txt += new TextDecoder().decode((await reader.read()).value);
      while (!/event: replay\ndata: .*\n\n/.test(txt)) txt += new TextDecoder().decode((await reader.read()).value);
      ac.abort();
      return txt;
    };
    const cross = await read({ origin: "https://evil.example" });
    expect(cross).not.toContain("/Users/me");
    expect(cross).not.toContain("private words");
    expect(cross).toContain("Transcribing speech");
    const same = await read({});
    expect(same).toContain("/Users/me/secret-interview.mp4");
  });
});

describe("standalone project file", () => {
  it("is written atomically (no temp files left, valid JSON after each save)", async () => {
    const file = join(TMP, "proj", "standalone.json");
    const host = new StandaloneHost(file);
    host.setCaptionStyle("clean");
    host.setOutputAspect("9:16");
    expect(readdirSync(join(TMP, "proj"))).toEqual(["standalone.json"]);
    expect(new StandaloneHost(file).getProject().outputAspect).toBe("9:16");
  });
});

describe("premiere bridge client", () => {
  it("a non-JSON reply (proxy, crashed panel) gives an error naming the HTTP status, not a JSON parse error", async () => {
    const srv = createHttpServer((_req, res) => {
      res.writeHead(502, { "content-type": "text/html" });
      res.end("<html>Bad gateway</html>");
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
    const port = (srv.address() as { port: number }).port;
    try {
      await expect(new PremiereHost(port).rpc("ping")).rejects.toThrow(/HTTP 502/);
    } finally {
      srv.close();
    }
  });
});

describe("resolve bridge client", () => {
  const hasPython = spawnSync("python3", ["--version"]).status === 0;
  it.skipIf(!hasPython)("does not silently re-run an editing command after the persistent bridge died mid-command", async () => {
    const log = join(TMP, "resolve-calls.log");
    const script = join(TMP, "crashy_bridge.py");
    writeFileSync(
      script,
      [
        "import json, sys",
        `LOG = ${JSON.stringify(log)}`,
        "def handle(line):",
        "    req = json.loads(line)",
        "    open(LOG, 'a').write(req['cmd'] + '\\n')",
        "    return req",
        "if '--serve' in sys.argv:",
        "    for line in sys.stdin:",
        "        req = handle(line)",
        "        os_exit = __import__('os')._exit",
        "        os_exit(3)  # crash after the editor already did the work",
        "else:",
        "    req = handle(sys.stdin.readline())",
        "    print(json.dumps({'id': req['id'], 'ok': True, 'result': 1}))",
      ].join("\n"),
    );
    const saved = process.env.OPENEDIT_RESOLVE_BRIDGE;
    process.env.OPENEDIT_RESOLVE_BRIDGE = script;
    const host = new ResolveHost();
    try {
      await expect(host.addMarkers([{ time: 1, name: "x" }])).rejects.toThrow(/exited/);
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["addMarkers"]);
      // Read-only commands may still fall back to a one-shot process.
      expect(await host.rpc("ping")).toBe(1);
    } finally {
      host.close();
      if (saved === undefined) delete process.env.OPENEDIT_RESOLVE_BRIDGE;
      else process.env.OPENEDIT_RESOLVE_BRIDGE = saved;
    }
  });
});
