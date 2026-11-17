// OpenEdit - applyCutPlan: build a NEW sequence from the keep ranges of one
// source file. The original sequence is never edited.
//
// Strategy:
//   1. Get an empty sequence with the active sequence's settings: clone the
//      active sequence (clone() returns a boolean, so the copy is found by
//      diffing sequence IDs), rename it, then remove every clip and marker
//      from it. With no active sequence, createNewSequenceFromClips() builds
//      one that matches the source, which is then emptied the same way.
//   2. "inout" method: for each keep range set in/out marks on the source
//      project item and overwriteClip() it onto V1 at the running cursor.
//      An A/V master placed on a video track brings its linked audio along.
//      The cursor is re-read from the track after every placement so frame
//      rounding never accumulates. The item's original marks are restored.
//   3. "razor" fallback (when in/out marks cannot be set on this build): put
//      the whole source at 0, razor every track at each boundary through the
//      QE DOM, then ripple-delete the removed pieces from last to first.
// ES3, 7-bit ASCII only. Loaded by openedit.jsx.

(function (OE) {
  function sanitizeRanges(keep, duration) {
    var out = [];
    if (!OE.isArray(keep)) {
      OE.fail("plan.keep must be an array");
    }
    for (var i = 0; i < keep.length; i++) {
      var r = keep[i];
      if (!r) {
        continue;
      }
      var s = OE.num(r.start, NaN);
      var e = OE.num(r.end, NaN);
      if (isNaN(s) || isNaN(e)) {
        continue;
      }
      if (s < 0) {
        s = 0;
      }
      if (duration > 0 && e > duration) {
        e = duration;
      }
      if (e > s) {
        out[out.length] = { start: s, end: e };
      }
    }
    return out;
  }

  function removeAllClips(seq) {
    var leftover = 0;
    var groups = [seq.videoTracks, seq.audioTracks];
    for (var g = 0; g < groups.length; g++) {
      var n = OE.count(groups[g]);
      for (var t = 0; t < n; t++) {
        var track = groups[g][t];
        for (var pass = 0; pass < 3; pass++) {
          var clips = OE.trackClips(track);
          if (!clips.length) {
            break;
          }
          for (var c = clips.length - 1; c >= 0; c--) {
            try {
              clips[c].remove(false, false);
            } catch (e) {
              // a linked partner may already be gone; re-read next pass
            }
          }
        }
        leftover += OE.count(track.clips);
      }
    }
    return leftover;
  }

  function removeAllMarkers(seq) {
    try {
      var markers = seq.markers;
      var guard = 0;
      var m = markers.getFirstMarker();
      while (m && guard < 100000) {
        guard++;
        markers.deleteMarker(m);
        m = markers.getFirstMarker();
      }
    } catch (e) {
      // markers are cosmetic here
    }
  }

  function renameSequence(seq, name) {
    try {
      seq.name = name;
    } catch (e) {
      try {
        seq.projectItem.name = name;
      } catch (e2) {
        // keep Premiere's name
      }
    }
  }

  // Empty sequence named `name`. Prefers a clone of `template`.
  function makeEmptySequence(template, sourceItem, name, bin) {
    var proj = OE.project();
    var before = OE.sequenceIds();
    var seq = null;
    var how = "";
    if (template) {
      try {
        var ok = template.clone();
        if (ok !== false) {
          seq = OE.findNewSequence(before);
        }
        how = "clone";
      } catch (e) {
        seq = null;
      }
    }
    if (!seq) {
      if (typeof proj.createNewSequenceFromClips !== "function") {
        OE.fail("cannot create a sequence: no active sequence to clone and createNewSequenceFromClips is unavailable");
      }
      before = OE.sequenceIds();
      try {
        proj.createNewSequenceFromClips(name, [sourceItem], bin);
      } catch (e2) {
        OE.fail("createNewSequenceFromClips failed: " + OE.errText(e2));
      }
      seq = OE.findNewSequence(before);
      how = "fromClips";
    }
    if (!seq) {
      OE.fail("new sequence was not created");
    }
    renameSequence(seq, name);
    try {
      if (bin && seq.projectItem && typeof seq.projectItem.moveBin === "function") {
        seq.projectItem.moveBin(bin);
      }
    } catch (e3) {
      // stays in the template's bin
    }
    removeAllMarkers(seq);
    var left = removeAllClips(seq);
    if (left > 0) {
      OE.fail("could not empty the new sequence (" + left + " clips left)");
    }
    return { seq: seq, how: how };
  }

  // Latest end time (seconds) of the clips on a track.
  function trackEnd(track) {
    var clips = OE.trackClips(track);
    var end = 0;
    for (var i = 0; i < clips.length; i++) {
      var e = OE.secs(clips[i].end);
      if (e !== null && e > end) {
        end = e;
      }
    }
    return end;
  }

  function placeByInOut(seq, item, ranges, audioOnly) {
    var track = audioOnly ? seq.audioTracks[0] : seq.videoTracks[0];
    if (!track) {
      OE.fail("new sequence has no " + (audioOnly ? "audio" : "video") + " track");
    }
    var frame = OE.frameSec(seq);
    var snap = OE.snapshotMarks(item);
    var cursor = 0;
    var placed = 0;
    var skipped = 0;
    try {
      for (var i = 0; i < ranges.length; i++) {
        var s = OE.snap(seq, ranges[i].start);
        var e = OE.snap(seq, ranges[i].end);
        if (e - s < frame * 0.5) {
          skipped++;
          continue;
        }
        if (!OE.setInOut(item, s, e, frame * 0.5 + 0.0005)) {
          if (placed === 0) {
            return { placed: 0, failed: true, reason: "in/out marks could not be set" };
          }
          skipped++;
          continue;
        }
        var countBefore = OE.count(track.clips);
        track.overwriteClip(item, cursor);
        var newEnd = trackEnd(track);
        if (OE.count(track.clips) <= countBefore && newEnd <= cursor + 0.0005) {
          if (placed === 0) {
            return { placed: 0, failed: true, reason: "overwriteClip placed nothing" };
          }
          skipped++;
          continue;
        }
        placed++;
        cursor = newEnd > cursor ? newEnd : cursor + (e - s);
      }
    } finally {
      OE.restoreInOut(item, snap);
    }
    return { placed: placed, skipped: skipped, duration: cursor };
  }

  // Merge keep ranges for the razor method (needs ascending, disjoint).
  function mergeRanges(ranges) {
    var sorted = ranges.slice(0);
    sorted.sort(function (a, b) {
      return a.start - b.start;
    });
    var out = [];
    for (var i = 0; i < sorted.length; i++) {
      var r = sorted[i];
      if (out.length && r.start <= out[out.length - 1].end) {
        if (r.end > out[out.length - 1].end) {
          out[out.length - 1].end = r.end;
        }
      } else {
        out[out.length] = { start: r.start, end: r.end };
      }
    }
    return out;
  }

  function timecodeFor(seq, sec) {
    var t = OE.makeTime(sec);
    var settings = seq.getSettings();
    return String(t.getFormatted(settings.videoFrameRate, seq.videoDisplayFormat));
  }

  function placeByRazor(seq, item, ranges, audioOnly) {
    if (!OE.isActive(seq) && !OE.activate(seq)) {
      OE.fail("razor fallback needs the new sequence to be active");
    }
    var q = OE.qeSeq();
    if (!q) {
      OE.fail("razor fallback needs the QE DOM, which is unavailable");
    }
    removeAllClips(seq);
    OE.clearInOut(item);
    var track = audioOnly ? seq.audioTracks[0] : seq.videoTracks[0];
    track.overwriteClip(item, 0);
    var total = trackEnd(track);
    if (!(total > 0)) {
      OE.fail("razor fallback: source could not be placed");
    }

    var keep = mergeRanges(ranges);
    var frame = OE.frameSec(seq);
    for (var k = 0; k < keep.length; k++) {
      keep[k].start = OE.snap(seq, keep[k].start);
      keep[k].end = OE.snap(seq, Math.min(keep[k].end, total));
    }
    // Pieces to delete = complement of keep inside [0, total].
    var cuts = [];
    var pos = 0;
    for (var j = 0; j < keep.length; j++) {
      if (keep[j].start - pos >= frame * 0.5) {
        cuts[cuts.length] = { start: pos, end: keep[j].start };
      }
      if (keep[j].end > pos) {
        pos = keep[j].end;
      }
    }
    if (total - pos >= frame * 0.5) {
      cuts[cuts.length] = { start: pos, end: total };
    }

    // Razor every track at every boundary.
    var bounds = {};
    var list = [];
    for (var c = 0; c < cuts.length; c++) {
      var pts = [cuts[c].start, cuts[c].end];
      for (var p = 0; p < 2; p++) {
        var b = pts[p];
        if (b > frame * 0.5 && b < total - frame * 0.5 && !bounds["t" + b]) {
          bounds["t" + b] = true;
          list[list.length] = b;
        }
      }
    }
    var nv = OE.count(seq.videoTracks);
    var na = OE.count(seq.audioTracks);
    for (var r = 0; r < list.length; r++) {
      var tc = timecodeFor(seq, list[r]);
      var vi;
      for (vi = 0; vi < nv; vi++) {
        try {
          q.getVideoTrackAt(vi).razor(tc);
        } catch (e) {
          // empty track
        }
      }
      for (vi = 0; vi < na; vi++) {
        try {
          q.getAudioTrackAt(vi).razor(tc);
        } catch (e2) {
          // empty track
        }
      }
    }

    // Delete pieces from the last cut to the first so earlier positions are
    // untouched. Collect every piece inside the cut first, then remove; a
    // linked partner removed along the way just throws and is skipped.
    var tol = frame * 0.5 + 0.0005;
    for (var d = cuts.length - 1; d >= 0; d--) {
      var victims = [];
      var groups = [seq.videoTracks, seq.audioTracks];
      for (var g = 0; g < groups.length; g++) {
        var n = OE.count(groups[g]);
        for (var ti = 0; ti < n; ti++) {
          var clips = OE.trackClips(groups[g][ti]);
          for (var ci = 0; ci < clips.length; ci++) {
            var cs = OE.secs(clips[ci].start);
            var ce = OE.secs(clips[ci].end);
            if (cs !== null && ce !== null && cs >= cuts[d].start - tol && ce <= cuts[d].end + tol) {
              victims[victims.length] = clips[ci];
            }
          }
        }
      }
      for (var v = 0; v < victims.length; v++) {
        try {
          victims[v].remove(true, true);
        } catch (e3) {
          // already removed with its linked partner
        }
      }
    }
    var placed = 0;
    for (var kk = 0; kk < keep.length; kk++) {
      if (keep[kk].end - keep[kk].start >= frame * 0.5) {
        placed++;
      }
    }
    return { placed: placed, skipped: 0, duration: trackEnd(track), merged: keep.length !== ranges.length };
  }

  OE.commands.applyCutPlan = function (args) {
    var plan = args.plan;
    if (!plan || typeof plan !== "object") {
      OE.fail("missing plan");
    }
    if (!plan.source || typeof plan.source !== "string") {
      OE.fail("plan.source must be a file path");
    }
    var ranges = sanitizeRanges(plan.keep, OE.num(plan.duration, 0));
    if (!ranges.length) {
      OE.fail("plan.keep has no usable ranges");
    }
    var proj = OE.project();
    var bin = OE.bin();
    var item = OE.importOne(plan.source, bin);
    var template = null;
    try {
      template = proj.activeSequence;
    } catch (e) {
      template = null;
    }
    var baseName = (typeof args.sequenceName === "string" && args.sequenceName) ?
      args.sequenceName : OE.stripExt(OE.basename(plan.source)) + " - OpenEdit";
    var name = OE.uniqueSequenceName(baseName);
    var made = makeEmptySequence(template, item, name, bin);
    var seq = made.seq;
    OE.activate(seq);

    var audioOnly = OE.isAudioPath(plan.source);
    var res = placeByInOut(seq, item, ranges, audioOnly);
    var method = "inout";
    if (res.failed) {
      var why = res.reason;
      res = placeByRazor(seq, item, ranges, audioOnly);
      method = "razor (" + why + ")";
    }
    if (!(res.placed > 0)) {
      OE.fail("no ranges were placed into " + name);
    }
    OE.activate(seq);
    return {
      sequence: String(seq.name),
      sequenceId: String(seq.sequenceID),
      clips: res.placed,
      skipped: res.skipped || 0,
      duration: OE.round(res.duration || 0, 4),
      method: method,
      createdBy: made.how
    };
  };
})($.OpenEdit);
