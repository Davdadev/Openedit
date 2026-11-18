import { describe, expect, it } from "vitest";
import { assTime, cuesFromTranscript, srtTime, toASS, toSRT, toVTT } from "../src/engine/captions.js";
import { buildCutPlan, detectFillers, detectRetakes, invertRanges, mergeCuts, summarizePlan } from "../src/engine/cutplan.js";
import { editDuration, mapRange, mapTime, unmapTime } from "../src/engine/remap.js";
import { buildRenderGraph, reframeSize, zoomExpression } from "../src/engine/render.js";
import { parseSilenceDetect } from "../src/engine/silence.js";
import { parseWhisperJson, refineWords, transcriptToText } from "../src/engine/transcribe.js";
import type { CutPlan, Transcript, Word } from "../src/hosts/types.js";

/** Build a transcript from "word@start-end" tokens; a token ending in "|" closes the segment. */
function tr(spec: string, duration = 60): Transcript {
  const segments: Transcript["segments"] = [];
  let words: Word[] = [];
  for (const tok of spec.trim().split(/\s+/)) {
    const close = tok.endsWith("|");
    const m = /^(.+)@([\d.]+)-([\d.]+)\|?$/.exec(tok);
    if (!m) throw new Error(`bad token ${tok}`);
    words.push({ text: m[1], start: Number(m[2]), end: Number(m[3]) });
    if (close) {
      segments.push({ text: words.map((w) => w.text).join(" "), start: words[0].start, end: words.at(-1)!.end, words });
      words = [];
    }
  }
  if (words.length) segments.push({ text: words.map((w) => w.text).join(" "), start: words[0].start, end: words.at(-1)!.end, words });
  return { language: "en", duration, segments };
}

describe("silence parsing", () => {
  it("parses silencedetect output including a trailing open silence", () => {
    const log = `
[silencedetect @ 0x1] silence_start: 0
[silencedetect @ 0x1] silence_end: 0.512 | silence_duration: 0.512
size=N/A time=00:00:03.00
[silencedetect @ 0x1] silence_start: 1.25
[silencedetect @ 0x1] silence_end: 2.75 | silence_duration: 1.5
[silencedetect @ 0x1] silence_start: 9.1`;
    expect(parseSilenceDetect(log, 10)).toEqual([
      { start: 0, end: 0.512 },
      { start: 1.25, end: 2.75 },
      { start: 9.1, end: 10 },
    ]);
  });
});

describe("cut merging", () => {
  it("merges overlapping and touching cuts, keeping the dominant reason", () => {
    const merged = mergeCuts([
      { start: 5, end: 6, reason: "filler", label: "um" },
      { start: 1, end: 2, reason: "silence" },
      { start: 1.5, end: 4, reason: "manual" },
      { start: 4, end: 4.5, reason: "silence" },
      { start: 8, end: 9, reason: "silence" },
    ]);
    expect(merged).toEqual([
      { start: 1, end: 4.5, reason: "manual" },
      { start: 5, end: 6, reason: "filler", label: "um" },
      { start: 8, end: 9, reason: "silence" },
    ]);
  });

  it("inverts cuts into keeps", () => {
    expect(invertRanges([{ start: 0, end: 1 }, { start: 3, end: 4 }], 5)).toEqual([
      { start: 1, end: 3 },
      { start: 4, end: 5 },
    ]);
  });
});

describe("buildCutPlan", () => {
  it("shortens pauses, merges short pieces instead of dropping them, and handles edges", () => {
    // Updated: the old behaviour DROPPED the 0.4 s piece between two pauses (it may hold speech).
    // Now the shorter adjacent pause is restored instead, and the last word gets a 0.45 s ring-out.
    const plan = buildCutPlan({
      source: "/x.mp4",
      duration: 10,
      silences: [
        { start: 0, end: 1 },
        { start: 3, end: 5 },
        { start: 5.2, end: 6 },
        { start: 9, end: 10 },
      ],
      padding: 0.1,
      minKeep: 0.5,
    });
    expect(plan.keep).toEqual([
      { start: 0.88, end: 3.1 },
      { start: 4.9, end: 9.45 },
    ]);
    expect(plan.cuts.map((c) => [c.start, c.end, c.reason])).toEqual([
      [0, 0.88, "silence"],
      [3.1, 4.9, "silence"],
      [9.45, 10, "silence"],
    ]);
    const sum = summarizePlan(plan);
    expect(sum.editedDuration).toBeCloseTo(6.77, 3);
    expect(sum.cutsByReason.silence.count).toBe(3);
  });

  it("removes hesitations, isolated phrase fillers and manual cuts, keeping a natural pause", () => {
    // Updated: "you know" now needs commas/pauses around it, and the cut keeps a short beat
    // around the removed words instead of butting the neighbours together.
    const t = tr("so@0-0.3 um@0.5-0.8 we,@1-1.2 you@1.5-1.6 know,@1.6-1.8 ship@2.2-2.5 it@2.5-2.7|", 3);
    expect(detectFillers(t, ["um", "you know"]).map((c) => c.label)).toEqual(["um", "you know"]);
    const plan = buildCutPlan({
      source: "/x.mp4",
      duration: 3,
      transcript: t,
      removeFillers: true,
      fillerWords: ["um", "you know"],
      manualCuts: [{ start: 2.85, end: 3, label: "tail" }],
      minKeep: 0.1,
    });
    expect(plan.keep).toEqual([
      { start: 0, end: 0.384 },
      { start: 0.898, end: 1.392 },
      { start: 2.072, end: 2.85 },
    ]);
    expect(plan.cuts.map((c) => c.reason)).toEqual(["filler", "filler", "manual"]);
    // The removed words are entirely inside cuts; kept words entirely inside keeps.
    for (const k of plan.keep) expect(k.end - k.start).toBeGreaterThan(0.3);
  });

  it("clips cuts to the media duration", () => {
    const plan = buildCutPlan({ source: "/x", duration: 5, manualCuts: [{ start: 4, end: 99 }] });
    expect(plan.keep).toEqual([{ start: 0, end: 4 }]);
  });
});

