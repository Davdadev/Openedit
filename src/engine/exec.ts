import { spawn } from "node:child_process";

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
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
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
      if (e.code === "ENOENT") reject(new Error(`${cmd} not found on PATH`));
      else reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const result: RunResult = {
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      };
      if (timedOut) {
        reject(new CommandError(`${cmd} timed out after ${opts.timeoutMs}ms`, result));
      } else if (result.code !== 0 && !opts.allowFailure) {
        const tail = result.stderr.trim().split("\n").slice(-8).join("\n");
        reject(new CommandError(`${cmd} exited with code ${result.code}: ${tail}`, result));
      } else {
        resolve(result);
      }
    });
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
