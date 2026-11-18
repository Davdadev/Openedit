import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import {
  breakCost,
  captionBand,
  captionPreset,
  cuesFromTranscript,
  defaultCaptionStyle,
  faceOverlap,
  layoutLines,
  placeCaptions,
  lineBreaks,
  toASS,
  toSRT,
  toVTT,
} from "../src/engine/captions.js";
import { buildAss, cueFits, cueWords, paginate, parseCaptionStyle } from "../src/motion/index.js";
import { buildCutPlan, detectFillers, isFillerInContext, MIN_REMOVE, snapToWords, TIGHTNESS } from "../src/engine/cutplan.js";
import {
  contactTimes,
  editStats,
  joinAudioIssues,
  parseAstatsPeak,
  parseBlackFreeze,
  parseEbur128,
  quietProbes,
  reviewWarnings,
  standardsFor,
} from "../src/engine/review.js";
import { meanDb, quietestNear } from "../src/engine/vad.js";
import { emphasisWeight, planZooms, zoomMoments, zoomWarnings } from "../src/engine/zooms.js";
import type { Transcript, Word } from "../src/hosts/types.js";

/** "word@start-end" tokens, one segment. */
function tr(spec: string, duration = 60): Transcript {
  const words: Word[] = spec
    .trim()
    .split(/\s+/)
    .map((tok) => {
      const m = /^(.+)@([\d.]+)-([\d.]+)$/.exec(tok);
      if (!m) throw new Error(`bad token ${tok}`);
      return { text: m[1], start: Number(m[2]), end: Number(m[3]) };
    });
  return { language: "en", duration, segments: [{ text: words.map((w) => w.text).join(" "), start: 0, end: duration, words }] };
}
const W = (text: string, start: number, end: number): Word => ({ text, start, end });
const env = (db: number[], hop = 0.01) => ({ hop, db });

// ------------------------------------------------------------------ cuts

