// OpenEdit Premiere bridge - HTTP server logic.
//
// Plain CommonJS with Node built-ins only, so the same file runs inside the
// CEP panel (Node via --enable-nodejs --mixed-context) and under plain Node
// for tests. Nothing here touches CEP: the panel injects `evalScript`.
//
//   const { createBridgeServer } = require("./server.js");
//   const bridge = createBridgeServer({ evalScript: (script) => Promise<string> });
//   await bridge.listen();
//
// Wire protocol: docs/PROTOCOL.md in the repository root.
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_PORT = 47821;
const DEFAULT_HOST = "127.0.0.1";
const MAX_BODY = 32 * 1024 * 1024;

const COMMANDS = [
  "ping",
  "status",
  "getTimeline",
  "getSourceMedia",
  "applyCutPlan",
  "addMarkers",
  "importMedia",
  "placeClips",
  "addCaptions",
  "addZooms",
  "render",
  "applyMogrt",
];

// How long the HTTP caller waits for one command. ExtendScript cannot be
// interrupted, so on timeout the queue still waits (up to the same limit)
// before starting the next command.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const COMMAND_TIMEOUT_MS = {
  ping: 15 * 1000,
  status: 30 * 1000,
  render: 4 * 60 * 60 * 1000,
  applyCutPlan: 30 * 60 * 1000,
};

function defaultTokenPath() {
  return path.join(os.homedir(), ".openedit", "token");
}

