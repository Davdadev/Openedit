import type { CaptionCue, CutPlan, Transcript, Word } from "../hosts/types.js";

export type CaptionStyle = "clean" | "bold-pop" | "minimal";
export const CAPTION_STYLES: CaptionStyle[] = ["clean", "bold-pop", "minimal"];

export interface CueOptions {
  maxChars?: number;
  maxWords?: number;
  /** Start a new cue when the pause between words exceeds this (s). Default 0.7. */
  maxGap?: number;
  /** Remap word times through this plan so cues line up with the cut edit. */
  plan?: Pick<CutPlan, "keep">;
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

/** Group transcript words into short, readable caption cues. */
export function cuesFromTranscript(t: Transcript, opts: CueOptions = {}): CaptionCue[] {
  const maxChars = opts.maxChars ?? 32;
  const maxWords = opts.maxWords ?? 6;
  const maxGap = opts.maxGap ?? 0.7;

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

  const cues: CaptionCue[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    cues.push({
      start: round3(cur[0].start),
      end: round3(cur[cur.length - 1].end),
      text: cur.map((w) => w.text.trim()).join(" "),
      words: cur.map((w) => ({ ...w, start: round3(w.start), end: round3(w.end) })),
    });
    cur = [];
  };
  for (const w of words) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const text = `${cur.map((x) => x.text.trim()).join(" ")} ${w.text.trim()}`;
      const sentenceEnd = /[.!?…]["')\]]*$/.test(prev.text.trim());
      if (cur.length >= maxWords || text.length > maxChars || w.start - prev.end > maxGap || sentenceEnd) flush();
    }
    cur.push(w);
  }
  flush();

  // Readability: hold each cue a little longer (up to 0.4 s) without overlapping the next.
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    const limit = next ? next.start : Infinity;
    cues[i].end = round3(Math.min(Math.max(cues[i].end, cues[i].start + 0.3) + 0.25, limit, cues[i].end + 0.4));
    if (cues[i].end <= cues[i].start) cues[i].end = round3(cues[i].start + 0.05);
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
  style?: CaptionStyle;
  width?: number;
  height?: number;
  /** Highlight colour for bold-pop, as RRGGBB. Default FFD400 (yellow). */
  highlight?: string;
}

function assEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\r?\n/g, "\\N");
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
  const style = opts.style ?? "clean";
  const W = opts.width ?? 1920;
  const H = opts.height ?? 1080;
  const base = Math.min(W, H);
  const vertical = H > W;
  const marginV = Math.round(H * (vertical ? 0.22 : 0.08));
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
      words.forEach((w, i) => {
        const s = i === 0 ? cue.start : w.start;
        const e = i === words.length - 1 ? cue.end : words[i + 1].start;
        if (e <= s) return;
        const text = tokens
          .map((t, k) => (k === i ? `{\\c${hl}&\\fscx112\\fscy112}${t}{\\r}` : t))
          .join(" ");
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
