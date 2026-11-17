/* OpenEdit inline views: minimal MCP Apps (SEP-1865, 2026-01-26) View-side bridge.
 * JSON-RPC 2.0 over postMessage with the host: ui/initialize handshake, tool input/result
 * notifications, host theme/style variables, auto-resize, and View -> Host requests
 * (tools/call, ui/message, ui/update-model-context, ui/open-link). No dependencies. */
(function () {
  "use strict";
  var PROTOCOL = "2026-01-26";
  var parentWin = window.parent;
  var nextId = 1;
  var pending = new Map();
  var listeners = {};
  var state = { ctx: {}, caps: {}, connected: false, input: undefined, result: undefined };

  function post(msg) {
    try {
      parentWin.postMessage(msg, "*");
    } catch (e) {
      /* no host */
    }
  }
  function emit(ev, payload) {
    (listeners[ev] || []).slice().forEach(function (fn) {
      try {
        fn(payload);
      } catch (e) {
        console.error(e);
      }
    });
  }
  function on(ev, fn) {
    (listeners[ev] = listeners[ev] || []).push(fn);
    // Late subscribers still get data that already arrived.
    if (ev === "result" && state.result) fn(state.result);
    if (ev === "input" && state.input) fn(state.input);
  }
  function request(method, params, timeoutMs) {
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        pending.delete(id);
        reject(new Error(method + " timed out"));
      }, timeoutMs || 120000);
      pending.set(id, { resolve: resolve, reject: reject, timer: t });
      post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    });
  }
  function notify(method, params) {
    post({ jsonrpc: "2.0", method: method, params: params || {} });
  }

  function applyContext(ctx) {
    if (!ctx) return;
    Object.assign(state.ctx, ctx);
    var root = document.documentElement;
    if (ctx.theme === "light" || ctx.theme === "dark") {
      root.dataset.theme = ctx.theme;
      root.style.colorScheme = ctx.theme;
    }
    var vars = ctx.styles && ctx.styles.variables;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        if (vars[k] != null && vars[k] !== "") root.style.setProperty(k, vars[k]);
      });
    }
    var fonts = ctx.styles && ctx.styles.css && ctx.styles.css.fonts;
    if (fonts && !document.getElementById("oe-host-fonts")) {
      var st = document.createElement("style");
      st.id = "oe-host-fonts";
      st.textContent = fonts;
      document.head.appendChild(st);
    }
    var dims = ctx.containerDimensions;
    if (dims && typeof dims.maxHeight === "number") root.style.setProperty("--oe-max-h", dims.maxHeight + "px");
    if (dims && typeof dims.height === "number") root.style.setProperty("--oe-max-h", dims.height + "px");
    if (ctx.displayMode) root.dataset.display = ctx.displayMode;
    emit("context", state.ctx);
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== parentWin) return;
    var m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.method === undefined && m.id !== undefined) {
      var p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error((m.error && m.error.message) || "Request failed"));
      else p.resolve(m.result);
      return;
    }
    var params = m.params || {};
    switch (m.method) {
      case "ui/notifications/tool-input":
        state.input = params.arguments || {};
        emit("input", state.input);
        break;
      case "ui/notifications/tool-input-partial":
        emit("partial", params.arguments || {});
        break;
      case "ui/notifications/tool-result":
        state.result = params;
        emit("result", params);
        break;
      case "ui/notifications/tool-cancelled":
        emit("cancelled", params);
        break;
      case "ui/notifications/host-context-changed":
        applyContext(params);
        break;
      default:
        break;
    }
    if (m.id !== undefined && m.method) {
      // Host -> View requests: ping, ui/resource-teardown. Acknowledge.
      if (m.method === "ui/resource-teardown") emit("teardown", params);
      post({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  });

  // Auto-resize: report the document size whenever it changes (debounced to a frame).
  var lastW = 0;
  var lastH = 0;
  var raf = 0;
  function reportSize() {
    raf = 0;
    var el = document.documentElement;
    var h = Math.ceil(el.getBoundingClientRect().height);
    var w = Math.ceil(el.scrollWidth);
    if (h === lastH && w === lastW) return;
    lastH = h;
    lastW = w;
    if (state.connected) notify("ui/notifications/size-changed", { width: w, height: h });
  }
  function scheduleSize() {
    if (!raf) raf = requestAnimationFrame(reportSize);
  }
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(scheduleSize).observe(document.documentElement);
  }

  function connect(appInfo) {
    return request(
      "ui/initialize",
      {
        appInfo: appInfo || { name: "openedit-view", version: "0.1.0" },
        appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
        protocolVersion: PROTOCOL,
      },
      15000,
    ).then(function (res) {
      state.caps = (res && res.hostCapabilities) || {};
      state.connected = true;
      applyContext((res && res.hostContext) || {});
      notify("ui/notifications/initialized", {});
      lastH = 0;
      scheduleSize();
      return res;
    });
  }

  // ---- helpers shared by the views ----
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function clock(t, digits) {
    if (t == null || !isFinite(t)) return "–";
    var d = digits == null ? 1 : digits;
    var neg = t < 0;
    t = Math.abs(t);
    var h = Math.floor(t / 3600);
    var m = Math.floor((t % 3600) / 60);
    var s = t - h * 3600 - m * 60;
    var ss = s.toFixed(d);
    if (Number(ss) >= 60) {
      ss = (0).toFixed(d);
      m += 1;
    }
    var sPad = (Number(ss) < 10 ? "0" : "") + ss;
    return (neg ? "−" : "") + (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + sPad;
  }
  function dur(t) {
    if (t == null || !isFinite(t)) return "–";
    if (t < 10) return t.toFixed(1) + "s";
    if (t < 60) return Math.round(t) + "s";
    return clock(t, 0);
  }
  function bytes(n) {
    if (!n && n !== 0) return "–";
    var u = ["B", "KB", "MB", "GB"];
    var i = 0;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + " " + u[i];
  }
  var toastTimer;
  function toast(msg) {
    var t = document.getElementById("oe-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "oe-toast";
      t.className = "toast";
      t.setAttribute("role", "status");
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.classList.remove("show");
    }, 2200);
  }
  function textOf(result) {
    return ((result && result.content) || [])
      .filter(function (c) {
        return c.type === "text";
      })
      .map(function (c) {
        return c.text;
      })
      .join("\n");
  }
  function copy(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(
          function () {
            return true;
          },
          function () {
            return false;
          },
        );
      }
    } catch (e) {
      /* fall through */
    }
    return Promise.resolve(false);
  }

  window.OE = {
    on: on,
    connect: connect,
    get ctx() {
      return state.ctx;
    },
    get caps() {
      return state.caps;
    },
    get connected() {
      return state.connected;
    },
    /** Call one of this server's tools through the host (needs hostCapabilities.serverTools). */
    callTool: function (name, args) {
      return request("tools/call", { name: name, arguments: args || {} }).then(function (res) {
        if (res && res.isError) throw new Error(textOf(res).replace(/^Error:\s*/, "") || "Tool failed");
        return res;
      });
    },
    canCallTools: function () {
      return !!state.caps.serverTools;
    },
    /** Add a user message to the conversation (Claude follows up). */
    sendMessage: function (text) {
      return request("ui/message", { role: "user", content: [{ type: "text", text: text }] });
    },
    /** Tell the model about view state for its next turn. */
    updateContext: function (text, structured) {
      return request("ui/update-model-context", {
        content: [{ type: "text", text: text }],
        structuredContent: structured,
      }).catch(function () {});
    },
    openLink: function (url) {
      return request("ui/open-link", { url: url });
    },
    log: function (level, data) {
      notify("notifications/message", { level: level || "info", logger: "openedit-view", data: data });
    },
    resize: scheduleSize,
    esc: esc,
    clock: clock,
    dur: dur,
    bytes: bytes,
    toast: toast,
    textOf: textOf,
    copy: copy,
    icon: function (name) {
      var P = {
        logo: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 14.5z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 7.5v5l4-2.5z" fill="currentColor"/>',
        scissors: '<circle cx="6" cy="6" r="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="6" cy="14" r="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7.8 7.4 16 15M7.8 12.6 16 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
        check: '<path d="m5 10.5 3.2 3.2L15 7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
        undo: '<path d="M7 6 4 9l3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 9H12a3.5 3.5 0 0 1 0 7H9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
        external: '<path d="M11 4h5v5M16 4l-7 7M14 12v3.5A.5.5 0 0 1 13.5 16h-9a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5H8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
        copy: '<rect x="7" y="7" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7" fill="none" stroke="currentColor" stroke-width="1.6"/>',
        play: '<path d="M7 5.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L7.9 4.7a.6.6 0 0 0-.9.5z" fill="currentColor"/>',
        pause: '<rect x="6" y="5" width="3" height="10" rx="1" fill="currentColor"/><rect x="11" y="5" width="3" height="10" rx="1" fill="currentColor"/>',
        text: '<path d="M4 5h12M4 9h12M4 13h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
        search: '<circle cx="9" cy="9" r="4.8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m12.6 12.6 3.4 3.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
        film: '<rect x="3.5" y="4.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6.5 4.5v11M13.5 4.5v11M3.5 8h3M3.5 12h3M13.5 8h3M13.5 12h3" stroke="currentColor" stroke-width="1.4"/>',
        image: '<rect x="3.5" y="4.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="8.5" r="1.4" fill="currentColor"/><path d="m4 14 4-3.5 3 2.5 2-1.5 3.5 2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
        music: '<path d="M8 14.5V5.5l8-1.5v9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="6" cy="14.5" r="2" fill="currentColor"/><circle cx="14" cy="13" r="2" fill="currentColor"/>',
        wave: '<path d="M3 10h1.5M6 7v6M9 4.5v11M12 7.5v5M15 6v8M17 10h0" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
        monitor: '<rect x="3" y="4" width="14" height="9.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7.5 16.5h5M10 13.5v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
        download: '<path d="M10 4v8.5M6.5 9.5 10 13l3.5-3.5M4.5 15.5h11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
        spark: '<path d="M10 3.5 11.6 8.4 16.5 10l-4.9 1.6L10 16.5l-1.6-4.9L3.5 10l4.9-1.6z" fill="currentColor"/>',
        folder: '<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h3l1.5 1.5H15a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 15 15.5H5A1.5 1.5 0 0 1 3.5 14z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
        chat: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3h0A1.5 1.5 0 0 1 4 11.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
      };
      return '<svg viewBox="0 0 20 20" aria-hidden="true">' + (P[name] || "") + "</svg>";
    },
  };
})();
