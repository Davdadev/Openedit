import { describe, expect, it } from "vitest";
import { buildCutPlan, detectRetakes, findRetakes, leadingSimilarity, TIGHTNESS } from "../src/engine/cutplan.js";
import { promptKey, VERBATIM_PROMPT } from "../src/engine/transcribe.js";
import {
  adaptiveLevels,
  frameDb,
  framesToSilences,
  smooth,
  spokenEnd,
  transcriptPauses,
  unionRanges,
} from "../src/engine/vad.js";
import { emphasisWeight, planZooms, zoomMoments } from "../src/engine/zooms.js";
import type { Transcript, Word } from "../src/hosts/types.js";

/** "word@start-end" tokens; a token ending in "|" closes the segment. */
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

/** Envelope from a per-frame level list (50 ms frames). */
const env = (db: number[]) => ({ hop: 0.05, db });
const fill = (n: number, v: number) => new Array<number>(n).fill(v);

describe("adaptive silence threshold", () => {
  it("computes per-frame RMS dB", () => {
    const sr = 1000;
    const s = new Float32Array(100).fill(0.5); // 0.5 amplitude -> -6.02 dB
    const db = frameDb(s, sr, 0.05);
    expect(db).toHaveLength(2);
    expect(db[0]).toBeCloseTo(-6.02, 1);
  });

  it("clean speech: threshold sits well above the noise floor", () => {
    const db = [...fill(40, -70), ...fill(60, -15)];
    const lv = adaptiveLevels(db);
    expect(lv.floorDb).toBe(-70);
    expect(lv.speechDb).toBe(-15);
    expect(lv.thresholdDb).toBe(-45); // max(-64, -45)
  });

  it("music bed: threshold rises above the bed so pauses are still found", () => {
    // Music at -36 dB during pauses, speech + music at -14 dB.
    const db = [...fill(20, -14), ...fill(30, -36), ...fill(40, -14), ...fill(12, -37), ...fill(20, -14)];
    const lv = adaptiveLevels(db);
    expect(lv.thresholdDb).toBeGreaterThan(-36);
    expect(lv.thresholdDb).toBeLessThan(-14);
    const sil = framesToSilences(env(db), lv.thresholdDb, 0.5, db.length * 0.05);
    expect(sil).toEqual([
      { start: 1, end: 2.5 },
      { start: 4.5, end: 5.1 },
    ]);
    // The old fixed -35 dB finds only the slightly quieter pause... or nothing under a louder bed.
    expect(framesToSilences(env(db.map((v) => v + 4)), -35, 0.5, 6.1)).toEqual([]);
  });

  it("clamps the threshold to [-60, -20]", () => {
    expect(adaptiveLevels(fill(10, -100)).thresholdDb).toBe(-60);
    expect(adaptiveLevels([...fill(5, -5), ...fill(5, -3)]).thresholdDb).toBe(-20);
  });

  it("median smoothing ignores single-frame clicks", () => {
    expect(smooth([-60, -60, -10, -60, -60])).toEqual([-60, -60, -60, -60, -60]);
    const db = [...fill(10, -10), ...fill(5, -60), -10, ...fill(5, -60), ...fill(10, -10)];
    expect(framesToSilences(env(db), -40, 0.5, db.length * 0.05)).toEqual([{ start: 0.5, end: 1.05 }]);
  });
});

describe("transcript pauses (speech map)", () => {
  it("caps DTW-stretched words by a spoken-length estimate", () => {
    expect(spokenEnd({ text: "I", start: 1, end: 3 })).toBeCloseTo(1.2);
    expect(spokenEnd({ text: "biochemist.", start: 10, end: 14 })).toBeCloseTo(10.75);
    expect(spokenEnd({ text: "hi", start: 1, end: 1.1 })).toBe(1.1);
  });

  it("finds gaps between words, including lead-in and tail", () => {
    // DTW style: "biochemist." runs to the next word, hiding a ~1.4 s pause.
    const t = tr("Hello@1-1.3 I@1.3-1.5 am@1.5-1.7 a@1.7-1.8 biochemist.@1.8-4| I@4-4.1 studied@4.1-4.6", 6);
    const p = transcriptPauses(t, 6, { minDuration: 0.5 });
    expect(p.map((r) => [r.start, r.end])).toEqual([
      [0, 1],
      [2.55, 4],
      [4.6, 6],
    ]);
  });

  it("uses energy to trim word tails and to keep speech whisper missed", () => {
    const t = tr("one@0-0.3 two.@0.3-5| three@5-5.4", 6);
    // two. is loud until 1.0 (longer than its 0.43 s estimate); unrecognised speech at 2.5-3.0.
    const db = fill(120, -36);
    for (let i = 0; i < 20; i++) db[i] = -12;
    for (let i = 50; i < 60; i++) db[i] = -12;
    for (let i = 100; i < 120; i++) db[i] = -12;
    const p = transcriptPauses(t, 6, { minDuration: 0.5, energy: env(db) });
    expect(p).toEqual([
      { start: 1, end: 2.5 },
      { start: 3, end: 5 },
    ]);
  });

  it("unions overlapping ranges", () => {
    expect(unionRanges([{ start: 3, end: 4 }, { start: 1, end: 2 }, { start: 1.5, end: 2.5 }])).toEqual([
      { start: 1, end: 2.5 },
      { start: 3, end: 4 },
    ]);
  });
});

