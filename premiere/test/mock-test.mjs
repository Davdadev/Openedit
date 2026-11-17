// Mock test for the OpenEdit Premiere bridge. Runs under plain Node, no CEP.
//
//   node premiere/test/mock-test.mjs
//
// Part 1 exercises lib/server.js over real HTTP with a mocked evalScript:
// token auth, /health, request queueing, error mapping, timeouts, reload.
// Part 2 loads the real host/*.jsx files into a Node vm with a tiny fake of
// the ExtendScript globals ($, File, Folder, app) and drives dispatch() with
// scripts built by buildScript(), so escaping and the JSON code are checked
// end to end.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const premiereDir = path.resolve(here, "..");
const lib = require(path.join(premiereDir, "lib", "server.js"));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ok   " + name);
  } catch (e) {
    failed++;
    console.log("  FAIL " + name);
    console.log("       " + (e && e.stack ? e.stack.split("\n").slice(0, process.env.VERBOSE ? 60 : 4).join("\n       ") : e));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openedit-premiere-test-"));
const tokenPath = path.join(tmp, "sub", "token");

// ---------------------------------------------------------------- part 1

// Mock ExtendScript: evaluates the built script against a fake $.OpenEdit
// whose dispatch() behaviour is chosen per command.
const calls = [];
let inFlight = 0;
let maxInFlight = 0;
let hostLoaded = true;
let reloads = 0;

function fakeDispatch(cmd, argsText) {
  const args = JSON.parse(argsText);
  calls.push({ cmd, args });
  switch (cmd) {
    case "ping":
      return JSON.stringify({ ok: true, result: "pong" });
    case "getTimeline":
      return JSON.stringify({ ok: true, result: { echo: args } });
    case "addMarkers":
      return JSON.stringify({ ok: false, error: "No active sequence" });
    case "importMedia":
      return "EvalScript error.";
    case "placeClips":
      return "this is not json";
    case "addZooms":
      return "";
    case "addCaptions":
      return JSON.stringify({ result: 1 });
    default:
      return JSON.stringify({ ok: true, result: cmd });
  }
}

async function mockEvalScript(script) {
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    await sleep(15);
    if (script.includes('"render"')) throw new Error("CEP bridge exploded");
    if (script.includes('"status"') && script.includes("hang")) {
      await sleep(400);
    }
    const sandbox = {
      $: hostLoaded ? { OpenEdit: { dispatch: fakeDispatch } } : {},
    };
    vm.createContext(sandbox);
    return vm.runInContext(script, sandbox);
  } finally {
    inFlight--;
  }
}

const bridge = lib.createBridgeServer({
  evalScript: mockEvalScript,
  reloadHost: async () => {
    reloads++;
    hostLoaded = true;
  },
  port: 0,
  tokenPath,
  timeouts: { status: 150 },
});
const port = await bridge.listen();
const base = `http://127.0.0.1:${port}`;
const token = fs.readFileSync(tokenPath, "utf8");

