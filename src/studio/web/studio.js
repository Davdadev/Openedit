// OpenEdit Studio page: renders the live event stream from /events.
const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const M = reduced ? 0.35 : 1; // motion scale: shorter, never removed

const REASON_COLORS = { silence: "#5b8cff", filler: "#ffb547", retake: "#ff5d8f", manual: "#b07bff" };
const REASON_NAMES = { silence: "Silence", filler: "Filler", retake: "Retake", manual: "Manual" };
const OUTPUT_TOOL = /render|export|download|generate|fetch|make_|motion|overlay/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg)$/i;

let S;
function freshState() {
  return {
    running: new Map(), // id -> {tool,title,args,target,t0,fraction,detail}
    steps: new Map(), // id -> li
    current: null,
    lastSeq: 0,
    plan: null,
    applied: false,
    captions: [],
    zooms: [],
    clips: [],
    media: new Map(),
    outputs: new Set(),
    toolMs: 0,
    stepCount: 0,
    lastEnd: null,
    idleTimer: 0,
    cursorFade: 0,
  };
}
S = freshState();

/* ---------------- helpers ---------------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const base = (p) => String(p ?? "").split(/[\\/]/).pop();
const mediaUrl = (p) => `/media?path=${encodeURIComponent(p)}`;
function clock(sec, dec = false) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${(dec ? s.toFixed(1) : Math.floor(s).toString()).padStart(dec ? 4 : 2, "0")}`;
}
function dur(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}`;
}
function hhmmss(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function swapText(el, text) {
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.remove("swap");
  void el.offsetWidth;
  el.classList.add("swap");
}
function timeOf(at) {
  const d = new Date(at || Date.now());
  return d.toTimeString().slice(0, 8);
}

/* ---------------- Claude cursor ---------------- */
const cursor = {
  el: $("cursor"),
  ring: $("cursor-ring"),
  spot: $("cursor-spot"),
  pointer: $("cursor-pointer"),
  label: $("cursor-label"),
  target: null,
  x: innerWidth / 2,
  y: innerHeight / 2,
  w: 40,
  h: 40,
  started: false,
};

function pointAt(el, label) {
  if (!el) return;
  clearTimeout(S.cursorFade);
  if (cursor.target && cursor.target !== el) cursor.target.removeAttribute("data-cursor-target");
  cursor.target = el;
  el.setAttribute("data-cursor-target", "");
  cursor.el.dataset.target = el.id || el.dataset.path || el.className;
  if (label) cursor.label.textContent = label;
  if (!cursor.started) {
    // First appearance: start from the status panel so the glide is visible.
    const r = $("st-title").getBoundingClientRect();
    Object.assign(cursor, { x: r.left, y: r.top, w: r.width, h: r.height, started: true });
  }
  cursor.el.classList.add("visible");
  const r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight) el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
}

function fadeCursor(delay = 1400) {
  clearTimeout(S.cursorFade);
  S.cursorFade = setTimeout(() => cursor.el.classList.remove("visible"), delay);
}

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(64, now - lastFrame) / 1000;
  lastFrame = now;
  if (cursor.target && cursor.target.isConnected) {
    const r = cursor.target.getBoundingClientRect();
    const pad = r.height < 40 ? 5 : 7;
    const tx = r.left - pad;
    const ty = r.top - pad;
    const tw = Math.max(18, r.width + pad * 2);
    const th = Math.max(18, r.height + pad * 2);
    const k = 1 - Math.exp(-dt * (reduced ? 18 : 7.5));
    cursor.x += (tx - cursor.x) * k;
    cursor.y += (ty - cursor.y) * k;
    cursor.w += (tw - cursor.w) * k;
    cursor.h += (th - cursor.h) * k;
  }
  const { x, y, w, h } = cursor;
  cursor.ring.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  cursor.ring.style.width = `${w}px`;
  cursor.ring.style.height = `${h}px`;
  const sd = Math.min(520, Math.max(w, h) * 1.6 + 80);
  cursor.spot.style.transform = `translate3d(${x + w / 2 - sd / 2}px, ${y + h / 2 - sd / 2}px, 0)`;
  cursor.spot.style.width = cursor.spot.style.height = `${sd}px`;
  // Pointer sits on the ring's lower-right, flipping inward near the viewport edge.
  const lw = cursor.label.offsetWidth + 30;
  let px = x + w - 10;
  let py = y + h - 12;
  if (px + lw > innerWidth - 8) px = Math.max(8, x + w - lw - 8);
  if (py + 50 > innerHeight) py = Math.max(8, y - 34);
  cursor.pointer.style.transform = `translate3d(${px}px, ${py}px, 0)`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ---------------- working / idle ---------------- */
