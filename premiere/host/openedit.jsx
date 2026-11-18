// OpenEdit - Premiere Pro bridge, ExtendScript entry point.
//
// Rules for every file in host/:
//   * ES3 only (var, function; no let/const, arrows, template strings,
//     Array.prototype.forEach/map/indexOf, Object.keys, trailing commas).
//   * 7-bit ASCII only. ExtendScript reads script files in the system code
//     page on Windows, so any non-ASCII byte can corrupt a string or the parse.
//     Use \uXXXX escapes inside string literals when needed.
//   * Every command returns plain data; dispatch() turns it into
//     {"ok":true,"result":...} or {"ok":false,"error":"..."} JSON text.
//
// Loading is idempotent: evaluating this file again (panel reload, second
// panel instance) refreshes the functions but keeps the $.OpenEdit object.

(function () {
  if (typeof $.OpenEdit !== "object" || $.OpenEdit === null) {
    $.OpenEdit = {};
  }
  var OE = $.OpenEdit;

  OE.version = "0.1.0";
  OE.TPS = 254016000000; // Premiere ticks per second
  OE.BIN_NAME = "OpenEdit";
  OE.commands = OE.commands || {};
  OE.loadErrors = [];

  // ------------------------------------------------------------------ JSON

  function hex4(n) {
    var h = n.toString(16);
    while (h.length < 4) {
      h = "0" + h;
    }
    return h;
  }

  function quote(s) {
    var out = "\"";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      var code = s.charCodeAt(i);
      if (c === "\"") {
        out += "\\\"";
      } else if (c === "\\") {
        out += "\\\\";
      } else if (c === "\n") {
        out += "\\n";
      } else if (c === "\r") {
        out += "\\r";
      } else if (c === "\t") {
        out += "\\t";
      } else if (code < 32 || code > 126) {
        // Escaping everything outside printable ASCII keeps the reply
        // independent of the code page the bridge uses.
        out += "\\u" + hex4(code);
      } else {
        out += c;
      }
    }
    return out + "\"";
  }

  function isArray(v) {
    return Object.prototype.toString.call(v) === "[object Array]";
  }
  OE.isArray = isArray;

  function stringify(v, depth) {
    depth = depth || 0;
    if (depth > 64) {
      return "null";
    }
    if (v === null || typeof v === "undefined") {
      return "null";
    }
    var t = typeof v;
    if (t === "boolean") {
      return v ? "true" : "false";
    }
    if (t === "number") {
      return isFinite(v) ? String(v) : "null";
    }
    if (t === "string") {
      return quote(v);
    }
    if (t === "function") {
      return "null";
    }
    if (isArray(v)) {
      var parts = [];
      for (var i = 0; i < v.length; i++) {
        parts[parts.length] = stringify(v[i], depth + 1);
      }
      return "[" + parts.join(",") + "]";
    }
    if (t === "object") {
      var props = [];
      for (var k in v) {
        if (Object.prototype.hasOwnProperty.call(v, k)) {
          var val = v[k];
          if (typeof val === "undefined" || typeof val === "function") {
            continue;
          }
          props[props.length] = quote(String(k)) + ":" + stringify(val, depth + 1);
        }
      }
      return "{" + props.join(",") + "}";
    }
    return quote(String(v));
  }
  OE.stringify = function (v) {
    return stringify(v, 0);
  };

  // Small recursive-descent JSON parser (no eval).
  OE.parseJSON = function (text) {
    var s = String(text);
    var pos = 0;

    function fail(msg) {
      throw new Error("JSON parse error at " + pos + ": " + msg);
    }
    function ws() {
      while (pos < s.length) {
        var c = s.charAt(pos);
        if (c === " " || c === "\t" || c === "\n" || c === "\r") {
          pos++;
        } else {
          break;
        }
      }
    }
    function parseString() {
      var out = "";
      pos++; // opening quote
      while (pos < s.length) {
        var c = s.charAt(pos++);
        if (c === "\"") {
          return out;
        }
        if (c === "\\") {
          var e = s.charAt(pos++);
          if (e === "\"" || e === "\\" || e === "/") {
            out += e;
          } else if (e === "b") {
            out += "\b";
          } else if (e === "f") {
            out += "\f";
          } else if (e === "n") {
            out += "\n";
          } else if (e === "r") {
            out += "\r";
          } else if (e === "t") {
            out += "\t";
          } else if (e === "u") {
            var h = s.substr(pos, 4);
            if (!/^[0-9a-fA-F]{4}$/.test(h)) {
              fail("bad unicode escape");
            }
            out += String.fromCharCode(parseInt(h, 16));
            pos += 4;
          } else {
            fail("bad escape");
          }
        } else {
          out += c;
        }
      }
      fail("unterminated string");
    }
    function parseNumber() {
      var m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+\-]?[0-9]+)?/.exec(s.substr(pos, 64));
      if (!m) {
        fail("bad number");
      }
      pos += m[0].length;
      return parseFloat(m[0]);
    }
    function parseValue() {
      ws();
      var c = s.charAt(pos);
      if (c === "{") {
        pos++;
        var obj = {};
        ws();
        if (s.charAt(pos) === "}") {
          pos++;
          return obj;
        }
        while (true) {
          ws();
          if (s.charAt(pos) !== "\"") {
            fail("expected key");
          }
          var key = parseString();
          ws();
          if (s.charAt(pos) !== ":") {
            fail("expected ':'");
          }
          pos++;
          obj[key] = parseValue();
          ws();
          var d = s.charAt(pos++);
          if (d === "}") {
            return obj;
          }
          if (d !== ",") {
            fail("expected ',' or '}'");
          }
        }
      }
      if (c === "[") {
        pos++;
        var arr = [];
        ws();
        if (s.charAt(pos) === "]") {
          pos++;
          return arr;
        }
        while (true) {
          arr[arr.length] = parseValue();
          ws();
          var d2 = s.charAt(pos++);
          if (d2 === "]") {
            return arr;
          }
          if (d2 !== ",") {
            fail("expected ',' or ']'");
          }
        }
      }
      if (c === "\"") {
        return parseString();
      }
      if (c === "t" && s.substr(pos, 4) === "true") {
        pos += 4;
        return true;
      }
      if (c === "f" && s.substr(pos, 5) === "false") {
        pos += 5;
        return false;
      }
      if (c === "n" && s.substr(pos, 4) === "null") {
        pos += 4;
        return null;
      }
      return parseNumber();
    }

    var value = parseValue();
    ws();
    if (pos < s.length) {
      fail("trailing characters");
    }
    return value;
  };

  // --------------------------------------------------------------- helpers

  OE.errText = function (e) {
    try {
      if (e && e.message) {
        return String(e.message) + (e.line ? " (line " + e.line + ")" : "");
      }
      return String(e);
    } catch (x) {
      return "unknown error";
    }
  };

  OE.fail = function (msg) {
    throw new Error(msg);
  };

  // Count of a Premiere collection, whichever counter it exposes.
  OE.count = function (coll) {
    try {
      if (!coll) {
        return 0;
      }
      if (typeof coll.numItems === "number") {
        return coll.numItems;
      }
      if (typeof coll.numTracks === "number") {
        return coll.numTracks;
      }
      if (typeof coll.numSequences === "number") {
        return coll.numSequences;
      }
      if (typeof coll.length === "number") {
        return coll.length;
      }
    } catch (e) {
      // fall through
    }
    return 0;
  };

  OE.num = function (v, fallback) {
    var n = (typeof v === "number") ? v : parseFloat(v);
    if (isNaN(n) || !isFinite(n)) {
      return fallback;
    }
    return n;
  };

  // Seconds from a Premiere Time object, tick string or number.
  OE.secs = function (t) {
    try {
      if (t === null || typeof t === "undefined") {
        return null;
      }
      if (typeof t === "object") {
        if (typeof t.ticks !== "undefined" && t.ticks !== null && String(t.ticks) !== "") {
          var tk = parseFloat(String(t.ticks));
          if (!isNaN(tk)) {
            return tk / OE.TPS;
          }
        }
        if (typeof t.seconds !== "undefined") {
          var sc = parseFloat(String(t.seconds));
          if (!isNaN(sc)) {
            return sc;
          }
        }
        return null;
      }
      var raw = parseFloat(String(t));
      if (isNaN(raw)) {
        return null;
      }
      // Bare values this large can only be ticks (1e6 s is 11 days).
      return raw >= 1000000 ? raw / OE.TPS : raw;
    } catch (e) {
      return null;
    }
  };

  OE.ticksString = function (sec) {
    return String(Math.round(sec * OE.TPS));
  };

  OE.makeTime = function (sec) {
    var t = new Time();
    t.ticks = OE.ticksString(sec);
    return t;
  };

  OE.round = function (x, digits) {
    var p = Math.pow(10, digits || 4);
    return Math.round(x * p) / p;
  };

  OE.isWindows = function () {
    try {
      return String($.os).toLowerCase().indexOf("windows") >= 0;
    } catch (e) {
      return false;
    }
  };

  OE.normPath = function (p) {
    if (!p) {
      return "";
    }
    var s = String(p).replace(/\\/g, "/");
    if (OE.isWindows()) {
      s = s.toLowerCase();
    }
    return s;
  };

  OE.nativePath = function (p) {
    try {
      return new File(p).fsName;
    } catch (e) {
      return String(p);
    }
  };

  OE.basename = function (p) {
    var s = String(p).replace(/\\/g, "/");
    var i = s.lastIndexOf("/");
    return i >= 0 ? s.substr(i + 1) : s;
  };

  OE.stripExt = function (name) {
    var i = name.lastIndexOf(".");
    return i > 0 ? name.substr(0, i) : name;
  };

  OE.extension = function (p) {
    var b = OE.basename(p);
    var i = b.lastIndexOf(".");
    return i >= 0 ? b.substr(i + 1).toLowerCase() : "";
  };

  var AUDIO_EXT = {
    wav: 1, mp3: 1, aac: 1, m4a: 1, aif: 1, aiff: 1, flac: 1, ogg: 1,
    wma: 1, bwf: 1, ac3: 1, opus: 1
  };
  OE.isAudioPath = function (p) {
    return AUDIO_EXT[OE.extension(p)] === 1;
  };

  OE.project = function () {
    if (typeof app === "undefined" || !app.project) {
      OE.fail("No Premiere Pro project is open");
    }
    return app.project;
  };

  OE.activeSeq = function () {
    var proj = OE.project();
    var seq = proj.activeSequence;
    if (!seq) {
      OE.fail("No active sequence");
    }
    return seq;
  };

  // Ticks per frame of a sequence (0 when unreadable).
  OE.frameTicks = function (seq) {
    try {
      var tb = parseFloat(String(seq.timebase));
      if (tb > 0 && isFinite(tb)) {
        return tb;
      }
    } catch (e) {
      // fall through
    }
    return 0;
  };

  OE.fps = function (seq) {
    var ft = OE.frameTicks(seq);
    return ft > 0 ? OE.TPS / ft : 0;
  };

  // Snap seconds to the sequence frame grid.
  OE.snap = function (seq, sec) {
    var ft = OE.frameTicks(seq);
    if (!(ft > 0)) {
      return sec;
    }
    return Math.round(sec * OE.TPS / ft) * ft / OE.TPS;
  };

  OE.frameSec = function (seq) {
    var ft = OE.frameTicks(seq);
    return ft > 0 ? ft / OE.TPS : 1 / 30;
  };

  // ---------------------------------------------------------- project items

  OE.itemMediaPath = function (item) {
    try {
      if (item && typeof item.getMediaPath === "function") {
        var p = item.getMediaPath();
        return p ? String(p) : "";
      }
    } catch (e) {
      // fall through
    }
    return "";
  };

  // Depth-first search of the project tree for a clip whose media path
  // matches. Subclips share the master's media path, so masters (non-subclip
  // items) are preferred when both exist.
  OE.findItemByPath = function (path, startBin) {
    var want = OE.normPath(OE.nativePath(path));
    var wantRaw = OE.normPath(path);
    var found = null;
    var fallback = null;

    function visit(bin, depth) {
      if (found || depth > 24 || !bin) {
        return;
      }
      var n = OE.count(bin.children);
      for (var i = 0; i < n && !found; i++) {
        var child = null;
        try {
          child = bin.children[i];
        } catch (e) {
          child = null;
        }
        if (!child) {
          continue;
        }
        var type = -1;
        try {
          type = child.type;
        } catch (e2) {
          type = -1;
        }
        if (type === 2 || type === 3) { // BIN or ROOT
          visit(child, depth + 1);
          continue;
        }
        var mp = OE.normPath(OE.itemMediaPath(child));
        if (mp && (mp === want || mp === wantRaw)) {
          var isSub = false;
          try {
            isSub = typeof child.isSubClip === "function" ? !!child.isSubClip() : false;
          } catch (e3) {
            isSub = false;
          }
          if (!isSub) {
            found = child;
          } else if (!fallback) {
            fallback = child;
          }
        }
      }
    }

    visit(startBin || OE.project().rootItem, 0);
    return found || fallback;
  };

  OE.findChildBin = function (parent, name) {
    var n = OE.count(parent.children);
    for (var i = 0; i < n; i++) {
      try {
        var c = parent.children[i];
        if (c && c.type === 2 && String(c.name) === name) {
          return c;
        }
      } catch (e) {
        // skip unreadable entries
      }
    }
    return null;
  };

  OE.bin = function () {
    var root = OE.project().rootItem;
    var b = OE.findChildBin(root, OE.BIN_NAME);
    if (b) {
      return b;
    }
    try {
      b = root.createBin(OE.BIN_NAME);
    } catch (e) {
      b = null;
    }
    // createBin's return value is not reliable on every build; look it up.
    return b || OE.findChildBin(root, OE.BIN_NAME) || root;
  };

  // Return the project item for a media file, importing it into the OpenEdit
  // bin when it is not in the project yet.
  OE.importOne = function (path, bin) {
    if (!path) {
      OE.fail("missing media path");
    }
    var existing = OE.findItemByPath(path);
    if (existing) {
      return existing;
    }
    var f = new File(path);
    if (!f.exists) {
      OE.fail("file not found: " + path);
    }
    var target = bin || OE.bin();
    var ok = OE.project().importFiles([f.fsName], true, target, false);
    if (ok === false) {
      OE.fail("importFiles failed for " + path);
    }
    var item = OE.findItemByPath(path, target) || OE.findItemByPath(path);
    if (!item) {
      OE.fail("imported but could not find project item for " + path);
    }
    return item;
  };

  // ------------------------------------------------------------- sequences

  OE.sequenceIds = function () {
    var ids = {};
    var seqs = OE.project().sequences;
    var n = OE.count(seqs);
    for (var i = 0; i < n; i++) {
      try {
        ids["id:" + String(seqs[i].sequenceID)] = true;
      } catch (e) {
        // skip
      }
    }
    return ids;
  };

  OE.findNewSequence = function (beforeIds) {
    var seqs = OE.project().sequences;
    var n = OE.count(seqs);
    for (var i = n - 1; i >= 0; i--) {
      try {
        var s = seqs[i];
        if (beforeIds["id:" + String(s.sequenceID)] !== true) {
          return s;
        }
      } catch (e) {
        // skip
      }
    }
    return null;
  };

  OE.sequenceById = function (id) {
    var seqs = OE.project().sequences;
    var n = OE.count(seqs);
    for (var i = 0; i < n; i++) {
      try {
        if (String(seqs[i].sequenceID) === String(id)) {
          return seqs[i];
        }
      } catch (e) {
        // skip
      }
    }
    return null;
  };

  OE.uniqueSequenceName = function (name) {
    var taken = {};
    var seqs = OE.project().sequences;
    var n = OE.count(seqs);
    for (var i = 0; i < n; i++) {
      try {
        taken["n:" + String(seqs[i].name)] = true;
      } catch (e) {
        // skip
      }
    }
    if (!taken["n:" + name]) {
      return name;
    }
    for (var k = 2; k < 1000; k++) {
      var candidate = name + " (" + k + ")";
      if (!taken["n:" + candidate]) {
        return candidate;
      }
    }
    return name + " " + (new Date()).getTime();
  };

  OE.activate = function (seq) {
    try {
      OE.project().openSequence(seq.sequenceID);
    } catch (e) {
      // best effort; callers verify with OE.isActive when it matters
    }
    return OE.isActive(seq);
  };

  OE.isActive = function (seq) {
    try {
      var a = OE.project().activeSequence;
      return !!a && String(a.sequenceID) === String(seq.sequenceID);
    } catch (e) {
      return false;
    }
  };

  // QE DOM sequence for the ACTIVE sequence (or null).
  OE.qeSeq = function () {
    try {
      app.enableQE();
      return qe.project.getActiveSequence();
    } catch (e) {
      return null;
    }
  };

  OE.trackClips = function (track) {
    var out = [];
    var n = OE.count(track.clips);
    for (var i = 0; i < n; i++) {
      try {
        out[out.length] = track.clips[i];
      } catch (e) {
        // skip
      }
    }
    return out;
  };

  // Append video tracks on top until the sequence has `wanted` tracks.
  // QE addTracks(numVideo, videoIndex, numAudio, audioType, audioIndex,
  // numSubmix, submixType) INSERTS at the given index, so the current count is
  // passed to append. The return value is ignored; numTracks is re-read.
  OE.ensureVideoTracks = function (seq, wanted) {
    var have = OE.count(seq.videoTracks);
    if (have >= wanted) {
      return have;
    }
    var q = OE.qeSeq();
    if (!q) {
      OE.fail("cannot add video tracks: QE DOM unavailable");
    }
    var guard = 0;
    while (OE.count(seq.videoTracks) < wanted && guard < 64) {
      guard++;
      var before = OE.count(seq.videoTracks);
      try {
        q.addTracks(1, before, 0, 0, 0, 0, 0);
      } catch (e) {
        break;
      }
      if (OE.count(seq.videoTracks) <= before) {
        break;
      }
    }
    have = OE.count(seq.videoTracks);
    if (have < wanted) {
      OE.fail("could not create video track V" + wanted + " (sequence has " + have + ")");
    }
    return have;
  };

  // Same for audio tracks. Audio type 0 is what Premiere accepts for a
  // standard track through QE; the insert index is the 5th argument.
  OE.ensureAudioTracks = function (seq, wanted) {
    var have = OE.count(seq.audioTracks);
    if (have >= wanted) {
      return have;
    }
    var q = OE.qeSeq();
    if (!q) {
      OE.fail("cannot add audio tracks: QE DOM unavailable");
    }
    var guard = 0;
    while (OE.count(seq.audioTracks) < wanted && guard < 64) {
      guard++;
      var before = OE.count(seq.audioTracks);
      try {
        q.addTracks(0, 0, 1, 0, before, 0, 0);
      } catch (e) {
        break;
      }
      if (OE.count(seq.audioTracks) <= before) {
        break;
      }
    }
    have = OE.count(seq.audioTracks);
    if (have < wanted) {
      OE.fail("could not create audio track A" + wanted + " (sequence has " + have + ")");
    }
    return have;
  };

  // In/out marks on a project item. Both argument forms (Time object and bare
  // seconds) are seen in the wild, so each write is read back and confirmed.
  OE.readInOut = function (item) {
    var snap = { inPoint: null, outPoint: null };
    try {
      snap.inPoint = OE.secs(item.getInPoint());
    } catch (e) {
      snap.inPoint = null;
    }
    try {
      snap.outPoint = OE.secs(item.getOutPoint());
    } catch (e2) {
      snap.outPoint = null;
    }
    return snap;
  };

  function writePoint(item, sec, isIn, form) {
    var v = form === 0 ? OE.makeTime(sec) : sec;
    if (isIn) {
      item.setInPoint(v, 4); // 4 = all media types
    } else {
      item.setOutPoint(v, 4);
    }
  }

  OE.setInOut = function (item, inSec, outSec, tolerance) {
    var tol = tolerance || 0.002;
    for (var form = 0; form < 2; form++) {
      try {
        // Out first when moving forward, so in never passes out.
        writePoint(item, outSec, false, form);
        writePoint(item, inSec, true, form);
        writePoint(item, outSec, false, form);
        var r = OE.readInOut(item);
        if (r.inPoint !== null && r.outPoint !== null &&
            Math.abs(r.inPoint - inSec) <= tol && Math.abs(r.outPoint - outSec) <= tol) {
          return true;
        }
      } catch (e) {
        // try the next form
      }
    }
    return false;
  };

  OE.clearInOut = function (item) {
    try {
      item.clearInPoint();
    } catch (e) {
      // best effort
    }
    try {
      item.clearOutPoint();
    } catch (e2) {
      // best effort
    }
  };

  // Snapshot an item's marks plus its full media duration (marks cleared
  // while measuring, then put back by restoreInOut).
  OE.snapshotMarks = function (item) {
    var snap = OE.readInOut(item);
    snap.duration = null;
    try {
      OE.clearInOut(item);
      snap.duration = OE.secs(item.getOutPoint());
    } catch (e) {
      snap.duration = null;
    }
    OE.restoreInOut(item, snap);
    return snap;
  };

  OE.restoreInOut = function (item, snap) {
    OE.clearInOut(item);
    if (!snap) {
      return;
    }
    // An unmarked item reads in=0 and out=duration; only restore marks that
    // actually narrow the clip, so untouched items stay unmarked.
    var hadIn = snap.inPoint !== null && snap.inPoint > 0.0005;
    var hadOut = snap.outPoint !== null && snap.duration !== null &&
      snap.outPoint < snap.duration - 0.0005;
    for (var form = 0; form < 2; form++) {
      try {
        if (hadOut) {
          writePoint(item, snap.outPoint, false, form);
        }
        if (hadIn) {
          writePoint(item, snap.inPoint, true, form);
        }
        break;
      } catch (e) {
        // try the other argument form
      }
    }
  };

  // Media duration of a project item in seconds (null when unknown).
  OE.itemDuration = function (item) {
    return OE.snapshotMarks(item).duration;
  };

  // ------------------------------------------------------------- dispatch

  OE.dispatch = function (cmd, argsText) {
    var out;
    try {
      var args = {};
      if (argsText) {
        args = OE.parseJSON(argsText);
      }
      if (args === null || typeof args !== "object" || isArray(args)) {
        args = {};
      }
      var fn = Object.prototype.hasOwnProperty.call(OE.commands, cmd) ? OE.commands[cmd] : null;
      if (typeof fn !== "function") {
        out = { ok: false, error: "unsupported: " + cmd };
      } else {
        var result = fn(args);
        out = { ok: true, result: (typeof result === "undefined") ? null : result };
      }
    } catch (e) {
      out = { ok: false, error: OE.errText(e) };
    }
    try {
      return OE.stringify(out);
    } catch (e2) {
      return "{\"ok\":false,\"error\":\"could not serialize result\"}";
    }
  };

  OE.commands.ping = function () {
    return "pong";
  };

  // ---------------------------------------------------------- load parts

  var root = null;
  try {
    root = File($.fileName).parent;
    if (!root || !root.exists || !File(root.fsName + "/oe-read.jsx").exists) {
      root = null;
    }
  } catch (e) {
    root = null;
  }
  if (!root && typeof $.OpenEdit_root === "string" && $.OpenEdit_root) {
    root = new Folder($.OpenEdit_root + "/host");
  }
  OE.hostDir = root ? root.fsName : "";

  var parts = ["oe-read.jsx", "oe-cut.jsx", "oe-edit.jsx", "oe-render.jsx", "oe-graphics.jsx"];
  for (var p = 0; p < parts.length; p++) {
    if (!root) {
      OE.loadErrors[OE.loadErrors.length] = parts[p] + ": host folder not found";
      continue;
    }
    try {
      $.evalFile(new File(root.fsName + "/" + parts[p]));
    } catch (loadErr) {
      OE.loadErrors[OE.loadErrors.length] = parts[p] + ": " + OE.errText(loadErr);
    }
  }
  OE.loaded = true;
})();
