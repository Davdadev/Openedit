// Rhythm: beat tracking, music fitting, beat snapping, J/L split edits, speed ramps, montage grid.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beatF, detectClaps, detectFlashes, makeClapFlash, synthSong, toM4a, writeWav } from "./rhythm-fixtures.js";

const TMP = resolve(process.env.RHYTHM_TMP ?? "test/.tmp-rhythm");
process.env.OPENEDIT_HOME = join(TMP, "home");

const { analyzeSamples, detectBeats, fitGrid } = await import("../src/engine/beats.js");
const { fitMusic, renderFittedMusic, snapPlanToBeats, planJoins, planMontage, montageGrid, alignment } = await import("../src/engine/music.js");
const S = await import("../src/engine/speed.js");
const { splitRanges, normalizeSplits, autoSplits, splitCounts } = await import("../src/engine/jl.js");
const { mapTime, unmapTime, editDuration } = await import("../src/engine/remap.js");
const { renderCutPlan } = await import("../src/engine/render.js");
const { buildInterchange } = await import("../src/engine/interchange.js");
const { rhythmStats, rhythmWarnings } = await import("../src/engine/review-rhythm.js");
const { probe } = await import("../src/engine/media.js");
type CutPlan = import("../src/hosts/types.js").CutPlan;
type Transcript = import("../src/hosts/types.js").Transcript;

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

beforeAll(() => mkdirSync(TMP, { recursive: true }));
afterAll(() => {
  if (!process.env.KEEP_TMP) rmSync(TMP, { recursive: true, force: true });
});

describe("beat tracking (synthetic, exact ground truth)", () => {
  const cases: [number, number][] = [
    [120, 0.5],
    [128, 0.5],
    [90, 0.5],
    [90, 0.62],
    [140, 0.6],
  ];
  it.each(cases)("%d BPM swing %s: tempo within 1%%, beat F >= 0.9 at ±70 ms, downbeats", (bpm, swing) => {
    const s = synthSong({ bpm, swing, bars: 16 });
    const a = analyzeSamples(s.samples, s.sr);
    expect(Math.abs(a.tempo - bpm) / bpm).toBeLessThan(0.01);
    expect(beatF(a.beats, s.beats).f).toBeGreaterThanOrEqual(0.9);
    expect(beatF(a.beats, s.beats, 0.01).f).toBeGreaterThanOrEqual(0.9); // transient-refined: ±10 ms
    expect(a.meter).toBe(4);
    expect(beatF(a.downbeats, s.downbeats).f).toBeGreaterThanOrEqual(0.9);
  });

  it("detects 3/4", () => {
    const s = synthSong({ bpm: 100, meter: 3, bars: 16 });
    const a = analyzeSamples(s.samples, s.sr);
    expect(a.meter).toBe(3);
    expect(beatF(a.downbeats, s.downbeats).f).toBeGreaterThanOrEqual(0.9);
  });

  it("finds section changes and labels a breakdown", () => {
    const s = synthSong({
      bpm: 124,
      parts: [
        { bars: 4, level: 0.5, kick: false, snare: false },
        { bars: 8, level: 0.6 },
        { bars: 4, level: 0.7, roll: true },
        { bars: 8, level: 1 },
        { bars: 4, level: 0.35, kick: false, snare: false, hats: false },
        { bars: 4, level: 0.8 },
      ],
    });
    const a = analyzeSamples(s.samples, s.sr);
    const starts = a.sections.map((x) => x.start);
    const bar = (60 / 124) * 4;
    for (const want of [s.partStarts[1], s.partStarts[4], s.partStarts[5]]) expect(starts.some((t) => Math.abs(t - want) < bar * 1.01)).toBe(true);
    expect(a.sections.some((x) => x.kind === "breakdown")).toBe(true);
    expect(Math.abs(a.ending.finalDownbeat - s.downbeats[s.downbeats.length - 1])).toBeLessThan(0.05);
  });

  it.skipIf(!hasFfmpeg)("decodes a real file (AAC) and caches the analysis", async () => {
    const s = synthSong({ bpm: 128, bars: 12 });
    const m4a = toM4a(writeWav(join(TMP, "s128.wav"), s.samples, s.sr), join(TMP, "s128.m4a"));
    const a = await detectBeats(m4a);
    expect(Math.abs(a.tempo - 128)).toBeLessThan(1.28);
    // AAC adds encoder priming; beats stay within a few ms of the truth.
    expect(beatF(a.beats, s.beats, 0.03).f).toBeGreaterThanOrEqual(0.9);
    expect((await detectBeats(m4a)).beats).toEqual(a.beats);
  });
});

