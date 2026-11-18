import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, spawn } from "node:child_process";

/** The current MCP tool call's AbortSignal (set by the studio instrumentation), so cancelling a call kills its processes. */
const callSignal = new AsyncLocalStorage<AbortSignal | undefined>();

export function runWithSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  return callSignal.run(signal, fn);
}

export function currentSignal(): AbortSignal | undefined {
  return callSignal.getStore();
}

/** Every child process started through this module (or registered), so shutdown can kill them all. */
const live = new Set<ChildProcess>();

/** Track a child started elsewhere; `group` kills its whole process group (detached POSIX children). */
export function trackChild(child: ChildProcess, group = false): void {
  if (group) (child as ChildProcess & { __group?: boolean }).__group = true;
  live.add(child);
  child.once("close", () => live.delete(child));
  child.once("error", () => live.delete(child));
}

/** Kill a tracked child (and its process group when it was spawned detached). */
export function killChild(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  try {
    if ((child as ChildProcess & { __group?: boolean }).__group && child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

let shutdownInstalled = false;

/**
 * For the long-running MCP server: when the client goes away (stdin closes) or the process is
 * signalled, kill every child first. Node's default signal handling exits without touching
 * children, which left ffmpeg renders, whisper and HyperFrames' Chrome running as orphans.
 */
export function installShutdownHandlers(stdin: NodeJS.ReadableStream = process.stdin): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  process.on("exit", () => killAllChildren());
  const signals: [NodeJS.Signals, number][] = [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]];
  for (const [sig, code] of signals) {
    process.on(sig, () => {
      killAllChildren();
      process.exit(code);
    });
  }
  const gone = () => {
    killAllChildren();
    process.exit(0);
  };
  stdin.once("end", gone);
  stdin.once("close", gone);
}

/** Kill every running child (server shutdown: no orphaned ffmpeg / whisper / Chrome). */
export function killAllChildren(): number {
  const n = live.size;
  for (const c of live) killChild(c);
  live.clear();
  return n;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Kill the process after this many ms. */
  timeoutMs?: number;
  /** Text written to stdin (then closed). */
  input?: string;
  cwd?: string;
  /** Do not throw on non-zero exit. */
  allowFailure?: boolean;
  /** Kill the process when aborted. Defaults to the current tool call's signal. */
  signal?: AbortSignal;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly result: RunResult,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

/** Spawn a process without a shell, capture output, reject on non-zero exit. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const signal = opts.signal ?? currentSignal();
    if (signal?.aborted) return reject(new Error(`${cmd} cancelled`));
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    trackChild(child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (e.code === "ENOENT") reject(new Error(`${cmd} not found on PATH`));
      else reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const result: RunResult = {
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      };
      if (cancelled) {
        reject(new CommandError(`${cmd} cancelled`, result));
      } else if (timedOut) {
        reject(new CommandError(`${cmd} timed out after ${opts.timeoutMs}ms`, result));
      } else if (result.code !== 0 && !opts.allowFailure) {
        const tail = result.stderr.trim().split("\n").slice(-8).join("\n");
        reject(new CommandError(`${cmd} exited with code ${result.code}: ${tail}`, result));
      } else {
        resolve(result);
      }
    });
    child.stdin.on("error", () => undefined);
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** True if `cmd` can be executed (used by doctor / capability checks). */
export async function hasCommand(cmd: string, args: string[] = ["-version"]): Promise<boolean> {
  try {
    await run(cmd, args, { allowFailure: true, timeoutMs: 15000 });
    return true;
  } catch {
    return false;
  }
}