function setWorking(on) {
  clearTimeout(S.idleTimer);
  if (on) {
    document.body.classList.add("working");
    document.body.classList.remove("idle");
    $("st-state-text").textContent = "Working";
    $("hero-eyebrow").textContent = "Claude is working";
    return;
  }
  S.idleTimer = setTimeout(() => {
    if (S.running.size) return;
    document.body.classList.remove("working");
    document.body.classList.add("idle");
    $("st-state-text").textContent = "Idle";
    $("hero-eyebrow").textContent = S.stepCount ? "Idle" : "Standing by";
    if (S.lastEnd) {
      swapText($("hero-title"), S.lastEnd.ok ? "All caught up" : "Stopped on an error");
      $("hero-detail").textContent = S.lastEnd.summary || "";
    }
    fadeCursor(900);
  }, 650 * M);
}

/* ---------------- status panel ---------------- */
function setProgress(mode, fraction, detail) {
  const p = $("progress");
  p.dataset.mode = mode;
  $("progress-fill").style.width = mode === "determinate" ? `${Math.round(fraction * 1000) / 10}%` : "";
  $("progress-pct").textContent = mode === "determinate" ? `${Math.round(fraction * 100)}%` : mode === "done" ? "100%" : "";
  if (detail !== undefined) $("progress-detail").textContent = detail;
}

const ICON_OK = '<svg viewBox="0 0 12 12"><path d="M2.5 6.4l2.3 2.2 4.7-5"/></svg>';
const ICON_ERR = '<svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6"/></svg>';

function addStep(e) {
  const list = $("history");
  list.querySelector(".history-empty")?.remove();
  const li = document.createElement("li");
  li.className = "step running";
  li.dataset.id = e.id;
  li.dataset.tool = e.tool;
  li.innerHTML = `<span class="ic"></span><div class="st-txt"><div class="t">${esc(e.title)}</div><div class="s">${esc(e.args || e.tool)}</div></div><span class="d">…</span>`;
  list.prepend(li);
  S.steps.set(e.id, li);
  while (list.children.length > 60) list.lastElementChild.remove();
}

function finishStep(e) {
  const li = S.steps.get(e.id);
  if (!li) return;
  li.className = `step ${e.ok ? "done" : "failed"}`;
  li.querySelector(".ic").innerHTML = e.ok ? ICON_OK : ICON_ERR;
  if (e.summary) li.querySelector(".s").textContent = e.summary;
  li.querySelector(".d").textContent = e.ms != null ? dur(e.ms) : "";
}

function showCurrent() {
  const cur = S.running.get(S.current);
  if (!cur) return;
  swapText($("st-title"), cur.title);
  $("st-tool").textContent = cur.tool;
  $("st-args").textContent = cur.args || "";
  if (cur.fraction == null) setProgress("indeterminate", 0, cur.detail || "Working…");
  else setProgress("determinate", cur.fraction, cur.detail || "");
}

setInterval(() => {
  const cur = S.running.get(S.current);
  if (cur) $("st-elapsed").textContent = hhmmss(Date.now() - cur.t0);
}, 250);

function log(cls, text, at) {
  const ol = $("log");
  const li = document.createElement("li");
  li.className = cls;
  li.innerHTML = `<time>${timeOf(at)}</time><span>${esc(text)}</span>`;
  ol.append(li);
  while (ol.children.length > 200) ol.firstElementChild.remove();
  ol.scrollTop = ol.scrollHeight;
}

/* ---------------- target resolution ---------------- */
function findCard(path) {
  if (!path) return null;
  return [...document.querySelectorAll(".mcard[data-path]")].find((c) => c.dataset.path === path) || null;
}