describe("detectRetakes", () => {
  it("cuts an abandoned sentence that is restarted", () => {
    const t = tr(
      "Hello@0-0.4 there.@0.4-0.8| This@2-2.2 is@2.2-2.3 a@2.3-2.4 test.@2.4-2.8| um@3.0-3.2 of@4-4.2 open@4.2-4.5 edit.@4.5-4.9| This@5.5-5.7 is@5.7-5.8 a@5.8-5.9 test@5.9-6.2 of@6.2-6.4 open@6.4-6.7 edit.@6.7-7|",
      8,
    );
    const cuts = detectRetakes(t);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({ start: 2, end: 5.5, reason: "retake" });
    expect(cuts[0].label).toContain("This is a test.");
  });

  it("handles short restarts and ignores repeats outside the window", () => {
    const t = tr("So@0-0.2 the@0.2-0.4 so@1-1.2 the@1.2-1.4 plan@1.4-2| we@30-30.2 did@30.2-30.4 it.@30.4-30.8| we@50-50.2 did@50.2-50.4 it.@50.4-50.8|", 60);
    const cuts = detectRetakes(t);
    expect(cuts.map((c) => [c.start, c.end])).toEqual([[0, 1]]);
  });
});

describe("remap", () => {
  const plan: CutPlan = {
    source: "/x",
    duration: 10,
    keep: [
      { start: 1, end: 3 },
      { start: 5, end: 6 },
      { start: 8, end: 10 },
    ],
    cuts: [],
  };
  it("maps source to edit time and back", () => {
    expect(editDuration(plan)).toBe(5);
    expect(mapTime(plan, 0.5)).toBeNull();
    expect(mapTime(plan, 1)).toBe(0);
    expect(mapTime(plan, 2.5)).toBe(1.5);
    expect(mapTime(plan, 4)).toBeNull();
    expect(mapTime(plan, 5.5)).toBe(2.5);
    expect(mapTime(plan, 9)).toBe(4);
    expect(unmapTime(plan, 0)).toBe(1);
    expect(unmapTime(plan, 2.5)).toBe(5.5);
    expect(unmapTime(plan, 4)).toBe(9);
    expect(unmapTime(plan, 6)).toBeNull();
    for (const e of [0.3, 1.9, 2.2, 3.7, 4.9]) expect(mapTime(plan, unmapTime(plan, e)!)).toBeCloseTo(e, 9);
  });
  it("splits ranges across cuts", () => {
    expect(mapRange(plan, { start: 2, end: 9 })).toEqual([
      { start: 1, end: 2 },
      { start: 2, end: 3 },
      { start: 3, end: 4 },
    ]);
  });
});