describe("cuts: pauses are shortened, not removed", () => {
  const t = tr("We@0.2-0.4 shipped@0.4-0.8 it.@0.8-1.0 Then@2.5-2.7 we@2.7-2.9 rested@2.9-3.3", 4);
  const words = t.segments[0].words;

  it("leaves keepPause (more at a sentence end), split tail > head", () => {
    const plan = buildCutPlan({ source: "/x", duration: 4, silences: [{ start: 1.0, end: 2.5 }], transcript: t });
    const c = plan.cuts.find((x) => x.start > 0.5)!;
    const tail = c.start - 1.0;
    const head = 2.5 - c.end;
    expect(tail).toBeGreaterThan(head);
    expect(tail + head).toBeCloseTo(TIGHTNESS.normal.keepPause * 1.3, 2); // after "it." (sentence end)
    expect(words.every((w) => plan.keep.some((k) => w.start >= k.start - 1e-6 && w.end <= k.end + 1e-6))).toBe(true);
  });

  it("keepPause: 0 removes the pause but still never cuts the words", () => {
    const plan = buildCutPlan({ source: "/x", duration: 4, silences: [{ start: 1.0, end: 2.5 }], transcript: t, keepPause: 0 });
    const c = plan.cuts.find((x) => x.start > 0.5)!;
    expect(c.start).toBeGreaterThanOrEqual(1.0 + 0.1 - 1e-9); // MIN_TAIL protects the decaying tail
    expect(c.end).toBeLessThanOrEqual(2.5 - 0.07 + 1e-9); // MIN_HEAD protects the onset
  });

  it("skips pauses that would remove less than MIN_REMOVE", () => {
    const plan = buildCutPlan({ source: "/x", duration: 4, silences: [{ start: 1.0, end: 1.0 + 0.32 + MIN_REMOVE - 0.05 }], transcript: t });
    expect(plan.cuts.filter((c) => c.start > 0.5 && c.end < 3.5)).toEqual([]);
  });

  it("never cuts a transcribed word even when the audio 'silence' covers it (music bed)", () => {
    // Under music the energy detector reports a silence that contains the word "rested".
    const plan = buildCutPlan({ source: "/x", duration: 4, silences: [{ start: 2.85, end: 4 }], transcript: t });
    const rested = words.at(-1)!;
    const kept = plan.keep.some((k) => k.start <= rested.start && k.end >= rested.start + 0.3);
    expect(kept).toBe(true);
  });

  it("protects a word tail the energy shows still sounding past the transcript", () => {
    // spokenEnd("it.") ~ 0.95; energy loud until 1.25 s.
    const db = Array.from({ length: 400 }, (_, i) => (i < 125 || (i >= 250 && i < 330) ? -10 : -60));
    const plan = buildCutPlan({ source: "/x", duration: 4, silences: [{ start: 1.0, end: 2.5 }], transcript: t, energy: env(db) });
    const c = plan.cuts.find((x) => x.start > 0.5)!;
    expect(c.start).toBeGreaterThanOrEqual(1.25 + 0.1 - 1e-6);
  });

  it("lands cut edges on the quietest 10 ms nearby", () => {
    const db = Array.from({ length: 400 }, () => -50);
    db[127] = -70; // a quiet trough at 1.275 s, within 40 ms of the planned edge (~1.25 s)
    const plan = buildCutPlan({ source: "/x", duration: 4, silences: [{ start: 1.0, end: 2.5 }], transcript: t, energy: env(db), levels: { thresholdDb: -45, floorDb: -60, speechDb: -10 } });
    const c = plan.cuts.find((x) => x.start > 0.5)!;
    expect(c.start).toBeCloseTo(1.275, 3);
  });

  it("merges a short kept piece by restoring the pause next to it, never dropping its speech", () => {
    const s = tr("one@0.2-0.6 two@1.6-1.8 three@2.8-3.3", 4);
    const plan = buildCutPlan({ source: "/x", duration: 4, silences: [{ start: 0.6, end: 1.6 }, { start: 1.8, end: 2.8 }], transcript: s, keepPause: 0.1, minKeep: 0.5 });
    for (const w of s.segments[0].words) expect(plan.keep.some((k) => w.start >= k.start && w.start < k.end)).toBe(true);
    expect(Math.min(...plan.keep.map((k) => k.end - k.start))).toBeGreaterThanOrEqual(0.5);
  });

  it("drops a pure-silence sliver between two cuts", () => {
    const plan = buildCutPlan({ source: "/x", duration: 6, silences: [{ start: 1, end: 3 }, { start: 3.1, end: 5 }], keepPause: 0.2, minKeep: 0.4, transcript: tr("a@0.5-1 b@5-5.5", 6) });
    expect(plan.keep.length).toBe(2);
  });

  it("snaps manual cuts to word boundaries", () => {
    expect(snapToWords({ start: 1.05, end: 2.75 }, [W("hello", 1.0, 1.4), W("world", 2.5, 2.9)])).toEqual({ start: 1.0, end: 2.9 });
    const plan = buildCutPlan({ source: "/x", duration: 4, transcript: t, manualCuts: [{ start: 0.45, end: 0.9 }] });
    // "shipped" (0.4–0.8) and "it." are removed whole; "We" is kept whole.
    expect(plan.keep[0].end).toBeGreaterThanOrEqual(0.4 - 1e-6);
    expect(plan.keep[0].end).toBeLessThanOrEqual(0.4 + 0.32);
  });
});