async function rpc(body, headers = {}) {
  const res = await fetch(base + "/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenEdit-Token": token, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

console.log("server (mock evalScript)");

await test("token file is created: 32 hex chars, mode 600", () => {
  assert.match(token, /^[0-9a-f]{32}$/);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
  }
  // A second call returns the same token instead of overwriting it.
  assert.equal(lib.ensureToken(tokenPath), token);
});

await test("GET /health answers without a token", async () => {
  const res = await fetch(base + "/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, host: "premiere" });
});

await test("missing token -> 401", async () => {
  const r = await rpc({ id: "a", cmd: "ping", args: {} }, { "X-OpenEdit-Token": "" });
  assert.equal(r.status, 401);
  assert.equal(r.json.ok, false);
});

await test("wrong token -> 401, evalScript not called", async () => {
  const before = calls.length;
  const r = await rpc({ id: "a", cmd: "ping", args: {} }, { "X-OpenEdit-Token": "0".repeat(32) });
  assert.equal(r.status, 401);
  assert.equal(calls.length, before);
});

await test("ping round-trips and echoes id", async () => {
  const r = await rpc({ id: "abc", cmd: "ping", args: {} });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { id: "abc", ok: true, result: "pong" });
});

await test("invalid JSON body -> 400", async () => {
  const r = await rpc("{nope");
  assert.equal(r.status, 400);
  assert.equal(r.json.ok, false);
});

await test("missing cmd -> 400", async () => {
  const r = await rpc({ id: "x", args: {} });
  assert.equal(r.status, 400);
});

await test("unknown command -> unsupported:, never reaches ExtendScript", async () => {
  const before = calls.length;
  const r = await rpc({ id: "u", cmd: "deleteEverything", args: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /^unsupported:/);
  assert.equal(calls.length, before);
});

await test("unknown path -> 404, bad Host header -> 403", async () => {
  const r = await fetch(base + "/nope");
  assert.equal(r.status, 404);
  const http = await import("node:http");
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/health", headers: { Host: "evil.example:80" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
});

await test("args with non-ASCII, quotes and U+2028 arrive intact", async () => {
  const args = { text: "caf\u00e9 \u65e5\u672c \"q\" back\\slash \u2028 line\nbreak \ud83c\udfac", n: [1, 2.5, null, true] };
  const r = await rpc({ id: "uni", cmd: "getTimeline", args });
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.result.echo, args);
  const script = lib.buildScript("getTimeline", args);
  assert.ok(/^[\x00-\x7e]*$/.test(script), "built script must be pure ASCII");
});

await test("commands are serialized (never more than one in ExtendScript)", async () => {
  maxInFlight = 0;
  const start = calls.length;
  const ids = ["q1", "q2", "q3", "q4", "q5", "q6"];
  const results = await Promise.all(ids.map((id) => rpc({ id, cmd: "getTimeline", args: { id } })));
  assert.equal(maxInFlight, 1);
  for (let i = 0; i < ids.length; i++) {
    assert.equal(results[i].json.id, ids[i]);
    assert.equal(results[i].json.result.echo.id, ids[i]);
  }
  // Every request ran exactly once (HTTP arrival order across sockets is
  // not deterministic, so order is checked in-process below).
  assert.deepEqual(calls.slice(start).map((c) => c.args.id).sort(), ids.slice().sort());
});

await test("queue runs commands in submission order", async () => {
  maxInFlight = 0;
  const start = calls.length;
  const ids = ["o1", "o2", "o3", "o4", "o5"];
  const results = await Promise.all(ids.map((id) => bridge.execute("getTimeline", { id })));
  assert.equal(maxInFlight, 1);
  assert.deepEqual(results.map((r) => r.result.echo.id), ids);
  assert.deepEqual(calls.slice(start).map((c) => c.args.id), ids);
});

await test("error mapping: host error passes through", async () => {
  const r = await rpc({ id: "e1", cmd: "addMarkers", args: { markers: [] } });
  assert.deepEqual(r.json, { id: "e1", ok: false, error: "No active sequence" });
});

await test("error mapping: 'EvalScript error.'", async () => {
  const r = await rpc({ id: "e2", cmd: "importMedia", args: { paths: [] } });
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /ExtendScript evaluation failed/);
});

await test("error mapping: non-JSON reply", async () => {
  const r = await rpc({ id: "e3", cmd: "placeClips", args: { clips: [] } });
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /invalid JSON from ExtendScript/);
});

await test("error mapping: empty reply", async () => {
  const r = await rpc({ id: "e4", cmd: "addZooms", args: { zooms: [] } });
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /empty response/);
});

await test("error mapping: JSON without ok flag", async () => {
  const r = await rpc({ id: "e5", cmd: "addCaptions", args: {} });
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /malformed/);
});

await test("error mapping: evalScript throws", async () => {
  const r = await rpc({ id: "e6", cmd: "render", args: { output: "/tmp/x.mp4" } });
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /evalScript failed: CEP bridge exploded/);
});

await test("host not loaded -> reloadHost() then retry succeeds", async () => {
  hostLoaded = false;
  reloads = 0;
  const r = await rpc({ id: "rl", cmd: "ping", args: {} });
  assert.equal(reloads, 1);
  assert.deepEqual(r.json, { id: "rl", ok: true, result: "pong" });
});