function setSource(path) {
  if (!path) return;
  $("source-chip").hidden = false;
  $("source-chip").dataset.path = path;
  $("source-name").textContent = base(path);
  $("source-chip").title = path;
}

function resolveTarget(e) {
  const t = e.target;
  const tlVisible = !$("tl-body").hidden;
  const hasPlan = !!S.plan;
  if (!t) return $("st-title");
  switch (t.kind) {
    case "file": {
      const card = findCard(t.path);
      if (card) return card;
      if (OUTPUT_TOOL.test(e.tool)) return pendingCard(e);
      if (t.path && (!hasPlan || S.plan.source === t.path)) {
        setSource(t.path);
        return $("source-chip");
      }
      return pendingCard(e);
    }
    case "media":
      return findCard(t.path) || pendingCard(e);
    case "timeline":
      if (!tlVisible) return $("timeline");
      if (hasPlan) return /edit|zoom/i.test(t.label || "") ? (/zoom/i.test(t.label) ? $("lane-zooms") : $("lane-edit")) : $("lane-source");
      return $("tl-body");
    case "caption":
      return tlVisible ? $("lane-captions") : $("timeline");
    case "range":
      if (!tlVisible) return $("timeline");
      return showRange(t.start, t.end) || $("tl-body");
    case "clip": {
      const c = [...document.querySelectorAll(".clip[data-path]")].find((x) => x.dataset.path === t.path);
      return c || (tlVisible ? $("clip-lanes").firstElementChild || $("tl-body") : $("timeline"));
    }
  }
  return $("st-title");
}

/* ---------------- media grid ---------------- */
function licenseClass(l) {
  if (!l) return "";
  if (/cc0|public.?domain|pexels|pixabay|unsplash|mixkit|royalty.?free|free/i.test(l)) return "lic-free";
  if (/unknown|restricted|editorial|\bnc\b|non.?commercial|check/i.test(l)) return "lic-warn";
  if (/cc|attribution|by/i.test(l)) return "lic-attr";
  return "";
}

const ART = {
  video: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="14" height="14" rx="3"/><path d="M17 10l4-2.5v9L17 14z"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 9"/></svg>',
  caption: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3"/></svg>',
  other: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
};

function kindOf(item) {
  if (item.kind && item.kind !== "other") return item.kind;
  const p = item.path || "";
  if (/\.(mp4|mov|webm|m4v|mkv)$/i.test(p)) return "video";
  if (/\.(png|jpe?g|gif|webp)$/i.test(p)) return "image";
  if (AUDIO_EXT.test(p)) return "audio";
  if (/\.(srt|vtt|ass)$/i.test(p)) return "caption";
  return item.kind || "other";
}

function waveBars(seed, n = 26) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  let out = "";
  for (let i = 0; i < n; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    const v = 0.25 + 0.75 * Math.abs(Math.sin(i * 0.55 + (h % 100) / 40));
    out += `<i style="height:${Math.round(8 + v * 36)}px"></i>`;
  }
  return `<div class="wavebars">${out}</div>`;
}

function artFor(kind, path) {
  if (kind === "audio") return `<div class="kind-art">${waveBars(path)}</div>`;
  return `<div class="kind-art">${ART[kind] || ART.other}</div>`;
}