describe("cuts: fillers by context", () => {
  const words = (s: string) => tr(s).segments[0].words;

  it("always removes hesitations", () => {
    expect(isFillerInContext(words("so@0-0.2 um@0.25-0.5 yes@0.55-0.8"), 1, 1)).toBe(true);
  });

  it("removes isolated 'like' but not the verb", () => {
    expect(isFillerInContext(words("it@0-0.1 was,@0.1-0.4 like,@0.5-0.7 huge@0.8-1.1"), 2, 1)).toBe(true);
    expect(isFillerInContext(words("I@0-0.1 would@0.1-0.3 like@0.3-0.5 that@0.5-0.8"), 2, 1)).toBe(false);
    expect(isFillerInContext(words("it@0-0.1 looks@0.1-0.3 like@0.6-0.8 rain.@1.1-1.4"), 2, 1)).toBe(false);
  });

  it("keeps 'so' that carries meaning and 'so' that ends a sentence", () => {
    expect(isFillerInContext(words("I@0-0.1 think@0.1-0.4 so.@0.4-0.7 Then@1.5-1.8"), 2, 1)).toBe(false);
    expect(isFillerInContext(words("it@0-0.1 was@0.1-0.3 so@0.3-0.5 much@0.5-0.8"), 2, 1)).toBe(false);
    expect(isFillerInContext(words("Okay.@0-0.3 So,@0.8-1.0 the@1.4-1.5 plan@1.5-1.9"), 1, 1)).toBe(true);
  });

  it("keeps 'you know what' and phrase fillers inside a running clause", () => {
    expect(isFillerInContext(words("and@0-0.2 you@0.2-0.3 know@0.3-0.5 what@0.5-0.7 happened@0.7-1.1"), 1, 2)).toBe(false);
    expect(isFillerInContext(words("it,@0-0.2 you@0.5-0.6 know,@0.6-0.8 works@1.2-1.5"), 1, 2)).toBe(true);
  });

  it("defaults to hesitations only", () => {
    const t = tr("I@0-0.1 would@0.1-0.3 like,@0.3-0.5 um,@0.9-1.1 coffee@1.5-2");
    expect(detectFillers(t).map((c) => c.label)).toEqual(["um"]);
  });
});

// ------------------------------------------------------------------ zooms

describe("zooms: purposeful and sparse", () => {
  // 120 s of talk with 8 pause cuts every ~15 s, two of them mid-sentence.
  const keep = Array.from({ length: 9 }, (_, i) => ({ start: i * 15, end: i * 15 + 14.4 }));
  const plan = { keep };
  const words: string[] = [];
  for (let i = 0; i < 9; i++) {
    const b = i * 15;
    words.push(`This@${b + 1}-${b + 1.3}`, `is@${b + 1.3}-${b + 1.5}`, `fine.@${b + 1.5}-${b + 2}`);
    words.push(i === 3 ? `Never@${b + 6}-${b + 6.4}` : `We@${b + 6}-${b + 6.3}`, `ship@${b + 6.4}-${b + 6.8}`, `late.@${b + 6.8}-${b + 7.3}`);
    words.push(`and@${b + 13.6}-${b + 13.9}`, `then@${b + 13.9}-${b + 14.2}`);
  }
  const t = tr(words.join(" "), 135);

  it("only jump cuts and strong emphasis are candidates", () => {
    const kinds = new Set(zoomMoments(plan, t).map((m) => m.kind));
    expect(kinds).toEqual(new Set(["jumpcut", "emphasis"]));
    expect(emphasisWeight(W("three", 0, 1))).toBe(0); // small numbers are not emphasis
    expect(emphasisWeight(W("400-page", 0, 1))).toBeGreaterThan(2);
    expect(emphasisWeight(W("300", 0, 1), W("percent", 1, 2))).toBeGreaterThan(2);
    expect(emphasisWeight(W("really", 0, 1))).toBe(0);
  });

  it("long-form normal: <= 1 per 20 s, never on adjacent segments, never back-to-back, <= 110%", () => {
    const z = planZooms(plan, t);
    const total = keep.length * 14.4;
    expect(z.length).toBeGreaterThan(0);
    expect(z.length).toBeLessThanOrEqual(Math.round(total / 20));
    for (let i = 1; i < z.length; i++) {
      expect(z[i].start - z[i - 1].start).toBeGreaterThanOrEqual(20);
      expect(z[i].start - z[i - 1].end).toBeGreaterThan(1);
    }
    expect(z.every((x) => x.scale >= 105 && x.scale <= 110)).toBe(true);
  });

  it("jump-cut zooms start exactly on the cut with a hard switch", () => {
    const z = planZooms(plan, t, { density: "energetic" }).filter((x) => x.kind === "jumpcut");
    const joins = keep.slice(1).map((_, i) => Math.round((i + 1) * 14.4 * 100) / 100);
    expect(z.length).toBeGreaterThan(0);
    for (const x of z) {
      expect(joins).toContain(x.start);
      expect(x.ease).toBe(0);
    }
  });

  it("density and format scale the count; shorts punch at up to 112%", () => {
    const subtle = planZooms(plan, t, { density: "subtle" }).length;
    const energetic = planZooms(plan, t, { density: "energetic" }).length;
    expect(energetic).toBeGreaterThan(subtle);
    const short = planZooms(plan, t, { format: "short" });
    expect(short.length).toBeGreaterThanOrEqual(planZooms(plan, t).length);
    expect(short.every((x) => x.ease === 0 && x.scale <= 112)).toBe(true);
  });

  it("does not zoom an uncut clip with nothing to emphasise", () => {
    expect(planZooms({ keep: [{ start: 0, end: 60 }] }, tr("just@1-1.3 talking@1.3-2"))).toEqual([]);
  });

  it("warns when a zoom upscales the source visibly", () => {
    expect(zoomWarnings([{ start: 0, end: 2, scale: 110 }], { sourceHeight: 1080, outputHeight: 1080 })).toEqual([]);
    expect(zoomWarnings([{ start: 0, end: 2, scale: 115 }], { sourceHeight: 1080, outputHeight: 1080 })[0]).toMatch(/soft/);
    expect(zoomWarnings([{ start: 0, end: 2, scale: 108 }], { sourceHeight: 720, outputHeight: 1080 })[0]).toMatch(/upscales/);
    expect(zoomWarnings([{ start: 0, end: 2, scale: 106 }, { start: 2.5, end: 4, scale: 106 }], {})[0]).toMatch(/back-to-back/);
  });
});