await test("timeout returns an error and the queue keeps going", async () => {
  const slow = rpc({ id: "slow", cmd: "status", args: { hang: true } });
  const next = rpc({ id: "next", cmd: "ping", args: {} });
  const [a, b] = await Promise.all([slow, next]);
  assert.equal(a.json.ok, false);
  assert.match(a.json.error, /^timeout:/);
  assert.deepEqual(b.json, { id: "next", ok: true, result: "pong" });
});

await test("token rotated on disk is picked up", async () => {
  const newToken = "f".repeat(32);
  fs.writeFileSync(tokenPath, newToken);
  const r = await rpc({ id: "rot", cmd: "ping", args: {} }, { "X-OpenEdit-Token": newToken });
  assert.equal(r.json.ok, true);
  const old = await rpc({ id: "rot2", cmd: "ping", args: {} });
  assert.equal(old.status, 401);
  fs.writeFileSync(tokenPath, token);
});

await bridge.close();

// ---------------------------------------------------------------- part 2

console.log("host/*.jsx in a fake ExtendScript vm");

const hostDir = path.join(premiereDir, "host");

function makeFile(p) {
  const fsName = path.resolve(String(p));
  return {
    fsName,
    get name() {
      return encodeURI(path.basename(fsName));
    },
    get exists() {
      return fs.existsSync(fsName);
    },
    get parent() {
      return makeFolder(path.dirname(fsName));
    },
  };
}
function makeFolder(p) {
  const f = makeFile(p);
  f.getFiles = () => [];
  f.create = () => true;
  return f;
}

// Minimal fake Premiere DOM: one sequence with one clip and one marker.
const TPS = 254016000000;
const t = (sec) => ({ ticks: String(Math.round(sec * TPS)), seconds: sec });
const fakeMarkers = [];
const markerColl = {
  getFirstMarker: () => fakeMarkers[0] || null,
  getNextMarker: (m) => fakeMarkers[fakeMarkers.indexOf(m) + 1] || null,
  createMarker(sec) {
    const m = {
      start: t(sec),
      end: t(sec),
      name: "",
      comments: "",
      color: 0,
      setColorByIndex(i) {
        this.color = i;
      },
      getColorByIndex() {
        return this.color;
      },
    };
    fakeMarkers.push(m);
    return m;
  },
};
const clip = {
  name: "interview.mov",
  start: t(0),
  end: t(10),
  inPoint: t(5),
  outPoint: t(15),
  projectItem: { getMediaPath: () => "/media/interview.mov" },
};
const fakeSeq = {
  name: "Main \u00e9dit",
  sequenceID: "seq-1",
  timebase: String(TPS / 25),
  end: String(10 * TPS),
  frameSizeHorizontal: 1920,
  frameSizeVertical: 1080,
  videoTracks: { numTracks: 1, 0: { clips: { numItems: 1, 0: clip } } },
  audioTracks: { numTracks: 1, 0: { clips: { numItems: 1, 0: clip } } },
  markers: markerColl,
};
const ctx = {
  app: {
    version: "25.0.0",
    project: { name: "Test.prproj", activeSequence: fakeSeq },
  },
  File: function (p) {
    return makeFile(p);
  },
  Folder: function (p) {
    return makeFolder(p);
  },
  Time: function () {
    this.ticks = "0";
  },
};
ctx.$ = {
  os: "Macintosh OS 15",
  fileName: path.join(hostDir, "openedit.jsx"),
  evalFile(f) {
    const p = typeof f === "string" ? f : f.fsName;
    vm.runInContext(fs.readFileSync(p, "utf8"), ctx, { filename: p });
  },
  sleep() {},
  getenv() {
    return "";
  },
};
vm.createContext(ctx);
ctx.$.evalFile(path.join(hostDir, "openedit.jsx"));
const OE = ctx.$.OpenEdit;
const run = (cmd, args) => lib.mapRawResult(vm.runInContext(lib.buildScript(cmd, args), ctx));