describe("tightness presets", () => {
  it("changes padding and minKeep", () => {
    const silences = [{ start: 2, end: 3 }];
    const loose = buildCutPlan({ source: "/x", duration: 5, silences, tightness: "loose" });
    const tight = buildCutPlan({ source: "/x", duration: 5, silences, tightness: "tight" });
    expect(loose.cuts[0]).toMatchObject({ start: 2.15, end: 2.85 });
    expect(tight.cuts[0]).toMatchObject({ start: 2.04, end: 2.96 });
    expect(buildCutPlan({ source: "/x", duration: 5, silences, tightness: "tight", padding: 0.1 }).cuts[0].start).toBe(2.1);
    expect(TIGHTNESS.loose.minSilence).toBeGreaterThan(TIGHTNESS.tight.minSilence);
  });
});

describe("whisper verbatim prompt", () => {
  it("is part of the cache key", () => {
    expect(VERBATIM_PROMPT).toMatch(/umm/i);
    expect(promptKey("")).toBe("");
    expect(promptKey(VERBATIM_PROMPT)).toMatch(/^\.p[0-9a-f]{8}$/);
    expect(promptKey("other")).not.toBe(promptKey(VERBATIM_PROMPT));
  });
});

describe("stricter retakes", () => {
  it("does not cut a finished sentence that merely shares 3 opening words", () => {
    // Previously cut: "I am from Buenos Aires." followed straight by "I am from ..." (3 words).
    const t = tr("I@0-0.1 am@0.1-0.3 from@0.3-0.5 Buenos@0.5-0.8 Aires.@0.8-1.2 I@1.2-1.3 am@1.3-1.5 from@1.5-1.7 Cordoba.@1.7-2.2|", 5);
    expect(detectRetakes(t)).toEqual([]);
  });

  it("does not cut a complete sentence with no pause before a similar one", () => {
    const t = tr(
      "We@0-0.2 want@0.2-0.4 to@0.4-0.5 build@0.5-0.8 tools.@0.8-1.25 We@1.25-1.4 want@1.4-1.6 to@1.6-1.7 build@1.7-2.0 communities.@2.0-2.6|",
      5,
    );
    expect(detectRetakes(t)).toEqual([]);
  });

  it("cuts an abandoned attempt followed by a pause, and reports texts", () => {
    const t = tr(
      "The@0-0.2 thing@0.2-0.5 about@0.5-0.8 our@0.8-1.0 product@1.0-1.5 is,@1.5-1.8 The@2.6-2.8 thing@2.8-3.1 about@3.1-3.4 our@3.4-3.6 product@3.6-4.0 is@4.0-4.2 speed.@4.2-4.8|",
      6,
    );
    const r = findRetakes(t);
    expect(r).toHaveLength(1);
    expect(r[0].cut).toMatchObject({ start: 0, end: 2.6, reason: "retake" });
    expect(r[0].attempt).toBe("The thing about our product is,");
    expect(r[0].restart).toContain("The thing about our product is");
    expect(r[0].matched).toBeGreaterThanOrEqual(4);
  });

  it("keeps a deliberate repeated short sentence (real clip: screen-reader demo)", () => {
    const t = tr("an@26.8-29.3 empty@29.34-29.98 document.@29.98-30.43 Empty@31.36-32.1 document.@32.1-32.66 This@32.66-32.88 means@32.88-33.18|", 40);
    expect(detectRetakes(t)).toEqual([]);
  });

  it("ignores zero-length (hallucinated) words", () => {
    const t = tr("So@0-0.2 the@0.2-0.4 plan@0.4-0.4| so@1-1.2 the@1.2-1.4 plan@1.4-1.4 works.@2-2.5|", 5);
    const words = findRetakes(t);
    // "plan" has zero length and is dropped; "So the" -> "so the" still matches as a 2-word abandoned prefix.
    expect(words.every((r) => !r.attempt.includes("plan"))).toBe(true);
  });

  it("caps a single retake cut", () => {
    const t = tr("Today@0-0.4 we@0.4-0.6 are@0.6-0.8 going@0.8-1.1 um@1.5-1.7| Today@20-20.4 we@20.4-20.6 are@20.6-20.8 going@20.8-21.1 home.@21.1-21.5|", 30);
    expect(findRetakes(t, { window: 30 })).toEqual([]);
    expect(findRetakes(t, { window: 30, maxCut: 25 })).toHaveLength(1);
  });

  it("accepts a near-identical restart by first-words similarity", () => {
    const t = tr(
      "So@0-0.2 the@0.2-0.4 main@0.4-0.6 reason@0.6-1.0 uh@1.2-1.4| So@2-2.2 the@2.2-2.4 real@2.4-2.6 main@2.6-2.8 reason@2.8-3.2 is@3.2-3.4 cost.@3.4-3.9|",
      5,
    );
    const r = findRetakes(t);
    expect(r).toHaveLength(1);
    expect(r[0].why).toMatch(/similar/);
    expect(leadingSimilarity(["a", "b", "c", "d"], ["a", "b", "x", "c", "d"])).toBeCloseTo(0.8);
  });
});

