#!/usr/bin/env node
// OpenEdit MCP launcher used by the Claude Code plugin (.mcp.json).
//
// dist/ is not committed, so a fresh plugin install has only the TypeScript sources. On first
// start this script installs dependencies if needed (npm ci --ignore-scripts) and runs the
// TypeScript build, then hands over to dist/cli.js (the MCP server on stdio).
//
// stdout belongs to the MCP protocol: every message from this script and from npm/tsc goes to
// stderr.
//
//   node scripts/openedit-mcp.mjs            build if needed, then run the MCP server
//   node scripts/openedit-mcp.mjs --build    build if needed, then exit (no server)
//   node scripts/openedit-mcp.mjs doctor     any other args are passed to dist/cli.js

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmdirSync, statSync, accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "dist", "cli.js");
const lock = join(root, ".openedit-build.lock");
const isWin = process.platform === "win32";

const log = (msg) => process.stderr.write(`[openedit] ${msg}\n`);

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: ["ignore", 2, 2], shell: isWin, env: process.env });
  if (r.error) throw new Error(`${cmd} ${args.join(" ")}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status}`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function build() {
  try {
    accessSync(root, constants.W_OK);
  } catch {
    throw new Error(`${root} is not writable, so dist/ cannot be built here. Build it yourself: cd "${root}" && npm ci && npm run build`);
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) log(`warning: Node ${process.versions.node} found, OpenEdit needs Node 22+`);
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc) || !existsSync(join(root, "node_modules", "@modelcontextprotocol", "sdk"))) {
    log("installing dependencies (npm ci --ignore-scripts), first run only...");
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  }
  log("building (tsc), first run only...");
  run(process.execPath, [tsc, "-p", "tsconfig.json"]);
  if (!existsSync(cli)) throw new Error("build finished but dist/cli.js is missing");
  log("build done");
}

function ensureBuilt() {
  if (existsSync(cli)) return;
  let owner = false;
  for (let waited = 0; ; waited += 1000) {
    try {
      mkdirSync(lock);
      owner = true;
      break;
    } catch {
      // Another process is building. Take over a stale lock after 10 minutes.
      if (existsSync(cli)) return;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 600_000) rmdirSync(lock);
      } catch {}
      if (waited === 0) log("another OpenEdit build is running, waiting...");
      if (waited > 600_000) throw new Error(`timed out waiting for the build lock ${lock}`);
      sleep(1000);
    }
  }
  try {
    if (!existsSync(cli)) build();
  } finally {
    if (owner) {
      try {
        rmdirSync(lock);
      } catch {}
    }
  }
}

const args = process.argv.slice(2);
try {
  ensureBuilt();
} catch (e) {
  log(`could not build OpenEdit: ${e.message}`);
  log("Requirements: Node 22+ and npm. See docs/SKILLS.md (Install as a Claude plugin).");
  process.exit(1);
}

if (args[0] === "--build") process.exit(0);

// Keep argv shaped like `node dist/cli.js ...args` for the CLI's own parsing.
process.argv = [process.argv[0], cli, ...args];
await import(pathToFileURL(cli).href);