await test("all host parts load without errors", () => {
  assert.ok(OE && OE.loaded);
  assert.deepEqual(Array.from(OE.loadErrors), []);
  for (const c of lib.COMMANDS) assert.equal(typeof OE.commands[c], "function", "missing command " + c);
});

await test("loading twice keeps the namespace (idempotent)", () => {
  OE.marker = 42;
  ctx.$.evalFile(path.join(hostDir, "openedit.jsx"));
  assert.equal(ctx.$.OpenEdit, OE);
  assert.equal(ctx.$.OpenEdit.marker, 42);
});

await test("dispatch: ping / unsupported", () => {
  assert.deepEqual(run("ping", {}), { ok: true, result: "pong" });
  const raw = vm.runInContext("$.OpenEdit.dispatch('nope', '{}')", ctx);
  assert.match(lib.mapRawResult(raw).error, /^unsupported: nope/);
});

await test("host JSON: parse/stringify round trip, ASCII output", () => {
  const value = { s: "a\"b\\c\n\u00e9\u2028\ud83c\udfac", n: -1.5e-3, b: false, z: null, arr: [1, [2, {}]], o: {} };
  const text = OE.stringify(OE.parseJSON(JSON.stringify(value)));
  assert.ok(/^[\x20-\x7e]*$/.test(text), "stringify must emit printable ASCII only");
  assert.deepEqual(JSON.parse(text), value);
  assert.throws(() => OE.parseJSON("{bad"));
  assert.throws(() => OE.parseJSON("[1,]"));
});

await test("status reports host, version, project and sequence", () => {
  const r = run("status", {});
  assert.equal(r.ok, true);
  assert.equal(r.result.host, "premiere");
  assert.equal(r.result.connected, true);
  assert.equal(r.result.version, "25.0.0");
  assert.equal(r.result.project, "Test.prproj");
  assert.equal(r.result.sequence, "Main \u00e9dit");
});

await test("addMarkers then getTimeline", () => {
  const added = run("addMarkers", {
    markers: [
      { time: 1.5, name: "Hook", color: "red", comment: "c" },
      { time: 4, duration: 2, name: "Chapter", color: "blue" },
      { time: -1, name: "invalid" },
    ],
  });
  assert.deepEqual(added, { ok: true, result: 2 });
  const tl = run("getTimeline", {});
  assert.equal(tl.ok, true);
  const info = tl.result;
  assert.equal(info.name, "Main \u00e9dit");
  assert.equal(info.fps, 25);
  assert.equal(info.duration, 10);
  assert.equal(info.width, 1920);
  assert.equal(info.videoTracks, 1);
  assert.equal(info.clips.length, 2);
  assert.deepEqual(info.clips[0], {
    name: "interview.mov",
    track: 1,
    kind: "video",
    start: 0,
    end: 10,
    sourceIn: 5,
    sourceOut: 15,
    path: "/media/interview.mov",
  });
  assert.equal(info.markers.length, 2);
  assert.equal(info.markers[0].color, "red");
  assert.equal(info.markers[0].comment, "c");
  assert.equal(info.markers[1].color, "blue");
  assert.equal(info.markers[1].duration, 2);
});

await test("getSourceMedia de-duplicates paths", () => {
  assert.deepEqual(run("getSourceMedia", {}), { ok: true, result: ["/media/interview.mov"] });
});

await test("no active sequence -> clean error", () => {
  ctx.app.project.activeSequence = null;
  const r = run("getTimeline", {});
  assert.deepEqual(r, { ok: false, error: "No active sequence" });
  ctx.app.project.activeSequence = fakeSeq;
});

await test("applyCutPlan validates its input", () => {
  assert.match(run("applyCutPlan", {}).error, /missing plan/);
  assert.match(run("applyCutPlan", { plan: { source: "/x.mov", keep: [] } }).error, /no usable ranges/);
});

// ---------------------------------------------------------------- part 3

console.log("editing commands against a fake Premiere DOM (test/fake-premiere.mjs)");

