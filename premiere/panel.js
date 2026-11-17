/* OpenEdit Premiere panel: starts the local bridge server and shows status.
 * Runs in the CEP panel page with Node enabled (mixed context). All server
 * logic lives in lib/server.js; this file only wires it to CEP and the UI. */
(function () {
  "use strict";

  var MAX_LOG = 40;
  var POLL_MS = 4000;

  function $(id) {
    return document.getElementById(id);
  }

  function setText(id, text) {
    var el = $(id);
    if (el) el.textContent = text;
  }

  function setState(kind, text) {
    var dot = $("state-dot");
    if (dot) dot.className = "dot " + kind;
    setText("state-text", text);
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function clock(ms) {
    var d = new Date(ms);
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function addLog(entry) {
    var list = $("log");
    if (!list) return;
    var li = document.createElement("li");
    li.className = entry.ok === false ? "err" : entry.ok === true ? "ok" : "info";
    var t = document.createElement("span");
    t.className = "t";
    t.textContent = clock(entry.time || Date.now());
    var c = document.createElement("span");
    c.className = "c";
    c.textContent = entry.cmd || "";
    var m = document.createElement("span");
    m.className = "m";
    m.textContent = entry.msg || "";
    li.appendChild(t);
    li.appendChild(c);
    li.appendChild(m);
    list.insertBefore(li, list.firstChild);
    while (list.childNodes.length > MAX_LOG) list.removeChild(list.lastChild);
  }

  var nodeRequire = window.require || (window.cep_node && window.cep_node.require);
  if (typeof CSInterface === "undefined" || !window.__adobe_cep__) {
    setState("bad", "Not running inside Premiere Pro");
    return;
  }
  if (typeof nodeRequire !== "function") {
    setState("bad", "Node.js is not enabled for this panel (check CSXS/manifest.xml)");
    return;
  }

  var cs = new CSInterface();
  var root = cs.getSystemPath(SystemPath.EXTENSION);
  var pathMod = nodeRequire("path");
  var lib;
  try {
    lib = nodeRequire(pathMod.join(root, "lib", "server.js"));
  } catch (e) {
    setState("bad", "Could not load lib/server.js: " + e.message);
    return;
  }

  function evalScript(script) {
    return new Promise(function (resolve) {
      cs.evalScript(script, function (res) {
        resolve(res);
      });
    });
  }

  function loadHost() {
    var hostFile = pathMod.join(root, "host", "openedit.jsx");
    var script =
      "$.OpenEdit_root=" + lib.toScriptLiteral(root) + ";" +
      "$.evalFile(" + lib.toScriptLiteral(hostFile) + ");" +
      "($.OpenEdit&&$.OpenEdit.loadErrors&&$.OpenEdit.loadErrors.length)?" +
      "('errors: '+$.OpenEdit.loadErrors.join(' | ')):'ok';";
    return evalScript(script).then(function (res) {
      if (res !== "ok") addLog({ cmd: "host", ok: false, msg: "load: " + res });
      return res;
    });
  }

  var bridge;
  try {
    bridge = lib.createBridgeServer({
      evalScript: evalScript,
      reloadHost: loadHost,
      onEvent: function (ev) {
        if (ev.type === "rpc-end") {
          addLog({
            time: ev.time,
            cmd: ev.cmd,
            ok: ev.ok,
            msg: ev.ok ? ev.ms + " ms" : ev.error,
          });
          if (ev.ok) refreshStatus();
        } else if (ev.type === "auth-failed") {
          addLog({ time: ev.time, cmd: "auth", ok: false, msg: "rejected request with bad token" });
        }
      },
    });
  } catch (e) {
    setState("bad", "Could not create server: " + e.message);
    return;
  }

  setText("port", String(lib.DEFAULT_PORT));
  setText("token-path", bridge.tokenPath);

  var refreshing = false;
  function refreshStatus() {
    if (refreshing || bridge.queueDepth > 0) return;
    refreshing = true;
    bridge
      .execute("status", {})
      .then(function (res) {
        if (res.ok && res.result) {
          setText("sequence", res.result.sequence || "(none)");
          setText("project", res.result.project || "(none)");
          setText("version", res.result.version || "?");
        } else {
          setText("sequence", "?");
          if (res.error) setText("host-error", res.error);
        }
      })
      .then(
        function () {
          refreshing = false;
        },
        function () {
          refreshing = false;
        }
      );
  }

  loadHost()
    .then(function () {
      return bridge.listen();
    })
    .then(
      function (port) {
        setText("port", String(port));
        setState("good", "Listening on 127.0.0.1:" + port);
        addLog({ cmd: "server", ok: true, msg: "listening on " + port });
        refreshStatus();
        setInterval(refreshStatus, POLL_MS);
      },
      function (err) {
        setState("bad", "Server error: " + (err && err.message ? err.message : String(err)));
        addLog({ cmd: "server", ok: false, msg: err && err.message ? err.message : String(err) });
      }
    );

  window.addEventListener("beforeunload", function () {
    try {
      bridge.close();
    } catch (e) {
      // page is going away anyway
    }
  });

  var reloadBtn = $("reload-host");
  if (reloadBtn) {
    reloadBtn.addEventListener("click", function () {
      loadHost().then(function (res) {
        addLog({ cmd: "host", ok: res === "ok", msg: "reloaded: " + res });
        refreshStatus();
      });
    });
  }
})();
