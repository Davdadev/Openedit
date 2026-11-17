// OpenEdit - read-only commands: status, getTimeline, getSourceMedia.
// ES3, 7-bit ASCII only. Loaded by openedit.jsx.

(function (OE) {
  // Premiere marker color indices.
  OE.MARKER_COLORS = {
    green: 0, red: 1, purple: 2, orange: 3, yellow: 4, white: 5, blue: 6, cyan: 7
  };
  OE.MARKER_COLOR_NAMES = ["green", "red", "purple", "orange", "yellow", "white", "blue", "cyan"];

  OE.commands.status = function () {
    var st = { host: "premiere", connected: true };
    try {
      st.version = String(app.version);
    } catch (e) {
      // leave unset
    }
    try {
      if (app.project) {
        st.project = String(app.project.name);
        if (app.project.activeSequence) {
          st.sequence = String(app.project.activeSequence.name);
        }
      }
    } catch (e2) {
      // leave unset
    }
    var detail = "OpenEdit host " + OE.version;
    if (OE.loadErrors.length) {
      detail += "; load errors: " + OE.loadErrors.join(" | ");
    }
    st.detail = detail;
    return st;
  };

  function clipInfo(clip, trackNo, kind) {
    var info = {
      name: "",
      track: trackNo,
      kind: kind,
      start: 0,
      end: 0,
      sourceIn: 0,
      sourceOut: 0
    };
    try {
      info.name = String(clip.name);
    } catch (e) {
      // keep default
    }
    try {
      var p = OE.itemMediaPath(clip.projectItem);
      if (p) {
        info.path = p;
      }
    } catch (e2) {
      // no project item (e.g. a graphic)
    }
    info.start = OE.round(OE.num(OE.secs(clip.start), 0), 6);
    info.end = OE.round(OE.num(OE.secs(clip.end), 0), 6);
    info.sourceIn = OE.round(OE.num(OE.secs(clip.inPoint), 0), 6);
    info.sourceOut = OE.round(OE.num(OE.secs(clip.outPoint), 0), 6);
    return info;
  }

  OE.readMarkers = function (seq) {
    var out = [];
    var markers = null;
    try {
      markers = seq.markers;
    } catch (e) {
      return out;
    }
    if (!markers) {
      return out;
    }
    var m = null;
    try {
      m = markers.getFirstMarker();
    } catch (e2) {
      m = null;
    }
    var guard = 0;
    while (m && guard < 100000) {
      guard++;
      var mk = { time: 0, name: "" };
      try {
        mk.time = OE.round(OE.num(OE.secs(m.start), 0), 6);
        var end = OE.num(OE.secs(m.end), mk.time);
        if (end > mk.time + 0.0005) {
          mk.duration = OE.round(end - mk.time, 6);
        }
        mk.name = String(m.name || "");
        if (m.comments) {
          mk.comment = String(m.comments);
        }
        try {
          var ci = m.getColorByIndex();
          if (typeof ci === "number" && ci >= 0 && ci < OE.MARKER_COLOR_NAMES.length) {
            var cname = OE.MARKER_COLOR_NAMES[ci];
            if (cname !== "cyan") {
              mk.color = cname;
            }
          }
        } catch (ce) {
          // older builds have no color getter
        }
      } catch (e3) {
        // keep what was read
      }
      out[out.length] = mk;
      try {
        m = markers.getNextMarker(m);
      } catch (e4) {
        m = null;
      }
    }
    return out;
  };

  OE.commands.getTimeline = function () {
    var seq = OE.activeSeq();
    var info = {
      name: String(seq.name),
      duration: 0,
      fps: OE.round(OE.fps(seq), 4),
      videoTracks: OE.count(seq.videoTracks),
      audioTracks: OE.count(seq.audioTracks),
      clips: [],
      markers: []
    };
    try {
      info.duration = OE.round(OE.num(OE.secs(seq.end), 0), 6);
    } catch (e) {
      info.duration = 0;
    }
    try {
      var w = OE.num(seq.frameSizeHorizontal, 0);
      var h = OE.num(seq.frameSizeVertical, 0);
      if (!(w > 0) || !(h > 0)) {
        var st = seq.getSettings();
        w = OE.num(st.videoFrameWidth, 0);
        h = OE.num(st.videoFrameHeight, 0);
      }
      if (w > 0 && h > 0) {
        info.width = w;
        info.height = h;
      }
    } catch (e2) {
      // size unknown
    }
    var t;
    var c;
    var clips;
    for (t = 0; t < info.videoTracks; t++) {
      clips = OE.trackClips(seq.videoTracks[t]);
      for (c = 0; c < clips.length; c++) {
        info.clips[info.clips.length] = clipInfo(clips[c], t + 1, "video");
      }
    }
    for (t = 0; t < info.audioTracks; t++) {
      clips = OE.trackClips(seq.audioTracks[t]);
      for (c = 0; c < clips.length; c++) {
        info.clips[info.clips.length] = clipInfo(clips[c], t + 1, "audio");
      }
    }
    info.markers = OE.readMarkers(seq);
    return info;
  };

  OE.commands.getSourceMedia = function () {
    var seq = OE.activeSeq();
    var seen = {};
    var out = [];
    function collect(tracks) {
      var n = OE.count(tracks);
      for (var t = 0; t < n; t++) {
        var clips = OE.trackClips(tracks[t]);
        for (var c = 0; c < clips.length; c++) {
          var p = "";
          try {
            p = OE.itemMediaPath(clips[c].projectItem);
          } catch (e) {
            p = "";
          }
          if (!p) {
            continue;
          }
          var key = "p:" + OE.normPath(p);
          if (!seen[key]) {
            seen[key] = true;
            out[out.length] = p;
          }
        }
      }
    }
    collect(seq.videoTracks);
    collect(seq.audioTracks);
    return out;
  };
})($.OpenEdit);
