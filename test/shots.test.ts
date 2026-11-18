// Shot & scene understanding: boundaries, motion, b-roll ranking, match cuts, audio sync,
// multicam switching, multi-source render and interchange.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MultiTrackEdit, Transcript } from "../src/hosts/types.js";
import { ABC, buildAngles, buildCutFixture, hasFfmpeg, workDir } from "./shots-fixtures.js";

process.env.OPENEDIT_HOME ||= join(process.env.OPENEDIT_TEST_WORK || "test/.tmp-shots", "home");
process.env.OPENEDIT_STUDIO = "0";

const { classifyCamera, cosine, detectBoundaries, estimateMotion, palette, paletteSimilarity, shotSize, TINY_W, TINY_H } = await import("../src/engine/analysis/shots.js");
const { FrameAccumulator, decodeStats } = await import("../src/engine/analysis/frames.js");
const { keywords, keywordMatch, phrasesFromTranscript, rankBroll, shotTerms } = await import("../src/engine/analysis/broll.js");
const { findMatchCuts, gridCorrelation, motionAgreement } = await import("../src/engine/analysis/matchcuts.js");
const { fft, refineLag, syncSignals, SYNC_RATE, syncAngles } = await import("../src/engine/analysis/sync.js");
const { planMulticam, remapCaptions, speakerTrack } = await import("../src/engine/multicam.js");
const { checkEdit, renderMultiEdit } = await import("../src/engine/render-multi.js");
const { multiToFCP7, multiToFCPXML, snapMulti } = await import("../src/engine/analysis/interchange-multi.js");
const { frameRate } = await import("../src/engine/interchange.js");
type Shot = import("../src/engine/analysis/analyze.js").Shot;

