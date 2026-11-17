import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { newRequestId, unwrap } from "./bridge.js";
import type {
  BridgeCommand,
  BridgeResponse,
  CaptionCue,
  ClipPlacement,
  CutPlan,
  EditorHost,
  HostStatus,
  Marker,
  TimelineInfo,
  Zoom,
} from "./types.js";

/** Repository root (works from src/hosts via tsx and from dist/hosts after build). */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function resolveBridgePath(): string {
  return process.env.OPENEDIT_RESOLVE_BRIDGE || join(repoRoot(), "resolve", "openedit_bridge.py");
}

/**
 * Talks to DaVinci Resolve through resolve/openedit_bridge.py: one process
 * per command, one JSON request line on stdin, one JSON response line on stdout.
 */
export class ResolveHost implements EditorHost {
  readonly name = "resolve" as const;

  async rpc<T>(cmd: BridgeCommand, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const script = resolveBridgePath();
    if (!existsSync(script)) throw new Error(`Resolve bridge not found at ${script}`);
    const python = process.env.OPENEDIT_RESOLVE_PYTHON || "python3";
    // render may run for hours inside Resolve; the bridge enforces its own timeoutSec.
    const limit = timeoutMs ?? (cmd === "render" ? 0 : cmd === "applyCutPlan" || cmd === "placeClips" ? 10 * 60_000 : 60_000);
    const request = JSON.stringify({ id: newRequestId(), cmd, args });
    const raw = await new Promise<string>((ok, fail) => {
      const child = spawn(python, [script], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      let out = "";
      let err = "";
      const timer = limit
        ? setTimeout(() => {
            child.kill("SIGKILL");
            fail(new Error(`Resolve bridge timed out after ${limit / 1000}s running ${cmd}`));
          }, limit)
        : undefined;
      child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
      child.on("error", (e) => {
        if (timer) clearTimeout(timer);
        fail(new Error(`Could not start ${python}: ${e.message}`));
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        const line = out
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("{"))
          .pop();
        if (line) ok(line);
        else fail(new Error(`Resolve bridge exited (${code}) without a response. ${err.trim().split("\n").slice(-5).join(" ")}`));
      });
      child.stdin.end(`${request}\n`);
    });
    return unwrap<T>(JSON.parse(raw) as BridgeResponse, cmd);
  }

  /** Bridge `status` never fails: it reports connected:false with a detail when Resolve is unavailable. */
  async status(timeoutMs = 20_000): Promise<HostStatus> {
    try {
      return { ...(await this.rpc<HostStatus>("status", {}, timeoutMs)), host: "resolve" };
    } catch (e) {
      return { host: "resolve", connected: false, detail: (e as Error).message };
    }
  }

  getTimeline(): Promise<TimelineInfo> {
    return this.rpc("getTimeline");
  }
  getSourceMedia(): Promise<string[]> {
    return this.rpc("getSourceMedia");
  }
  applyCutPlan(plan: CutPlan, opts: { sequenceName?: string } = {}): Promise<{ sequence: string; output?: string }> {
    return this.rpc("applyCutPlan", { plan, sequenceName: opts.sequenceName });
  }
  addMarkers(markers: Marker[]): Promise<number> {
    return this.rpc("addMarkers", { markers });
  }
  importMedia(paths: string[]): Promise<number> {
    return this.rpc("importMedia", { paths });
  }
  placeClips(clips: ClipPlacement[]): Promise<number> {
    return this.rpc("placeClips", { clips });
  }
  addCaptions(cues: CaptionCue[], opts: { srtPath?: string } = {}): Promise<{ added: number; file?: string }> {
    if (!opts.srtPath) throw new Error("Resolve needs an SRT file: pass srtPath");
    return this.rpc("addCaptions", { cues, srtPath: opts.srtPath });
  }
  addZooms(zooms: Zoom[]): Promise<number> {
    return this.rpc("addZooms", { zooms });
  }
  render(opts: { output: string; preset?: string }): Promise<{ output: string }> {
    return this.rpc("render", opts);
  }
}
