import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeSourceDetails, writeInterchange } from "../engine/interchange.js";
import { trackChild } from "../engine/exec.js";
import { probe } from "../engine/media.js";
import { paths } from "../engine/paths.js";
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

/** Commands that are safe to repeat when the persistent bridge dies mid-request. */
const READ_ONLY = new Set<BridgeCommand>(["ping", "status", "getTimeline", "getSourceMedia"]);

interface Pending {
  resolve: (line: string) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
  cmd: BridgeCommand;
}

/**
 * A long-lived `openedit_bridge.py --serve` process: newline-delimited JSON
 * requests in, responses matched back by id. Saves a Python start-up and a
 * fusionscript connect per command.
 */
export class BridgeServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private buf = "";
  private errTail = "";

  constructor(
    private readonly python: string,
    private readonly script: string,
  ) {}

  get alive(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  private start(): ChildProcessWithoutNullStreams {
    const child = spawn(this.python, [this.script, "--serve"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    trackChild(child);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      this.buf += d;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        let id: string | undefined;
        try {
          id = (JSON.parse(line) as { id?: string }).id ?? undefined;
        } catch {
          continue;
        }
        const p = id ? this.pending.get(id) : undefined;
        if (!p || !id) continue;
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        if (!this.pending.size) this.setRef(false);
        p.resolve(line);
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      this.errTail = (this.errTail + d.toString("utf8")).slice(-4000);
    });
    const failAll = (why: string) => {
      for (const [id, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error(why));
        this.pending.delete(id);
      }
      if (this.child === child) this.child = null;
    };
    child.on("error", (e) => failAll(`Could not start ${this.python}: ${e.message}`));
    child.on("close", (code) =>
      failAll(`Resolve bridge exited (${code}). ${this.errTail.trim().split("\n").slice(-5).join(" ")}`),
    );
    child.stdin.on("error", () => undefined);
    this.child = child;
    this.setRef(false);
    return child;
  }

  /** Hold the event loop only while a request is in flight; an idle bridge never keeps Node alive. */
  private setRef(on: boolean): void {
    const c = this.child;
    if (!c) return;
    for (const h of [c, c.stdout, c.stderr, c.stdin] as unknown as { ref?: () => void; unref?: () => void }[]) {
      if (on) h.ref?.();
      else h.unref?.();
    }
  }

  request(id: string, line: string, cmd: BridgeCommand, timeoutMs: number): Promise<string> {
    const child = this.alive && this.child ? this.child : this.start();
    return new Promise<string>((ok, fail) => {
      const p: Pending = { resolve: ok, reject: fail, cmd };
      if (timeoutMs) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          // A wedged request blocks the serial loop: restart the process for the next call.
          this.stop();
          fail(new Error(`Resolve bridge timed out after ${timeoutMs / 1000}s running ${cmd}`));
        }, timeoutMs);
      }
      this.pending.set(id, p);
      this.setRef(true);
      child.stdin.write(`${line}\n`);
    });
  }

  stop(): void {
    const c = this.child;
    this.child = null;
    if (c) {
      try {
        c.stdin.end();
        c.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Talks to DaVinci Resolve through resolve/openedit_bridge.py. By default it
 * keeps one persistent `--serve` process (request/response matched by id) and
 * falls back to a one-shot process per command (one JSON line in, one out) if
 * the persistent process can't be used. OPENEDIT_RESOLVE_ONESHOT=1 forces one-shot.
 */
export class ResolveHost implements EditorHost {
  readonly name = "resolve" as const;
  private server: BridgeServer | null = null;
  private persistentBroken = false;

  /** Stop the persistent bridge process (tests, shutdown). */
  close(): void {
    this.server?.stop();
    this.server = null;
  }

  async rpc<T>(cmd: BridgeCommand, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const script = resolveBridgePath();
    if (!existsSync(script)) throw new Error(`Resolve bridge not found at ${script}`);
    const python = process.env.OPENEDIT_RESOLVE_PYTHON || "python3";
    // render may run for hours inside Resolve; the bridge enforces its own timeoutSec.
    const limit = timeoutMs ?? (cmd === "render" ? 0 : cmd === "applyCutPlan" || cmd === "placeClips" ? 10 * 60_000 : 60_000);
    const id = newRequestId();
    const request = JSON.stringify({ id, cmd, args });
    let raw: string | undefined;
    if (process.env.OPENEDIT_RESOLVE_ONESHOT !== "1" && !this.persistentBroken) {
      try {
        this.server ??= new BridgeServer(python, script);
        raw = await this.server.request(id, request, cmd, limit);
      } catch (e) {
        const msg = (e as Error).message;
        // Timeouts are real answers; start-up/crash problems fall back to one-shot.
        if (/timed out/.test(msg)) throw e;
        const couldNotStart = /Could not start/.test(msg);
        if (couldNotStart) this.persistentBroken = true;
        this.server?.stop();
        this.server = null;
        // The bridge died while running an editing command: Resolve may already have done it
        // (a timeline built, clips placed), so re-running it one-shot could duplicate the edit.
        if (!couldNotStart && !READ_ONLY.has(cmd)) {
          throw new Error(`${msg} The ${cmd} command may have partly run in Resolve; check the project before retrying.`);
        }
      }
    }
    raw ??= await this.oneShot(python, script, request, cmd, limit);
    return unwrap<T>(JSON.parse(raw) as BridgeResponse, cmd);
  }

  private oneShot(python: string, script: string, request: string, cmd: BridgeCommand, limit: number): Promise<string> {
    return new Promise<string>((ok, fail) => {
      const child = spawn(python, [script], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      trackChild(child);
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
  async applyCutPlan(plan: CutPlan, opts: { sequenceName?: string } = {}): Promise<{ sequence: string; output?: string }> {
    // Also hand the bridge an FCP7 XML of the same edit: if AppendToTimeline fails it
    // imports that with MediaPool.ImportTimelineFromFile instead.
    let xmlPath: string | undefined;
    try {
      const info = await probe(plan.source);
      const source = await probeSourceDetails(plan.source);
      xmlPath = join(paths.tmp(), `${basename(plan.source, extname(plan.source))}-${newRequestId()}.xml`);
      writeInterchange("fcp7", { plan, info, source, name: opts.sequenceName }, xmlPath);
    } catch {
      xmlPath = undefined; // the XML is only a fallback
    }
    return this.rpc("applyCutPlan", { plan, sequenceName: opts.sequenceName, ...(xmlPath ? { xmlPath } : {}) });
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