const dirs: string[] = [];
afterAll(() => {
  if (!process.env.KEEP_TMP) for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** A textured luma image w x h, optionally shifted. */
function texture(w: number, h: number, dx = 0, dy = 0, seed = 7): Uint8Array {
  const big = 160;
  const rnd = lcg(seed);
  const base = new Float64Array(big * big);
  for (let i = 0; i < base.length; i++) base[i] = rnd();
  // Smooth a little so sub-pixel shifts are well defined.
  const sm = (x: number, y: number) => {
    let s = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += base[((y + j + big) % big) * big + ((x + i + big) % big)];
    return s / 9;
  };
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = Math.round(sm(x - dx + 20, y - dy + 20) * 255);
  return out;
}

describe("camera motion", () => {
  it("estimates a global shift and its direction", () => {
    const a = texture(TINY_W, TINY_H);
    const b = texture(TINY_W, TINY_H, 2, -1);
    const m = estimateMotion(a, b, TINY_W, TINY_H);
    expect(m.dx).toBeCloseTo(2, 0);
    expect(m.dy).toBeCloseTo(-1, 0);
    expect(Math.abs(m.zoom)).toBeLessThan(0.02);
  });
  it("classifies pans, zooms and static shots", () => {
    const pan = Array.from({ length: 20 }, () => ({ dx: -2, dy: 0, zoom: 0, resid: 0.1 }));
    expect(classifyCamera(pan, 25).move).toBe("pan-right");
    const zoom = Array.from({ length: 20 }, () => ({ dx: 0, dy: 0, zoom: 0.01, resid: 0.1 }));
    expect(classifyCamera(zoom, 25).move).toBe("zoom-in");
    const still = Array.from({ length: 20 }, (_, i) => ({ dx: i === 3 ? 4 : 0.01, dy: 0, zoom: 0, resid: 0.05 }));
    expect(classifyCamera(still, 25).move).toBe("static");
  });
});

describe("shot features", () => {
  it("palette k-means is deterministic and finds the dominant colours", () => {
    const px: number[] = [];
    for (let i = 0; i < 300; i++) px.push(250, 10, 10);
    for (let i = 0; i < 100; i++) px.push(10, 10, 250);
    const p = palette(px, 3);
    expect(p[0].hex).toBe("#fa0a0a");
    expect(p[0].weight).toBeCloseTo(0.75, 2);
    expect(palette(px, 3)).toEqual(p);
    expect(paletteSimilarity(p, p)).toBeCloseTo(1, 5);
  });
  it("shot size from face height", () => {
    expect(shotSize(0.7)).toBe("extreme-close-up");
    expect(shotSize(0.4)).toBe("close-up");
    expect(shotSize(0.2)).toBe("medium");
    expect(shotSize(0.08)).toBe("wide");
    expect(shotSize(undefined)).toBe("no-faces");
    expect(cosine([1, 0], [1, 0])).toBe(1);
  });
  it("finds a hard cut in synthetic frames and ignores a flash", () => {
    const acc = new FrameAccumulator(25);
    const frame = (seed: number, flash = false) => {
      const y = texture(TINY_W, TINY_H, 0, 0, seed);
      const rgb = new Uint8Array(TINY_W * TINY_H * 3);
      for (let i = 0; i < y.length; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = flash ? 255 : y[i];
      return rgb;
    };
    for (let i = 0; i < 40; i++) acc.push(frame(1, i === 20));
    for (let i = 0; i < 40; i++) acc.push(frame(2));
    const b = detectBoundaries(acc.result());
    expect(b.map((x) => x.frame)).toEqual([40]);
  });
});

describe.skipIf(!hasFfmpeg())("shot boundaries on a synthetic edit (cuts, dissolve, fade, pan, flash)", () => {
  it("recalls ≥95% of boundaries within ±1 frame with no false positives", async () => {
    const dir = workDir("cuts");
    dirs.push(dir);
    const fx = buildCutFixture(dir);
    const st = await decodeStats(fx.file, 25);
    expect(st.count).toBe(fx.frames);
    const found = detectBoundaries(st);
    const hits = fx.truth.filter((t) => found.some((f) => Math.abs(f.frame - t.frame) <= 1));
    const falsePos = found.filter((f) => !fx.truth.some((t) => Math.abs(f.frame - t.frame) <= 1));
    const recall = hits.length / fx.truth.length;
    console.log(`shot boundaries: recall ${(recall * 100).toFixed(1)}% (${hits.length}/${fx.truth.length}), false positives ${falsePos.length}`);
    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(falsePos.length).toBeLessThanOrEqual(1);
    const dis = fx.truth.find((t) => t.kind === "dissolve")!;
    expect(found.find((f) => Math.abs(f.frame - dis.frame) <= 1)?.kind).toBe("dissolve");
    const fade = fx.truth.find((t) => t.kind === "fade")!;
    expect(found.find((f) => Math.abs(f.frame - fade.frame) <= 1)?.kind).toBe("fade");
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------

function fakeShot(id: string, o: Partial<Shot> & { labels?: Shot["labels"] }): Shot {
  return {
    id,
    file: `/lib/${id.split("#")[0]}.mp4`,
    index: Number(id.split("#")[1] ?? 1),
    start: 0,
    end: 6,
    duration: 6,
    startFrame: 0,
    endFrame: 150,
    transition: "start",
    motion: 0.01,
    camera: "static",
    pan: 0,
    tilt: 0,
    zoom: 0,
    shake: 0,
    headMotion: { dx: 0, dy: 0 },
    tailMotion: { dx: 0, dy: 0 },
    brightness: 0.5,
    exposure: "ok",
    sharpness: 80,
    palette: [{ hex: "#808080", weight: 1, rgb: [128, 128, 128] }],
    faces: { count: 0, maxH: 0 },
    shotSize: "no-faces",
    labels: [],
    reps: [{ t: 3, frame: 75, thumb: "/x.jpg" }],
    ...o,
  };
}

function transcriptOf(lines: [number, string][]): Transcript {
  return {
    language: "en",
    duration: 60,
    segments: lines.map(([start, text]) => {
      const ws = text.split(" ");
      const words = ws.map((w, i) => ({ text: w, start: start + i * 0.4, end: start + i * 0.4 + 0.35 }));
      return { text, start, end: words[words.length - 1].end, words };
    }),
  };
}

describe("b-roll ranking", () => {
  const library = [
    fakeShot("typing#1", { labels: [{ label: "computer", conf: 0.9 }, { label: "computer_keyboard", conf: 0.8 }] }),
    fakeShot("shelves#1", { labels: [{ label: "bookshelf", conf: 0.85 }, { label: "library", conf: 0.6 }] }),
    fakeShot("shelves#2", { labels: [{ label: "book", conf: 0.8 }], sharpness: 10 }),
    fakeShot("talker#1", { labels: [{ label: "computer", conf: 0.9 }], faces: { count: 1, maxH: 0.4 }, shotSize: "close-up" }),
    fakeShot("ocean#1", { labels: [{ label: "liquid", conf: 0.9 }, { label: "sky", conf: 0.5 }] }),
  ];
  const t = transcriptOf([
    [0, "Hi, my name is Sam."],
    [6, "My computer reads the text aloud."],
    [14, "Imagine a textbook with four hundred pages."],
    [22, "This takes a lot of time and information."],
  ]);

  it("extracts visual keywords, not abstract words", () => {
    expect(keywords("This information is important to the computer reads")).toEqual(["computer", "read"]);
    expect(keywordMatch(["computer"], shotTerms(library[0])).score).toBeGreaterThan(0.8);
    expect(keywordMatch(["textbook"], shotTerms(library[1])).hits[0].via).toBe("bookshelf");
  });

  it("picks literal, sharp, faceless shots and refuses weak matches", () => {
    const props = rankBroll(phrasesFromTranscript(t), library);
    const byText = (s: string) => props.find((p) => p.phrase.text.includes(s))!;
    expect(byText("computer").pick?.shot.id).toBe("typing#1");
    expect(byText("textbook").pick?.shot.id).toBe("shelves#1");
    expect(byText("information").pick).toBeUndefined();
    expect(byText("Sam").pick).toBeUndefined();
    // Cut a beat before the keyword.
    const comp = byText("computer");
    expect(comp.at).toBeCloseTo(6 + 0.4 - 0.15, 2);
    expect(comp.duration).toBeGreaterThanOrEqual(2);
    expect(comp.duration).toBeLessThanOrEqual(5);
    // Never reuse a shot.
    const ids = props.filter((p) => p.pick).map((p) => p.pick!.shot.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is deterministic whatever the library order", () => {
    const a = rankBroll(phrasesFromTranscript(t), library).map((p) => [p.at, p.pick?.shot.id, p.pick?.confidence]);
    const b = rankBroll(phrasesFromTranscript(t), [...library].reverse()).map((p) => [p.at, p.pick?.shot.id, p.pick?.confidence]);
    expect(b).toEqual(a);
  });
});

describe("match cuts", () => {
  const grid = (cx: number, cy: number) => Array.from({ length: 64 }, (_, i) => Math.exp(-(((i % 8) - cx) ** 2 + (Math.floor(i / 8) - cy) ** 2) / 2));
  const edges = (seed: number) => {
    const r = lcg(seed);
    return Array.from({ length: 64 }, () => 3 + r() * 10);
  };
  it("prefers pairs with the subject in the same place and the same motion", () => {
    const a = fakeShot("a#1", { reps: [{ t: 5, frame: 125, thumb: "/a.jpg", sal: grid(2, 3), edges: edges(1) }], tailMotion: { dx: 0.3, dy: 0 } });
    const b = fakeShot("b#1", { reps: [{ t: 1, frame: 25, thumb: "/b.jpg", sal: grid(2, 3), edges: edges(1) }], headMotion: { dx: 0.25, dy: 0 } });
    const c = fakeShot("c#1", { reps: [{ t: 1, frame: 25, thumb: "/c.jpg", sal: grid(6, 1), edges: edges(9) }], headMotion: { dx: -0.3, dy: 0 } });
    const blank = fakeShot("d#1", { reps: [{ t: 1, frame: 25, thumb: "/d.jpg", sal: grid(2, 3), edges: new Array(64).fill(0.1) }] });
    const m = findMatchCuts([a, b, c, blank], { minScore: 0.3 });
    expect(m[0].a.id).toBe("a#1");
    expect(m[0].b.id).toBe("b#1");
    expect(m[0].kind).toBe("motion");
    expect(m.some((x) => x.b.id === "d#1" || x.a.id === "d#1")).toBe(false);
    expect(gridCorrelation(grid(2, 3), grid(2, 3))).toBeCloseTo(1, 5);
    expect(motionAgreement({ dx: 1, dy: 0 }, { dx: -1, dy: 0 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("audio sync maths", () => {
  it("FFT round-trips", () => {
    const re = Float64Array.from({ length: 16 }, (_, i) => Math.sin(i));
    const im = new Float64Array(16);
    const orig = [...re];
    fft(re, im);
    fft(re, im, true);
    re.forEach((v, i) => expect(v).toBeCloseTo(orig[i], 9));
  });
  it("finds a known offset to the sample despite gain and noise", () => {
    const rnd = lcg(3);
    const n = SYNC_RATE * 40;
    const master = new Float32Array(n);
    // Bursts of noise (speech-like onsets).
    for (let k = 0; k < 60; k++) {
      const at = Math.floor(rnd() * (n - 4000));
      const len = 800 + Math.floor(rnd() * 3000);
      for (let i = 0; i < len; i++) master[at + i] += (rnd() - 0.5) * Math.exp(-i / 1500);
    }
    const lag = 12345; // b starts 12345 samples into a
    const b = new Float32Array(n - lag);
    for (let i = 0; i < b.length; i++) b[i] = master[i + lag] * 0.3 + (rnd() - 0.5) * 0.01;
    const r = syncSignals(master, b);
    expect(Math.abs(r.offset - lag / SYNC_RATE)).toBeLessThan(0.5 / SYNC_RATE + 1e-6);
    expect(r.confidence).toBeGreaterThan(0.5);
    expect(refineLag(master, b, lag + 3, 6).lag).toBeCloseTo(lag, 0);
  });
});

describe.skipIf(!hasFfmpeg() || !existsSync(ABC))("multicam on synthetic angles", () => {
  const specs = [
    { start: 30, duration: 100, vf: "scale=1280:720", gainDb: 0, noise: 0.01 },
    { start: 31.37, duration: 100, vf: "crop=iw*0.45:ih*0.6:iw*0.25:ih*0.05,scale=1280:720,hflip", gainDb: -9, noise: 0.03 },
    { start: 0, duration: 75, vf: "crop=iw*0.7:ih*0.7:iw*0.1:ih*0.1,scale=1280:720", gainDb: 6, noise: 0.02 },
  ];
  let files: string[] = [];
  let dir = "";

  it("syncs angles to within one frame", async () => {
    dir = workDir("angles");
    dirs.push(dir);
    files = buildAngles(dir, ABC, specs);
    const r = await syncAngles(files);
    r.forEach((s, i) => {
      const truth = specs[i].start - specs[0].start;
      const errFrames = Math.abs(s.offset - truth) * 25;
      console.log(`angle ${i + 1}: offset ${s.offset} (truth ${truth}), error ${errFrames.toFixed(3)} frames, confidence ${s.confidence}`);
      expect(errFrames).toBeLessThan(1);
      expect(s.confidence).toBeGreaterThan(0.5);
    });
  }, 300_000);

  it("renders a multi-source edit with the right length and pictures", async () => {
    const edit: MultiTrackEdit = {
      sources: files.map((p) => ({ path: p })),
      segments: [
        { source: 0, srcIn: 5, srcOut: 8, recIn: 0, recOut: 3 },
        { source: 1, srcIn: 6.63, srcOut: 9.63, recIn: 3, recOut: 6 },
        { source: 2, srcIn: 41, srcOut: 43, recIn: 6, recOut: 8 },
      ],
      audio: [{ source: 0, srcIn: 5, srcOut: 13, recIn: 0 }],
      width: 640,
      height: 360,
      fps: 25,
    };
    expect(checkEdit(edit)).toEqual([]);
    const out = join(dir, "multi.mp4");
    const r = await renderMultiEdit(edit, out, { quality: "draft", captions: [{ start: 1, end: 2, text: "hi" }] });
    expect(r.duration).toBe(8);
    const { probe } = await import("../src/engine/media.js");
    const info = await probe(out);
    expect(Math.abs(info.duration - 8)).toBeLessThan(0.15);
    expect(info.width).toBe(640);
    expect(existsSync(r.srt!)).toBe(true);
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------

describe("multicam switching rules", () => {
  const dt = 0.2;
  /** Two people (angles 1, 2 close) + a wide (angle 0). Turns: [person, start, end]. */
  function input(turns: [number, number, number][], end: number, sentenceEnds: number[] = []) {
    const n = Math.round(end / dt);
    const activity = [0, 1].map((p) => Array.from({ length: n }, (_, k) => (turns.some(([q, s, e]) => q === p && k * dt >= s && k * dt < e) ? 0.9 : 0.05)));
    const speech = Array.from({ length: n }, (_, k) => turns.some(([, s, e]) => k * dt >= s && k * dt < e));
    return {
      angles: [
        { index: 0, role: "wide" as const, faceH: 0.1, offset: 0, duration: end },
        { index: 1, role: "close" as const, person: 0, faceH: 0.4, offset: 0, duration: end },
        { index: 2, role: "close" as const, person: 1, faceH: 0.4, offset: 0, duration: end },
      ],
      dt,
      t0: 0,
      speech,
      activity,
      sentenceEnds,
      start: 0,
      end,
    };
  }
  const minShot = 1.8;

  it("opens wide, cuts to each speaker near their first word, respects the minimum shot", () => {
    const d = planMulticam(input([[0, 1, 10], [1, 10.6, 20], [0, 20.5, 30]], 30), { minShot });
    expect(d[0].angle).toBe(0);
    expect(d.find((x) => x.angle === 2)!.start).toBeGreaterThan(10.2);
    expect(d.find((x) => x.angle === 2)!.start).toBeLessThan(10.7);
    for (const x of d) expect(x.end - x.start).toBeGreaterThanOrEqual(minShot - 1e-6);
    expect(d[d.length - 1].end).toBe(30);
    for (let i = 1; i < d.length; i++) expect(d[i].start).toBeCloseTo(d[i - 1].end, 6);
  });

  it("stays wide on a quick exchange instead of ping-ponging", () => {
    const d = planMulticam(input([[0, 1, 8], [1, 8.4, 9.8], [0, 10, 11.5], [1, 11.8, 13], [0, 13.3, 25]], 25), { minShot });
    const mid = d.filter((x) => x.start < 13 && x.end > 9);
    expect(mid.some((x) => x.angle === 0)).toBe(true);
    // No shot shorter than minShot anywhere.
    for (const x of d) expect(x.end - x.start).toBeGreaterThanOrEqual(minShot - 1e-6);
  });

  it("cuts to a listener reaction or the wide during a long answer, at a sentence end", () => {
    const ends = [5, 12, 18, 23.5, 27, 33, 39, 44];
    const d = planMulticam(input([[0, 1, 50]], 50, ends), { minShot, maxCloseRun: 20 });
    const inserts = d.filter((x) => x.angle !== 1 && x.start > 5);
    expect(inserts.length).toBeGreaterThan(0);
    for (const x of inserts) expect(ends.some((e) => Math.abs(e - x.start) < 1e-6)).toBe(true);
    expect(inserts.some((x) => x.angle === 2 && /reaction/.test(x.why))).toBe(true);
  });

  it("speaker track removes blips shorter than a turn", () => {
    const inp = input([[0, 0, 5], [1, 5, 5.4], [0, 5.4, 10]], 10);
    const tr = speakerTrack(inp, { minTurn: 0.8 });
    expect(tr.every((p) => p === 0 || p === -1)).toBe(true);
  });

  it("remaps captions and writes valid multi-source interchange", () => {
    const edit: MultiTrackEdit = {
      sources: [{ path: "/m/a.mov" }, { path: "/m/b.mov" }],
      segments: [
        { source: 0, srcIn: 10, srcOut: 14, recIn: 0, recOut: 4 },
        { source: 1, srcIn: 12.5, srcOut: 16.02, recIn: 4, recOut: 7.52 },
      ],
      audio: [{ source: 0, srcIn: 10, srcOut: 17.52, recIn: 0 }],
      fps: 25,
      width: 1920,
      height: 1080,
    };
    const cues = remapCaptions([{ start: 9, end: 11, text: "a" }, { start: 12, end: 13, text: "b" }, { start: 30, end: 31, text: "c" }], edit);
    expect(cues.map((c) => [c.start, c.end, c.text])).toEqual([[0, 1, "a"], [2, 3, "b"]]);
    const snapped = snapMulti(edit, frameRate(25));
    expect(snapped.video.map((v) => [v.recIn, v.recOut])).toEqual([[0, 100], [100, 188]]);
    const info = [{ hasAudio: true, hasVideo: true, fps: 25 }, { hasAudio: true, hasVideo: true, fps: 25 }];
    const x7 = multiToFCP7({ edit, info });
    expect((x7.match(/<clipitem /g) ?? []).length).toBe(2 + 2);
    expect(x7).toContain("file://localhost/m/b.mov");
    const fx = multiToFCPXML({ edit, info });
    expect(fx).toContain('srcEnable="video"');
    expect(fx).toContain('lane="-1"');
  });
});