describe("fit_music", () => {
  const s = synthSong({ bpm: 120, bars: 32, tail: 2.5 });
  const a = analyzeSamples(s.samples, s.sr, { path: join(TMP, "fit.wav") });
  const onDownbeat = (t: number) => a.downbeats.some((d) => Math.abs(d - t) < 0.01);

  it("shortens on bar lines, keeps the ending", () => {
    const fit = fitMusic(a, 30, { fps: 25 });
    expect(fit.edits.length).toBe(1);
    for (const e of fit.edits) {
      expect(onDownbeat(e.from)).toBe(true);
      expect(onDownbeat(e.to)).toBe(true);
      expect(Math.abs(e.bars) % 2).toBe(0);
    }
    // The song's last segment runs to its natural end.
    expect(fit.segments.at(-1)!.out).toBeGreaterThan(a.ending.finalDownbeat + 1);
    expect(fit.endsOn).toBeLessThan(30);
    expect(fit.endsOn).toBeGreaterThan(30 - 4);
    // Mapped downbeats keep the bar spacing across the edit (no half-bar hiccup).
    const gaps = fit.downbeats.slice(1).map((d, i) => d - fit.downbeats[i]);
    for (const g of gaps) expect(Math.abs(g - 2)).toBeLessThan(0.03);
  });

  it("extends by repeating whole phrases", () => {
    const fit = fitMusic(a, 100, { fps: 25 });
    expect(fit.edits.length).toBeGreaterThanOrEqual(1);
    for (const e of fit.edits) expect(Math.abs(e.bars) % 4).toBe(0);
    expect(fit.joinedLength).toBeGreaterThan(95);
  });

  it.skipIf(!hasFfmpeg)("renders exactly the target length (within one frame)", async () => {
    const wav = writeWav(join(TMP, "fit.wav"), s.samples, s.sr);
    const fit = fitMusic({ ...a, path: wav }, 23.4, { fps: 25 });
    const out = await renderFittedMusic(fit, join(TMP, "fit-out.wav"));
    expect(Math.abs((await probe(out)).duration - 23.4)).toBeLessThanOrEqual(1 / 25);
  });
});

describe("snap_to_beats (dialogue)", () => {
  const w = (text: string, start: number, end: number) => ({ text, start, end });
  const transcript: Transcript = {
    language: "en",
    duration: 20,
    segments: [
      { text: "", start: 0, end: 20, words: [w("Hello", 0.3, 0.7), w("there.", 0.75, 1.2), w("um", 1.9, 2.1), w("This", 2.9, 3.1), w("works.", 3.15, 3.6), w("Next", 5.0, 5.3), w("line.", 5.35, 5.8)] },
    ],
  };
  const plan: CutPlan = { source: "/x.mp4", duration: 20, keep: [{ start: 0.1, end: 1.45 }, { start: 2.7, end: 3.85 }, { start: 4.83, end: 6.2 }], cuts: [] };

  it("moves joins onto beats inside pauses, never into words", () => {
    const beats = Array.from({ length: 40 }, (_, i) => i * 0.5);
    const { plan: out, report } = snapPlanToBeats(plan, beats, { transcript, fps: 25 });
    expect(report.alignedAfter).toBeGreaterThan(report.alignedBefore);
    for (const j of planJoins(out)) expect(beats.some((b) => Math.abs(b - j) < 0.021)).toBe(true);
    const words = transcript.segments[0].words;
    for (const k of out.keep) for (const wd of words) {
      expect(k.start <= wd.start - 0.05 || k.start >= wd.end).toBe(true);
      expect(k.end >= wd.end + 0.05 || k.end <= wd.start).toBe(true);
    }
    // The removed "um" (1.9-2.1) never comes back.
    expect(out.keep.some((k) => k.start < 2.0 && k.end > 2.0)).toBe(false);
  });

  it("leaves a join alone when the beat is too far or the move would cut a word", () => {
    const beats = [0, 1.62 + 0.3, 5]; // join 0 at 1.35: nearest beat 0.57 s away
    const { report } = snapPlanToBeats(plan, beats, { transcript, fps: 25 });
    expect(report.moved.find((m) => m.index === 0)).toBeUndefined();
    expect(report.skipped.length).toBeGreaterThan(0);
  });
});