const { makePremiere, makeSequence, razorTrack, TPS: FTPS } = await import("./fake-premiere.mjs");
const mediaDir = path.join(tmp, "media");
fs.mkdirSync(mediaDir, { recursive: true });
const media = {};
for (const name of ["source.mov", "broll.mp4", "music.wav", "subs.srt", "preset.epr"]) {
  media[name] = path.join(mediaDir, name);
  fs.writeFileSync(media[name], "x");
}

function hostContext(pp) {
  const c = {
    app: pp.app,
    File: function (p) {
      return makeFile(p);
    },
    Folder: function (p) {
      return makeFolder(p);
    },
    Time: function () {
      this.ticks = "0";
    },
  };
  // Real getFormatted returns a timecode; the fake returns the tick count so
  // the fake razor below can cut at the exact position.
  c.Time.prototype.getFormatted = function () {
    return "T" + this.ticks;
  };
  c.$ = {
    os: "Macintosh OS 15",
    fileName: path.join(hostDir, "openedit.jsx"),
    evalFile(f) {
      const p = typeof f === "string" ? f : f.fsName;
      vm.runInContext(fs.readFileSync(p, "utf8"), c, { filename: p });
    },
    sleep() {},
    getenv() {
      return "";
    },
  };
  // QE: only addTracks is modelled (appends tracks to the active sequence).
  c.qe = {
    project: {
      getActiveSequence() {
        const seq = pp.project.activeSequence;
        return {
          getVideoTrackAt(i) {
            return { razor: (tc) => razorTrack(seq._video[i], Number(String(tc).slice(1)) / FTPS) };
          },
          getAudioTrackAt(i) {
            return { razor: (tc) => razorTrack(seq._audio[i], Number(String(tc).slice(1)) / FTPS) };
          },
          addTracks(nv, vi, na, at, ai) {
            const fresh = makeSequence(pp.project, "tmp", { videoTracks: nv, audioTracks: na });
            for (const tr of fresh._video) seq._video.splice(vi, 0, tr);
            for (const tr of fresh._audio) seq._audio.splice(ai, 0, tr);
          },
        };
      },
    },
  };
  vm.createContext(c);
  c.$.evalFile(path.join(hostDir, "openedit.jsx"));
  return (cmd, args) => lib.mapRawResult(vm.runInContext(lib.buildScript(cmd, args), c));
}

const secs = (t) => Number(t.ticks) / FTPS;
const clipSummary = (tr) => tr._clips.map((c) => [secs(c.start), secs(c.end), secs(c.inPoint)].map((x) => Math.round(x * 1000) / 1000));

