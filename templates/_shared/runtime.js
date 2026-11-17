/*
 * OpenEdit motion runtime — tiny, dependency-free helpers for HyperFrames
 * compositions driven by the seek protocol (`hf-seek`). Every frame is a pure
 * function of time `t`, so renders are deterministic and frame-accurate.
 */
(function () {
  "use strict";
  var DATA = JSON.parse(document.getElementById("oe-data").textContent || "{}");

  function clamp(v, a, b) {
    return Math.min(b, Math.max(a, v));
  }
  function lerp(a, b, k) {
    return a + (b - a) * k;
  }

  var E = {
    linear: function (x) {
      return x;
    },
    inCubic: function (x) {
      return x * x * x;
    },
    inQuart: function (x) {
      return x * x * x * x;
    },
    inExpo: function (x) {
      return x <= 0 ? 0 : Math.pow(2, 10 * x - 10);
    },
    outCubic: function (x) {
      return 1 - Math.pow(1 - x, 3);
    },
    outQuart: function (x) {
      return 1 - Math.pow(1 - x, 4);
    },
    outQuint: function (x) {
      return 1 - Math.pow(1 - x, 5);
    },
    outExpo: function (x) {
      return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
    },
    inOutCubic: function (x) {
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    },
    inOutQuart: function (x) {
      return x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2;
    },
    inOutExpo: function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      return x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2;
    },
    outBack: function (x) {
      var c1 = 1.70158,
        c3 = c1 + 1;
      return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    },
    outBackSoft: function (x) {
      var c1 = 1.1,
        c3 = c1 + 1;
      return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    },
    outElastic: function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
    },
  };

  /** Linear progress of t through [start, start+dur], clamped to 0..1. */
  function p(t, start, dur) {
    if (dur <= 0) return t >= start ? 1 : 0;
    return clamp((t - start) / dur, 0, 1);
  }
  /** Eased progress. */
  function tw(t, start, dur, ease) {
    return (ease || E.outCubic)(p(t, start, dur));
  }
  /** Enter/exit envelope: rises over [inStart, inStart+inDur], falls over [outStart, outStart+outDur]. */
  function life(t, inStart, inDur, outStart, outDur, easeIn, easeOut) {
    var a = tw(t, inStart, inDur, easeIn || E.outCubic);
    var b = tw(t, outStart, outDur, easeOut || E.inCubic);
    return a * (1 - b);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function norm(w) {
    return String(w)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  }

  /**
   * Split text into masked words of animatable characters.
   * Returns { words: [{el, chars: [el], text, hl}], chars: [el] }.
   * opts.highlight: comma-separated words that get class "hl".
   * opts.mask: wrap each word in an overflow mask (default true).
   * opts.chars: split into characters (default true) — otherwise words only.
   */
  function split(el, text, opts) {
    opts = opts || {};
    var hl = String(opts.highlight || "")
      .split(",")
      .map(norm)
      .filter(Boolean);
    var parts = String(text == null ? "" : text)
      .split(/\s+/)
      .filter(Boolean);
    var html = parts
      .map(function (w) {
        var isHl = hl.indexOf(norm(w)) >= 0;
        var cls = "oe-w" + (opts.mask === false ? "" : " oe-mask") + (isHl ? " hl" : "");
        var inner =
          opts.chars === false
            ? '<span class="oe-c">' + esc(w) + "</span>"
            : Array.from(w)
                .map(function (c) {
                  return '<span class="oe-c">' + esc(c) + "</span>";
                })
                .join("");
        return '<span class="' + cls + '">' + inner + "</span>";
      })
      .join(" ");
    el.innerHTML = html;
    var words = Array.prototype.map.call(el.querySelectorAll(".oe-w"), function (w, i) {
      return {
        el: w,
        text: parts[i],
        hl: w.classList.contains("hl"),
        chars: Array.prototype.slice.call(w.querySelectorAll(".oe-c")),
      };
    });
    var chars = [];
    words.forEach(function (w) {
      chars.push.apply(chars, w.chars);
    });
    return { words: words, chars: chars };
  }

  /**
   * Shrink an element's font-size until it fits maxLines (by layout height) and no
   * word overflows its box. Re-runs automatically once web fonts finish loading.
   */
  var fitted = [];
  function fit(el, opts) {
    opts = opts || {};
    var key = document.fonts ? document.fonts.status : "loaded";
    if (el.__oeFit === key && !opts.force) return;
    el.__oeFit = key;
    if (fitted.indexOf(el) < 0) fitted.push(el);
    if (!el.__oeBase) el.__oeBase = parseFloat(getComputedStyle(el).fontSize);
    var base = el.__oeBase,
      size = base,
      maxLines = opts.maxLines || 2,
      lhRatio = opts.lineHeight || parseFloat(getComputedStyle(el).lineHeight) / base || 1.1,
      maxW = opts.maxWidth || el.clientWidth || Infinity,
      minSize = base * (opts.minScale || 0.3);
    el.style.fontSize = size + "px";
    for (var i = 0; i < 40; i++) {
      var tooTall = el.offsetHeight > maxLines * size * lhRatio * 1.02 + 2;
      var tooWide = el.scrollWidth > maxW + 1;
      if (!tooWide) {
        var ws = el.querySelectorAll(".oe-w");
        for (var j = 0; j < ws.length; j++) {
          if (ws[j].offsetWidth > maxW + 1) {
            tooWide = true;
            break;
          }
        }
      }
      if ((!tooTall && !tooWide) || size <= minSize) break;
      size = Math.max(minSize, size * 0.94);
      el.style.fontSize = size + "px";
    }
  }
  if (document.fonts && document.fonts.addEventListener) {
    document.fonts.addEventListener("loadingdone", function () {
      fitted.forEach(function (el) {
        el.__oeFit = null;
      });
    });
  }

  /** Relative luminance of a CSS hex colour (fallback 0.5). */
  function luminance(c) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c || "").trim());
    if (!m) return 0.5;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var rgb = [0, 2, 4].map(function (i) {
      var v = parseInt(h.substr(i, 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  }

  /** Deterministic PRNG (mulberry32). */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Drive `render(t)` from HyperFrames seeks. Add `#play` to the URL to preview in a normal browser. */
  function run(render) {
    var dur = DATA.duration || 3;
    function go(t) {
      render(clamp(t, 0, dur));
    }
    window.addEventListener("hf-seek", function (e) {
      go(e.detail && typeof e.detail.time === "number" ? e.detail.time : 0);
    });
    go(0);
    if (/#play/.test(location.hash)) {
      var t0 = performance.now();
      var loop = function (now) {
        go(((now - t0) / 1000) % dur);
        window.requestAnimationFrame(loop);
      };
      window.requestAnimationFrame(loop);
    }
  }

  window.OE = {
    data: DATA,
    params: DATA.params || {},
    duration: DATA.duration || 3,
    width: DATA.width || 1920,
    height: DATA.height || 1080,
    rem: DATA.rem || 10,
    portrait: (DATA.height || 1080) > (DATA.width || 1920),
    E: E,
    p: p,
    tw: tw,
    life: life,
    lerp: lerp,
    clamp: clamp,
    esc: esc,
    split: split,
    fit: fit,
    luminance: luminance,
    rng: rng,
    run: run,
    $: function (s) {
      return document.querySelector(s);
    },
    $$: function (s) {
      return Array.prototype.slice.call(document.querySelectorAll(s));
    },
  };
})();