// ------------------------------------------------------------------ captions

describe("captions: phrase-aware, readable", () => {
  const sentence = tr(
    "This@0-0.2 product@0.2-0.6 has@0.6-0.8 been@0.8-0.95 designed@0.95-1.4 in@1.4-1.5 the@1.5-1.6 spirit@1.6-2.0 of@2.0-2.1 the@2.1-2.2 " +
      "Marrakesh@2.2-2.8 Treaty,@2.8-3.3 which@3.5-3.7 makes@3.7-4.0 published@4.0-4.5 works@4.5-4.9 accessible.@4.9-5.6",
  );

  it("breakCost: punctuation best, function words worst, phrase openers good", () => {
    expect(breakCost(W("Treaty,", 0, 1), W("which", 1, 2))).toBeLessThan(breakCost(W("designed", 0, 1), W("in", 1, 2)));
    expect(breakCost(W("designed", 0, 1), W("in", 1, 2))).toBeLessThan(breakCost(W("the", 0, 1), W("spirit", 1, 2)));
    expect(breakCost(W("done.", 0, 1), W("Next", 1, 2))).toBeLessThan(0);
  });

  it("never ends a cue on an article/preposition when a better break exists", () => {
    const cues = cuesFromTranscript(sentence, captionPreset("16:9", "clean"));
    for (const c of cues.slice(0, -1)) expect(c.text).not.toMatch(/\b(the|of|in|a|an|and|been|has)$/i);
    expect(cues.every((c) => c.text.split("\n").every((l) => l.length <= 42))).toBe(true);
  });

  it("16:9 default: balanced two-line cues, line breaks consistent across SRT / VTT / ASS", () => {
    const p = captionPreset("16:9", "clean");
    expect(p.maxLines).toBe(2);
    expect(p.maxCharsPerLine).toBe(42);
    const cues = cuesFromTranscript(sentence, p);
    const two = cues.find((c) => c.text.includes("\n"))!;
    expect(two).toBeDefined();
    const [l1, l2] = two.text.split("\n");
    expect(toSRT([two])).toContain(`${l1}\n${l2}\n`);
    expect(toVTT([two])).toContain(`${l1}\n${l2}\n`);
    expect(toASS([two])).toContain(`${l1}\\N${l2}`);
    // bold-pop (one event per word) keeps the break too.
    const bp = toASS([two], { style: "bold-pop" });
    const ev = bp.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(ev.length).toBe(two.words!.length);
    expect(ev.every((l) => l.includes("\\N"))).toBe(true);
    expect(lineBreaks("a b\nc d", 4)).toEqual(new Set([1]));
    expect(lineBreaks("a b\nc d", 3).size).toBe(0);
  });

  it("balances two lines, no orphan, and joins them with a newline", () => {
    const l = layoutLines(sentence.segments[0].words.slice(0, 12), 42, 2)!;
    expect(l.lines).toHaveLength(2);
    expect(l.lines[0].split(" ").length).toBeGreaterThan(1);
    expect(l.lines[1].split(" ").length).toBeGreaterThan(1);
    expect(Math.abs(l.lines[0].length - l.lines[1].length)).toBeLessThan(20);
    expect(l.lines[0]).not.toMatch(/\b(the|of|in)$/);
    const cues = cuesFromTranscript(sentence, { maxCharsPerLine: 42, maxLines: 2 });
    expect(cues.some((c) => c.text.includes("\n"))).toBe(true);
    expect(toASS(cues)).toContain("\\N");
  });

  it("9:16 bold-pop: <= 3 words, <= 18 chars", () => {
    const cues = cuesFromTranscript(sentence, captionPreset("9:16", "bold-pop"));
    expect(cues.every((c) => c.text.split(" ").length <= 3 && c.text.length <= 18)).toBe(true);
  });

  it("holds cues >= 0.9 s when the pause allows, <= 5 s, without overlap", () => {
    const t = tr("Yes.@0-0.3 Okay@3-3.3 then.@3.3-3.6");
    const cues = cuesFromTranscript(t);
    expect(cues[0].end - cues[0].start).toBeGreaterThanOrEqual(0.9);
    for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end);
    const long = tr(Array.from({ length: 30 }, (_, i) => `w${i}@${i * 0.4}-${i * 0.4 + 0.35}`).join(" "));
    expect(cuesFromTranscript(long, { maxCharsPerLine: 200 }).every((c) => c.end - c.start <= 5.3)).toBe(true);
  });

  it("extends display toward the reading speed limit when there is room", () => {
    const t = tr("Accessibility@0-0.5 matters@0.5-0.9 enormously.@0.9-1.3 Next@4-4.3");
    const c = cuesFromTranscript(t)[0];
    expect(c.text.length / (c.end - c.start)).toBeLessThanOrEqual(17.01);
  });

  it("default style by context", () => {
    expect(defaultCaptionStyle("16:9", 600)).toBe("clean");
    expect(defaultCaptionStyle("9:16", 45)).toBe("bold-pop");
    expect(defaultCaptionStyle("9:16", 900)).toBe("clean");
    expect(captionPreset("16:9").maxCharsPerLine).toBe(42);
    expect(captionPreset("9:16").maxCharsPerLine).toBeLessThanOrEqual(22);
  });

  it("keeps captions off faces", () => {
    const low = [{ faces: [{ y: 0.55, h: 0.3 }] }, { faces: [{ y: 0.56, h: 0.3 }] }];
    expect(faceOverlap(low, captionBand("clean", "bottom", false))).toBe(1);
    const p = placeCaptions(low, "clean", false);
    expect(p.position).toBe("top");
    expect(placeCaptions([{ faces: [{ y: 0.2, h: 0.25 }] }], "clean", false).position).toBeUndefined();
    expect(placeCaptions(null, "clean", false)).toEqual({ overlap: 0 });
  });

  it("toASS accepts a style spec with options", () => {
    expect(toASS([{ start: 0, end: 1, text: "Hi" }], { style: "clean:position=top" })).toContain("Style: Default,Arial");
  });
});