function upsertMedia(item, animateCursor) {
  if (!item?.path) return;
  const kind = kindOf(item);
  let card = findCard(item.path);
  const isNew = !card;
  if (!card) {
    card = document.createElement("article");
    card.className = "mcard";
    card.dataset.path = item.path;
    card.dataset.kind = kind;
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.dataset.kind = kind;
    if (kind === "image") {
      const img = new Image();
      img.loading = "lazy";
      img.alt = "";
      img.src = mediaUrl(item.path);
      img.onerror = () => (thumb.innerHTML = artFor(kind, item.path));
      thumb.append(img);
    } else if (kind === "video") {
      const v = document.createElement("video");
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.preload = "metadata";
      v.src = `${mediaUrl(item.path)}#t=0.1`;
      v.onerror = () => (thumb.innerHTML = artFor(kind, item.path));
      v.onloadedmetadata = () => {
        const b = document.createElement("span");
        b.className = "play";
        b.textContent = `▶ ${clock(v.duration)}`;
        thumb.append(b);
      };
      card.addEventListener("mouseenter", () => v.play().catch(() => {}));
      card.addEventListener("mouseleave", () => v.pause());
      thumb.append(v);
    } else thumb.innerHTML = artFor(kind, item.path);
    card.append(thumb);
    const meta = document.createElement("div");
    meta.className = "mmeta";
    card.append(meta);
    $("media-grid").prepend(card);
    card.addEventListener("click", () => window.open(mediaUrl(item.path), "_blank"));
  }
  const prev = S.media.get(item.path) || {};
  const it = { ...prev, ...Object.fromEntries(Object.entries(item).filter(([, v]) => v != null)) };
  S.media.set(item.path, it);
  const lic = it.license ? `<span class="badge ${licenseClass(it.license)}">${esc(it.license)}</span>` : "";
  card.querySelector(".mmeta").innerHTML =
    `<div class="mname" title="${esc(it.path)}">${esc(it.title || base(it.path))}</div>` +
    `<div class="msub"><span class="badge kind">${esc(kind)}</span>${lic}${it.source ? `<span>${esc(it.source)}</span>` : ""}</div>`;
  updateMediaCount();
  if (isNew && animateCursor && S.running.size) pointAt(card, `Added ${base(it.path)}`);
  return card;
}

function pendingCard(e) {
  const key = `pending-${e.id}`;
  let card = $(key);
  if (card) return card;
  card = document.createElement("article");
  card.className = "mcard pending";
  card.id = key;
  const label = e.target?.label || e.title;
  card.innerHTML =
    `<div class="thumb"><svg class="ring-prog indet" viewBox="0 0 54 54"><circle class="bg" cx="27" cy="27" r="22"/><circle class="fg" cx="27" cy="27" r="22" stroke-dasharray="138.2" stroke-dashoffset="104"/></svg></div>` +
    `<div class="mmeta"><div class="mname">${esc(label)}</div><div class="msub"><span class="badge kind">${esc(e.title)}</span></div></div>`;
  $("media-grid").prepend(card);
  updateMediaCount();
  return card;
}

function pendingProgress(id, fraction) {
  const card = $(`pending-${id}`);
  const ring = card?.querySelector(".ring-prog");
  if (!ring) return;
  if (fraction == null) {
    ring.classList.add("indet");
    ring.querySelector(".fg").setAttribute("stroke-dashoffset", "104");
  } else {
    ring.classList.remove("indet");
    ring.querySelector(".fg").setAttribute("stroke-dashoffset", String(138.2 * (1 - fraction)));
  }
}

function endPending(id, ok) {
  const card = $(`pending-${id}`);
  if (!card) return;
  if (ok) {
    card.style.transition = `opacity ${0.35 * M}s, transform ${0.35 * M}s`;
    card.style.opacity = "0";
    card.style.transform = "scale(0.96)";
    setTimeout(() => {
      card.remove();
      updateMediaCount();
    }, 360 * M);
  } else {
    card.classList.remove("pending");
    card.classList.add("failed");
    card.querySelector(".thumb").innerHTML = `<div class="kind-art" style="color:#ff9aa3;font-weight:600">Failed</div>`;
    setTimeout(() => {
      card.remove();
      updateMediaCount();
    }, 4000);
  }
}

function updateMediaCount() {
  const n = $("media-grid").querySelectorAll(".mcard:not(.pending)").length;
  $("media-count").textContent = n ? `${n} file${n === 1 ? "" : "s"}` : "";
  $("media-empty").hidden = $("media-grid").children.length > 0;
}

/* ---------------- timeline ---------------- */
function editedDuration() {
  if (S.plan) return S.plan.keep.reduce((a, k) => a + (k.end - k.start), 0);
  const ends = [...S.captions.map((c) => c.end), ...S.zooms.map((z) => z.end), ...S.clips.map((c) => c.at + (c.duration || 3))];
  return Math.max(10, ...ends);
}

function niceStep(d, target = 8) {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return steps.find((s) => d / s <= target) || 3600;
}