function readTokenFile(tokenPath) {
  try {
    return fs.readFileSync(tokenPath, "utf8").trim();
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Return the shared token, creating ~/.openedit/token (32 hex chars, mode
 * 600) when it does not exist yet. Whichever side starts first creates it.
 */
function ensureToken(tokenPath) {
  tokenPath = tokenPath || defaultTokenPath();
  const existing = readTokenFile(tokenPath);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(16).toString("hex");
  try {
    // wx: never clobber a token another process just wrote.
    fs.writeFileSync(tokenPath, token, { mode: 0o600, flag: "wx" });
  } catch (e) {
    if (e && e.code === "EEXIST") {
      const raced = readTokenFile(tokenPath);
      if (raced) return raced;
      fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    } else {
      throw e;
    }
  }
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch (e) {
    // Windows ignores POSIX modes.
  }
  return token;
}

function tokensEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * A JavaScript string literal that is safe to splice into ExtendScript
 * source: JSON string syntax with every non-ASCII code unit (and U+2028/2029)
 * escaped as \uXXXX, so nothing depends on the code page of the bridge.
 */
function toScriptLiteral(str) {
  return JSON.stringify(String(str)).replace(/[\u007f-\uffff]/g, function (c) {
    return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

const HOST_NOT_LOADED = "host-not-loaded";

/** ExtendScript source that dispatches one command to $.OpenEdit. */
function buildScript(cmd, args) {
  const c = toScriptLiteral(cmd);
  const a = toScriptLiteral(JSON.stringify(args === undefined ? {} : args));
  return (
    "(function(){try{" +
    "if(typeof $.OpenEdit!=='object'||!$.OpenEdit||typeof $.OpenEdit.dispatch!=='function'){" +
    "return '{\"ok\":false,\"error\":\"" + HOST_NOT_LOADED + "\"}';}" +
    "return $.OpenEdit.dispatch(" + c + "," + a + ");" +
    "}catch(e){return '{\"ok\":false,\"error\":\"dispatch threw: '+String(e).replace(/[\"\\\\\\r\\n]/g,' ')+'\"}';}})()"
  );
}

/** Turn the raw evalScript return string into { ok, result } | { ok, error }. */
function mapRawResult(raw) {
  if (raw === undefined || raw === null || raw === "" || raw === "undefined") {
    return { ok: false, error: "empty response from ExtendScript" };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: "unexpected ExtendScript response type: " + typeof raw };
  }
  if (raw === "EvalScript error.") {
    return {
      ok: false,
      error: "ExtendScript evaluation failed (host script missing or threw a syntax error)",
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: "invalid JSON from ExtendScript: " + raw.slice(0, 200) };
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean") {
    return { ok: false, error: "malformed ExtendScript reply: " + raw.slice(0, 200) };
  }
  if (parsed.ok) return { ok: true, result: parsed.result === undefined ? null : parsed.result };
  return { ok: false, error: String(parsed.error || "unknown ExtendScript error") };
}

/** Serial task queue: ExtendScript is single-threaded, one command at a time. */
function createQueue() {
  let tail = Promise.resolve();
  let depth = 0;
  return {
    run(task) {
      depth++;
      const p = tail.then(() => task());
      tail = p.then(
        () => {
          depth--;
        },
        () => {
          depth--;
        }
      );
      return p;
    },
    get depth() {
      return depth;
    },
  };
}

function withTimeout(promise, ms, message) {
  let timer;
  const t = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: message }), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} opts
 * @param {(script: string) => Promise<string>} opts.evalScript  required
 * @param {() => Promise<unknown>} [opts.reloadHost]  re-evaluates the host .jsx
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 * @param {string} [opts.tokenPath]
 * @param {(ev: object) => void} [opts.onEvent]  log hook for the panel UI
 * @param {object} [opts.timeouts]  per-command ms overrides (tests)
 */
function createBridgeServer(opts) {
  if (!opts || typeof opts.evalScript !== "function") {
    throw new Error("createBridgeServer: evalScript function required");
  }
  const port = opts.port === undefined ? DEFAULT_PORT : opts.port;
  const host = opts.host || DEFAULT_HOST;
  const tokenPath = opts.tokenPath || defaultTokenPath();
  const onEvent = typeof opts.onEvent === "function" ? opts.onEvent : function () {};
  const timeouts = Object.assign({}, COMMAND_TIMEOUT_MS, opts.timeouts || {});
  const queue = createQueue();
  let token = ensureToken(tokenPath);
  let boundPort = port;

  function emit(ev) {
    try {
      onEvent(ev);
    } catch (e) {
      // UI problems never break the bridge
    }
  }

  function currentToken() {
    // Re-read so a token regenerated by the MCP server is picked up.
    try {
      const t = readTokenFile(tokenPath);
      if (t) token = t;
    } catch (e) {
      // keep the cached one
    }
    return token;
  }

  async function evalOnce(cmd, args) {
    let raw;
    try {
      raw = await opts.evalScript(buildScript(cmd, args));
    } catch (e) {
      return { ok: false, error: "evalScript failed: " + (e && e.message ? e.message : String(e)) };
    }
    return mapRawResult(raw);
  }

  /** Run one command through the queue. Never rejects. */
  function execute(cmd, args) {
    if (typeof cmd !== "string" || COMMANDS.indexOf(cmd) < 0) {
      return Promise.resolve({ ok: false, error: "unsupported: " + String(cmd) });
    }
    const ms = timeouts[cmd] || timeouts.default || DEFAULT_TIMEOUT_MS;
    const timeoutMsg =
      "timeout: " + cmd + " did not finish within " + Math.round(ms / 1000) +
      "s (Premiere may still be working on it)";
    const work = queue.run(() =>
      withTimeout(
        (async () => {
          let res = await evalOnce(cmd, args);
          if (!res.ok && res.error === HOST_NOT_LOADED && typeof opts.reloadHost === "function") {
            try {
              await opts.reloadHost();
            } catch (e) {
              // reported below
            }
            res = await evalOnce(cmd, args);
          }
          if (!res.ok && res.error === HOST_NOT_LOADED) {
            res = {
              ok: false,
              error: "ExtendScript host not loaded: reopen the OpenEdit panel (Window > Extensions > OpenEdit)",
            };
          }
          return res;
        })(),
        ms,
        timeoutMsg
      )
    );
    return work.catch((e) => ({ ok: false, error: "internal: " + (e && e.message ? e.message : String(e)) }));
  }

  function send(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
    });
    res.end(body);
  }

  function hostAllowed(req) {
    const h = String(req.headers.host || "").toLowerCase();
    if (!h) return false;
    const name = h.replace(/:\d+$/, "");
    return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error("request body too large"), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  async function handle(req, res) {
    const url = String(req.url || "/").split("?")[0];
    if (!hostAllowed(req)) {
      return send(res, 403, { ok: false, error: "forbidden host" });
    }
    if (url === "/health") {
      if (req.method !== "GET") return send(res, 405, { ok: false, error: "method not allowed" });
      return send(res, 200, { ok: true, host: "premiere" });
    }
    if (url !== "/rpc") {
      return send(res, 404, { ok: false, error: "not found" });
    }
    if (req.method !== "POST") {
      return send(res, 405, { ok: false, error: "method not allowed" });
    }
    if (!tokensEqual(String(req.headers["x-openedit-token"] || ""), currentToken())) {
      emit({ type: "auth-failed", time: Date.now() });
      return send(res, 401, { id: null, ok: false, error: "unauthorized: bad or missing X-OpenEdit-Token" });
    }
    let text;
    try {
      text = await readBody(req);
    } catch (e) {
      return send(res, e.status || 400, { id: null, ok: false, error: e.message });
    }
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      return send(res, 400, { id: null, ok: false, error: "invalid JSON body" });
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return send(res, 400, { id: null, ok: false, error: "request must be a JSON object" });
    }
    const id = msg.id === undefined || msg.id === null ? null : String(msg.id);
    if (typeof msg.cmd !== "string" || !msg.cmd) {
      return send(res, 400, { id, ok: false, error: "missing cmd" });
    }
    const args = msg.args && typeof msg.args === "object" && !Array.isArray(msg.args) ? msg.args : {};
    const started = Date.now();
    emit({ type: "rpc-start", id, cmd: msg.cmd, time: started, queued: queue.depth });
    const out = await execute(msg.cmd, args);
    const ms = Date.now() - started;
    emit({ type: "rpc-end", id, cmd: msg.cmd, ok: out.ok, error: out.error, ms, time: Date.now() });
    if (out.ok) return send(res, 200, { id, ok: true, result: out.result });
    return send(res, 200, { id, ok: false, error: out.error });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      try {
        send(res, 500, { id: null, ok: false, error: "internal: " + (e && e.message) });
      } catch (e2) {
        // socket already gone
      }
    });
  });
  server.keepAliveTimeout = 5000;
  // Long renders must not be cut by Node's default request timeout.
  server.requestTimeout = 0;
  server.headersTimeout = 60000;

  return {
    server,
    execute,
    get port() {
      return boundPort;
    },
    get host() {
      return host;
    },
    get tokenPath() {
      return tokenPath;
    },
    get queueDepth() {
      return queue.depth;
    },
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (e) => {
          server.removeListener("listening", onListening);
          if (e && e.code === "EADDRINUSE") {
            e.message =
              "port " + port + " on " + host + " is already in use (another OpenEdit panel or app is running)";
          }
          reject(e);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          boundPort = server.address().port;
          emit({ type: "listening", port: boundPort, host, time: Date.now() });
          resolve(boundPort);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = {
  createBridgeServer,
  ensureToken,
  defaultTokenPath,
  buildScript,
  mapRawResult,
  toScriptLiteral,
  createQueue,
  COMMANDS,
  DEFAULT_PORT,
};