describe("caption overlay: honours line breaks, keeps fitting cues whole", () => {
  const cue = (text: string, start = 0, end = 2) => ({ start, end, text });

  it("a bold-pop cue that fits is one page, not re-split at the comma", () => {
    const pages = paginate([cue("to Article Two,"), cue("and then more", 2, 3)], "bold-pop");
    expect(pages.map((p) => p.words.map((w) => w.text).join(" "))).toEqual(["to Article Two,", "and then more"]);
    // Too many words still paginates.
    expect(paginate([cue("one two three four five six")], "bold-pop").length).toBe(2);
    expect(cueFits(cue("a quite long bold line here"), "bold-pop")).toBe(false);
  });

  it("\\n marks a line break on the right word, for given or synthesized word timings", () => {
    expect(cueWords(cue("Hi, my name is\nNicholas Hookstra.")).map((w) => Boolean(w.br))).toEqual([false, false, false, true, false, false]);
    const words = [
      { text: "Hi,", start: 0, end: 0.2 },
      { text: "there", start: 0.2, end: 0.5 },
      { text: "friend.", start: 0.5, end: 0.9 },
    ];
    expect(cueWords({ ...cue("Hi, there\nfriend."), words }).map((w) => Boolean(w.br))).toEqual([false, true, false]);
    // Words that do not line up with the text: no break is guessed.
    expect(cueWords({ ...cue("Hi\nthere friend."), words: words.slice(0, 2) }).some((w) => w.br)).toBe(false);
  });

  it("a two-line clean cue stays one page with its break; the ASS fallback uses \\N", () => {
    const two = cue("I work here at the Accessible Books\nConsortium as the capacity focal point.");
    expect(cueFits(two, "clean")).toBe(true);
    const pages = paginate([two], "clean");
    expect(pages).toHaveLength(1);
    expect(pages[0].words.filter((w) => w.br).map((w) => w.text)).toEqual(["Books"]);
    const ass = buildAss([two], parseCaptionStyle("clean"), { width: 1920, height: 1080, accent: "#FFFFFF" });
    expect(ass).toContain("Books\\NConsortium");
    // Three lines does not fit: re-paginated without forced breaks.
    expect(cueFits(cue("a\nb\nc"), "clean")).toBe(false);
  });
});