function drawRuler(el, d) {
  const step = niceStep(d);
  const minor = step / (step >= 10 ? 5 : 2);
  let html = "";
  for (let t = 0; t <= d + 1e-6; t += minor) {
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    html += `<i class="tick${major ? " major" : ""}" style="left:${(t / d) * 100}%">${major && t / d < 0.97 ? `<span>${clock(t)}</span>` : ""}</i>`;
  }
  el.innerHTML = html;
}

/** Ordered keep/removed pieces covering [0, duration]. */
function pieces(plan) {
  const keep = [...plan.keep].sort((a, b) => a.start - b.start);
  const out = [];
  let t = 0;
  const reasonFor = (a, b) => {
    let best = null;
    let bestOv = 0;
    for (const c of plan.cuts) {
      const ov = Math.min(b, c.end) - Math.max(a, c.start);
      if (ov > bestOv) [best, bestOv] = [c, ov];
    }
    return best?.reason || "silence";
  };
  for (const k of keep) {
    if (k.start > t + 1e-3) out.push({ kind: "cut", start: t, end: k.start, reason: reasonFor(t, k.start) });
    out.push({ kind: "keep", start: k.start, end: k.end });
    t = k.end;
  }
  if (plan.duration > t + 1e-3) out.push({ kind: "cut", start: t, end: plan.duration, reason: reasonFor(t, plan.duration) });
  return out;
}

function seeded(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function drawWave() {
  const c = $("wave");
  if (!S.plan || !c.isConnected) return;
  const r = c.getBoundingClientRect();
  if (!r.width) return;
  const dpr = devicePixelRatio || 1;
  c.width = Math.round(r.width * dpr);
  c.height = Math.round(r.height * dpr);
  const g = c.getContext("2d");
  g.scale(dpr, dpr);
  const W = r.width;
  const H = r.height;
  const d = S.plan.duration || 1;
  const rnd = seeded(S.plan.source || "x");
  const silent = (t) => S.plan.cuts.some((k) => k.reason === "silence" && t >= k.start && t <= k.end);
  const kept = (t) => S.plan.keep.some((k) => t >= k.start && t <= k.end);
  const grad = g.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, "#ffa175");
  grad.addColorStop(0.5, "#ff6aa8");
  grad.addColorStop(1, "#a07bff");
  const bar = 2;
  const gap = 1.5;
  let phase = rnd() * 10;
  for (let x = 0; x < W; x += bar + gap) {
    const t = (x / W) * d;
    phase += 0.18 + rnd() * 0.1;
    let a = (0.35 + 0.65 * Math.abs(Math.sin(phase) * Math.sin(phase * 0.37 + 1.3))) * (0.6 + 0.4 * rnd());
    if (silent(t)) a = 0.04 + rnd() * 0.05;
    const h = Math.max(1.5, a * (H * 0.78));
    g.fillStyle = kept(t) ? grad : "rgba(255,255,255,0.16)";
    g.globalAlpha = kept(t) ? 0.85 : 1;
    g.beginPath();
    g.roundRect ? g.roundRect(x, (H - h) / 2, bar, h, 1) : g.rect(x, (H - h) / 2, bar, h);
    g.fill();
  }
}

function renderLegend() {
  const lg = $("legend");
  if (!S.plan) {
    lg.innerHTML = "";
    return;
  }
  const by = {};
  for (const c of S.plan.cuts) {
    by[c.reason] ??= { n: 0, s: 0 };
    by[c.reason].n++;
    by[c.reason].s += c.end - c.start;
  }
  const keptS = S.plan.keep.reduce((a, k) => a + k.end - k.start, 0);
  let html = `<span class="lg"><span class="sw" style="background:linear-gradient(90deg,#ff9a6b,#c46bff)"></span>Kept <b>${clock(keptS)}</b></span>`;
  for (const r of ["silence", "filler", "retake", "manual"]) {
    if (!by[r]) continue;
    html += `<span class="lg" data-reason="${r}"><span class="sw" style="background:${REASON_COLORS[r]}"></span>${REASON_NAMES[r]} <b>${by[r].n}</b> · ${by[r].s.toFixed(1)}s</span>`;
  }
  lg.innerHTML = html;
}