describe("speed ramps: time map", () => {
  const base: CutPlan = { source: "/x.mp4", duration: 30, keep: [{ start: 0, end: 10 }, { start: 12, end: 20 }], cuts: [] };

  it("constant slow motion doubles the range and shifts later times", () => {
    const p = { ...base, ramps: [{ start: 2, end: 4, speed: 0.5 }] };
    expect(editDuration(p)).toBeCloseTo(20, 6);
    expect(mapTime(p, 3)).toBeCloseTo(4, 6);
    expect(mapTime(p, 5)).toBeCloseTo(7, 6);
    expect(mapTime(p, 13)).toBeCloseTo(13, 6);
    expect(mapTime(p, 11)).toBeNull();
  });

  it("eased ramps integrate 1/speed exactly and map / unmap are inverse", () => {
    const r = { start: 1, end: 3, from: 1, to: 0.25, curve: "ease-in-out" as const };
    const p = { ...base, ramps: [r] };
    let integral = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) integral += (2 / N) / S.rampSpeedAt(r, (i + 0.5) / N);
    expect(editDuration(p) - 16).toBeCloseTo(integral, 3);
    for (const s of [0.5, 1.2, 1.9, 2.6, 2.999, 7, 15]) expect(unmapTime(p, mapTime(p, s)!)).toBeCloseTo(s, 6);
    // Monotone.
    let prev = -1;
    for (let s = 0; s < 10; s += 0.01) {
      const t = mapTime(p, s)!;
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it("freeze frames and reverse", () => {
    const p = { ...base, freezes: [{ at: 5, duration: 1.5 }], ramps: [{ start: 14, end: 16, reverse: true }] };
    expect(editDuration(p)).toBeCloseTo(19.5, 6);
    expect(mapTime(p, 6)).toBeCloseTo(7.5, 6);
    expect(unmapTime(p, 5.7)).toBeCloseTo(5, 6);
    // Reverse: source 14 shows at the END of the reversed piece.
    const startRev = 10 + 1.5 + 2;
    expect(mapTime(p, 15.5)).toBeCloseTo(startRev + 0.5, 6);
  });

  it("remaps later edit-time items through a new ramp", () => {
    const after = { ...base, ramps: [{ start: 2, end: 4, speed: 0.5 }] };
    expect(S.remapEditTime(base, after, 15)).toBeCloseTo(17, 6);
    expect(S.remapEditTime(base, after, 1)).toBeCloseTo(1, 6);
  });

  it("setpts expression is continuous at step boundaries", () => {
    const steps = S.rampSteps({ start: 0, end: 1, from: 1, to: 0.2, curve: "ease-in" }, 0, 1, 30);
    const f = (T: number) => steps.reduce((a, st) => a + Math.min(Math.max(T - st.s0, 0), st.s1 - st.s0) / st.v, 0);
    for (const st of steps) expect(f(st.s1 - 1e-9)).toBeCloseTo(f(st.s1 + 1e-9), 6);
    expect(S.setptsExpression(steps, 0)).toMatch(/^\(clip\(T-0,0,/);
    expect(S.atempoChain(0.2)).toBe("atempo=0.5,atempo=0.5,atempo=0.8");
  });

  it("sanity flags jumps, stutters and unblended slow motion", () => {
    const bad = { ...base, ramps: [{ start: 1, end: 1.05, speed: 0.1 }, { start: 3, end: 3.1, speed: 2 }] };
    const r = S.rampSanity(bad, 25);
    expect(r.maxJump).toBeGreaterThan(8);
    expect(r.warnings.join(" ")).toMatch(/jumps/);
    expect(r.warnings.join(" ")).toMatch(/stutter/);
    expect(r.warnings.join(" ")).toMatch(/blend/);
    expect(S.retimingProblems({ ...base, ramps: [{ start: 9, end: 13, speed: 2 }] }).join(" ")).toMatch(/not inside one kept range/);
  });
});

describe("J / L split edits", () => {
  const plan: CutPlan = { source: "/x.mp4", duration: 30, keep: [{ start: 1, end: 5 }, { start: 8, end: 12 }, { start: 15, end: 20 }], cuts: [] };

  it("moves the sound edit and keeps sync and duration", () => {
    const p = { ...plan, splits: [{ index: 0, type: "J" as const, seconds: 0.5 }, { index: 1, type: "L" as const, seconds: 0.8 }] };
    const { video, audio } = splitRanges(p);
    expect(video).toEqual(plan.keep);
    expect(audio[0]).toEqual({ start: 1, end: 4.5 });
    expect(audio[1]).toEqual({ start: 7.5, end: 12.8 });
    expect(audio[2]).toEqual({ start: 15.8, end: 20 });
    const len = (r: { start: number; end: number }[]) => r.reduce((a, x) => a + x.end - x.start, 0);
    expect(len(audio)).toBeCloseTo(len(video), 9);
    // Sync: picture piece i and sound piece i put source time s at the same edit time.
    let accV = 0;
    let accA = 0;
    video.forEach((v, i) => {
      const s = (v.start + v.end) / 2;
      expect(accV + (s - v.start)).toBeCloseTo(accA + (s - audio[i].start), 9);
      accV += v.end - v.start;
      accA += audio[i].end - audio[i].start;
    });
    expect(splitCounts(p)).toEqual({ J: 1, L: 1, meanSeconds: 0.65 });
  });

  it("clamps to handles and piece lengths", () => {
    const { splits, notes } = normalizeSplits({ ...plan, keep: [{ start: 0.2, end: 5 }, { start: 5.3, end: 5.5 }] }, [{ index: 0, type: "L", seconds: 1 }, { index: 3, type: "L", seconds: 1 }]);
    expect(splits[0].seconds).toBeLessThanOrEqual(0.1 + 1e-9); // B's sound must keep >= 0.1 s
    expect(notes.join(" ")).toMatch(/no such join/);
  });

  it("auto: breath pre-lap at a sentence boundary only, never bringing back removed words", () => {
    const tr: Transcript = {
      language: "en",
      duration: 30,
      segments: [{ text: "", start: 0, end: 30, words: [
        { text: "First", start: 1.2, end: 1.6 }, { text: "point.", start: 1.7, end: 4.4 },
        { text: "um", start: 6, end: 6.3 },
        { text: "Second", start: 8.2, end: 8.6 }, { text: "and", start: 8.7, end: 11.6 },
        { text: "third", start: 15.3, end: 19 },
      ] }],
    };
    const auto = autoSplits(plan, tr, { minSpacing: 0 });
    expect(auto.map((a) => a.index)).toEqual([0]);
    expect(auto[0].type).toBe("J");
    expect(auto[0].seconds).toBeLessThanOrEqual(0.5); // 3 s removed: a transition lead
    expect(8 - auto[0].seconds).toBeGreaterThan(6.3); // the removed "um" stays out
  });

  it("exports linked clips with different audio / video in-out (FCP7) and audioStart (FCPXML)", () => {
    const p = { ...plan, splits: [{ index: 0, type: "J" as const, seconds: 0.4 }] };
    const info = { path: "/x.mp4", duration: 30, width: 1920, height: 1080, fps: 25, hasAudio: true, hasVideo: true };
    const xml = buildInterchange("fcp7", { plan: p, info, source: { audioChannels: 2 } });
    const items = [...xml.matchAll(/<clipitem id="(clipitem-\d+)">[\s\S]*?<start>(\d+)<\/start>\s*<end>(\d+)<\/end>\s*<in>(\d+)<\/in>\s*<out>(\d+)<\/out>[\s\S]*?<mediatype>(video|audio)<\/mediatype>/g)];
    const v1 = items.find((m) => m[6] === "video" && m[4] === "200")!;
    const a1 = items.filter((m) => m[6] === "audio" && m[4] === "190");
    expect(v1[2]).toBe("100");
    expect(a1.length).toBe(2);
    expect(a1[0][2]).toBe("90"); // sound of clip 2 starts 10 frames before its picture
    const fx = buildInterchange("fcpxml", { plan: p, info, source: { audioChannels: 2 } });
    expect(fx).toMatch(/audioStart="38\/5s" audioDuration="22\/5s"/);
  });
});

describe("retimed interchange", () => {
  it("writes Time Remap (FCP7), timeMap (FCPXML) and M2 (EDL)", () => {
    const plan: CutPlan = { source: "/x.mp4", duration: 30, keep: [{ start: 0, end: 10 }], cuts: [], ramps: [{ start: 2, end: 4, speed: 0.5 }], freezes: [{ at: 6, duration: 1 }] };
    const info = { path: "/x.mp4", duration: 30, width: 1920, height: 1080, fps: 25, hasAudio: true, hasVideo: true };
    const x7 = buildInterchange("fcp7", { plan, info });
    expect(x7).toMatch(/<effectid>timeremap<\/effectid>/);
    expect(x7).toMatch(/<value>50<\/value>/);
    const fx = buildInterchange("fcpxml", { plan, info });
    expect(fx).toMatch(/<timeMap>/);
    expect(fx).toMatch(/duration="13s"|duration="1s"/);
    expect(buildInterchange("edl", { plan, info })).toMatch(/^M2 /m);
  });
});

describe.skipIf(!hasFfmpeg)("render: clap + flash sync through J/L cuts, a freeze and a ramp", () => {
  it("every clap stays on its flash; split sound lands where planned", async () => {
    const src = join(TMP, "clapflash.mp4");
    const ev = makeClapFlash(src, { duration: 12, events: [0.6, 1.4, 2.2, 3.0, 3.8, 4.6, 5.4, 6.2, 7.0, 7.8, 8.6, 9.4, 10.2, 11.0] });
    const plan: CutPlan = {
      source: src,
      duration: 12,
      keep: [{ start: 0.2, end: 2.5 }, { start: 3.3, end: 6.5 }, { start: 7.4, end: 11.6 }],
      cuts: [],
      splits: [{ index: 0, type: "J", seconds: 0.5 }, { index: 1, type: "L", seconds: 0.6 }],
      ramps: [{ start: 8.2, end: 9.8, from: 1, to: 0.25, curve: "ease-in-out", audio: "pitch" }],
      freezes: [{ at: 4.6, duration: 0.8 }],
    };
    const out = join(TMP, "sync.mp4");
    const r = await renderCutPlan(plan, out, { edgeFade: 0, crossfade: 0 });
    const p = await probe(out);
    expect(Math.abs(p.duration - r.duration)).toBeLessThan(0.05);
    const flashes = detectFlashes(out, 25);
    const claps = detectClaps(out);
    const near = (xs: number[], t: number, tol: number) => xs.some((x) => Math.abs(x - t) <= tol);
    const { audio } = splitRanges(plan);
    for (const s of ev) {
      const t = mapTime(plan, s);
      if (t === null) continue;
      expect(near(flashes, t, 0.041), `flash of source ${s}s at ${t}`).toBe(true);
    }
    // Sound: plain pieces within one frame; the time-stretched ramp within 80 ms.
    expect(near(claps, 0.4, 0.041)).toBe(true);
    expect(near(claps, 2.8, 0.041)).toBe(true);
    // L-cut: source 7.0 (cut from the picture) is heard 0.5 s after the picture cut at 6.3.
    expect(audio[1].end).toBeCloseTo(7.1, 6);
    expect(near(claps, 6.8, 0.041)).toBe(true);
    // J-cut: source 3.0 (before keep 2's picture) is heard at 2.0, under keep 1's picture.
    expect(near(claps, 2.0, 0.041)).toBe(true);
    // Freeze: the clap of the frozen frame plays when the picture moves again (4.4).
    expect(near(claps, 4.4, 0.041)).toBe(true);
    expect(near(claps, mapTime(plan, 9.4)!, 0.08)).toBe(true);
    expect(near(claps, mapTime(plan, 11.0)!, 0.041)).toBe(true);
    // Nothing from the J-trimmed tail of keep 1 (source 2.2 sound) or the L-trimmed head of keep 3 (7.8).
    expect(claps.filter((c) => Math.abs(c - 6.7) < 0.03).length).toBe(0);
  });
});

describe("montage grid and review", () => {
  const s = synthSong({ bpm: 120, bars: 24, tail: 2, parts: [{ bars: 8, level: 0.6 }, { bars: 8, level: 1 }, { bars: 8, level: 0.7 }] });
  const a = analyzeSamples(s.samples, s.sr, { path: "/song.wav" });
  const fit = fitMusic(a, 30, { fps: 25, energyWeight: 2 });

  it("cuts on downbeats, holds the last shot, frame-quantised", () => {
    const clips = ["/a.mp4", "/b.mp4", "/c.mp4"].map((p) => ({ path: p, duration: 12 }));
    const m = planMontage(clips, fit, "downbeats", { fps: 25 });
    expect(m.cuts.length).toBeGreaterThan(5);
    expect(alignment(m.cuts, fit.beats, 0.041)).toBe(1);
    for (const sh of m.shots) expect(sh.duration).toBeGreaterThanOrEqual(0.45);
    expect(m.duration - m.shots.at(-1)!.at).toBeGreaterThanOrEqual(0.8);
    for (const c of m.cuts) expect(Math.abs(c * 25 - Math.round(c * 25))).toBeLessThan(1e-6);
    // Consecutive shots never reuse the same clip.
    for (let i = 1; i < m.shots.length; i++) expect(m.shots[i].path).not.toBe(m.shots[i - 1].path);
    const st = rhythmStats(m.cuts, { music: { beats: fit.beats, downbeats: fit.downbeats }, fps: 25 });
    expect(st.beatAligned).toBe(1);
    expect(rhythmWarnings(st)).toEqual([]);
  });

  it("on-beat cuts faster than phrase", () => {
    expect(montageGrid(fit, "on-beat").length).toBeGreaterThan(montageGrid(fit, "phrase").length * 3);
  });

  it("review flags off-beat and late cuts", () => {
    const late = fit.downbeats.slice(1, 8).map((d) => d + 0.12);
    const st = rhythmStats(late, { music: { beats: fit.beats, downbeats: fit.downbeats }, fps: 25 });
    expect(st.lateCuts.length).toBe(7);
    expect(rhythmWarnings(st).join(" ")).toMatch(/AFTER the beat/);
    expect(fitGrid([0, 0.5, 1, 1.5]).T).toBeCloseTo(0.5, 9);
  });
});