// ------------------------------------------------------------------ review

describe("review_edit pure parts", () => {
  it("parses ebur128, blackdetect/freezedetect and astats", () => {
    const log = `[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -14.2 LUFS\n    Threshold: -24.6 LUFS\n\n  Loudness range:\n    LRA:         5.1 LU\n\n  True peak:\n    Peak:       -1.4 dBFS\n`;
    expect(parseEbur128(log)).toEqual({ integrated: -14.2, lra: 5.1, truePeak: -1.4 });
    const bf = `[blackdetect @ 0x2] black_start:0 black_end:0.48 black_duration:0.48\n[freezedetect @ 0x3] lavfi.freezedetect.freeze_start: 10.5\n[freezedetect @ 0x3] lavfi.freezedetect.freeze_duration: 2\n[freezedetect @ 0x3] lavfi.freezedetect.freeze_end: 12.5\n`;
    expect(parseBlackFreeze(bf)).toEqual({ black: [{ start: 0, end: 0.48 }], frozen: [{ start: 10.5, end: 12.5 }] });
    expect(parseAstatsPeak("[Parsed_astats_1 @ 0x4] Overall\n[Parsed_astats_1 @ 0x4] Peak level dB: -0.05\n")).toBe(-0.05);
  });

  const plan = { keep: [{ start: 0, end: 2 }, { start: 3, end: 3.3 }, { start: 4, end: 8 }] };
  const t = tr("Hello@0.1-0.5 there.@0.5-1.9 Mid@3.0-3.25 cut@3.2-3.6 tail@4.1-4.5 words@4.5-5", 8);

  it("editStats: shortest keep, join pauses, words cut, zooms and caption quality", () => {
    const s = editStats({
      plan,
      transcript: t,
      duration: 6.3,
      zooms: [{ start: 0.5, end: 1.9, scale: 115 }, { start: 2.1, end: 3, scale: 108 }],
      captions: [
        { start: 0, end: 0.3, text: "Hello there and the" },
        { start: 0.3, end: 2.5, text: "Hello" },
        { start: 2.5, end: 4, text: "a short\nphrase in the" },
      ],
    });
    expect(s.cuts).toBe(2);
    expect(s.shortestKeep).toEqual({ seconds: 0.3, at: 2 });
    expect(s.wordsCut.map((w) => w.word)).toContain("cut");
    expect(s.zoomsPerMinute).toBeCloseTo(19, 0);
    expect(s.maxZoomScale).toBe(115);
    expect(s.adjacentZooms).toBe(1);
    expect(s.captionMaxCps).toBeGreaterThan(17);
    expect(s.badLineEnds.length).toBeGreaterThan(0);
    expect(s.orphanCaptions).toBe(1);
  });

  it("word-by-word captions are not judged by reading speed", () => {
    const s = editStats({ duration: 10, captions: [{ start: 0, end: 0.2, text: "BIG" }, { start: 0.2, end: 0.4, text: "WORDS HERE" }] });
    expect(s.captionMaxCps).toBeUndefined();
  });

  it("quietProbes: dead air only where the audio is quiet; measured join pauses", () => {
    const db = Array.from({ length: 800 }, (_, i) => (i >= 200 && i < 300 ? -60 : -12));
    const q = quietProbes(env(db));
    expect(q.isQuiet(2.0, 3.0)).toBe(true);
    expect(q.isQuiet(3.5, 4.5)).toBe(false);
    expect(q.quietRunAt(2.5)).toBeCloseTo(1.0, 2);
    expect(q.quietRunAt(5)).toBe(0);
  });

  it("joinAudioIssues: flags joins that land on sound", () => {
    const db = Array.from({ length: 1000 }, (_, i) => (i < 300 ? -12 : i < 500 ? -60 : -12));
    const r = joinAudioIssues(env(db), [2.0, 4.0]);
    expect(r.hot).toEqual([2]);
    expect(meanDb(env(db), 3.1, 3.5)).toBeCloseTo(-60, 0);
  });

  it("reviewWarnings: maps stats to editorial warnings", () => {
    const s = editStats({ plan, transcript: t, duration: 6.3, zooms: [{ start: 0.5, end: 1.9, scale: 115 }] });
    const w = reviewWarnings(
      s,
      { duration: 7.5, loudness: { integrated: -20, truePeak: -0.2 }, peakDb: 0, black: [{ start: 1, end: 2 }], frozen: [{ start: 3, end: 6 }], hotJoins: [2], jumpJoins: [] },
      standardsFor("long"),
    ).join("\n");
    for (const re of [/duration/, /choppy/, /inside a word/, /speech level/, /softens/, /LUFS/, /true peak/, /clips/, /black/, /frozen/]) expect(w).toMatch(re);
  });

  it("contactTimes: before/after pairs around joins, flagged ones first, plus intervals", () => {
    const ct = contactTimes([1, 2, 3, 4, 5, 6], 10, { maxJoins: 2, intervals: 3, priority: [5] });
    expect(ct.filter((x) => x.kind === "before").map((x) => x.join)).toContain(5);
    expect(ct.filter((x) => x.kind === "interval")).toHaveLength(3);
    expect(ct.find((x) => x.kind === "after" && x.join === 5)!.t).toBeCloseTo(5.3, 6);
  });

  it("quietestNear prefers the trough, ties to the preferred point", () => {
    const db = [-30, -30, -45, -30, -30];
    expect(quietestNear(env(db), 0.01, 0, 0.04)).toBeCloseTo(0.025, 6);
    expect(quietestNear(env([-30, -30, -30]), 0.015, 0, 0.02)).toBeCloseTo(0.015, 6);
  });
});

// ------------------------------------------------------------------ server

const TMP = resolve("test/.tmp-quality");
describe.skipIf(!hasFfmpeg())("plan_cuts on a video without audio", () => {
  afterAll(() => rmSync(TMP, { recursive: true, force: true }));
  it("degrades gracefully instead of failing", async () => {
    mkdirSync(TMP, { recursive: true });
    process.env.OPENEDIT_HOME = join(TMP, "home");
    process.env.OPENEDIT_STUDIO = "0";
    const src = join(TMP, "silent.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x180:d=2", "-pix_fmt", "yuv420p", src]);
    const { createServer } = await import("../src/mcp/server.js");
    const server = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(ct);
    const res = (await client.callTool({ name: "plan_cuts", arguments: { path: src } })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content.map((c) => c.text).join("\n");
    expect(res.isError).toBeFalsy();
    expect(text).toMatch(/no audio stream/);
    expect(text).toMatch(/planId:/);
    await client.close();
  });
});

function hasFfmpeg(): boolean {
  try {
    execFileSync("which", ["ffmpeg"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
