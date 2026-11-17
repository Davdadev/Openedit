import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
import { PREMIERE_BRIDGE_PORT } from "./types.js";

/**
 * Read the shared bridge token (bare 32 hex chars), creating it with mode 600
 * if absent. An existing token is never overwritten: whichever side starts
 * first (this server or the Premiere panel) owns it.
 */
export function ensureToken(): string {
  const file = paths.token();
  if (existsSync(file)) {
    const t = readFileSync(file, "utf8").trim();
    if (t) return t;
  }
  try {
    writeFileSync(file, randomBytes(16).toString("hex"), { mode: 0o600, flag: existsSync(file) ? "w" : "wx" });
    chmodSync(file, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return readFileSync(file, "utf8").trim();
}

const LONG_CMDS = new Set<BridgeCommand>(["applyCutPlan", "render", "importMedia", "placeClips", "addCaptions"]);

/** Talks to the OpenEdit CEP panel inside Premiere Pro over localhost HTTP. */
export class PremiereHost implements EditorHost {
  readonly name = "premiere" as const;
  private readonly base: string;

  constructor(port = Number(process.env.OPENEDIT_PREMIERE_PORT) || PREMIERE_BRIDGE_PORT) {
    this.base = `http://127.0.0.1:${port}`;
  }

  /** True if the panel answers GET /health. */
  async health(timeoutMs = 800): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return false;
      const body = (await res.json()) as { ok?: boolean };
      return body.ok === true;
    } catch {
      return false;
    }
  }

  async rpc<T>(cmd: BridgeCommand, args: Record<string, unknown> = {}): Promise<T> {
    const timeoutMs = cmd === "render" ? 6 * 3600_000 : LONG_CMDS.has(cmd) ? 10 * 60_000 : 30_000;
    let res: Response;
    try {
      res = await fetch(`${this.base}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-OpenEdit-Token": ensureToken() },
        body: JSON.stringify({ id: newRequestId(), cmd, args }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(
        `Premiere bridge not reachable at ${this.base} (${(e as Error).message}). ` +
          "Open Premiere Pro and the OpenEdit panel (Window > Extensions > OpenEdit).",
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error("Premiere bridge rejected the token. Reopen the OpenEdit panel so it re-reads ~/.openedit/token.");
    }
    const body = (await res.json()) as BridgeResponse;
    return unwrap<T>(body, cmd);
  }

  async status(): Promise<HostStatus> {
    if (!(await this.health())) {
      return { host: "premiere", connected: false, detail: `No OpenEdit panel answering on ${this.base}` };
    }
    try {
      return { ...(await this.rpc<HostStatus>("status")), host: "premiere" };
    } catch (e) {
      return { host: "premiere", connected: false, detail: (e as Error).message };
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
    if (!opts.srtPath) throw new Error("Premiere needs an SRT file: pass srtPath");
    return this.rpc("addCaptions", { cues, srtPath: opts.srtPath });
  }
  addZooms(zooms: Zoom[]): Promise<number> {
    return this.rpc("addZooms", { zooms });
  }
  render(opts: { output: string; preset?: string }): Promise<{ output: string }> {
    return this.rpc("render", opts);
  }
}