function renderPlan(instant) {
  const p = S.plan;
  const srcGroup = $("lane-source").closest(".tl-group");
  const editGroup = $("lane-edit").closest(".tl-group");
  srcGroup.hidden = editGroup.hidden = !p;
  if (!p) return;
  setSource(p.source);
  const d = p.duration || 1;
  drawRuler($("ruler-src"), d);
  $("src-dur").textContent = clock(d, true);
  const ed = editedDuration();
  $("edit-dur").textContent = clock(ed, true);
  drawRuler($("ruler-edit"), S.applied ? ed : d);

  // Source lane: kept vs cut (hatched, colored by reason).
  const segs = $("segs-source");
  segs.innerHTML = "";
  const all = [...p.keep.map((k) => ({ ...k, kind: "keep" })), ...p.cuts.map((c) => ({ ...c, kind: "cut" }))];
  all.forEach((s, i) => {
    const el = document.createElement("div");
    el.className = `seg ${s.kind}`;
    if (s.kind === "cut") {
      el.dataset.reason = s.reason;
      el.title = `${REASON_NAMES[s.reason] || s.reason} ${clock(s.start, true)}–${clock(s.end, true)}${s.label ? ` · ${s.label}` : ""}`;
      el.style.animationDelay = `${Math.min(i * 25, 900) * M}ms`;
    }
    el.style.left = `${(s.start / d) * 100}%`;
    el.style.width = `${Math.max(0.15, ((s.end - s.start) / d) * 100)}%`;
    segs.append(el);
  });

  // Edit lane: same pieces in a flex row; cuts collapse when applied.
  const flex = $("segs-edit");
  flex.classList.remove("applied");
  flex.innerHTML = "";
  const ps = pieces(p);
  const cuts = ps.filter((x) => x.kind === "cut").length || 1;
  const stagger = Math.min(70, 1400 / cuts) * M;
  let ci = 0;
  for (const x of ps) {
    const el = document.createElement("div");
    el.className = `piece ${x.kind}`;
    el.style.setProperty("--g", String(Math.max(0.0001, x.end - x.start)));
    if (x.kind === "cut") {
      el.dataset.reason = x.reason;
      el.style.transitionDelay = `${ci++ * stagger}ms`;
    }
    flex.append(el);
  }
  const badge = $("edit-badge");
  if (S.applied) {
    if (instant) {
      flex.querySelectorAll(".piece").forEach((el) => (el.style.transition = "none"));
      flex.classList.add("applied");
      void flex.offsetWidth;
      flex.querySelectorAll(".piece").forEach((el) => (el.style.transition = ""));
    } else requestAnimationFrame(() => requestAnimationFrame(() => flex.classList.add("applied")));
    badge.textContent = "Applied";
    badge.classList.add("done");
  } else {
    badge.textContent = "Preview · not applied";
    badge.classList.remove("done");
  }
  renderLegend();
  const saved = d - ed;
  const chip = $("stat-saved");
  chip.hidden = false;
  chip.innerHTML = `${clock(d)} → ${clock(ed)} · saves <b>${saved.toFixed(1)}s</b> (${Math.round((saved / d) * 100)}%)`;
  requestAnimationFrame(drawWave);
}

