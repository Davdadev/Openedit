// OpenEdit - Premiere Pro bridge: motion graphics (MOGRT placement).
//
//   applyMogrt { path, at, duration?, track?, params?: [{ name, type, value }] }
//
// Places a Motion Graphics template with sequence.importMGT(path, ticks,
// videoTrackIndex, audioTrackIndex) and sets Essential Graphics controls
// through trackItem.getMGTComponent().properties.getParamForDisplayName(name):
//   text      After Effects text params hold a JSON string ({"textEditValue":...})
//             in current Premiere versions; older ones take the plain string.
//   color     setColorValue(alpha, red, green, blue, updateUI), 0..255 each.
//   point     setValue([x, y], true), fractions of the frame (0..1).
//   slider / angle / number   setValue(n, true)
//   checkbox  setValue(bool, true)
//   dropdown  setValue(index, true)
// ES3 + ASCII only (see openedit.jsx).

(function (OE) {
  function clipNear(track, atSec, tol) {
    var clips = OE.trackClips(track);
    var best = null;
    var bestD = tol;
    for (var i = 0; i < clips.length; i++) {
      var s = OE.secs(clips[i].start);
      if (s === null) {
        continue;
      }
      var d = Math.abs(s - atSec);
      if (d <= bestD) {
        best = clips[i];
        bestD = d;
      }
    }
    return best;
  }

  function setText(param, value) {
    var cur = null;
    try {
      cur = param.getValue();
    } catch (e) {
      cur = null;
    }
    if (typeof cur === "string" && cur.charAt(0) === "{") {
      var obj = null;
      try {
        obj = OE.parseJSON(cur);
      } catch (e2) {
        obj = null;
      }
      if (obj && typeof obj === "object" && typeof obj.textEditValue !== "undefined") {
        obj.textEditValue = String(value);
        param.setValue(OE.stringify(obj), true);
        return;
      }
    }
    param.setValue(String(value), true);
  }

  function setColor(param, v) {
    if (!OE.isArray(v) || v.length < 3) {
      OE.fail("color must be [r, g, b, a] (0..255)");
    }
    var r = Math.round(OE.num(v[0], 0));
    var g = Math.round(OE.num(v[1], 0));
    var b = Math.round(OE.num(v[2], 0));
    var a = v.length > 3 ? Math.round(OE.num(v[3], 255)) : 255;
    if (typeof param.setColorValue === "function") {
      param.setColorValue(a, r, g, b, true);
      return;
    }
    param.setValue([a / 255, r / 255, g / 255, b / 255], true);
  }

  function setParam(param, p) {
    var t = String(p.type || "");
    var v = p.value;
    if (t === "text") {
      setText(param, v);
    } else if (t === "color") {
      setColor(param, v);
    } else if (t === "point") {
      if (!OE.isArray(v) || v.length < 2) {
        OE.fail("point must be [x, y]");
      }
      param.setValue([OE.num(v[0], 0.5), OE.num(v[1], 0.5)], true);
    } else if (t === "checkbox") {
      param.setValue(v === true || v === 1 || v === "true", true);
    } else if (t === "slider" || t === "angle" || t === "number" || t === "dropdown") {
      param.setValue(OE.num(v, 0), true);
    } else {
      param.setValue(v, true);
    }
  }

  OE.commands.applyMogrt = function (args) {
    var seq = OE.activeSeq();
    var path = args.path;
    if (typeof path !== "string" || !path) {
      OE.fail("path missing");
    }
    var f = new File(path);
    if (!f.exists) {
      OE.fail("file not found: " + path);
    }
    if (typeof seq.importMGT !== "function") {
      OE.fail("unsupported: this Premiere version has no sequence.importMGT (needs 2018 or newer)");
    }
    var at = OE.num(args.at, 0);
    if (at < 0) {
      OE.fail("at must be >= 0");
    }
    at = OE.snap(seq, at);
    var trackNo = Math.max(1, Math.floor(OE.num(args.track, 2)));
    OE.ensureVideoTracks(seq, trackNo);
    var item = seq.importMGT(f.fsName, OE.ticksString(at), trackNo - 1, 0);
    if (!item) {
      item = clipNear(seq.videoTracks[trackNo - 1], at, OE.frameSec(seq) + 0.001);
    }
    if (!item) {
      OE.fail("importMGT placed nothing for " + path);
    }
    var result = { placed: true, track: trackNo, at: at, set: 0, missing: [], errors: [] };
    try {
      result.name = String(item.name);
    } catch (eName) {
      // ignore
    }

    var dur = OE.num(args.duration, 0);
    if (dur > 0) {
      try {
        item.end = OE.makeTime(OE.snap(seq, at + dur));
      } catch (eEnd) {
        result.errors[result.errors.length] = "duration: " + OE.errText(eEnd);
      }
    }
    var endS = OE.secs(item.end);
    if (endS !== null) {
      result.duration = OE.round(endS - at, 3);
    }

    var list = OE.isArray(args.params) ? args.params : [];
    if (list.length) {
      var comp = null;
      try {
        comp = typeof item.getMGTComponent === "function" ? item.getMGTComponent() : null;
      } catch (eComp) {
        comp = null;
      }
      if (!comp || !comp.properties) {
        OE.fail("placed, but the clip has no Graphics Parameters (not a MOGRT?)");
      }
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (!p || typeof p.name !== "string") {
          continue;
        }
        var param = null;
        try {
          param = comp.properties.getParamForDisplayName(p.name);
        } catch (eFind) {
          param = null;
        }
        if (!param) {
          result.missing[result.missing.length] = p.name;
          continue;
        }
        try {
          setParam(param, p);
          result.set++;
        } catch (eSet) {
          result.errors[result.errors.length] = p.name + ": " + OE.errText(eSet);
        }
      }
    }
    return result;
  };
})($.OpenEdit);