describe("captions", () => {
  const t = tr(
    "Hello@0-0.4 there.@0.4-0.8| This@2-2.2 is@2.2-2.3 a@2.3-2.4 really@2.4-2.8 long@2.8-3.1 sentence@3.1-3.6 that@3.6-3.8 keeps@3.8-4.1 going@4.1-4.5|",
    6,
  );
  it("groups words into cues by sentence, word count and gaps", () => {
    // Updated: the old output left "going" as an orphan cue and ended a cue on "that".
    const cues = cuesFromTranscript(t, { maxWords: 4 });
    expect(cues.map((c) => c.text)).toEqual(["Hello there.", "This is a really", "long sentence", "that keeps going"]);
    expect(cues[0].start).toBe(0);
    expect(cues[0].end).toBeLessThanOrEqual(cues[1].start);
    for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end);
  });
  it("remaps cues through a cut plan", () => {
    const plan = { keep: [{ start: 0, end: 0.9 }, { start: 1.9, end: 6 }] };
    const cues = cuesFromTranscript(t, { maxWords: 4, plan });
    expect(cues[1].text).toBe("This is a really");
    expect(cues[1].start).toBeCloseTo(0.9 + 0.1, 6);
    const dropped = cuesFromTranscript(t, { plan: { keep: [{ start: 1.9, end: 6 }] } });
    expect(dropped[0].text.startsWith("This")).toBe(true);
  });
  it("keeps a word whose timing spills into a silence cut but is mostly spoken in the kept part", () => {
    // "readable." 52.76–53.34 with a silence cut from 53.0: 0.24 s kept (41%) is still the spoken word.
    const s = tr("is@52.4-52.76 readable.@52.76-53.34| Diplomatic@53.54-54.54|", 60);
    const cues = cuesFromTranscript(s, { plan: { keep: [{ start: 50, end: 53 }, { start: 53.4, end: 60 }] } });
    expect(cues.map((c) => c.text)).toEqual(["is readable.", "Diplomatic"]);
  });
  it("formats SRT, VTT and ASS", () => {
    expect(srtTime(3723.456)).toBe("01:02:03,456");
    expect(assTime(3723.456)).toBe("1:02:03.46");
    const cues = [
      { start: 0, end: 1.5, text: "Hello there." },
      { start: 2, end: 3.25, text: "Second {line}", words: [{ text: "Second", start: 2, end: 2.5 }, { text: "{line}", start: 2.6, end: 3 }] },
    ];
    expect(toSRT(cues)).toBe("1\n00:00:00,000 --> 00:00:01,500\nHello there.\n\n2\n00:00:02,000 --> 00:00:03,250\nSecond {line}\n");
    expect(toVTT(cues).startsWith("WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello there.\n")).toBe(true);
    const ass = toASS(cues, { style: "bold-pop", width: 1080, height: 1920 });
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
    // bold-pop: one event per word, active word highlighted, braces escaped
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(events).toHaveLength(3);
    expect(events[2]).toContain("0:00:02.60,0:00:03.25");
    expect(events[2]).toContain("SECOND {\\c&H0000D4FF&\\fscx112\\fscy112}(LINE){\\r}");
    expect(toASS(cues, { style: "clean" })).toContain("Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,{\\fad(80,80)}Hello there.");
  });
});

describe("whisper JSON parsing", () => {
  it("merges sub-word tokens and drops special tokens", () => {
    const json = {
      result: { language: "en" },
      transcription: [
        {
          offsets: { from: 0, to: 2000 },
          text: " Hello OpenEdit.",
          tokens: [
            { text: "[_BEG_]", offsets: { from: 0, to: 0 }, p: 0.9 },
            { text: " Hello", offsets: { from: 100, to: 600 }, p: 0.8 },
            { text: " Open", offsets: { from: 700, to: 1000 }, p: 0.6 },
            { text: "Edit", offsets: { from: 1000, to: 1400 }, p: 1 },
            { text: ".", offsets: { from: 1400, to: 2000 }, p: 1 },
            { text: "[_TT_100]", offsets: { from: 2000, to: 2000 }, p: 0.1 },
          ],
        },
      ],
    };
    const t = parseWhisperJson(json, 2);
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0].words).toEqual([
      { text: "Hello", start: 0.1, end: 0.6, confidence: 0.8 },
      { text: "OpenEdit.", start: 0.7, end: 1.4, confidence: 0.867 },
    ]);
    expect(transcriptToText(t)).toBe("[00:00.1] Hello OpenEdit.");
  });
  it("trims words out of silences", () => {
    const t = tr("Hello@0.1-0.7 there@0.7-2.0|", 3);
    const r = refineWords(t, [{ start: 1.1, end: 2.4 }]);
    expect(r.segments[0].words[1]).toMatchObject({ start: 0.7, end: 1.1 });
    expect(r.segments[0].end).toBe(1.1);
  });
  it("moves words that whisper placed inside a pause onto the following speech", () => {
    const t = tr("This@6.1-6.58 is@6.7-6.8 it.@8.78-8.8| Goodbye.@9.08-9.7|", 10.5);
    const r = refineWords(t, [{ start: 5.67, end: 6.6 }, { start: 8.09, end: 9.75 }]);
    expect(r.segments[0].words[0]).toMatchObject({ start: 6.6, end: 6.7 });
    expect(r.segments[0].words[2]).toMatchObject({ start: 8.04, end: 8.09 });
    expect(r.segments[1].words[0]).toMatchObject({ start: 9.75, end: 10.15 });
  });
  it("uses DTW token times for word starts when whisper provides them", () => {
    const json = {
      transcription: [
        {
          offsets: { from: 71000, to: 73400 },
          text: " Imagine that this",
          tokens: [
            { text: " Imagine", offsets: { from: 71000, to: 71510 }, t_dtw: 7234 },
            { text: " that", offsets: { from: 71800, to: 71810 }, t_dtw: 7258 },
            { text: " this", offsets: { from: 71960, to: 72090 }, t_dtw: 7278 },
          ],
        },
      ],
    };
    const w = parseWhisperJson(json, 80).segments[0].words;
    expect(w.map((x) => [x.start, x.end])).toEqual([
      [72.34, 72.58],
      [72.58, 72.78],
      [72.78, 72.91],
    ]);
  });
  it("drops a hallucinated repeat that whisper collapsed to zero length", () => {
    const tok = (text: string, from: number, to: number) => ({ text, offsets: { from, to } });
    const json = {
      transcription: [
        {
          offsets: { from: 26900, to: 31000 },
          text: "",
          tokens: [
            tok(" Alert", 26900, 26970),
            tok(" empty", 28040, 29060),
            tok(" document.", 29060, 30440),
            tok(" Alert", 31000, 31000),
            tok(" empty", 31000, 31000),
            tok(" document.", 31000, 31000),
            tok(" Empty", 31000, 31120),
          ],
        },
      ],
    };
    const words = parseWhisperJson(json, 40).segments[0].words.map((w) => w.text);
    expect(words).toEqual(["Alert", "empty", "document.", "Empty"]);
  });
});

