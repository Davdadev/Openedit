// A small, deliberately simplified fake of the Premiere Pro ExtendScript DOM,
// used only by mock-test.mjs to drive host/*.jsx logic under Node. It models
// the shapes the host code relies on (collections with numItems/numTracks
// and index access, Time objects in ticks, project item marks, overwriteClip
// with linked audio, clone(), markers, Motion/Volume components). It is NOT
// evidence that Premiere behaves the same way.
import fs from "node:fs";
import path from "node:path";

export const TPS = 254016000000;

export function time(sec) {
  return { ticks: String(Math.round(sec * TPS)), seconds: sec };
}

function toSec(v) {
  if (v && typeof v === "object") {
    if (v.ticks !== undefined) return Number(v.ticks) / TPS;
    return Number(v.seconds);
  }
  return Number(v);
}

function coll(arr, countName) {
  return new Proxy(arr, {
    get(target, prop) {
      if (prop === countName) return target.length;
      if (typeof prop === "string" && /^\d+$/.test(prop)) return target[Number(prop)];
      return target[prop];
    },
  });
}

let nextId = 1;

/** Graphics Parameters of fake .mogrt files, keyed by absolute path: { duration, params: [{ name, value }] }. */
export const MOGRT_PARAMS = new Map();

function makeParam(displayName, value) {
  const keys = [];
  let varying = false;
  return {
    displayName,
    keys,
    getValue: () => value,
    setValue(v) {
      value = v;
    },
    isTimeVarying: () => varying,
    setTimeVarying(v) {
      varying = !!v;
    },
    addKey(t) {
      keys.push({ t: toSec(t), v: value, interp: 0 });
    },
    setValueAtKey(t, v) {
      const k = keys.find((k) => Math.abs(k.t - toSec(t)) < 1e-6);
      if (!k) throw new Error("no key at " + toSec(t));
      k.v = v;
    },
    setInterpolationTypeAtKey(t, mode) {
      const k = keys.find((k) => Math.abs(k.t - toSec(t)) < 1e-6);
      if (k) k.interp = mode;
    },
    getKeys: () => keys.map((k) => time(k.t)),
  };
}

function makeTrackItem(item, kind, startSec, inSec, outSec, track) {
  const components =
    kind === "video"
      ? [
          { matchName: "AE.ADBE Opacity", displayName: "Opacity", properties: coll([makeParam("Opacity", 100)], "numItems") },
          {
            matchName: "AE.ADBE Motion",
            displayName: "Motion",
            properties: coll([makeParam("Position", [0.5, 0.5]), makeParam("Scale", 100)], "numItems"),
          },
        ]
      : [
          {
            matchName: "Internal Volume Stereo",
            displayName: "Volume",
            properties: coll([makeParam("Bypass", false), makeParam("Level", 0.17782794100389)], "numItems"),
          },
        ];
  const ti = {
    name: item.name,
    projectItem: item.master || item,
    start: time(startSec),
    end: time(startSec + (outSec - inSec)),
    inPoint: time(inSec),
    outPoint: time(outSec),
    components: coll(components, "numItems"),
    remove(ripple) {
      const i = track._clips.indexOf(ti);
      if (i < 0) throw new Error("already removed");
      track._clips.splice(i, 1);
      if (ripple) {
        const d = toSec(ti.end) - toSec(ti.start);
        for (const c of track._clips) {
          if (toSec(c.start) >= toSec(ti.end) - 1e-9) {
            c.start = time(toSec(c.start) - d);
            c.end = time(toSec(c.end) - d);
          }
        }
      }
    },
  };
  return ti;
}

function makeTrack(seq, kind, index) {
  const track = { _clips: [], kind, index };
  track.clips = coll(track._clips, "numItems");
  track.overwriteClip = function (item, at) {
    const startSec = toSec(at);
    let inSec;
    let outSec;
    if (item.isSub) {
      inSec = item.subIn;
      outSec = item.subOut;
    } else {
      inSec = item.markIn;
      outSec = item.markOut === null ? item.duration : item.markOut;
    }
    const placeOn = (tr, k) => {
      const endSec = startSec + (outSec - inSec);
      // Overwrite: drop clips fully covered by the new one.
      for (let i = tr._clips.length - 1; i >= 0; i--) {
        const c = tr._clips[i];
        if (toSec(c.start) >= startSec - 1e-9 && toSec(c.end) <= endSec + 1e-9) tr._clips.splice(i, 1);
      }
      tr._clips.push(makeTrackItem(item, k, startSec, inSec, outSec, tr));
      tr._clips.sort((a, b) => toSec(a.start) - toSec(b.start));
    };
    if (kind === "video") {
      if (item.hasVideo) placeOn(track, "video");
      if (item.hasAudio) {
        const at2 = seq._audio[index];
        if (at2) placeOn(at2, "audio");
      }
    } else if (item.hasAudio) {
      placeOn(track, "audio");
    }
    seq._recalcEnd();
  };
  return track;
}