function renderEditLanes() {
  const d = editedDuration();
  const pct = (t) => `${Math.max(0, Math.min(100, (t / d) * 100))}%`;
  const cap = $("lane-captions");
  cap.innerHTML = "";
  S.captions.forEach((c, i) => {
    const el = document.createElement("div");
    el.className = "cap";
    el.style.left = pct(c.start);
    el.style.width = `calc(${pct(c.end - c.start)} - 2px)`;
    el.style.animationDelay = `${Math.min(i * 30, 1200) * M}ms`;
    el.textContent = c.text;
    el.title = `${clock(c.start, true)} ${c.text}`;
    cap.append(el);
  });
  $("cap-count").textContent = S.captions.length ? String(S.captions.length) : "";
  const zl = $("lane-zooms");
  zl.innerHTML = "";
  S.zooms.forEach((z, i) => {
    const el = document.createElement("div");
    el.className = "zoom";
    el.style.left = pct(z.start);
    el.style.width = pct(Math.max(0.2, z.end - z.start));
    el.style.animationDelay = `${i * 60 * M}ms`;
    el.innerHTML = `<span>${Math.round(z.scale)}%</span>`;
    zl.append(el);
  });
  $("zoom-count").textContent = S.zooms.length ? String(S.zooms.length) : "";
  const lanes = $("clip-lanes");
  lanes.innerHTML = "";
  const byTrack = new Map();
  for (const c of S.clips) {
    const audio = AUDIO_EXT.test(c.path);
    const key = `${audio ? "A" : "V"}${c.track ?? 2}`;
    if (!byTrack.has(key)) byTrack.set(key, []);
    byTrack.get(key).push({ ...c, audio });
  }
  for (const [key, list] of [...byTrack].sort()) {
    const g = document.createElement("div");
    g.className = "tl-group";
    g.innerHTML = `<div class="lane-label">${key}<small>${list[0].audio ? "audio" : "video"}</small></div><div class="lane-wrap"><div class="lane-track thin"></div></div>`;
    const track = g.querySelector(".lane-track");
    list.forEach((c, i) => {
      const el = document.createElement("div");
      el.className = "clip";
      el.dataset.path = c.path;
      el.dataset.kind = c.audio ? "audio" : "video";
      el.style.left = pct(c.at);
      el.style.width = pct(c.duration || 3);
      el.style.animationDelay = `${i * 60 * M}ms`;
      el.textContent = base(c.path);
      el.title = `${base(c.path)} @ ${clock(c.at, true)}`;
      track.append(el);
    });
    lanes.append(g);
  }
}

function showRange(start, end) {
  const host = $("edit-lanes");
  const ref = $("lane-captions");
  const hr = host.getBoundingClientRect();
  const rr = ref.getBoundingClientRect();
  if (!rr.width || start == null) return null;
  const d = editedDuration();
  const hi = $("range-hi");
  const a = Math.max(0, Math.min(1, start / d));
  const b = Math.max(a + 0.004, Math.min(1, (end ?? start) / d));
  hi.hidden = false;
  hi.style.left = `${rr.left - hr.left + a * rr.width - 3}px`;
  hi.style.width = `${Math.max(10, (b - a) * rr.width + 6)}px`;
  return hi;
}

function renderTimeline(instant) {
  const any = S.plan || S.captions.length || S.zooms.length || S.clips.length;
  $("tl-empty").hidden = !!any;
  $("tl-body").hidden = !any;
  if (!any) return;
  renderPlan(instant);
  renderEditLanes();
}

addEventListener("resize", () => requestAnimationFrame(drawWave));