describe("render graph", () => {
  const info = { path: "/in.mp4", duration: 10, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true };
  const plan: CutPlan = { source: "/in.mp4", duration: 10, keep: [{ start: 0, end: 2 }, { start: 4, end: 7.5 }], cuts: [] };
  it("trims, crossfades audio and concatenates kept ranges", () => {
    const g = buildRenderGraph(plan, info, {});
    expect(g.graph).toContain("[0:v:0]trim=start=0:end=2,setpts=PTS-STARTPTS[v0]");
    expect(g.graph).toContain("[0:a:0]atrim=start=3.98:end=7.5,asetpts=PTS-STARTPTS,afade=t=out:st=3.51:d=0.01[a1]");
    expect(g.graph).toContain("[v0][v1]concat=n=2:v=1:a=0[vcat]");
    expect(g.graph).toContain("[a0][a1]acrossfade=d=0.04:c1=qsin:c2=qsin[acat]");
    expect(g.duration).toBe(5.5);
    expect(g.maps).toEqual(["-map", "[vout]", "-map", "[aout]"]);
  });
  it("adds zooms, reframe, music ducking and loudnorm", () => {
    const g = buildRenderGraph(plan, info, {
      zooms: [{ start: 1, end: 3, scale: 112, ease: 0 }],
      reframe: "9:16",
      loudnorm: true,
      audio: [{ path: "/music.mp3", at: 0, loop: true, gainDb: -18, duckDb: 12 }],
    });
    expect(g.graph).toContain("zoompan=z='1+0.12*between(it,1,3)'");
    expect(g.graph).toContain("crop=606:1080");
    expect(g.graph).toContain("sidechaincompress");
    expect(g.graph).toContain("loudnorm=I=-14");
    expect(g.inputs[1].args).toEqual(["-stream_loop", "-1", "-i", "/music.mp3"]);
    expect(g.outSize).toEqual({ width: 606, height: 1080 });
  });
  it("computes zoom expressions and reframe sizes", () => {
    expect(zoomExpression([])).toBe("1");
    expect(zoomExpression([{ start: 0, end: 3, scale: 120 }])).toBe("1+0.2*between(it,0,3)*min(1,min((it-0)/0.15,(3-it)/0.15))");
    expect(reframeSize(1920, 1080, "1:1")).toEqual({ width: 1080, height: 1080 });
    expect(reframeSize(1080, 1920, "16:9")).toEqual({ width: 1080, height: 606 });
    expect(reframeSize(1281, 721)).toEqual({ width: 1280, height: 720 });
  });
  it("forces the libvpx decoder only for VP9 .webm overlays (alpha), not AV1/VP8", () => {
    const g = buildRenderGraph(plan, info, {
      overlays: [
        { path: "/alpha.webm", at: 0, codec: "vp9" },
        { path: "/broll.webm", at: 1, codec: "av1" },
      ],
    });
    expect(g.inputs[1].args).toEqual(["-c:v", "libvpx-vp9", "-i", "/alpha.webm"]);
    expect(g.inputs[2].args).toEqual(["-i", "/broll.webm"]);
  });
});
