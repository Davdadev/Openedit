// OpenEdit - render: export the ACTIVE sequence to a file.
//
// Preset resolution (first hit wins):
//   1. args.preset when it is an existing .epr file path
//   2. args.preset as a preset NAME, searched in Premiere's system presets
//   3. $OPENEDIT_PREMIERE_PRESET environment variable (an .epr path)
//   4. Premiere's own H.264 "Match Source" presets, found under
//      <Premiere install>/MediaIO/systempresets/4E49434B_48323634/ (the folder
//      name is hex for the H.264 exporter id; on macOS the install is the .app
//      bundle and the folder sits in Contents/).
// Encoding uses sequence.exportAsMediaDirect (renders inside Premiere and
// blocks until done). When that API is missing, the job is queued in Adobe
// Media Encoder through app.encoder instead.
// ES3, 7-bit ASCII only. Loaded by openedit.jsx.

(function (OE) {
  var H264_DIR = "4E49434B_48323634";
  var PREFERRED = [
    "Match Source - Adaptive High Bitrate.epr",
    "Match Source - High bitrate.epr",
    "Match Source - Adaptive Medium Bitrate.epr",
    "Match Source - Medium bitrate.epr"
  ];

  function presetRoots() {
    var roots = [];
    var base = "";
    try {
      base = String(app.path);
    } catch (e) {
      base = "";
    }
    if (base) {
      roots[roots.length] = base + "/Contents/MediaIO/systempresets";
      roots[roots.length] = base + "/MediaIO/systempresets";
      try {
        var parent = new Folder(base).parent;
        if (parent) {
          roots[roots.length] = parent.fsName + "/MediaIO/systempresets";
          roots[roots.length] = parent.fsName + "/Contents/MediaIO/systempresets";
        }
      } catch (e2) {
        // ignore
      }
    }
    var out = [];
    for (var i = 0; i < roots.length; i++) {
      var f = new Folder(roots[i]);
      if (f.exists) {
        out[out.length] = f;
      }
    }
    return out;
  }

  function findByName(folder, name, depth) {
    if (!folder || depth > 3) {
      return null;
    }
    var entries = folder.getFiles();
    if (!entries) {
      return null;
    }
    var lname = name.toLowerCase();
    var i;
    for (i = 0; i < entries.length; i++) {
      if (entries[i] instanceof File) {
        var n = decodeURI(entries[i].name).toLowerCase();
        if (n === lname || n === lname + ".epr") {
          return entries[i];
        }
      }
    }
    for (i = 0; i < entries.length; i++) {
      if (entries[i] instanceof Folder) {
        var hit = findByName(entries[i], name, depth + 1);
        if (hit) {
          return hit;
        }
      }
    }
    return null;
  }

  OE.findPreset = function (wanted) {
    var tried = [];
    if (wanted) {
      var direct = new File(wanted);
      if (direct.exists && !(direct instanceof Folder)) {
        return { file: direct, tried: tried };
      }
      tried[tried.length] = "preset arg as path";
    }
    try {
      var env = $.getenv("OPENEDIT_PREMIERE_PRESET");
      if (!wanted && env) {
        var ef = new File(env);
        if (ef.exists) {
          return { file: ef, tried: tried };
        }
        tried[tried.length] = "OPENEDIT_PREMIERE_PRESET=" + env;
      }
    } catch (e) {
      // no env support
    }
    var roots = presetRoots();
    for (var r = 0; r < roots.length; r++) {
      if (wanted) {
        var byName = findByName(roots[r], wanted, 0);
        if (byName) {
          return { file: byName, tried: tried };
        }
        continue;
      }
      var h264 = new Folder(roots[r].fsName + "/" + H264_DIR);
      if (h264.exists) {
        for (var p = 0; p < PREFERRED.length; p++) {
          var pf = new File(h264.fsName + "/" + PREFERRED[p]);
          if (pf.exists) {
            return { file: pf, tried: tried };
          }
        }
        var any = h264.getFiles("*.epr");
        if (any && any.length) {
          return { file: any[0], tried: tried };
        }
      }
      tried[tried.length] = roots[r].fsName;
    }
    if (!roots.length) {
      tried[tried.length] = "no systempresets folder under app.path=" + String(app.path);
    }
    return { file: null, tried: tried };
  };

  OE.commands.render = function (args) {
    var seq = OE.activeSeq();
    var output = args.output;
    if (typeof output !== "string" || !output) {
      OE.fail("output path required");
    }
    var outFile = new File(output);
    try {
      if (!outFile.parent.exists) {
        outFile.parent.create();
      }
    } catch (e) {
      // export will report a bad path
    }
    var found = OE.findPreset(typeof args.preset === "string" ? args.preset : "");
    if (!found.file) {
      OE.fail("no export preset found (pass args.preset as an .epr path or set OPENEDIT_PREMIERE_PRESET); looked in: " +
        found.tried.join(", "));
    }
    var presetPath = found.file.fsName;
    var nativeOut = outFile.fsName;
    var staleStamp = 0;
    if (outFile.exists) {
      try {
        outFile.remove();
      } catch (e2) {
        // checked below
      }
      outFile = new File(nativeOut);
      if (outFile.exists && outFile.modified) {
        staleStamp = outFile.modified.getTime();
      }
    }

    if (typeof seq.exportAsMediaDirect === "function") {
      var res = seq.exportAsMediaDirect(nativeOut, presetPath, 0); // 0 = entire sequence
      if (res && typeof res === "string" && res !== "No Error") {
        OE.fail("export failed: " + res);
      }
      // Some builds return before the file is flushed.
      for (var i = 0; i < 40; i++) {
        var f = new File(nativeOut);
        if (f.exists && (!staleStamp || (f.modified && f.modified.getTime() > staleStamp))) {
          return { output: f.fsName, preset: presetPath };
        }
        $.sleep(250);
      }
      OE.fail("export finished but no output file appeared at " + nativeOut);
    }

    if (app.encoder && typeof app.encoder.encodeSequence === "function") {
      try {
        app.encoder.launchEncoder();
      } catch (e3) {
        // AME may already be running
      }
      var jobId = app.encoder.encodeSequence(seq, nativeOut, presetPath, 0, 1);
      try {
        app.encoder.startBatch();
      } catch (e4) {
        // the job still sits in the AME queue
      }
      return { output: nativeOut, preset: presetPath, queued: true, jobId: String(jobId) };
    }
    OE.fail("unsupported: no export API available in this Premiere version");
  };
})($.OpenEdit);
