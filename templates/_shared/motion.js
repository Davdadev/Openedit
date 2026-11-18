/*
 * OpenEdit motion presets — a declarative, deterministic animation layer on top of
 * runtime.js (window.OE). Every frame is a pure function of time t (HyperFrames
 * seeks), so renders are frame-accurate and repeatable.
 *
 *   OE.motion.play({
 *     fields: [{ id, selector, text|attr|style, type, default }],   // bound once from params
 *     motion: [{ selector, preset, delay, duration, easing, stagger, split, exit, ...opts }],
 *     autoExit: true,     // mirror every entrance at the end (faster, ease-in, reverse order)
 *   });
 *
 * Presets (entrance by default; `exit: true` plays them out): fade, rise, drop,
 * slide-left, slide-right, scale-in, pop, spring-in, blur-in, rotate-in, flip-up,
 * mask-up, mask-down, mask-left, mask-right, wipe-left, wipe-right, wipe-up, wipe-down,
 * iris, grow-x, grow-y, grow, line-draw, tracking-in, type, count-up, highlight,
 * underline, morph. Emphasis/continuous: pulse, shake, float, drift, ken-burns, spin, breathe.
 * Keyframes: { selector, keyframes: [{ t, x, y, scale, rotate, opacity, blur }], easing }.
 * The list is mirrored in src/graphics/presets.ts (validation + docs).
 */