export function makeSequence(project, name, opts = {}) {
  const seq = {
    name,
    sequenceID: "seq-" + nextId++,
    timebase: String(TPS / (opts.fps || 25)),
    end: "0",
    frameSizeHorizontal: opts.width || 1920,
    frameSizeVertical: opts.height || 1080,
    _video: [],
    _audio: [],
    _markers: [],
    projectItem: { name, moveBin() {} },
  };
  seq._recalcEnd = () => {
    let e = 0;
    for (const tr of seq._video.concat(seq._audio)) for (const c of tr._clips) e = Math.max(e, toSec(c.end));
    seq.end = String(Math.round(e * TPS));
  };
  for (let i = 0; i < (opts.videoTracks ?? 3); i++) seq._video.push(makeTrack(seq, "video", i));
  for (let i = 0; i < (opts.audioTracks ?? 3); i++) seq._audio.push(makeTrack(seq, "audio", i));
  seq.videoTracks = coll(seq._video, "numTracks");
  seq.audioTracks = coll(seq._audio, "numTracks");
  seq.markers = {
    get numMarkers() {
      return seq._markers.length;
    },
    getFirstMarker: () => seq._markers[0] || null,
    getNextMarker: (m) => seq._markers[seq._markers.indexOf(m) + 1] || null,
    deleteMarker(m) {
      seq._markers.splice(seq._markers.indexOf(m), 1);
    },
    createMarker(sec) {
      const m = {
        start: time(sec),
        end: time(sec),
        name: "",
        comments: "",
        _color: 0,
        setColorByIndex(i) {
          this._color = i;
        },
        getColorByIndex() {
          return this._color;
        },
      };
      seq._markers.push(m);
      return m;
    },
  };
  // MOGRT placement: importMGT(path, ticks, videoTrackIndex, audioTrackIndex) puts a graphic
  // clip on the video track whose Graphics Parameters come from MOGRT_PARAMS[path].
  seq.importMGT = (filePath, ticks, vIdx) => {
    if (!fs.existsSync(filePath)) return null;
    const spec = MOGRT_PARAMS.get(filePath) || { duration: 5, params: [] };
    const track = seq._video[vIdx];
    if (!track) throw new Error("no video track " + vIdx);
    const startSec = Number(ticks) / TPS;
    const item = { name: path.basename(filePath, ".mogrt"), _path: filePath, duration: spec.duration, hasVideo: true, hasAudio: false };
    const ti = makeTrackItem(item, "video", startSec, 0, spec.duration, track);
    const params = spec.params.map((p) => {
      const prm = makeParam(p.name, p.value);
      prm.setColorValue = (a, r, g, b) => {
        prm.colorValue = [r, g, b, a];
      };
      return prm;
    });
    ti._mgtParams = params;
    ti.getMGTComponent = () => ({
      displayName: "Graphic Parameters",
      properties: Object.assign(coll(params, "numItems"), {
        getParamForDisplayName: (n) => params.find((x) => x.displayName === n) || null,
      }),
    });
    track._clips.push(ti);
    track._clips.sort((a, b) => toSec(a.start) - toSec(b.start));
    seq._recalcEnd();
    return ti;
  };
  seq.getSettings = () => ({ videoFrameRate: time(1 / (opts.fps || 25)), videoFrameWidth: seq.frameSizeHorizontal });
  seq.clone = () => {
    const copy = makeSequence(project, seq.name + " Copy", {
      fps: opts.fps,
      videoTracks: seq._video.length,
      audioTracks: seq._audio.length,
    });
    // Copy clips by re-placing the same source ranges.
    seq._video.forEach((tr, i) => {
      for (const c of tr._clips) {
        copy._video[i]._clips.push(makeTrackItem(c.projectItem, "video", toSec(c.start), toSec(c.inPoint), toSec(c.outPoint), copy._video[i]));
      }
    });
    seq._audio.forEach((tr, i) => {
      for (const c of tr._clips) {
        copy._audio[i]._clips.push(makeTrackItem(c.projectItem, "audio", toSec(c.start), toSec(c.inPoint), toSec(c.outPoint), copy._audio[i]));
      }
    });
    copy._markers.push(...seq._markers.map((m) => ({ ...m })));
    project._sequences.push(copy);
    return true;
  };
  return seq;
}