/* ---------------- event handling ---------------- */
function handle(e, instant = false) {
  if (!e || !e.type) return;
  if (e.seq && !instant && e.seq <= S.lastSeq) return;
  if (e.seq) S.lastSeq = Math.max(S.lastSeq, e.seq);
  switch (e.type) {
    case "session":
      $("session").textContent = `session ${e.session}${e.version ? ` · v${e.version}` : ""}`;
      if (!instant) log("", `New OpenEdit session ${e.session}`, e.at);
      break;
    case "tool_start": {
      const stale = instant && Date.now() - (e.at || 0) > 20 * 60 * 1000;
      S.running.set(e.id, { ...e, t0: e.at || Date.now(), fraction: null });
      S.current = e.id;
      S.stepCount++;
      $("stat-steps").textContent = String(S.stepCount);
      addStep(e);
      log("start", `${e.title}${e.args ? ` — ${e.args}` : ""}`, e.at);
      if (stale) {
        handle({ type: "tool_end", id: e.id, tool: e.tool, ok: false, summary: "No result (session ended)" }, true);
        break;
      }
      setWorking(true);
      if (e.target?.kind !== "range") $("range-hi").hidden = true;
      swapText($("hero-title"), e.title);
      $("hero-detail").textContent = e.target?.label ? `${e.target.label}${e.args ? ` · ${e.args}` : ""}` : e.args || e.tool;
      showCurrent();
      const el = resolveTarget(e);
      pointAt(el, `Claude · ${e.title}`);
      break;
    }
    case "progress": {
      const id = e.id && S.running.has(e.id) ? e.id : S.current;
      const cur = S.running.get(id);
      if (!cur) break;
      cur.fraction = typeof e.fraction === "number" ? e.fraction : null;
      if (e.detail) cur.detail = e.detail;
      if (id === S.current) showCurrent();
      pendingProgress(id, cur.fraction);
      break;
    }
    case "tool_end": {
      const cur = S.running.get(e.id);
      S.running.delete(e.id);
      finishStep(e);
      S.toolMs += e.ms || (cur ? Date.now() - cur.t0 : 0);
      $("stat-time").textContent = dur(S.toolMs);
      for (const o of e.outputs || []) S.outputs.add(o);
      $("stat-outputs").textContent = String(S.outputs.size);
      log(e.ok ? "ok" : "err", e.summary || `${e.tool} ${e.ok ? "done" : "failed"}`, e.at);
      endPending(e.id, e.ok);
      $("range-hi").hidden = true;
      S.lastEnd = e;
      if (S.current === e.id) {
        S.current = [...S.running.keys()].pop() ?? null;
        if (S.current) showCurrent();
        else {
          setProgress(e.ok ? "done" : "error", 1, e.ok ? e.summary || "Done" : e.summary || "Failed");
          if (cur) $("st-elapsed").textContent = hhmmss(e.ms ?? Date.now() - cur.t0);
        }
      }
      if (!S.running.size) setWorking(false);
      break;
    }
    case "log":
      log(e.level === "error" ? "err" : e.level === "warn" ? "warn" : "", e.message, e.at);
      break;
    case "timeline": {
      if (e.plan) {
        if (S.plan && S.plan.source !== e.plan.source) {
          S.captions = [];
          S.zooms = [];
          S.clips = [];
        }
        const wasApplied = S.applied && S.plan?.id === e.plan.id;
        S.plan = e.plan;
        S.applied = !!e.applied || wasApplied;
      }
      if (e.captions) S.captions = e.captions;
      if (e.zooms) {
        const k = (z) => `${z.start}-${z.end}`;
        const have = new Set(S.zooms.map(k));
        S.zooms = [...S.zooms, ...e.zooms.filter((z) => !have.has(k(z)))];
      }
      if (e.clips) S.clips = [...S.clips, ...e.clips];
      renderTimeline(instant);
      if (!instant && S.running.size) {
        const target = e.captions ? $("lane-captions") : e.zooms ? $("lane-zooms") : e.clips ? $("clip-lanes").lastElementChild : e.applied ? $("lane-edit") : e.plan ? $("lane-source") : null;
        if (target) pointAt(target, cursor.label.textContent);
      }
      break;
    }
    case "media":
      for (const it of e.items || []) upsertMedia(it, !instant);
      break;
  }
}

function resetAll() {
  for (const t of [S.idleTimer, S.cursorFade]) clearTimeout(t);
  S = freshState();
  $("history").innerHTML = '<li class="history-empty">No steps yet</li>';
  $("log").innerHTML = "";
  $("media-grid").innerHTML = "";
  $("legend").innerHTML = "";
  $("stat-saved").hidden = true;
  $("source-chip").hidden = true;
  for (const id of ["stat-steps", "stat-outputs"]) $(id).textContent = "0";
  $("stat-time").textContent = "0s";
  document.body.classList.remove("working");
  document.body.classList.add("idle");
  renderTimeline(true);
  updateMediaCount();
}

/* ---------------- live stream ---------------- */
function connect() {
  const conn = $("conn");
  const es = new EventSource("/events");
  es.addEventListener("replay", (m) => {
    resetAll();
    const list = JSON.parse(m.data);
    for (const e of list) handle(e, true);
    if (S.running.size) {
      setWorking(true);
      showCurrent();
      const cur = S.running.get(S.current);
      if (cur) pointAt(resolveTarget(cur), `Claude · ${cur.title}`);
    } else if (S.lastEnd) setWorking(false);
  });
  es.onmessage = (m) => handle(JSON.parse(m.data));
  es.onopen = () => {
    conn.dataset.state = "live";
    $("conn-text").textContent = "Live";
  };
  es.onerror = () => {
    conn.dataset.state = "down";
    $("conn-text").textContent = "Reconnecting";
  };
}

updateMediaCount();
connect();
window.__studio = { handle, state: () => S };