(function () {
  "use strict";
  var OE = window.OE;
  if (!OE) return;
  var clamp = OE.clamp, lerp = OE.lerp;

  // ------------------------------------------------------------------ easing

  function bezier(x1, y1, x2, y2) {
    function a(p1, p2) { return 1 - 3 * p2 + 3 * p1; }
    function b(p1, p2) { return 3 * p2 - 6 * p1; }
    function c(p1) { return 3 * p1; }
    function calc(t, p1, p2) { return ((a(p1, p2) * t + b(p1, p2)) * t + c(p1)) * t; }
    function slope(t, p1, p2) { return 3 * a(p1, p2) * t * t + 2 * b(p1, p2) * t + c(p1); }
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      var t = x;
      for (var i = 0; i < 8; i++) {
        var s = slope(t, x1, x2);
        if (Math.abs(s) < 1e-6) break;
        t -= (calc(t, x1, x2) - x) / s;
      }
      t = clamp(t, 0, 1);
      // Bisection polish for flat slopes.
      var lo = 0, hi = 1;
      for (var j = 0; j < 12 && Math.abs(calc(t, x1, x2) - x) > 1e-5; j++) {
        if (calc(t, x1, x2) < x) lo = t; else hi = t;
        t = (lo + hi) / 2;
      }
      return calc(t, y1, y2);
    };
  }

  function spring(zeta, omega) {
    // Damped harmonic oscillator step response, normalised to settle at 1 by x = 1.
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      var t = x * omega;
      if (zeta < 1) {
        var wd = Math.sqrt(1 - zeta * zeta);
        return 1 - Math.exp(-zeta * t) * (Math.cos(wd * t) + (zeta / wd) * Math.sin(wd * t));
      }
      return 1 - Math.exp(-t) * (1 + t);
    };
  }

  var P = function (k) { return function (x) { return Math.pow(x, k); }; };
  function outOf(f) { return function (x) { return 1 - f(1 - x); }; }
  function inOutOf(f) { return function (x) { return x < 0.5 ? f(2 * x) / 2 : 1 - f(2 - 2 * x) / 2; }; }
  var base = {
    Sine: function (x) { return 1 - Math.cos((x * Math.PI) / 2); },
    Quad: P(2), Cubic: P(3), Quart: P(4), Quint: P(5),
    Expo: function (x) { return x <= 0 ? 0 : Math.pow(2, 10 * x - 10); },
    Circ: function (x) { return 1 - Math.sqrt(1 - x * x); },
    Back: function (x) { var c = 1.70158; return (c + 1) * x * x * x - c * x * x; },
  };
  var EASE = { linear: function (x) { return x; } };
  Object.keys(base).forEach(function (k) {
    EASE["in" + k] = base[k];
    EASE["out" + k] = outOf(base[k]);
    EASE["inOut" + k] = inOutOf(base[k]);
  });
  EASE.outBackSoft = OE.E.outBackSoft;
  EASE.outElastic = OE.E.outElastic;
  EASE.spring = spring(0.5, 13);
  EASE.springSoft = spring(0.75, 11);
  EASE.springBouncy = spring(0.32, 16);
  // Named curves from design tools.
  EASE.standard = bezier(0.2, 0, 0, 1);
  EASE.emphasized = bezier(0.05, 0.7, 0.1, 1);
  EASE.smooth = bezier(0.65, 0, 0.35, 1);

  function ease(e, fallback) {
    if (typeof e === "function") return e;
    if (typeof e === "string") {
      var m = /^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/.exec(e);
      if (m) return bezier(+m[1], +m[2], +m[3], +m[4]);
      var k = e.replace(/[-_ ](\w)/g, function (_m, c) { return c.toUpperCase(); });
      if (EASE[k]) return EASE[k];
      if (EASE[e]) return EASE[e];
    }
    return fallback || EASE.outExpo;
  }

  // ------------------------------------------------------------------ splitting

  function wrapUnits(el, mode, mask) {
    var key = mode + (mask ? "m" : "");
    el.__oeSplit = el.__oeSplit || {};
    if (el.__oeSplit[key]) return el.__oeSplit[key];
    var units = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (node) {
      var parts = node.nodeValue.split(/(\s+)/);
      var frag = document.createDocumentFragment();
      parts.forEach(function (part) {
        if (!part) return;
        if (/^\s+$/.test(part)) {
          frag.appendChild(document.createTextNode(part));
          return;
        }
        var word = document.createElement("span");
        word.className = "oe-w" + (mask && mode !== "chars" ? " oe-mask" : "");
        if (mode === "chars") {
          Array.from(part).forEach(function (ch) {
            var c = document.createElement("span");
            c.className = "oe-c";
            c.textContent = ch;
            if (mask) {
              var m = document.createElement("span");
              m.className = "oe-mask";
              m.style.display = "inline-block";
              m.appendChild(c);
              word.appendChild(m);
            } else word.appendChild(c);
            units.push(c);
          });
        } else {
          var inner = document.createElement("span");
          inner.className = "oe-c";
          inner.textContent = part;
          word.appendChild(inner);
          units.push(inner);
        }
        frag.appendChild(word);
      });
      node.parentNode.replaceChild(frag, node);
    });
    el.__oeSplit[key] = units;
    return units;
  }

  /** Line index of each unit (by layout), recomputed when fonts change. */
  function lineIndex(units) {
    var key = document.fonts ? document.fonts.status : "loaded";
    if (units.__lines && units.__linesKey === key) return units.__lines;
    var tops = [], idx = [];
    units.forEach(function (u) {
      var top = Math.round(u.getBoundingClientRect().top / 4);
      var i = tops.indexOf(top);
      if (i < 0) { tops.push(top); i = tops.length - 1; }
      idx.push(i);
    });
    var order = tops.slice().sort(function (a, b) { return a - b; });
    units.__lines = idx.map(function (i) { return order.indexOf(tops[i]); });
    units.__linesKey = key;
    return units.__lines;
  }

  // ------------------------------------------------------------------ per-frame state

  var states = new Map();
  function st(el) {
    var s = states.get(el);
    if (!s) {
      var cs = getComputedStyle(el);
      s = { el: el, baseT: cs.transform && cs.transform !== "none" ? cs.transform : "", baseO: parseFloat(cs.opacity) || 1, baseLs: cs.letterSpacing };
      states.set(el, s);
    }
    if (s.frame !== frameNo) {
      s.frame = frameNo;
      s.x = 0; s.y = 0; s.xp = 0; s.yp = 0; s.s = 1; s.sx = 1; s.sy = 1; s.r = 0; s.rx = 0; s.ry = 0; s.skx = 0;
      s.o = 1; s.blur = 0; s.clip = null; s.circle = null; s.ls = null; s.origin = null; s.persp = false;
      s.touched = true;
    }
    return s;
  }
  var frameNo = 0;
  var remPx = function () { return OE.rem || 10; };

  function clipMax(s, t, r, b, l) {
    var c = s.clip || [0, 0, 0, 0];
    s.clip = [Math.max(c[0], t), Math.max(c[1], r), Math.max(c[2], b), Math.max(c[3], l)];
  }

  function write(s) {
    var el = s.el, tf = [];
    if (s.baseT) tf.push(s.baseT);
    if (s.persp) tf.push("perspective(" + (80 * remPx()).toFixed(0) + "px)");
    if (s.xp || s.yp) tf.push("translate(" + s.xp.toFixed(3) + "%," + s.yp.toFixed(3) + "%)");
    if (s.x || s.y) tf.push("translate(" + s.x.toFixed(2) + "px," + s.y.toFixed(2) + "px)");
    if (s.r) tf.push("rotate(" + s.r.toFixed(3) + "deg)");
    if (s.rx) tf.push("rotateX(" + s.rx.toFixed(3) + "deg)");
    if (s.ry) tf.push("rotateY(" + s.ry.toFixed(3) + "deg)");
    if (s.skx) tf.push("skewX(" + s.skx.toFixed(3) + "deg)");
    var sx = s.s * s.sx, sy = s.s * s.sy;
    if (sx !== 1 || sy !== 1) tf.push("scale(" + sx.toFixed(4) + "," + sy.toFixed(4) + ")");
    el.style.transform = tf.join(" ");
    if (s.origin) el.style.transformOrigin = s.origin;
    el.style.opacity = clamp(s.o * s.baseO, 0, 1).toFixed(4);
    el.style.filter = s.blur > 0.01 ? "blur(" + s.blur.toFixed(2) + "px)" : "";
    if (s.circle !== null) el.style.clipPath = "circle(" + s.circle.toFixed(2) + "% at 50% 50%)";
    else if (s.clip) el.style.clipPath = "inset(" + s.clip.map(function (v) { return clamp(v, 0, 100).toFixed(3) + "%"; }).join(" ") + ")";
    else el.style.clipPath = "";
    if (s.ls !== null) el.style.letterSpacing = s.ls.toFixed(4) + "em";
  }

  // ------------------------------------------------------------------ presets

  function dist(o, def) { return (o.distance != null ? +o.distance : def) * remPx(); }

  // Visual function of presence k (0 hidden .. 1 shown). `o` = entry options.
  var PRESETS = {
    fade: function (s, k) { s.o *= k; },
    rise: function (s, k, o) { s.y += (1 - k) * dist(o, 4); s.o *= Math.min(1, k * 1.6); },
    drop: function (s, k, o) { s.y -= (1 - k) * dist(o, 4); s.o *= Math.min(1, k * 1.6); },
    "slide-left": function (s, k, o) { s.x -= (1 - k) * dist(o, 8); s.o *= Math.min(1, k * 1.6); },
    "slide-right": function (s, k, o) { s.x += (1 - k) * dist(o, 8); s.o *= Math.min(1, k * 1.6); },
    "scale-in": function (s, k, o) { s.s *= lerp(o.from != null ? +o.from : 0.86, 1, k); s.o *= Math.min(1, k * 1.5); },
    pop: function (s, k, o) { s.s *= lerp(o.from != null ? +o.from : 0.5, 1, k); s.o *= clamp(k * 4, 0, 1); },
    "spring-in": function (s, k, o) { s.s *= lerp(o.from != null ? +o.from : 0, 1, k); s.o *= clamp(k * 6, 0, 1); },
    "blur-in": function (s, k, o) { s.blur += (1 - clamp(k, 0, 1)) * dist(o, 1.6); s.o *= clamp(k, 0, 1); s.s *= lerp(1.06, 1, clamp(k, 0, 1)); },
    "rotate-in": function (s, k, o) { s.r += (1 - k) * (o.angle != null ? +o.angle : -10); s.y += (1 - k) * dist(o, 3); s.o *= clamp(k * 1.6, 0, 1); },
    "flip-up": function (s, k, o) { s.persp = true; s.rx += (1 - k) * (o.angle != null ? +o.angle : 85); s.origin = s.origin || "50% 100%"; s.o *= clamp(k * 2, 0, 1); },
    "mask-up": function (s, k) { s.yp += (1 - k) * 100; clipMax(s, 0, 0, (1 - k) * 100, 0); },
    "mask-down": function (s, k) { s.yp -= (1 - k) * 100; clipMax(s, (1 - k) * 100, 0, 0, 0); },
    "mask-left": function (s, k) { s.xp += (1 - k) * 100; clipMax(s, 0, (1 - k) * 100, 0, 0); },
    "mask-right": function (s, k) { s.xp -= (1 - k) * 100; clipMax(s, 0, 0, 0, (1 - k) * 100); },
    "wipe-right": function (s, k) { clipMax(s, 0, (1 - k) * 100, 0, 0); },
    "wipe-left": function (s, k) { clipMax(s, 0, 0, 0, (1 - k) * 100); },
    "wipe-up": function (s, k) { clipMax(s, (1 - k) * 100, 0, 0, 0); },
    "wipe-down": function (s, k) { clipMax(s, 0, 0, (1 - k) * 100, 0); },
    iris: function (s, k) { s.circle = (s.circle === null ? 75 : s.circle) * k; },
    "grow-x": function (s, k, o) { s.sx *= Math.max(0, k); s.origin = o.origin || "0% 50%"; },
    "grow-y": function (s, k, o) { s.sy *= Math.max(0, k); s.origin = o.origin || "50% 100%"; },
    grow: function (s, k, o) { s.s *= Math.max(0, k); s.origin = o.origin || "50% 50%"; },
    "tracking-in": function (s, k, o) {
      var target = o.tracking != null ? +o.tracking : parseFloat(s.baseLs) / (parseFloat(getComputedStyle(s.el).fontSize) || 1) || 0;
      s.ls = lerp(o.from != null ? +o.from : 0.6, target, k);
      s.blur += (1 - k) * dist(o, 0.6);
      s.o *= clamp(k * 1.4, 0, 1);
    },
    type: function (s, k) { s.o *= k > 0.001 ? 1 : 0; },
  };
  var EMPHASIS = {
    pulse: function (s, p, o) { s.s *= 1 + (o.amount != null ? +o.amount : 0.06) * Math.sin(Math.PI * clamp(p * (o.count || 1), 0, o.count || 1) % Math.PI); },
    shake: function (s, p, o) { s.x += Math.sin(p * Math.PI * 2 * (o.count || 4)) * dist(o, 0.8) * (1 - p); },
    float: function (s, p, o, t) { s.y += Math.sin((2 * Math.PI * t) / (o.period || 3)) * dist(o, 0.6); },
    drift: function (s, p, o) {
      s.x += lerp(-0.5, 0.5, p) * (o.x != null ? +o.x : 3) * remPx();
      s.y += lerp(-0.5, 0.5, p) * (o.y != null ? +o.y : 0) * remPx();
    },
    "ken-burns": function (s, p, o) { s.s *= lerp(1, o.scale != null ? +o.scale : 1.08, p); },
    spin: function (s, p, o) { s.r += 360 * p * (o.turns != null ? +o.turns : 1); },
    breathe: function (s, p, o, t) { s.o *= lerp(o.min != null ? +o.min : 0.65, 1, 0.5 + 0.5 * Math.cos((2 * Math.PI * t) / (o.period || 2.4))); },
  };
  // Presets with side effects outside the transform state.
  var SPECIAL = {
    "line-draw": function (el, k) {
      var shapes = /^(path|line|polyline|polygon|circle|ellipse|rect)$/i.test(el.tagName) ? [el] : Array.prototype.slice.call(el.querySelectorAll("path,line,polyline,polygon,circle,ellipse,rect"));
      shapes.forEach(function (sh) {
        if (sh.__oeLen == null) {
          try { sh.__oeLen = sh.getTotalLength(); } catch (e) { sh.__oeLen = 0; }
        }
        var L = sh.__oeLen;
        if (!L) return;
        sh.style.strokeDasharray = L.toFixed(2) + " " + (L + 1).toFixed(2);
        sh.style.strokeDashoffset = ((1 - clamp(k, 0, 1)) * L).toFixed(2);
      });
    },
    "count-up": function (el, k, o) {
      if (el.__oeCount == null) {
        var txt = el.textContent || "";
        var m = /(-?[\d,.]*\d)/.exec(txt);
        var num = m ? m[1] : "0";
        el.__oeCount = {
          to: o.to != null ? +o.to : parseFloat(num.replace(/,/g, "")) || 0,
          from: o.from != null ? +o.from : 0,
          dec: o.decimals != null ? +o.decimals : num.indexOf(".") >= 0 ? num.split(".")[1].length : 0,
          pre: o.prefix != null ? String(o.prefix) : m ? txt.slice(0, m.index) : "",
          suf: o.suffix != null ? String(o.suffix) : m ? txt.slice(m.index + m[1].length) : "",
          sep: o.separator != null ? String(o.separator) : num.indexOf(",") >= 0 ? "," : "",
        };
      }
      var c = el.__oeCount;
      var v = lerp(c.from, c.to, clamp(k, 0, 1));
      var s = v.toFixed(c.dec);
      if (c.sep) {
        var parts = s.split(".");
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, c.sep);
        s = parts.join(".");
      }
      el.textContent = c.pre + s + c.suf;
    },
    highlight: function (el, k, o) {
      var color = o.color || "var(--accent)";
      el.style.backgroundImage = "linear-gradient(" + color + "," + color + ")";
      el.style.backgroundRepeat = "no-repeat";
      el.style.backgroundPosition = o.position || "0 85%";
      el.style.backgroundSize = (clamp(k, 0, 1) * 100).toFixed(2) + "% " + (o.height || "38%");
    },
    underline: function (el, k, o) {
      SPECIAL.highlight(el, k, { color: o.color, position: o.position || "0 100%", height: o.height || "0.09em" });
    },
    morph: function (el, k, o) {
      if (!o.to || !el.getAttribute) return;
      if (el.__oeFrom == null) el.__oeFrom = el.getAttribute("d") || "";
      var nums = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;
      var a = el.__oeFrom.match(nums) || [], b = String(o.to).match(nums) || [];
      if (a.length !== b.length) {
        el.setAttribute("d", k < 0.5 ? el.__oeFrom : o.to);
        return;
      }
      var i = 0;
      el.setAttribute("d", String(o.to).replace(nums, function () {
        var v = lerp(+a[i], +b[i], clamp(k, 0, 1.2));
        i++;
        return v.toFixed(3);
      }));
    },
  };

  var DEFAULTS = {
    fade: [0.5, "outCubic"], rise: [0.6, "outExpo"], drop: [0.6, "outExpo"], "slide-left": [0.7, "outExpo"], "slide-right": [0.7, "outExpo"],
    "scale-in": [0.6, "outExpo"], pop: [0.55, "outBack"], "spring-in": [0.9, "spring"], "blur-in": [0.7, "outQuart"], "rotate-in": [0.7, "outExpo"],
    "flip-up": [0.7, "outExpo"], "mask-up": [0.7, "outExpo"], "mask-down": [0.7, "outExpo"], "mask-left": [0.7, "outExpo"], "mask-right": [0.7, "outExpo"],
    "wipe-right": [0.7, "inOutQuart"], "wipe-left": [0.7, "inOutQuart"], "wipe-up": [0.6, "inOutQuart"], "wipe-down": [0.6, "inOutQuart"], iris: [0.7, "inOutQuart"],
    "grow-x": [0.6, "outExpo"], "grow-y": [0.6, "outExpo"], grow: [0.6, "outBack"], "line-draw": [0.9, "inOutQuart"], "tracking-in": [0.9, "outQuart"],
    type: [1.0, "linear"], "count-up": [1.4, "outQuart"], highlight: [0.5, "inOutQuart"], underline: [0.5, "outExpo"], morph: [0.8, "inOutQuart"],
    pulse: [0.5, "linear"], shake: [0.5, "linear"], float: [0, "linear"], drift: [0, "inOutSine"], "ken-burns": [0, "linear"], spin: [1, "inOutCubic"], breathe: [0, "linear"],
  };
  var SPLIT_DEFAULT = { type: "chars" };

  // ------------------------------------------------------------------ fields

  function bindFields(fields, params) {
    (fields || []).forEach(function (f) {
      var v = params[f.id] != null && params[f.id] !== "" ? params[f.id] : f["default"];
      if (v == null) return;
      if (!f.selector || f.selector === ":root") {
        if (f.style) document.documentElement.style.setProperty(f.style, String(v));
        return;
      }
      OE.$$(f.selector).forEach(function (el) {
        if (f.style) {
          if (/^--/.test(f.style)) el.style.setProperty(f.style, String(v));
          else el.style.setProperty(f.style, String(v));
        } else if (f.attr) {
          el.setAttribute(f.attr, String(v));
        } else if (f.type === "image") {
          el.setAttribute(el.tagName.toLowerCase() === "image" ? "href" : "src", String(v));
        } else if (f.type === "color") {
          if (el instanceof SVGElement) el.setAttribute("fill", String(v));
          else el.style.setProperty("color", String(v));
        } else if (f.type === "checkbox") {
          el.style.display = v === true || v === "true" ? "" : "none";
        } else {
          // Text sits in the deepest single child (Figma wraps text layers in <p>/<span>).
          var target = el;
          while (target.children && target.children.length === 1) target = target.children[0];
          target.textContent = String(v);
        }
      });
    });
  }

  // ------------------------------------------------------------------ timeline

  function staggerOrder(n, mode, seed) {
    var idx = [];
    for (var i = 0; i < n; i++) idx.push(i);
    if (mode === "end") return idx.map(function (i) { return n - 1 - i; });
    if (mode === "center") return idx.map(function (i) { return Math.abs(i - (n - 1) / 2); });
    if (mode === "random") {
      var r = OE.rng(seed || 7), order = idx.slice().sort(function () { return r() - 0.5; });
      var pos = [];
      order.forEach(function (v, k) { pos[v] = k; });
      return pos;
    }
    return idx;
  }

  function compile(entry, D, exitIdx) {
    var name = entry.preset || (entry.keyframes ? "keyframes" : "fade");
    var def = DEFAULTS[name] || [0.6, "outExpo"];
    var targets = OE.$$(entry.selector);
    var split = entry.split || (name === "type" ? SPLIT_DEFAULT.type : null);
    var units = [];
    targets.forEach(function (el) {
      if (split === "chars" || split === "words" || split === "lines") {
        var u = wrapUnits(el, split === "lines" ? "words" : split, entry.mask === true || /^mask-/.test(name));
        u.__line = split === "lines";
        units.push(u);
      } else units.push([el]);
    });
    var flat = [];
    units.forEach(function (u) { u.forEach(function (x) { flat.push({ el: x, group: u }); }); });
    var st0 = entry.stagger;
    var each = typeof st0 === "number" ? st0 : st0 && st0.each != null ? +st0.each : split ? (split === "chars" ? 0.025 : 0.06) : flat.length > 1 ? 0.06 : 0;
    var from = st0 && st0.from ? st0.from : "start";
    var order = staggerOrder(flat.length, from, st0 && st0.seed);
    var exit = !!entry.exit;
    var dur = entry.duration != null ? +entry.duration : def[0];
    if (name === "type" && entry.duration == null) dur = Math.max(0.2, flat.length * (each || 0.04));
    var easeFn = ease(entry.easing, exit ? ease(entry.easing || "inQuart") : ease(def[1]));
    if (exit && !entry.easing) easeFn = name === "type" ? EASE.linear : EASE.inQuart;
    var delay = entry.delay != null ? +entry.delay : 0;
    if (entry.at === "end" || (exit && entry.delay == null)) delay = Math.max(0, D - dur - each * Math.max(0, flat.length - 1) - 0.04);
    return {
      name: name, entry: entry, flat: flat, order: order, each: each, dur: dur, ease: easeFn, delay: delay, exit: exit, split: split,
      emphasis: !!EMPHASIS[name], special: SPECIAL[name], kf: entry.keyframes, exitIdx: exitIdx,
    };
  }

  function kfValue(keys, prop, t, easeFn) {
    var ks = keys.filter(function (k) { return k[prop] != null; });
    if (!ks.length) return null;
    if (t <= ks[0].t) return +ks[0][prop];
    for (var i = 0; i < ks.length - 1; i++) {
      var a = ks[i], b = ks[i + 1];
      if (t <= b.t) {
        var e = ease(b.easing || b.ease, easeFn);
        return lerp(+a[prop], +b[prop], e(OE.p(t, a.t, b.t - a.t)));
      }
    }
    return +ks[ks.length - 1][prop];
  }

  function apply(c, t, D) {
    c.flat.forEach(function (u, i) {
      var pos = c.order[i];
      if (c.split === "lines" && u.group.__line) pos = lineIndex(u.group)[u.group.indexOf(u.el)];
      var start = c.delay + pos * c.each;
      if (c.kf) {
        var s0 = st(u.el), tt = t - start;
        var x = kfValue(c.kf, "x", tt, c.ease), y = kfValue(c.kf, "y", tt, c.ease), sc = kfValue(c.kf, "scale", tt, c.ease);
        var r = kfValue(c.kf, "rotate", tt, c.ease), op = kfValue(c.kf, "opacity", tt, c.ease), bl = kfValue(c.kf, "blur", tt, c.ease);
        if (x != null) s0.x += x;
        if (y != null) s0.y += y;
        if (sc != null) s0.s *= sc;
        if (r != null) s0.r += r;
        if (op != null) s0.o *= op;
        if (bl != null) s0.blur += bl;
        return;
      }
      if (c.emphasis) {
        var dur = c.dur > 0 ? c.dur : Math.max(0.01, D - start);
        if (t < start || (c.dur > 0 && t > start + dur)) return;
        EMPHASIS[c.name](st(u.el), c.ease(OE.p(t, start, dur)), c.entry, t);
        return;
      }
      var k = c.ease(OE.p(t, start, c.dur));
      if (c.exit) k = 1 - k;
      if (c.special) {
        c.special(u.el, k, c.entry);
        return;
      }
      var fn = PRESETS[c.name];
      if (fn) fn(st(u.el), k, c.entry);
    });
  }

  function play(spec) {
    spec = spec || {};
    var D = OE.duration;
    bindFields(spec.fields, OE.params);
    var entries = (spec.motion || []).slice();
    if (spec.autoExit !== false) {
      // Mirror entrances: faster (60%), ease-in, reverse order, finishing at the end.
      var exits = [];
      entries.forEach(function (e) {
        if (e.exit || e.keyframes || EMPHASIS[e.preset] || e.noExit) return;
        var p = e.preset || "fade";
        var outPreset = p === "type" || p === "count-up" || p === "line-draw" || p === "morph" || p === "highlight" || p === "underline" ? "fade" : p;
        var each = typeof e.stagger === "number" ? e.stagger * 0.5 : e.stagger && e.stagger.each != null ? e.stagger.each * 0.5 : undefined;
        exits.push({
          selector: e.selector, preset: outPreset, exit: true, split: outPreset === "fade" ? null : e.split, mask: e.mask, distance: e.distance, angle: e.angle, origin: e.origin,
          duration: spec.exitDuration != null ? spec.exitDuration : Math.max(0.25, Math.min(0.5, (e.duration != null ? +e.duration : (DEFAULTS[p] || [0.6])[0]) * 0.6)),
          stagger: each != null ? { each: each, from: "end" } : undefined,
        });
      });
      entries = entries.concat(exits);
    }
    var compiled = entries.map(function (e, i) { return compile(e, D, i); });
    OE.run(function (t) {
      frameNo++;
      // Reset every element ever animated, so a seek never leaves stale styles behind.
      states.forEach(function (s) { st(s.el); });
      if (spec.fit) spec.fit.forEach(function (f) { OE.$$(f.selector).forEach(function (el) { OE.fit(el, f); }); });
      compiled.forEach(function (c) { apply(c, t, D); });
      states.forEach(write);
      if (typeof spec.onFrame === "function") spec.onFrame(t);
    });
  }

  OE.motion = { play: play, ease: ease, EASE: EASE, presets: Object.keys(PRESETS).concat(Object.keys(SPECIAL), Object.keys(EMPHASIS)), bindFields: bindFields, split: wrapUnits };
})();
