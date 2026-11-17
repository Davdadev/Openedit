#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hasCommand, run } from "./engine/exec.js";
import { paths } from "./engine/paths.js";
import { canBurnAss } from "./engine/render.js";
import { WHISPER_MODELS, modelPath } from "./engine/transcribe.js";
import { PremiereHost } from "./hosts/premiere.js";
import { ResolveHost, repoRoot, resolveBridgePath } from "./hosts/resolve.js";
import { runServer, VERSION } from "./mcp/server.js";
import { runStudioCli } from "./studio/standalone.js";
import { keysCommand } from "./media/keys-cli.js";

const HELP = `openedit ${VERSION} — local AI video editing for Claude (MCP)

Usage:
  openedit                 run the MCP server on stdio (what Claude Code launches)
  openedit doctor          check ffmpeg, whisper.cpp, models and editor bridges
  openedit studio [--port N] [--open]   run OpenEdit Studio (live view) on 127.0.0.1:47822
  openedit keys [--status]    set up free stock-media API keys (Pexels, Pixabay, ...)
  openedit install-premiere   show how to install the Premiere Pro panel
  openedit install-resolve    show how to install the DaVinci Resolve bridge
  openedit --version

Add to Claude Code:
  claude mcp add openedit -- node ${join(repoRoot(), "dist", "cli.js")}
`;

function line(ok: boolean | null, label: string, detail = ""): void {
  const mark = ok === null ? "-" : ok ? "✓" : "✗";
  console.log(`  ${mark} ${label}${detail ? `  ${detail}` : ""}`);
}

async function firstLine(cmd: string, args: string[]): Promise<string> {
  const r = await run(cmd, args, { allowFailure: true, timeoutMs: 20000 });
  return (r.stdout || r.stderr).split("\n").find((l) => l.trim()) ?? "";
}

async function doctor(): Promise<number> {
  console.log(`OpenEdit ${VERSION} doctor\n`);
  let failures = 0;

  console.log("Engine");
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const ok = await hasCommand(tool);
    line(ok, tool, ok ? (await firstLine(tool, ["-version"])).replace(/ Copyright.*/, "") : "install with: brew install ffmpeg");
    if (!ok) failures++;
  }
  if (await hasCommand("ffmpeg")) {
    const ass = await canBurnAss();
    line(ass ? true : null, "libass caption burn-in", ass ? "" : "not in this ffmpeg; captions are burned via the motion overlay renderer instead");
  }
  const whisper = await hasCommand("whisper-cli", ["--help"]);
  line(whisper, "whisper-cli", whisper ? "" : "install with: brew install whisper-cpp");
  if (!whisper) failures++;

  const models = WHISPER_MODELS.filter((m) => existsSync(modelPath(m)));
  line(models.length > 0 ? true : null, "whisper models", models.length ? models.join(", ") : `none yet (downloaded on first use into ${paths.models()})`);
  const plans = existsSync(paths.plans()) ? readdirSync(paths.plans()).length : 0;
  line(true, "state dir", `${paths.home()} (${plans} saved plans)`);

  console.log("\nEditors");
  const premiere = new PremiereHost();
  const pOk = await premiere.health(1500);
  if (pOk) {
    const st = await premiere.status();
    line(st.connected, "Premiere Pro panel", [st.version, st.project, st.sequence].filter(Boolean).join(" · ") || st.detail);
  } else line(null, "Premiere Pro panel", "not running (open Premiere > Window > Extensions > OpenEdit)");

  const bridge = resolveBridgePath();
  if (existsSync(bridge)) {
    const st = await new ResolveHost().status(20000);
    line(st.connected ? true : null, "DaVinci Resolve", st.connected ? [st.version, st.project, st.sequence].filter(Boolean).join(" · ") : (st.detail ?? "not connected"));
  } else line(null, "DaVinci Resolve", `bridge missing at ${bridge}`);
  line(true, "Standalone (ffmpeg)", "always available");

  console.log(failures ? `\n${failures} required component(s) missing.` : "\nReady.");
  return failures ? 1 : 0;
}

function installHint(which: "premiere" | "resolve"): number {
  const dir = join(repoRoot(), which);
  const script = join(dir, process.platform === "win32" ? "install.ps1" : "install.sh");
  if (!existsSync(script)) {
    console.error(`Installer not found at ${script}`);
    return 1;
  }
  console.log(`To install the ${which === "premiere" ? "Premiere Pro panel" : "DaVinci Resolve bridge"}, run:\n`);
  console.log(process.platform === "win32" ? `  powershell -ExecutionPolicy Bypass -File "${script}"` : `  bash "${script}"`);
  console.log(`\nDetails: ${join(dir, "README.md")}`);
  return 0;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case undefined:
    case "serve":
    case "mcp":
      await runServer();
      return;
    case "doctor":
      process.exitCode = await doctor();
      return;
    case "studio":
      process.exitCode = await runStudioCli(process.argv.slice(3));
      return;
    case "keys":
      process.exitCode = await keysCommand(process.argv.slice(3));
      return;
    case "install-premiere":
      process.exitCode = installHint("premiere");
      return;
    case "install-resolve":
      process.exitCode = installHint("resolve");
      return;
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command "${cmd}"\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`openedit: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
