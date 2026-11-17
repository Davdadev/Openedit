// OpenEdit Studio overlay: inject into any page to show the glowing border,
// the Claude cursor and a status pill driven by the live OpenEdit event stream.
//   (()=>{const s=document.createElement('script');s.src='http://127.0.0.1:47822/overlay.js';document.documentElement.appendChild(s)})()
(() => {
  if (window.__openeditOverlay) return;
  window.__openeditOverlay = true;
  const ORIGIN = "__OPENEDIT_STUDIO_ORIGIN__";
  const origin = ORIGIN.startsWith("http") ? ORIGIN : (document.currentScript && new URL(document.currentScript.src).origin) || "http://127.0.0.1:47822";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const m = reduced ? 0.35 : 1;

  const host = document.createElement("div");
  host.id = "openedit-overlay";
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    @property --oe-a { syntax: "<angle>"; inherits: true; initial-value: 0deg; }
    :host { all: initial; }
    * { box-sizing: border-box; }
    .glow { position: fixed; inset: 0; opacity: 0; transition: opacity ${1.1 * m}s cubic-bezier(.22,1,.36,1); animation: spin ${5 * m}s linear infinite; }
    .on .glow { opacity: 1; }
    .ring { position: absolute; inset: 0;
      background: conic-gradient(from var(--oe-a), #ff8a5b, #ffc46b, #ff5fa2, #8b7bff, #4cc9f0, #3ee6a8, #ff8a5b);
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
      mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0); }
    .sharp { padding: 3px; }
    .soft { position: absolute; inset: 0; filter: blur(20px); animation: pulse ${2.4 * m}s ease-in-out infinite; }
    .soft .ring { padding: 14px; }
    @keyframes spin { to { --oe-a: 360deg; } }
    @keyframes pulse { 0%,100% { opacity: .5 } 50% { opacity: 1 } }
    .cur { position: fixed; left: 0; top: 0; opacity: 0; transition: opacity ${0.5 * m}s; }
    .cur.vis { opacity: 1; }
    .hl { position: fixed; left: 0; top: 0; border-radius: 12px; border: 1.5px solid rgba(255,168,130,.95);
      box-shadow: 0 0 0 4px rgba(255,138,91,.14), 0 0 26px rgba(255,95,162,.55); }
    .ptr { position: fixed; left: 0; top: 0; display: flex; gap: 2px; }
    .ptr svg { width: 26px; height: 26px; filter: drop-shadow(0 4px 10px rgba(255,95,162,.6)); }
    .lbl { margin: 18px 0 0 -8px; padding: 4px 10px; border-radius: 99px; white-space: nowrap; font: 650 11.5px/1.3 -apple-system, "Inter", sans-serif;
      color: #fff; background: linear-gradient(90deg,#ff7d55,#ff4f9a); box-shadow: 0 6px 20px rgba(255,79,154,.45); }
    .pill { position: fixed; left: 50%; bottom: 22px; transform: translate(-50%, 20px); opacity: 0;
      transition: transform ${0.5 * m}s cubic-bezier(.22,1,.36,1), opacity ${0.5 * m}s;
      display: flex; align-items: center; gap: 12px; padding: 10px 16px 10px 12px; border-radius: 16px; min-width: 260px; max-width: 520px;
      background: rgba(20,20,30,.7); backdrop-filter: blur(22px) saturate(150%); -webkit-backdrop-filter: blur(22px) saturate(150%);
      border: 1px solid rgba(255,255,255,.12); box-shadow: 0 20px 60px -15px rgba(0,0,0,.6); color: #f2f1f7;
      font: 13px/1.35 -apple-system, "Inter", sans-serif; }
    .on .pill, .pill.show { transform: translate(-50%, 0); opacity: 1; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #3ee6a8; flex: none; }
    .on .dot { background: #ff8a5b; box-shadow: 0 0 12px #ff8a5b; animation: pulse ${1.2 * m}s infinite; }
    .txt { min-width: 0; flex: 1; }
    .t { font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .d { color: #9a98ab; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bar { position: relative; height: 4px; margin-top: 6px; border-radius: 9px; background: rgba(255,255,255,.08); overflow: hidden; }
    .fill { position: absolute; inset: 0 auto 0 0; width: 0; background: linear-gradient(90deg,#ff8a5b,#ff5fa2,#8b7bff); transition: width ${0.5 * m}s; }
    .ind .fill { width: 40%; animation: ind ${1.3 * m}s ease-in-out infinite; }
    @keyframes ind { from { transform: translateX(-100%) } to { transform: translateX(260%) } }
    .brand { font: 700 10px/1 -apple-system, sans-serif; letter-spacing: .12em; text-transform: uppercase; color: #ffb08a; }
  </style>
  <div class="wrap">
    <div class="glow"><div class="soft"><div class="ring"></div></div><div class="ring sharp"></div></div>
    <div class="cur"><div class="hl"></div><div class="ptr"><svg viewBox="0 0 28 28"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb08a"/><stop offset="1" stop-color="#ff5fa2"/></linearGradient></defs><path d="M4 3l18 9.2-7.6 1.9L11 22z" fill="url(#g)" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><span class="lbl">Claude</span></div></div>
    <div class="pill"><span class="dot"></span><div class="txt"><div class="brand">OpenEdit</div><div class="t">Ready</div><div class="d"></div><div class="bar ind"><div class="fill"></div></div></div></div>
  </div>`;
  document.documentElement.appendChild(host);

  const q = (s) => root.querySelector(s);
  const wrap = q(".wrap"), cur = q(".cur"), hl = q(".hl"), ptr = q(".ptr"), lbl = q(".lbl");
  const pill = q(".pill"), title = q(".t"), detail = q(".d"), bar = q(".bar"), fill = q(".fill");
  const c = { el: null, pt: null, x: innerWidth / 2, y: innerHeight / 2, w: 40, h: 40 };
  let idleT = 0;
  const running = new Map();

  function point(target, label) {
    let el = typeof target === "string" ? document.querySelector(target) : target;
    if (target && typeof target === "object" && !(target instanceof Element) && "x" in target) {
      c.el = null;
      c.pt = { x: target.x, y: target.y };
    } else if (el instanceof Element) {
      c.el = el;
      c.pt = null;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    } else {
      c.el = null;
      c.pt = null;
    }
    if (label) lbl.textContent = label;
    cur.classList.add("vis");
  }
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(64, now - last) / 1000;
    last = now;
    let tx, ty, tw, th;
    if (c.el && c.el.isConnected) {
      const r = c.el.getBoundingClientRect();
      [tx, ty, tw, th] = [r.left - 6, r.top - 6, r.width + 12, r.height + 12];
    } else if (c.pt) [tx, ty, tw, th] = [c.pt.x - 14, c.pt.y - 14, 28, 28];
    else {
      const r = pill.getBoundingClientRect();
      [tx, ty, tw, th] = [r.left - 4, r.top - 4, r.width + 8, r.height + 8];
    }
    const k = 1 - Math.exp(-dt * (reduced ? 18 : 7.5));
    c.x += (tx - c.x) * k; c.y += (ty - c.y) * k; c.w += (tw - c.w) * k; c.h += (th - c.h) * k;
    hl.style.transform = `translate3d(${c.x}px,${c.y}px,0)`;
    hl.style.width = `${c.w}px`;
    hl.style.height = `${c.h}px`;
    let px = c.x + c.w - 10, py = c.y + c.h - 12;
    const lw = lbl.offsetWidth + 30;
    if (px + lw > innerWidth - 8) px = Math.max(8, c.x + c.w - lw - 8);
    if (py + 50 > innerHeight) py = Math.max(8, c.y - 34);
    ptr.style.transform = `translate3d(${px}px,${py}px,0)`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function working(t, d) {
    clearTimeout(idleT);
    wrap.classList.add("on");
    title.textContent = t || "Working";
    detail.textContent = d || "";
    progress(null);
    cur.classList.add("vis");
  }
  function progress(f, d) {
    if (d) detail.textContent = d;
    if (typeof f === "number") {
      bar.classList.remove("ind");
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;
    } else {
      bar.classList.add("ind");
      fill.style.width = "";
    }
  }
  function done(summary) {
    clearTimeout(idleT);
    idleT = setTimeout(() => {
      if (running.size) return;
      wrap.classList.remove("on");
      title.textContent = "Done";
      detail.textContent = summary || "";
      bar.classList.remove("ind");
      fill.style.width = "100%";
      pill.classList.add("show");
      cur.classList.remove("vis");
      setTimeout(() => pill.classList.remove("show"), 4000);
    }, 650 * m);
  }

  let es;
  try {
    es = new EventSource(`${origin}/events`);
    es.onmessage = (msg) => {
      const e = JSON.parse(msg.data);
      if (e.type === "tool_start") {
        running.set(e.id, e);
        working(e.title, e.target?.label || e.args);
        if (e.target?.selector) point(e.target.selector, `Claude · ${e.title}`);
        else lbl.textContent = `Claude · ${e.title}`;
      } else if (e.type === "progress") progress(typeof e.fraction === "number" ? e.fraction : null, e.detail);
      else if (e.type === "tool_end") {
        running.delete(e.id);
        if (!running.size) done(e.summary);
      }
    };
  } catch {
    /* CSP may block the stream; the manual API still works */
  }

  window.OpenEditOverlay = {
    point,
    working,
    progress,
    done: (s) => { running.clear(); done(s); },
    hide: () => { es?.close(); host.remove(); delete window.__openeditOverlay; delete window.OpenEditOverlay; },
  };
})();
