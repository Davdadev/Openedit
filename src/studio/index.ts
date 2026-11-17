// Studio lifecycle for the MCP process: serve in-process, or forward events
// to an already-running studio (another MCP session or the Mac app).
import { spawn } from "node:child_process";
import { ensureToken } from "../hosts/premiere.js";
import { emitStudio, onStudio, SESSION_ID, type StudioEvent } from "./events.js";
import { STUDIO_APP_ID, startStudioServer, studioPort, type StudioServer } from "./server.js";

export { emitStudio, onStudio, reportProgress, studioLog } from "./events.js";
export { startStudioServer, STUDIO_DEFAULT_PORT } from "./server.js";

type Mode = { kind: "local"; server: StudioServer } | { kind: "remote"; port: number; token: string };

let mode: Mode | undefined;
let starting: Promise<Mode | undefined> | undefined;
let unsubscribe: (() => void) | undefined;
const queue: StudioEvent[] = [];
let flushing = false;

export function studioUrl(): string {
  const port = mode?.kind === "local" ? mode.server.port : mode?.kind === "remote" ? mode.port : studioPort();
  return `http://127.0.0.1:${port}/`;
}

async function isStudio(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return ((await r.json()) as { app?: string }).app === STUDIO_APP_ID;
  } catch {
    return false;
  }
}

async function flush(): Promise<void> {
  if (flushing || mode?.kind !== "remote") return;
  flushing = true;
  try {
    while (queue.length && mode?.kind === "remote") {
      const batch = queue.splice(0, 50);
      try {
        const r = await fetch(`http://127.0.0.1:${mode.port}/emit`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-openedit-token": mode.token },
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(3000),
        });
        if (!r.ok) throw new Error(`emit ${r.status}`);
      } catch {
        // The other studio went away: take over serving, keeping the pending events.
        queue.unshift(...batch);
        mode = undefined;
        await ensureStudio();
        if (mode && (mode as Mode).kind === "local") {
          const server = (mode as { server: StudioServer }).server;
          for (const e of queue.splice(0)) server.publish(e);
        }
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

/**
 * Make sure a studio is reachable: start one in-process, or if the port is held
 * by another OpenEdit Studio, forward events to it over POST /emit.
 */
export async function ensureStudio(): Promise<{ url: string; mode: "local" | "remote" } | undefined> {
  if (!mode) {
    starting ??= (async () => {
      const port = studioPort();
      try {
        const server = await startStudioServer({ port });
        server.server.unref();
        return { kind: "local", server } as Mode;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EADDRINUSE" && (await isStudio(port))) {
          return { kind: "remote", port, token: ensureToken() } as Mode;
        }
        process.stderr.write(`openedit studio unavailable: ${(e as Error).message}\n`);
        return undefined;
      }
    })();
    mode = await starting;
    starting = undefined;
    unsubscribe ??= onStudio((evt) => {
      if (mode?.kind === "local") mode.server.publish(evt);
      else {
        queue.push(evt);
        if (queue.length > 1000) queue.splice(0, queue.length - 1000);
        void flush();
      }
    });
  }
  return mode ? { url: studioUrl(), mode: mode.kind } : undefined;
}

/** Called by the MCP server at startup (disable with OPENEDIT_STUDIO=0). */
export async function autoStartStudio(version?: string): Promise<void> {
  if (process.env.OPENEDIT_STUDIO === "0") return;
  const s = await ensureStudio();
  if (s) {
    emitStudio({ type: "session", session: SESSION_ID, version, pid: process.pid });
    process.stderr.write(`openedit studio: ${s.url} (${s.mode})\n`);
  }
}

export function openInBrowser(url: string): boolean {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** One line of JS that injects the overlay (glow border, cursor, status pill) into any page. */
export function overlaySnippet(base = studioUrl()): string {
  return `(()=>{if(window.__openeditOverlay)return'already';const s=document.createElement('script');s.src='${base}overlay.js';document.documentElement.appendChild(s);return'injected'})()`;
}

/** For tests. */
export async function stopStudio(): Promise<void> {
  unsubscribe?.();
  unsubscribe = undefined;
  if (mode?.kind === "local") await mode.server.close();
  mode = undefined;
}