describe("emphasis-aware zooms", () => {
  const plan = { keep: [{ start: 0, end: 30 }] };
  const t = tr(
    "Hello@0.5-0.8 everyone.@0.8-1.3| This@3-3.2 is@3.2-3.3 really@3.3-3.6 important.@3.6-4.2| We@6-6.2 grew@6.2-6.5 300@6.5-7.0 percent.@7.0-7.6| " +
      "And@12-12.2 then@12.2-12.4 we@12.4-12.5 stopped.@12.5-13| Why@18-18.2 did@18.2-18.4 it@18.4-18.5 work?@18.5-19| It@24-24.2 just@24.2-24.4 did.@24.4-25|",
    30,
  );

  it("scores emphasis words", () => {
    expect(emphasisWeight({ text: "300", start: 0, end: 1 })).toBeGreaterThan(2);
    expect(emphasisWeight({ text: "never", start: 0, end: 1 })).toBe(2);
    expect(emphasisWeight({ text: "wow!", start: 0, end: 1 })).toBe(2.5);
    expect(emphasisWeight({ text: "table", start: 0, end: 1 })).toBe(0);
  });

  it("finds sentence, emphasis and question moments", () => {
    const kinds = new Set(zoomMoments(plan, t).map((m) => m.kind));
    expect(kinds).toEqual(new Set(["sentence", "emphasis", "question"]));
  });

  it("places spaced zooms with alternating levels, punch vs smooth", () => {
    const z = planZooms(plan, t, { minGap: 3 });
    expect(z.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < z.length; i++) expect(z[i].start - z[i - 1].start).toBeGreaterThanOrEqual(3);
    expect(z.every((x) => x.ease === 0)).toBe(true);
    expect(new Set(z.map((x) => x.scale))).toEqual(new Set([108, 115]));
    expect(z.some((x) => x.text === "300" && x.scale === 115)).toBe(true);
    expect(z.every((x) => x.end - x.start <= 5 + 1e-9)).toBe(true);
    const smoothZ = planZooms(plan, t, { style: "smooth" });
    expect(smoothZ.every((x) => x.ease === 0.4)).toBe(true);
  });

  it("works on an uncut clip without a transcript (periodic)", () => {
    const z = planZooms(plan, undefined, { every: 6 });
    expect(z.length).toBeGreaterThan(0);
  });

  it("maps moments to the edited timeline and skips cut words", () => {
    const cut = { keep: [{ start: 0, end: 5 }, { start: 13, end: 30 }] };
    const m = zoomMoments(cut, t);
    expect(m.find((x) => x.text === "300")).toBeUndefined(); // 6.5 s was cut
    expect(m.some((x) => x.kind === "jumpcut" && x.time === 5)).toBe(true);
  });
});