function makeItem(filePath, opts) {
  const ext = path.extname(filePath).toLowerCase();
  const audioOnly = [".wav", ".mp3", ".m4a", ".aac"].includes(ext);
  const item = {
    type: 1,
    name: path.basename(filePath),
    _path: filePath,
    duration: opts.duration || 60,
    hasVideo: !audioOnly && !/\.srt$/i.test(filePath),
    hasAudio: !/\.srt$/i.test(filePath),
    markIn: 0,
    markOut: null,
    marksWork: opts.marksWork !== false,
    getMediaPath: () => filePath,
    isSubClip: () => false,
    getInPoint() {
      return time(item.markIn);
    },
    getOutPoint() {
      return time(item.markOut === null ? item.duration : item.markOut);
    },
    setInPoint(v) {
      if (item.marksWork) item.markIn = toSec(v);
    },
    setOutPoint(v) {
      if (item.marksWork) item.markOut = toSec(v);
    },
    clearInPoint() {
      item.markIn = 0;
    },
    clearOutPoint() {
      item.markOut = null;
    },
    createSubClip(name, a, b, hard, takeVideo, takeAudio) {
      const sub = {
        ...item,
        type: 1,
        name,
        isSub: true,
        master: item,
        subIn: toSec(a),
        subOut: toSec(b),
        hasVideo: item.hasVideo && !!takeVideo,
        hasAudio: item.hasAudio && !!takeAudio,
        isSubClip: () => true,
      };
      item._bin.children._arr.push(sub);
      return sub;
    },
  };
  return item;
}

function makeBin(name, type = 2) {
  const arr = [];
  const bin = { type, name, children: coll(arr, "numItems") };
  bin.children._arr = arr;
  bin.createBin = (n) => {
    const b = makeBin(n);
    arr.push(b);
    return b;
  };
  return bin;
}

export function makePremiere(opts = {}) {
  const project = {
    name: "Fake.prproj",
    _sequences: [],
    activeSequence: null,
    rootItem: makeBin("root", 3),
  };
  project.sequences = coll(project._sequences, "numSequences");
  project.importFiles = (paths, suppress, bin) => {
    for (const p of paths) {
      if (!fs.existsSync(p)) return false;
      const it = makeItem(p, { duration: opts.duration, marksWork: opts.marksWork });
      it._bin = bin;
      bin.children._arr.push(it);
    }
    return true;
  };
  project.openSequence = (id) => {
    const s = project._sequences.find((x) => x.sequenceID === id);
    if (s) project.activeSequence = s;
    return !!s;
  };
  project.createNewSequenceFromClips = (name, items) => {
    const s = makeSequence(project, name, { fps: opts.fps });
    project._sequences.push(s);
    s._video[0].overwriteClip(items[0], 0);
    return s;
  };
  const app = {
    version: "25.0.0",
    path: "/nonexistent/Adobe Premiere Pro.app",
    project,
    enableQE() {},
  };
  return { app, project };
}

// QE-style razor on a DOM track at `sec`: split any clip that spans it.
export function razorTrack(track, sec) {
  let did = false;
  for (const c of track._clips.slice()) {
    const s = toSec(c.start);
    const e = toSec(c.end);
    if (s < sec - 1e-9 && e > sec + 1e-9) {
      const inS = toSec(c.inPoint);
      const outS = toSec(c.outPoint);
      const cut = inS + (sec - s);
      c.end = time(sec);
      c.outPoint = time(cut);
      const kind = track.kind;
      const right = makeTrackItem(c.projectItem, kind, sec, cut, outS, track);
      track._clips.push(right);
      did = true;
    }
  }
  track._clips.sort((a, b) => toSec(a.start) - toSec(b.start));
  return did;
}