{
  const pp = makePremiere({ fps: 25, duration: 60 });
  const run3 = hostContext(pp);
  // Original sequence: the whole source on V1/A1 plus a marker.
  const original = makeSequence(pp.project, "Interview", { fps: 25 });
  pp.project._sequences.push(original);
  pp.project.activeSequence = original;
  pp.project.importFiles([media["source.mov"]], true, pp.project.rootItem);
  const srcItem = pp.project.rootItem.children._arr[0];
  original._video[0].overwriteClip(srcItem, 0);
  original.markers.createMarker(3).name = "old";

  let cut;
  await test("applyCutPlan builds a new back-to-back sequence and leaves the original alone", () => {
    cut = run3("applyCutPlan", {
      plan: {
        source: media["source.mov"],
        duration: 60,
        keep: [
          { start: 1, end: 3 },
          { start: 5, end: 8.6 },
          { start: 10, end: 10.02 },
          { start: 20, end: 20.01 },
        ],
        cuts: [],
      },
      sequenceName: "Edit - jump cuts",
    });
    assert.equal(cut.ok, true, cut.error);
    assert.equal(cut.result.sequence, "Edit - jump cuts");
    assert.equal(cut.result.clips, 3);
    assert.equal(cut.result.skipped, 1);
    assert.equal(cut.result.method, "inout");
    assert.equal(cut.result.createdBy, "clone");
    const seq = pp.project.activeSequence;
    assert.equal(seq.name, "Edit - jump cuts");
    assert.notEqual(seq.sequenceID, original.sequenceID);
    assert.deepEqual(clipSummary(seq._video[0]), [[0, 2, 1], [2, 5.6, 5], [5.6, 5.64, 10]]);
    assert.deepEqual(clipSummary(seq._audio[0]), clipSummary(seq._video[0]));
    assert.equal(seq._markers.length, 0, "markers copied by clone() are removed");
    // Original untouched, source marks restored.
    assert.deepEqual(clipSummary(original._video[0]), [[0, 60, 0]]);
    assert.equal(original._markers.length, 1);
    assert.equal(srcItem.markIn, 0);
    assert.equal(srcItem.markOut, null);
  });

  await test("applyCutPlan picks a unique name when it already exists", () => {
    pp.project.activeSequence = original;
    const again = run3("applyCutPlan", {
      plan: { source: media["source.mov"], duration: 60, keep: [{ start: 0, end: 1 }], cuts: [] },
      sequenceName: "Edit - jump cuts",
    });
    assert.equal(again.ok, true, again.error);
    assert.equal(again.result.sequence, "Edit - jump cuts (2)");
    pp.project.openSequence(cut.result.sequenceId);
  });

  await test("placeClips: video-only subclip on a new V5, audio on A2 with gain", () => {
    const seq = pp.project.activeSequence;
    const a1Before = clipSummary(seq._audio[0]);
    const r = run3("placeClips", {
      clips: [
        { path: media["broll.mp4"], at: 2, sourceIn: 3, sourceOut: 4.5, track: 5 },
        { path: media["music.wav"], at: 0, sourceIn: 1, sourceOut: 4, track: 2, gainDb: -6 },
        { path: path.join(mediaDir, "missing.mov"), at: 0 },
      ],
    });
    assert.deepEqual(r, { ok: true, result: 2 });
    assert.equal(seq._video.length, 5);
    assert.deepEqual(clipSummary(seq._video[4]), [[2, 3.5, 3]]);
    assert.deepEqual(clipSummary(seq._audio[0]), a1Before, "b-roll must not touch A1");
    assert.deepEqual(clipSummary(seq._audio[1]), [[0, 3, 1]]);
    const level = seq._audio[1]._clips[0].components[0].properties[1].getValue();
    assert.ok(Math.abs(level - 0.17782794100389 * Math.pow(10, -6 / 20)) < 1e-9);
    const music = pp.project.rootItem.children._arr
      .find((b) => b.name === "OpenEdit")
      .children._arr.find((i) => i.name === "music.wav");
    assert.equal(music.markIn, 0);
    assert.equal(music.markOut, null);
  });

  await test("addZooms keyframes Motion > Scale on V1 clips with eased keys", () => {
    const seq = pp.project.activeSequence;
    const r = run3("addZooms", { zooms: [{ start: 0.5, end: 1.5, scale: 120 }, { start: 1.5, end: 3, scale: 110 }] });
    assert.deepEqual(r, { ok: true, result: 2 });
    const scale0 = seq._video[0]._clips[0].components[1].properties[1];
    const keys0 = scale0.keys.map((k) => [Math.round(k.t * 1000) / 1000, k.v, k.interp]);
    // Clip 0 sits at 0..2 with source in 1: local time = 1 + (t - 0).
    assert.deepEqual(keys0.slice(0, 4), [[1.5, 100, 5], [1.7, 120, 5], [2.3, 120, 5], [2.5, 100, 5]]);
    const scale1 = seq._video[0]._clips[1].components[1].properties[1];
    assert.equal(scale1.keys.length, 4, "second zoom spills onto the next clip");
  });

  await test("addMarkers / getTimeline on the new sequence", () => {
    assert.deepEqual(run3("addMarkers", { markers: [{ time: 1, name: "A", color: "green" }] }), { ok: true, result: 1 });
    const tl = run3("getTimeline", {});
    assert.equal(tl.ok, true);
    assert.equal(tl.result.name, "Edit - jump cuts");
    assert.equal(tl.result.videoTracks, 5);
    assert.equal(tl.result.markers[0].color, "green");
    assert.deepEqual(run3("getSourceMedia", {}).result, [media["source.mov"], media["broll.mp4"], media["music.wav"]]);
  });

  await test("addCaptions falls back to markers, then uses createCaptionTrack", () => {
    const seq = pp.project.activeSequence;
    const cues = [
      { start: 0, end: 1.2, text: "Hello" },
      { start: 1.2, end: 2, text: "world" },
    ];
    const fb = run3("addCaptions", { cues, srtPath: media["subs.srt"] });
    assert.equal(fb.ok, true);
    assert.equal(fb.result.mode, "markers");
    assert.equal(fb.result.added, 2);
    let used = null;
    seq.createCaptionTrack = (item, start) => {
      used = item.name;
      return true;
    };
    const real = run3("addCaptions", { cues, srtPath: media["subs.srt"] });
    assert.deepEqual(real.result, { added: 2, file: media["subs.srt"], mode: "captions" });
    assert.equal(used, "subs.srt");
  });

  await test("importMedia counts available files and de-duplicates", () => {
    const r = run3("importMedia", { paths: [media["preset.epr"], media["source.mov"], path.join(mediaDir, "nope.mov")] });
    assert.deepEqual(r, { ok: true, result: 2 });
    const bin = pp.project.rootItem.children._arr.find((b) => b.name === "OpenEdit");
    const before = bin.children._arr.length;
    run3("importMedia", { paths: [media["preset.epr"]] });
    assert.equal(bin.children._arr.length, before);
  });

  await test("render: clear error without a preset, exportAsMediaDirect with one", () => {
    const seq = pp.project.activeSequence;
    const out = path.join(tmp, "out", "edit.mp4");
    const none = run3("render", { output: out });
    assert.equal(none.ok, false);
    assert.match(none.error, /no export preset found/);
    let args = null;
    seq.exportAsMediaDirect = (o, p, mode) => {
      args = [o, p, mode];
      fs.mkdirSync(path.dirname(o), { recursive: true });
      fs.writeFileSync(o, "video");
      return "No Error";
    };
    const r = run3("render", { output: out, preset: media["preset.epr"] });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.result.output, out);
    assert.deepEqual(args, [out, media["preset.epr"], 0]);
  });

  await test("applyCutPlan without an active sequence uses createNewSequenceFromClips", () => {
    pp.project.activeSequence = null;
    const r = run3("applyCutPlan", {
      plan: { source: media["source.mov"], duration: 60, keep: [{ start: 2, end: 4 }], cuts: [] },
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.result.createdBy, "fromClips");
    assert.equal(r.result.sequence, "source - OpenEdit");
    assert.deepEqual(clipSummary(pp.project.activeSequence._video[0]), [[0, 2, 2]]);
  });
}

{
  // Build where project-item marks cannot be set: the razor fallback runs.
  const pp = makePremiere({ fps: 25, duration: 30, marksWork: false });
  const run3 = hostContext(pp);
  const original = makeSequence(pp.project, "Interview", { fps: 25 });
  pp.project._sequences.push(original);
  pp.project.activeSequence = original;

  await test("applyCutPlan razor fallback: razor + ripple delete, A/V stay in sync", () => {
    const r = run3("applyCutPlan", {
      plan: {
        source: media["source.mov"],
        duration: 30,
        keep: [
          { start: 1, end: 3 },
          { start: 5, end: 8 },
          { start: 7, end: 9 },
          { start: 20, end: 30 },
        ],
        cuts: [],
      },
    });
    assert.equal(r.ok, true, r.error);
    assert.match(r.result.method, /^razor/);
    const seq = pp.project.activeSequence;
    // keep merged to [1,3] [5,9] [20,30] -> 2 + 4 + 10 seconds back to back.
    assert.deepEqual(clipSummary(seq._video[0]), [[0, 2, 1], [2, 6, 5], [6, 16, 20]]);
    assert.deepEqual(clipSummary(seq._audio[0]), clipSummary(seq._video[0]));
    assert.equal(r.result.clips, 3);
  });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
