// OpenEdit - editing commands on the ACTIVE sequence: addMarkers, importMedia,
// placeClips, addCaptions, addZooms.
// ES3, 7-bit ASCII only. Loaded by openedit.jsx.

(function (OE) {
  // ------------------------------------------------------------ markers

  function setMarkerColor(marker, color) {
    var idx = OE.MARKER_COLORS[String(color).toLowerCase()];
    if (typeof idx !== "number") {
      return false;
    }
    try {
      marker.setColorByIndex(idx, 0);
      return true;
    } catch (e) {
      try {
        marker.setColorByIndex(idx);
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  function setMarkerEnd(marker, endSec) {
    try {
      marker.end = endSec;
      if (OE.secs(marker.end) > OE.secs(marker.start)) {
        return true;
      }
    } catch (e) {
      // try the Time form
    }
    try {
      marker.end = OE.makeTime(endSec);
      return OE.secs(marker.end) > OE.secs(marker.start);
    } catch (e2) {
      return false;
    }
  }

  OE.addMarker = function (seq, m) {
    var t = OE.num(m.time, NaN);
    if (isNaN(t) || t < 0) {
      return false;
    }
    var marker = seq.markers.createMarker(t);
    if (!marker) {
      return false;
    }
    try {
      marker.name = String(m.name || "");
    } catch (e) {
      // keep default name
    }
    try {
      if (m.comment) {
        marker.comments = String(m.comment);
      }
    } catch (e2) {
      // no comment
    }
    var dur = OE.num(m.duration, 0);
    if (dur > 0) {
      setMarkerEnd(marker, t + dur);
    }
    if (m.color) {
      setMarkerColor(marker, m.color);
    }
    return true;
  };

  OE.commands.addMarkers = function (args) {
    var seq = OE.activeSeq();
    var list = args.markers;
    if (!OE.isArray(list)) {
      OE.fail("markers must be an array");
    }
    var added = 0;
    for (var i = 0; i < list.length; i++) {
      try {
        if (list[i] && OE.addMarker(seq, list[i])) {
          added++;
        }
      } catch (e) {
        // skip this marker, keep going
      }
    }
    return added;
  };

  // ------------------------------------------------------------- import

  OE.commands.importMedia = function (args) {
    var paths = args.paths;
    if (!OE.isArray(paths)) {
      OE.fail("paths must be an array");
    }
    var bin = OE.bin();
    var toImport = [];
    var missing = [];
    var present = 0;
    var i;
    for (i = 0; i < paths.length; i++) {
      var p = paths[i];
      if (typeof p !== "string" || !p) {
        continue;
      }
      if (OE.findItemByPath(p)) {
        present++;
        continue;
      }
      var f = new File(p);
      if (!f.exists) {
        missing[missing.length] = p;
        continue;
      }
      toImport[toImport.length] = f.fsName;
    }
    if (toImport.length) {
      var ok = OE.project().importFiles(toImport, true, bin, false);
      if (ok === false) {
        OE.fail("importFiles failed");
      }
    }
    var imported = 0;
    for (i = 0; i < toImport.length; i++) {
      if (OE.findItemByPath(toImport[i])) {
        imported++;
      }
    }
    if (!imported && !present && missing.length) {
      OE.fail("file(s) not found: " + missing.join(", "));
    }
    // Number of requested files now available in the project.
    return imported + present;
  };

  // --------------------------------------------------------------- place

  // Find the clip on `track` that starts at `atSec` (within tolerance).
  function clipAt(track, atSec, tol) {
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

  // Volume "Level" param of an audio track item. The component is matched by
  // matchName ("Internal Volume ..."), falling back to display name; the
  // level is the first numeric param that is not the bypass toggle.
  function volumeLevelParam(clip) {
    var comps = clip.components;
    var n = OE.count(comps);
    for (var i = 0; i < n; i++) {
      var comp = null;
      try {
        comp = comps[i];
      } catch (e) {
        comp = null;
      }
      if (!comp) {
        continue;
      }
      var mn = "";
      var dn = "";
      try {
        mn = String(comp.matchName || "");
        dn = String(comp.displayName || "");
      } catch (e2) {
        // ignore
      }
      if (mn.indexOf("Internal Volume") !== 0 && mn !== "PR.Volume" && dn !== "Volume") {
        continue;
      }
      var pn = OE.count(comp.properties);
      for (var j = 0; j < pn; j++) {
        try {
          var prop = comp.properties[j];
          var pdn = String(prop.displayName || "");
          if (pdn === "Bypass") {
            continue;
          }
          if (typeof prop.getValue() === "number") {
            return prop;
          }
        } catch (e3) {
          // keep looking
        }
      }
    }
    return null;
  }

  // Change a placed audio clip's level by `db` decibels (relative to its
  // current level). Returns true when the write reads back.
  OE.applyGainDb = function (clip, db) {
    var prop = volumeLevelParam(clip);
    if (!prop) {
      return false;
    }
    try {
      if (typeof prop.isTimeVarying === "function" && prop.isTimeVarying()) {
        return false; // never flatten existing automation
      }
      var cur = prop.getValue();
      var want = cur * Math.pow(10, db / 20);
      prop.setValue(want, true);
      var back = prop.getValue();
      return Math.abs(back - want) < 0.0001 || (db > 0 ? back > cur : back < cur);
    } catch (e) {
      return false;
    }
  };

  // Subclip of `item` over [inSec, outSec] carrying only video or only audio.
  // createSubClip's time arguments are tried as seconds and as Time objects.
  function makeSubClip(item, inSec, outSec, takeVideo, takeAudio) {
    if (typeof item.createSubClip !== "function") {
      OE.fail("createSubClip is unavailable on this Premiere version");
    }
    var name = String(item.name) + " [OE " + OE.round(inSec, 2) + "-" + OE.round(outSec, 2) + "]";
    var forms = [0, 1];
    for (var f = 0; f < forms.length; f++) {
      try {
        var a = forms[f] === 0 ? inSec : OE.makeTime(inSec);
        var b = forms[f] === 0 ? outSec : OE.makeTime(outSec);
        var sub = item.createSubClip(name, a, b, 1, takeVideo ? 1 : 0, takeAudio ? 1 : 0);
        if (sub) {
          return sub;
        }
      } catch (e) {
        // next form
      }
    }
    OE.fail("createSubClip failed for " + String(item.name));
  }

  function placeOne(seq, c, frame) {
    if (!c || typeof c.path !== "string" || !c.path) {
      OE.fail("clip.path missing");
    }
    var at = OE.num(c.at, NaN);
    if (isNaN(at) || at < 0) {
      OE.fail("clip.at must be >= 0");
    }
    at = OE.snap(seq, at);
    var trackNo = Math.max(1, Math.floor(OE.num(c.track, 1)));
    var item = OE.importOne(c.path);
    var isAudio = OE.isAudioPath(c.path);
    var hasRange = typeof c.sourceIn === "number" || typeof c.sourceOut === "number";
    var track;
    if (isAudio) {
      OE.ensureAudioTracks(seq, trackNo);
      track = seq.audioTracks[trackNo - 1];
    } else {
      OE.ensureVideoTracks(seq, trackNo);
      track = seq.videoTracks[trackNo - 1];
    }
    var source = item;
    var snap = null;
    if (isAudio && !hasRange) {
      // Whole file: ignore any marks the user left on the item.
      snap = OE.snapshotMarks(item);
      OE.clearInOut(item);
    } else {
      var dur = OE.itemDuration(item);
      var inS = OE.num(c.sourceIn, 0);
      var outS = OE.num(c.sourceOut, dur !== null ? dur : 0);
      if (dur !== null && outS > dur) {
        outS = dur;
      }
      if (!(outS > inS)) {
        OE.fail("invalid source range for " + c.path);
      }
      if (isAudio) {
        // Audio file: mark in/out on the master (it has no video to route).
        snap = OE.snapshotMarks(item);
        if (!OE.setInOut(item, inS, outS, frame * 0.5 + 0.0005)) {
          OE.restoreInOut(item, snap);
          snap = null;
          source = makeSubClip(item, inS, outS, false, true);
        }
      } else {
        // Video file: always a video-only subclip, so overwriteClip on a
        // video track cannot also overwrite dialogue on the audio tracks.
        source = makeSubClip(item, inS, outS, true, false);
      }
    }
    try {
      track.overwriteClip(source, at);
    } finally {
      if (snap) {
        OE.restoreInOut(item, snap);
      }
    }
    var placed = clipAt(track, at, frame + 0.001);
    if (!placed) {
      OE.fail("overwriteClip placed nothing for " + c.path);
    }
    if (isAudio && typeof c.gainDb === "number" && c.gainDb !== 0) {
      OE.applyGainDb(placed, c.gainDb);
    }
    return true;
  }

  OE.commands.placeClips = function (args) {
    var seq = OE.activeSeq();
    var list = args.clips;
    if (!OE.isArray(list)) {
      OE.fail("clips must be an array");
    }
    var frame = OE.frameSec(seq);
    var placed = 0;
    var errors = [];
    for (var i = 0; i < list.length; i++) {
      try {
        if (placeOne(seq, list[i], frame)) {
          placed++;
        }
      } catch (e) {
        errors[errors.length] = "clip " + i + ": " + OE.errText(e);
      }
    }
    if (!placed && errors.length) {
      OE.fail(errors.join("; "));
    }
    return placed;
  };

  // ------------------------------------------------------------ captions

  function captionFormat() {
    try {
      if (typeof Sequence !== "undefined" && typeof Sequence.CAPTION_FORMAT_SUBTITLE !== "undefined") {
        return Sequence.CAPTION_FORMAT_SUBTITLE;
      }
    } catch (e) {
      // fall through
    }
    return null;
  }

  function cuesAsMarkers(seq, cues) {
    var added = 0;
    for (var i = 0; i < cues.length; i++) {
      var c = cues[i];
      if (!c) {
        continue;
      }
      var s = OE.num(c.start, NaN);
      var e = OE.num(c.end, NaN);
      if (isNaN(s)) {
        continue;
      }
      try {
        if (OE.addMarker(seq, {
          time: s,
          duration: (!isNaN(e) && e > s) ? e - s : 0,
          name: String(c.text || ""),
          comment: String(c.text || ""),
          color: "yellow"
        })) {
          added++;
        }
      } catch (err) {
        // skip
      }
    }
    return added;
  }

  OE.commands.addCaptions = function (args) {
    var seq = OE.activeSeq();
    var cues = OE.isArray(args.cues) ? args.cues : [];
    var srt = (typeof args.srtPath === "string") ? args.srtPath : "";
    var why = "";
    if (srt && new File(srt).exists && typeof seq.createCaptionTrack === "function") {
      try {
        var item = OE.importOne(srt, OE.bin());
        var fmt = captionFormat();
        var ok = (fmt === null) ? seq.createCaptionTrack(item, 0) : seq.createCaptionTrack(item, 0, fmt);
        if (ok !== false) {
          return { added: cues.length, file: srt, mode: "captions" };
        }
        why = "createCaptionTrack returned false";
      } catch (e) {
        why = OE.errText(e);
      }
    } else if (!srt || !new File(srt).exists) {
      why = "srt file not found";
    } else {
      why = "createCaptionTrack unavailable";
    }
    if (!cues.length) {
      OE.fail("captions could not be added (" + why + ") and no cues were given for the marker fallback");
    }
    var n = cuesAsMarkers(seq, cues);
    var res = { added: n, mode: "markers", note: why };
    if (srt) {
      res.file = srt;
    }
    return res;
  };

  // --------------------------------------------------------------- zooms

  // Motion > Scale param of a video track item. Component by matchName
  // (locale-stable), param by index 1 (Position=0, Scale=1), checked by
  // display name when the UI is English.
  function motionScaleParam(clip) {
    var comps = clip.components;
    var n = OE.count(comps);
    for (var i = 0; i < n; i++) {
      var comp = null;
      try {
        comp = comps[i];
      } catch (e) {
        comp = null;
      }
      if (!comp) {
        continue;
      }
      var mn = "";
      var dn = "";
      try {
        mn = String(comp.matchName || "");
        dn = String(comp.displayName || "");
      } catch (e2) {
        // ignore
      }
      if (mn !== "AE.ADBE Motion" && dn !== "Motion") {
        continue;
      }
      var pn = OE.count(comp.properties);
      var j;
      for (j = 0; j < pn; j++) {
        try {
          if (String(comp.properties[j].displayName) === "Scale") {
            return comp.properties[j];
          }
        } catch (e3) {
          // keep looking
        }
      }
      try {
        if (pn > 1 && typeof comp.properties[1].getValue() === "number") {
          return comp.properties[1];
        }
      } catch (e4) {
        // not found
      }
    }
    return null;
  }

  function valueAt(prop, t) {
    try {
      if (typeof prop.isTimeVarying === "function" && prop.isTimeVarying() &&
          typeof prop.getValueAtTime === "function") {
        var v = prop.getValueAtTime(t);
        if (typeof v === "number") {
          return v;
        }
      }
    } catch (e) {
      // fall back to the static value
    }
    var s = prop.getValue();
    return typeof s === "number" ? s : 100;
  }

  var BEZIER = 5; // Premiere keyframe interpolation: 0 linear, 4 hold, 5 bezier

  function keyAt(prop, localSec, value) {
    var t = OE.makeTime(localSec);
    prop.addKey(t);
    prop.setValueAtKey(t, value, true);
    try {
      prop.setInterpolationTypeAtKey(t, BEZIER, true);
    } catch (e) {
      // linear keys still give the punch-in
    }
  }

  // One zoom on one clip over [s, e] (sequence seconds, inside the clip).
  function zoomClip(clip, s, e, scalePct, ramp) {
    var prop = motionScaleParam(clip);
    if (!prop) {
      return false;
    }
    var cStart = OE.secs(clip.start);
    var cIn = OE.secs(clip.inPoint);
    if (cStart === null || cIn === null) {
      return false;
    }
    // Keyframe times are clip-local: the clip's source in point plus the
    // offset from where the clip starts on the timeline.
    var l0 = cIn + (s - cStart);
    var l3 = cIn + (e - cStart);
    var r = Math.min(ramp, (l3 - l0) / 3);
    var l1 = l0 + r;
    var l2 = l3 - r;
    var base0 = valueAt(prop, OE.makeTime(l0));
    var base3 = valueAt(prop, OE.makeTime(l3));
    var peak = base0 * scalePct / 100;
    if (typeof prop.isTimeVarying === "function" && !prop.isTimeVarying()) {
      prop.setTimeVarying(true, true);
    }
    keyAt(prop, l0, base0);
    keyAt(prop, l1, peak);
    keyAt(prop, l2, peak);
    keyAt(prop, l3, base3);
    return true;
  }

  OE.commands.addZooms = function (args) {
    var seq = OE.activeSeq();
    var list = args.zooms;
    if (!OE.isArray(list)) {
      OE.fail("zooms must be an array");
    }
    if (OE.count(seq.videoTracks) < 1) {
      OE.fail("sequence has no video track");
    }
    var clips = OE.trackClips(seq.videoTracks[0]);
    var frame = OE.frameSec(seq);
    var applied = 0;
    var errors = [];
    for (var i = 0; i < list.length; i++) {
      var z = list[i];
      if (!z) {
        continue;
      }
      var zs = OE.num(z.start, NaN);
      var ze = OE.num(z.end, NaN);
      var sc = OE.num(z.scale, NaN);
      if (isNaN(zs) || isNaN(ze) || isNaN(sc) || ze <= zs || sc <= 0) {
        errors[errors.length] = "zoom " + i + ": invalid";
        continue;
      }
      var any = false;
      for (var c = 0; c < clips.length; c++) {
        var cs = OE.secs(clips[c].start);
        var ce = OE.secs(clips[c].end);
        if (cs === null || ce === null) {
          continue;
        }
        var s = Math.max(zs, cs);
        var e = Math.min(ze, ce);
        if (e - s < frame * 2) {
          continue;
        }
        try {
          if (zoomClip(clips[c], s, e, sc, 0.2)) {
            any = true;
          }
        } catch (err) {
          errors[errors.length] = "zoom " + i + ": " + OE.errText(err);
        }
      }
      if (any) {
        applied++;
      }
    }
    if (!applied && errors.length) {
      OE.fail(errors.join("; "));
    }
    return applied;
  };
})($.OpenEdit);
