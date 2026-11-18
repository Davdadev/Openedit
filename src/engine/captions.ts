import type { CaptionCue, CutPlan, Transcript, Word } from "../hosts/types.js";

export type CaptionStyle = "clean" | "bold-pop" | "minimal";
export const CAPTION_STYLES: CaptionStyle[] = ["clean", "bold-pop", "minimal"];

export type CaptionAspect = "16:9" | "9:16" | "1:1" | "4:5";

export interface CueOptions {
  /** Max characters per cue (all lines). Default maxCharsPerLine * maxLines. */
  maxChars?: number;
  /** Max words per cue. Default unlimited (bold-pop presets use 3). */
  maxWords?: number;
  /** Max characters per line. Default 42 (16:9). */
  maxCharsPerLine?: number;
  /** Max lines per cue. Default 1. */
  maxLines?: number;
  /** Start a new cue when the pause between words exceeds this (s). Default 0.7. */
  maxGap?: number;
  /** Shortest time a cue stays up (s). Default 0.9. */
  minDuration?: number;
  /** Longest cue (s). Default 5. */
  maxDuration?: number;
  /** Target reading speed, characters per second. Default 17. */
  maxCps?: number;
  /** Remap word times through this plan so cues line up with the cut edit. */
  plan?: Pick<CutPlan, "keep">;
}

/**
 * Words a line or a cue should not END on: articles, prepositions, conjunctions,
 * possessive determiners, auxiliaries, subject pronouns. Ending there splits a
 * phrase ("has been designed / in" or "the / treaty").
 */
export const FUNCTION_WORDS = new Set([
  "a", "an", "the", "of", "to", "in", "on", "at", "by", "for", "with", "from", "into", "onto", "about", "as", "over", "under",
  "between", "through", "and", "or", "but", "nor", "if", "than", "because", "while", "my", "your", "his", "her", "its", "our",
  "their", "this", "these", "those", "that", "which", "who", "am", "is", "are", "was", "were", "be", "been", "being", "have",
  "has", "had", "will", "would", "can", "could", "should", "shall", "may", "might", "must", "do", "does", "did", "not", "i",
  "you", "we", "they", "he", "she", "it", "i'm", "it's", "we're", "they're", "you're", "very", "so", "just", "some", "any",
  "every", "each", "no", "all", "both", "more", "most", "such", "how", "what", "when", "where", "why",
]);
/** Words that open a new phrase: a line/cue break before them reads naturally. */
const PHRASE_OPENERS = new Set(["and", "but", "or", "so", "because", "which", "who", "that", "when", "where", "while", "if", "then", "to", "in", "on", "for", "with"]);

const wnorm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
const SENT_END = /[.!?…]["')\]]*$/;
const CLAUSE_END = /[,;:—–-]["')\]]*$/;

/** Cost of breaking (a line or a cue) between word a and word b. Lower is better. */
export function breakCost(a: Word, b?: Word): number {
  const at = a.text.trim();
  if (!b) return 0;
  if (SENT_END.test(at)) return -2;
  if (CLAUSE_END.test(at)) return -1;
  let c = 2;
  if (FUNCTION_WORDS.has(wnorm(at))) c += 6;
  if (PHRASE_OPENERS.has(wnorm(b.text))) c -= 1;
  if (b.start - a.end >= 0.3) c -= 1.5;
  return c;
}

const joinWords = (ws: Word[]) => ws.map((w) => w.text.trim()).join(" ");

/**
 * Lay out words as at most `maxLines` lines of <= maxCharsPerLine. Two lines are
 * broken at the best phrase boundary, balanced (bottom line may be a little longer),
 * without single-word orphans. Returns null if it cannot fit.
 */
export function layoutLines(ws: Word[], maxCharsPerLine: number, maxLines = 2): { lines: string[]; cost: number } | null {
  const all = joinWords(ws);
  if (all.length <= maxCharsPerLine) return { lines: [all], cost: 0 };
  if (maxLines < 2 || ws.length < 2) return null;
  let best: { lines: string[]; cost: number } | null = null;
  for (let k = 1; k < ws.length; k++) {
    const l1 = joinWords(ws.slice(0, k));
    const l2 = joinWords(ws.slice(k));
    if (l1.length > maxCharsPerLine || l2.length > maxCharsPerLine) continue;
    let cost = breakCost(ws[k - 1], ws[k]) + (3 * Math.abs(l1.length - l2.length)) / maxCharsPerLine;
    if (l1.length > l2.length) cost += 0.5; // prefer a pyramid: shorter top line
    if (k === 1 || k === ws.length - 1) cost += 3; // orphan
    if (!best || cost < best.cost) best = { lines: [l1, l2], cost };
  }
  if (!best && maxLines > 2) return null;
  return best;
}

/** Caption layout defaults for an output aspect and style (see make_captions). */
export function captionPreset(aspect: CaptionAspect = "16:9", style: string = "clean"): CueOptions {
  const vertical = aspect === "9:16" || aspect === "4:5";
  if (style.startsWith("bold-pop")) return { maxCharsPerLine: vertical ? 18 : 24, maxLines: 1, maxWords: 3, minDuration: 0.5, maxDuration: 2.5 };
  if (aspect === "9:16") return { maxCharsPerLine: 22, maxLines: 2, maxWords: 8 };
  if (aspect === "1:1" || aspect === "4:5") return { maxCharsPerLine: 28, maxLines: 2, maxWords: 10 };
  // 16:9: balanced two-line cues of <= 42 characters per line (the renderers honour the "\n" break),
  // so each cue can stay up longer and reading speed drops toward <= 17 cps.
  return { maxCharsPerLine: 42, maxLines: 2, maxWords: 20 };
}

/** Default caption style by context: bold-pop only for vertical short-form, clean otherwise. */
export function defaultCaptionStyle(aspect: CaptionAspect, durationSec?: number): CaptionStyle {
  if (aspect === "9:16" && (durationSec === undefined || durationSec <= 180)) return "bold-pop";
  return "clean";
}

/**
 * Map a word into edit time. It survives if most of it (or at least 0.12 s)
 * lies in one kept segment; its times are clipped to that segment.
 */
function remapWord(w: Word, keep: CutPlan["keep"], offsets: number[]): Word | null {
  let bestIdx = -1;
  let bestOverlap = 0;
  for (let i = 0; i < keep.length; i++) {
    const k = keep[i];
    if (k.start >= w.end) break;
    const ov = Math.min(w.end, k.end) - Math.max(w.start, k.start);
    if (ov > bestOverlap) [bestIdx, bestOverlap] = [i, ov];
  }
  const len = Math.max(w.end - w.start, 1e-3);
  // Silence cuts are padded from the audio, so a word whose (approximate) timing
  // spills into a cut but still has a solid chunk in a kept segment was spoken there.
  if (bestIdx < 0 || (bestOverlap / len < 0.5 && bestOverlap < 0.12)) return null;
  const k = keep[bestIdx];
  const s = Math.max(w.start, k.start);
  const e = Math.min(w.end, k.end);
  return { ...w, start: offsets[bestIdx] + (s - k.start), end: offsets[bestIdx] + (e - k.start) };
}

/**
 * Group transcript words into readable caption cues: phrase-aware breaks (never
 * after an article/preposition/conjunction when avoidable, no orphan words),
 * <= maxLines balanced lines of <= maxCharsPerLine, 0.9–5 s on screen,
 * reading speed <= ~17 cps where the pauses allow. Multi-line cue text is joined with "\n".
 */
export function cuesFromTranscript(t: Transcript, opts: CueOptions = {}): CaptionCue[] {
  const maxLines = opts.maxLines ?? 1;
  const maxCharsPerLine = opts.maxCharsPerLine ?? (opts.maxChars && maxLines === 1 ? opts.maxChars : 42);
  const maxChars = opts.maxChars ?? maxCharsPerLine * maxLines;
  const maxWords = opts.maxWords ?? Infinity;
  const maxGap = opts.maxGap ?? 0.7;
  const minDuration = opts.minDuration ?? 0.9;
  const maxDuration = opts.maxDuration ?? 5;
  const maxCps = opts.maxCps ?? 17;

  let words: Word[] = t.segments.flatMap((s) => s.words).filter((w) => w.text.trim());
  if (opts.plan) {
    const keep = opts.plan.keep;
    const offsets: number[] = [];
    let acc = 0;
    for (const k of keep) {
      offsets.push(acc);
      acc += k.end - k.start;
    }
    words = words.map((w) => remapWord(w, keep, offsets)).filter((w): w is Word => w !== null);
  }

  // Hard boundaries: long pauses, and sentence ends for one-line cues. With two lines a short
  // sentence may share a cue with the next one (each on its own line where it fits), which keeps
  // fast talkers' cues on screen long enough to read; the DP still prefers breaking there.
  const runs: Word[][] = [];
  let cur: Word[] = [];
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && ((maxLines < 2 && SENT_END.test(prev.text.trim())) || w.start - prev.end > maxGap)) {
      runs.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) runs.push(cur);

  const cues: CaptionCue[] = [];
  for (const run of runs) {
    // DP over cue boundaries.
    const n = run.length;
    const best = new Array<number>(n + 1).fill(Infinity);
    const from = new Array<number>(n + 1).fill(-1);
    const lay = new Map<string, string[]>();
    best[0] = 0;
    for (let j = 1; j <= n; j++) {
      for (let i = j - 1; i >= 0; i--) {
        const ws = run.slice(i, j);
        if (ws.length > maxWords) break;
        const text = joinWords(ws);
        if (text.length > maxChars && ws.length > 1) break;
        const dur = ws[ws.length - 1].end - ws[0].start;
        if (dur > maxDuration && ws.length > 1) break;
        const l = layoutLines(ws, maxCharsPerLine, maxLines) ?? (ws.length === 1 ? { lines: [text], cost: 0 } : null);
        if (!l) continue;
        let cost = 1 + l.cost + (j < n ? breakCost(run[j - 1], run[j]) : 0);
        if (ws.length === 1 && n > 1) cost += 4; // orphan cue
        // On screen until the next cue (chained) or the hold after the last word: a flash is unreadable.
        const shown = (j < n ? run[j].start : ws[ws.length - 1].end + 0.3) - ws[0].start;
        if (shown < minDuration) cost += (4 * (minDuration - shown)) / minDuration;
        // Reading speed over the time the cue is actually up (until the next one replaces it).
        const cps = text.length / Math.max(shown, 0.2);
        if (cps > maxCps) cost += Math.min(6, (cps - maxCps) * 0.4);
        if (best[i] + cost < best[j]) {
          best[j] = best[i] + cost;
          from[j] = i;
          lay.set(`${i}:${j}`, l.lines);
        }
      }
    }
    const spans: [number, number][] = [];
    for (let j = n; j > 0; j = from[j]) {
      if (from[j] < 0) {
        spans.push([j - 1, j]);
        from[j] = j - 1;
      } else spans.push([from[j], j]);
    }
    spans.reverse();
    for (const [i, j] of spans) {
      const ws = run.slice(i, j);
      const lines = lay.get(`${i}:${j}`) ?? [joinWords(ws)];
      cues.push({
        start: round3(ws[0].start),
        end: round3(ws[ws.length - 1].end),
        text: lines.join("\n"),
        words: ws.map((w) => ({ ...w, start: round3(w.start), end: round3(w.end) })),
      });
    }
  }

  // Timing: hold for reading (min duration, reading speed), chain across short gaps, never overlap.
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const next = cues[i + 1];
    const limit = next ? next.start : Infinity;
    const chars = c.text.replace(/\n/g, " ").length;
    const want = Math.max(c.end + 0.3, c.start + minDuration, c.start + chars / maxCps);
    let end = Math.min(want, c.start + Math.max(maxDuration, c.end - c.start), limit);
    if (next && next.start - end < 0.25) end = next.start; // chain: no flash of empty frame
    c.end = round3(Math.max(end, c.start + 0.05));
  }
  return cues;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

function splitTime(t: number) {
  const ms = Math.max(0, Math.round(t * 1000));
  return {
    h: Math.floor(ms / 3_600_000),
    m: Math.floor((ms % 3_600_000) / 60_000),
    s: Math.floor((ms % 60_000) / 1000),
    ms: ms % 1000,
  };
}

/** "HH:MM:SS,mmm" */
export function srtTime(t: number): string {
  const { h, m, s, ms } = splitTime(t);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** "HH:MM:SS.mmm" */
export function vttTime(t: number): string {
  return srtTime(t).replace(",", ".");
}

/** "H:MM:SS.cc" (ASS uses centiseconds) */
export function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs % 100)}`;
}

export function toSRT(cues: CaptionCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
    .join("\n");
}

export function toVTT(cues: CaptionCue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}\n`).join("\n")}`;
}

export interface AssOptions {
  style?: CaptionStyle | string;
  width?: number;
  height?: number;
  /** Highlight colour for bold-pop, as RRGGBB. Default FFD400 (yellow). */
  highlight?: string;
}

function assEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\r?\n/g, "\\N");
}

/** Word indices after which a "\n" in the cue text breaks the line (empty when the words do not line up). */
export function lineBreaks(text: string, wordCount: number): Set<number> {
  const lines = text.split(/\r?\n/).map((l) => l.split(/\s+/).filter(Boolean));
  const out = new Set<number>();
  if (lines.reduce((a, l) => a + l.length, 0) !== wordCount) return out;
  let n = 0;
  for (const l of lines.slice(0, -1)) {
    n += l.length;
    if (l.length) out.add(n - 1);
  }
  return out;
}

/** RRGGBB -> ASS &HBBGGRR& */
function assColor(rgb: string, alpha = "00"): string {
  const h = rgb.replace(/^#/, "").padStart(6, "0");
  return `&H${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

/**
 * Advanced SubStation Alpha subtitles. "bold-pop" emits one event per word so
 * the word being spoken is highlighted (karaoke style).
 */
export function toASS(cues: CaptionCue[], opts: AssOptions = {}): string {
  // Accept motion-style specs such as "clean:position=top"; only the name matters here.
  const style = ((opts.style ?? "clean").split(/[:?]/)[0] as CaptionStyle) || "clean";
  const W = opts.width ?? 1920;
  const H = opts.height ?? 1080;
  const base = Math.min(W, H);
  const vertical = H > W;
  // Safe zones: 16:9 bottom edge at ~86% of the height (title safe); 9:16 above the platform UI (bottom ~22%).
  const marginV = Math.round(H * (vertical ? 0.22 : 0.14));
  const marginH = Math.round(W * 0.06);
  // Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic,
  // Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment,
  // MarginL, MarginR, MarginV, Encoding
  const styles: Record<CaptionStyle, string> = {
    clean: `Style: Default,Arial,${Math.round(base * 0.06)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(base * 0.004))},${Math.max(1, Math.round(base * 0.002))},2,${marginH},${marginH},${marginV},1`,
    "bold-pop": `Style: Default,Arial Black,${Math.round(base * 0.075)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,1,0,1,${Math.max(3, Math.round(base * 0.007))},${Math.max(1, Math.round(base * 0.003))},2,${marginH},${marginH},${marginV},1`,
    minimal: `Style: Default,Helvetica,${Math.round(base * 0.045)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,3,${Math.max(4, Math.round(base * 0.008))},0,2,${marginH},${marginH},${Math.round(H * (vertical ? 0.18 : 0.05))},1`,
  };
  const header = [
    "[Script Info]",
    "; Generated by OpenEdit",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    styles[style],
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events: string[] = [];
  const dialogue = (s: number, e: number, text: string) =>
    events.push(`Dialogue: 0,${assTime(s)},${assTime(e)},Default,,0,0,0,,${text}`);

  if (style === "bold-pop") {
    const hl = assColor(opts.highlight ?? "FFD400");
    for (const cue of cues) {
      const words = cue.words?.length ? cue.words : [{ text: cue.text, start: cue.start, end: cue.end }];
      const tokens = words.map((w) => assEscape(w.text.trim().toUpperCase()));
      const breaks = lineBreaks(cue.text, words.length);
      words.forEach((w, i) => {
        const s = i === 0 ? cue.start : w.start;
        const e = i === words.length - 1 ? cue.end : words[i + 1].start;
        if (e <= s) return;
        const text = tokens
          .map((t, k) => (k === i ? `{\\c${hl}&\\fscx112\\fscy112}${t}{\\r}` : t) + (k === tokens.length - 1 ? "" : breaks.has(k) ? "\\N" : " "))
          .join("");
        dialogue(s, e, i === 0 ? `{\\fad(60,0)}${text}` : text);
      });
    }
  } else {
    for (const cue of cues) {
      const text = assEscape(cue.text);
      dialogue(cue.start, cue.end, style === "minimal" ? text : `{\\fad(80,80)}${text}`);
    }
  }
  return `${header.join("\n")}\n${events.join("\n")}\n`;
}

export type CaptionPosition = "top" | "middle" | "middle-low" | "bottom";

/**
 * Vertical band (fractions of frame height) a caption occupies for a style and
 * position, matching the caption renderer's layout (two lines at most).
 */
export function captionBand(style: string, position: CaptionPosition | undefined, vertical: boolean): { top: number; bottom: number } {
  const pos = position ?? (style.startsWith("bold-pop") ? "middle-low" : "bottom");
  const lineH = style.startsWith("bold-pop") ? (vertical ? 0.06 : 0.1) : vertical ? 0.035 : 0.065;
  const h = lineH * 2;
  if (pos === "top") return { top: 0.1, bottom: 0.1 + h };
  if (pos === "middle") return { top: 0.5 - h / 2, bottom: 0.5 + h / 2 };
  if (pos === "middle-low") {
    const c = vertical ? 0.66 : 0.74;
    return { top: c - h / 2, bottom: c + h / 2 };
  }
  const b = vertical ? 0.8 : 0.86;
  return { top: b - h, bottom: b };
}

/** Share (0..1) of face samples where a face overlaps the band. Faces are normalised boxes (origin top-left). */
export function faceOverlap(samples: { faces: { y: number; h: number }[] }[], band: { top: number; bottom: number }): number {
  const seen = samples.filter((s) => s.faces.length);
  if (!seen.length) return 0;
  // Chin and neck sit below the detected face box; extend it by 15% of its height.
  const hit = seen.filter((s) => s.faces.some((f) => f.y < band.bottom && f.y + f.h * 1.15 > band.top)).length;
  return hit / seen.length;
}

/**
 * Pick a caption position that keeps captions off faces: the style's default
 * unless faces overlap it in > 15% of samples, then the least-overlapping of
 * bottom / middle-low / top. Pure.
 */
export function placeCaptions(
  samples: { faces: { y: number; h: number }[] }[] | null | undefined,
  style: string,
  vertical: boolean,
): { position?: CaptionPosition; overlap: number; note?: string } {
  if (!samples?.length) return { overlap: 0 };
  const def = faceOverlap(samples, captionBand(style, undefined, vertical));
  if (def <= 0.15) return { overlap: def };
  const options: CaptionPosition[] = ["bottom", "middle-low", "top"];
  const scored = options.map((p) => ({ p, o: faceOverlap(samples, captionBand(style, p, vertical)) })).sort((a, b) => a.o - b.o);
  const best = scored[0];
  if (best.o >= def) return { overlap: def, note: `captions overlap the speaker's face in ${Math.round(def * 100)}% of the shot; no better position found` };
  return { position: best.p, overlap: best.o, note: `moved captions to ${best.p} to keep them off the face (default position overlapped ${Math.round(def * 100)}%)` };
}
