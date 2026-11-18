import type { Cut, CutPlan, CutReason, TimeRange, Transcript, Word } from "../hosts/types.js";
import { editDuration } from "./remap.js";
import { type AdaptiveLevels, type EnergyEnvelope, adaptiveLevels, quietestNear, smooth, spokenEnd } from "./vad.js";

/** Hesitation sounds. These are always safe to remove. */
export const DEFAULT_FILLERS = ["um", "umm", "uh", "uhh", "uhm", "erm", "er", "ah", "ahh", "hmm", "hm", "mm", "mhm"];
/**
 * Words that are fillers only in some contexts ("it was, like, huge" vs "I would like that").
 * Pass them in fillerWords to opt in; they are then removed only when isolated (see isFillerInContext).
 */
export const CONTEXT_FILLERS = ["like", "so", "you know", "i mean", "kind of", "sort of", "basically", "literally", "actually", "right", "well", "okay"];

export type Tightness = "loose" | "normal" | "tight";

/**
 * Pacing presets.
 *  - minSilence: shortest pause considered for shortening (s)
 *  - keepPause: pause left in place of a shortened one (s). Pauses are SHORTENED to this, never
 *    removed to zero, so speech keeps its breaths and rhythm. Sentence ends get ~30% more,
 *    mid-phrase pauses ~20% less.
 *  - minKeep: shortest kept piece (s); shorter pieces are merged with a neighbour instead.
 */
export const TIGHTNESS: Record<Tightness, { minSilence: number; keepPause: number; minKeep: number }> = {
  loose: { minSilence: 0.9, keepPause: 0.45, minKeep: 0.5 },
  normal: { minSilence: 0.6, keepPause: 0.32, minKeep: 0.4 },
  tight: { minSilence: 0.45, keepPause: 0.22, minKeep: 0.3 },
};

/** Share of a kept pause left AFTER the last word (word tails decay; onsets are sharp). */
export const TAIL_SHARE = 0.6;
/** Never leave less than this after a word (decaying tail, s) / before a word (plosive onset, s). */
export const MIN_TAIL = 0.1;
export const MIN_HEAD = 0.07;
/** A silence cut must remove at least this much (s): smaller jumps cost a visible jump cut for nothing. */
export const MIN_REMOVE = 0.2;
/** How far (s) a cut edge may move to land on the quietest 10 ms. */
export const SNAP_WINDOW = 0.04;

export interface CutPlanInput {
  source: string;
  duration: number;
  /** Silent ranges to shorten (from detectSilences / transcriptPauses). */
  silences?: TimeRange[];
  transcript?: Transcript;
  removeFillers?: boolean;
  /** Filler words/phrases (case-insensitive). Multi-word phrases like "you know" are supported. */
  fillerWords?: string[];
  /** Remove earlier attempts of restarted sentences (needs transcript). */
  removeRetakes?: boolean;
  retakeWindow?: number;
  /** Preset for keepPause / minKeep (explicit values win). Default "normal". */
  tightness?: Tightness;
  /** Pause (s) left where a longer one is shortened. Default from tightness (0.32). 0 = remove pauses entirely. */
  keepPause?: number;
  /**
   * Legacy symmetric padding (s) around speech at each cut. When set it replaces the
   * asymmetric tail/head split of keepPause.
   */
  padding?: number;
  /** Kept pieces shorter than this (s) are merged with a neighbour. Default from tightness (0.4). */
  minKeep?: number;
  /** Extra ranges to remove, e.g. chosen by Claude from the transcript. Snapped to word boundaries. */
  manualCuts?: (TimeRange & { label?: string })[];
  /**
   * Fine (10 ms) voice-band energy envelope. Used to protect word tails / onsets that run
   * past the transcript timings and to land cut edges on the quietest 10 ms.
   */
  energy?: EnergyEnvelope;
  levels?: AdaptiveLevels;
}

export function normalizeWord(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "").replace(/^'+|'+$/g, "");
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Sort and merge overlapping/touching cuts. The merged cut keeps the reason that covers the most time. */
export function mergeCuts(cuts: Cut[], tolerance = 0.001): Cut[] {
  const sorted = cuts.filter((c) => c.end > c.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: (Cut & { _w: Map<CutReason, number>; _labels: string[] })[] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.start <= last.end + tolerance) {
      last.end = Math.max(last.end, c.end);
      last._w.set(c.reason, (last._w.get(c.reason) ?? 0) + (c.end - c.start));
      if (c.label) last._labels.push(c.label);
    } else {
      out.push({ ...c, _w: new Map([[c.reason, c.end - c.start]]), _labels: c.label ? [c.label] : [] });
    }
  }
  return out.map(({ _w, _labels, ...c }) => {
    let reason = c.reason;
    let best = -1;
    for (const [r, w] of _w) if (w > best) [reason, best] = [r, w];
    const cut: Cut = { start: c.start, end: c.end, reason };
    const labels = [...new Set(_labels)];
    if (labels.length) cut.label = labels.join("; ");
    return cut;
  });
}

/** Complement of `cuts` within [0, duration]. */
export function invertRanges(cuts: TimeRange[], duration: number): TimeRange[] {
  const keep: TimeRange[] = [];
  let pos = 0;
  for (const c of [...cuts].sort((a, b) => a.start - b.start)) {
    if (c.start > pos) keep.push({ start: pos, end: Math.min(c.start, duration) });
    pos = Math.max(pos, c.end);
    if (pos >= duration) break;
  }
  if (pos < duration) keep.push({ start: pos, end: duration });
  return keep.filter((k) => k.end > k.start);
}

const HESITATIONS = new Set(DEFAULT_FILLERS);
/** Words after which "like" is a verb / comparison, not a filler ("I would like", "looks like"). */
const LIKE_LEFT = new Set([
  "would", "i'd", "you'd", "we'd", "they'd", "he'd", "she'd", "look", "looks", "looked", "feel", "feels", "felt", "sound", "sounds",
  "seem", "seems", "something", "anything", "nothing", "things", "just", "more", "much", "not", "don't", "didn't", "doesn't",
  "be", "is", "was", "are", "were", "i", "you", "we", "they", "really", "also", "still", "exactly",
]);
/** After "so" these make it an adverb/conjunction with meaning ("so that", "so much"). */
const SO_RIGHT = new Set(["that", "much", "many", "far", "long", "good", "bad", "well", "to", "is", "was", "are", "if"]);
const BREAK_AFTER = /[,;:…—–-]["')\]]*$/;
const SENTENCE_END = /[.!?]["')\]]*$/;

/**
 * Is the phrase words[i..i+len) a filler here? Hesitations (um, uh…) always are.
 * Other words only when isolated: a comma or a pause (>= 0.25 s) on both sides,
 * not ending a sentence ("I think so."), and not in a meaningful construction
 * ("I would like", "so that", "you know what").
 */
export function isFillerInContext(words: Word[], i: number, len: number): boolean {
  const phrase = words.slice(i, i + len).map((w) => normalizeWord(w.text));
  if (len === 1 && HESITATIONS.has(phrase[0])) return true;
  const prev = words[i - 1];
  const last = words[i + len - 1];
  const next = words[i + len];
  if (SENTENCE_END.test(last.text.trim())) return false;
  const leftBreak = !prev || SENTENCE_END.test(prev.text.trim()) || BREAK_AFTER.test(prev.text.trim()) || words[i].start - spokenEnd(prev) >= 0.25;
  const rightBreak = !next || BREAK_AFTER.test(last.text.trim()) || next.start - spokenEnd(last) >= 0.25;
  if (!leftBreak || !rightBreak) return false;
  const nNext = next ? normalizeWord(next.text) : "";
  const joined = phrase.join(" ");
  if (joined === "like" && prev && !BREAK_AFTER.test(prev.text.trim()) && LIKE_LEFT.has(normalizeWord(prev.text))) return false;
  if (joined === "so" && SO_RIGHT.has(nNext) && !BREAK_AFTER.test(last.text.trim())) return false;
  if ((joined === "you know" || joined === "i mean") && ["what", "that", "how", "why", "who", "where", "when"].includes(nNext) && !BREAK_AFTER.test(last.text.trim()))
    return false;
  return true;
}

/** Cuts for filler words / phrases found in the transcript (context-checked, see isFillerInContext). */
export function detectFillers(transcript: Transcript, fillerWords: string[] = DEFAULT_FILLERS): Cut[] {
  const words = transcript.segments.flatMap((s) => s.words);
  const norm = words.map((w) => normalizeWord(w.text));
  const phrases = fillerWords
    .map((f) => f.split(/\s+/).map(normalizeWord).filter(Boolean))
    .filter((p) => p.length)
    .sort((a, b) => b.length - a.length);
  const cuts: Cut[] = [];
  for (let i = 0; i < words.length; i++) {
    for (const p of phrases) {
      if (p.every((tok, k) => norm[i + k] === tok) && isFillerInContext(words, i, p.length)) {
        const last = words[i + p.length - 1];
        cuts.push({ start: words[i].start, end: last.end, reason: "filler", label: p.join(" ") });
        i += p.length - 1;
        break;
      }
    }
  }
  return cuts;
}

export interface RetakeOptions {
  /** Max seconds between the start of the abandoned attempt and the restart. Default 10. */
  window?: number;
  /** Leading words that must match for a full-sentence retake. Default 4. */
  minMatch?: number;
  /** Longest single retake cut, seconds. Default 15. */
  maxCut?: number;
  fillerWords?: string[];
}

export interface Retake {
  cut: Cut;
  /** The abandoned attempt (removed). */
  attempt: string;
  /** The start of the kept restart. */
  restart: string;
  /** How many leading words matched. */
  matched: number;
  why: string;
}

/** Ordered similarity of the first n tokens of two word lists (0..1). */
export function leadingSimilarity(a: string[], b: string[], n = 5): number {
  const x = a.slice(0, n);
  const y = b.slice(0, n);
  if (!x.length || !y.length) return 0;
  // LCS on short prefixes.
  const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = 1; i <= x.length; i++)
    for (let j = 1; j <= y.length; j++)
      dp[i][j] = x[i - 1] === y[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[x.length][y.length] / Math.max(x.length, y.length);
}

/**
 * Retake detection: a phrase is started, abandoned and started again. To avoid
 * cutting real content (people repeat sentence openings on purpose), a match needs
 *  - the same opening at a later phrase start within `window` seconds, with either
 *    >= minMatch (4) identical leading words, >= 80% similarity of the first 5 words
 *    (4+ words compared), or an unfinished fragment that is exactly a 2-3 word prefix
 *    of the restart ("so the — so the plan is");
 *  - evidence the first attempt was abandoned: it does not end a sentence, or is
 *    followed by a pause / filler, or is entirely repeated by the restart;
 *  - a cut no longer than `maxCut` (15 s).
 * Zero-length (collapsed / hallucinated) words are ignored. The earlier attempt
 * is cut, from its first word to the restart.
 */
export function findRetakes(transcript: Transcript, opts: RetakeOptions = {}): Retake[] {
  const window = opts.window ?? 10;
  const minMatch = opts.minMatch ?? 4;
  const maxCut = opts.maxCut ?? 15;
  const fillers = new Set((opts.fillerWords ?? DEFAULT_FILLERS).map(normalizeWord));
  const words: (Word & { n: string; segStart: boolean })[] = [];
  for (const seg of transcript.segments) {
    seg.words.forEach((w, k) => {
      const n = normalizeWord(w.text);
      if (n && w.end - w.start > 0.015) words.push({ ...w, n, segStart: k === 0 });
    });
  }
  const gapBefore = (i: number) => (i === 0 ? Infinity : words[i].start - spokenEnd(words[i - 1]));
  const isPhraseStart = (i: number): boolean => {
    if (i === 0 || words[i].segStart) return true;
    const prev = words[i - 1];
    if (/[.!?,;:…—-]$/.test(prev.text.trim())) return true;
    if (fillers.has(prev.n)) return true;
    return gapBefore(i) >= 0.35;
  };
  const starts = words.map((_, i) => i).filter(isPhraseStart);
  const out: Retake[] = [];
  let si = 0;
  while (si < starts.length) {
    const i = starts[si];
    if (fillers.has(words[i].n)) {
      si++;
      continue;
    }
    let found: Retake | null = null;
    let foundSj = -1;
    for (let sj = si + 1; sj < starts.length && !found; sj++) {
      const j = starts[sj];
      if (words[j].start - words[i].start > window) break;
      if (fillers.has(words[j].n)) continue;
      const attemptLen = j - i;
      let m = 0;
      while (i + m < j && j + m < words.length && words[i + m].n === words[j + m].n) m++;
      const content = words.slice(i, j).filter((w) => !fillers.has(w.n));
      const sim = leadingSimilarity(content.map((w) => w.n), words.slice(j, j + 8).filter((w) => !fillers.has(w.n)).map((w) => w.n));
      const compared = Math.min(5, content.length, words.length - j);
      let why = "";
      if (m >= minMatch) why = `${m} leading words repeated`;
      else if (compared >= 4 && sim >= 0.8) why = `first words ${Math.round(sim * 100)}% similar`;
      else if (m >= 2 && m === content.length && m <= 3) why = `abandoned "${content.map((w) => w.text).join(" ")}" restarted`;
      if (!why) continue;
      const lastAttempt = words[j - 1];
      const endsSentence = /[.!?]["')\]]*$/.test(lastAttempt.text.trim());
      const pause = gapBefore(j) >= 0.3 || fillers.has(lastAttempt.n) || /[,…—-]$/.test(lastAttempt.text.trim());
      const short = attemptLen <= m; // the whole attempt is repeated by the restart
      if (endsSentence && !pause && !short) continue; // a finished sentence, not an abandoned one
      // A 2-3 word fragment counts only if it was cut off mid-sentence ("Empty document. Empty document." is deliberate).
      if (why.startsWith("abandoned") && endsSentence) continue;
      const cutLen = words[j].start - words[i].start;
      if (cutLen > maxCut || cutLen <= 0) continue;
      const attempt = words.slice(i, j).map((w) => w.text).join(" ");
      const restart = words.slice(j, j + Math.max(m, 6)).map((w) => w.text).join(" ");
      found = {
        cut: {
          start: words[i].start,
          end: words[j].start,
          reason: "retake",
          label: `retake: "${attempt.length > 80 ? `${attempt.slice(0, 77)}...` : attempt}"`,
        },
        attempt,
        restart,
        matched: m,
        why,
      };
      foundSj = sj;
    }
    if (!found) {
      si++;
      continue;
    }
    out.push(found);
    si = foundSj;
  }
  return out;
}

/** Retake cuts (see findRetakes). */
export function detectRetakes(transcript: Transcript, opts: RetakeOptions = {}): Cut[] {
  return findRetakes(transcript, opts).map((r) => r.cut);
}

/**
 * Move a range's edges off words: an edge inside a word goes to that word's
 * nearer boundary, so a cut never starts or ends mid-word.
 */
export function snapToWords(r: TimeRange, words: Word[]): TimeRange {
  let { start, end } = r;
  for (const w of words) {
    const we = spokenEnd(w);
    if (start > w.start && start < we) start = start - w.start < (we - w.start) / 2 ? w.start : we;
    if (end > w.start && end < we) end = end - w.start < (we - w.start) / 2 ? w.start : we;
  }
  return { start, end: Math.max(start, end) };
}

/** Subtract `holes` from [a, b]. */
function subtract(a: number, b: number, holes: TimeRange[]): TimeRange[] {
  let parts: TimeRange[] = [{ start: a, end: b }];
  for (const h of holes) {
    if (h.end <= a || h.start >= b) continue;
    parts = parts.flatMap((p) => {
      if (h.end <= p.start || h.start >= p.end) return [p];
      const out: TimeRange[] = [];
      if (h.start > p.start) out.push({ start: p.start, end: h.start });
      if (h.end < p.end) out.push({ start: h.end, end: p.end });
      return out;
    });
  }
  return parts.filter((p) => p.end - p.start > 1e-6);
}

/**
 * Build the edit decision: which source ranges to keep.
 *
 * Professional pacing rules:
 *  - pauses are SHORTENED to `keepPause` (more at sentence ends, less mid-phrase), not removed;
 *    the kept pause is split asymmetrically: ~60% after the last word (tails decay), ~40%
 *    before the next (onsets are sharp, but plosives need a run-up);
 *  - never cut inside a (kept) word; manual cuts are snapped to word boundaries; with an
 *    energy envelope, word tails / onsets that outlast the transcript timings are protected
 *    and each edge lands on the quietest 10 ms within ±40 ms;
 *  - removals smaller than MIN_REMOVE are skipped (a jump cut for nothing);
 *  - kept pieces shorter than `minKeep` are merged with a neighbour by restoring the adjacent
 *    pause (speech is never dropped to satisfy minKeep; pure-silence slivers are removed).
 */
export function buildCutPlan(input: CutPlanInput): CutPlan {
  const { source, duration } = input;
  const preset = TIGHTNESS[input.tightness ?? "normal"];
  const keepPause = input.keepPause ?? preset.keepPause;
  const minKeep = input.minKeep ?? preset.minKeep;
  const words = (input.transcript?.segments.flatMap((s) => s.words) ?? [])
    .filter((w) => normalizeWord(w.text) && w.end - w.start > 0.015)
    .sort((a, b) => a.start - b.start);

  // 1. Content to remove (fillers, retakes, manual) and pauses to shorten.
  const content: Cut[] = [];
  if (input.transcript && input.removeFillers) content.push(...detectFillers(input.transcript, input.fillerWords));
  if (input.transcript && input.removeRetakes) {
    content.push(...detectRetakes(input.transcript, { window: input.retakeWindow, fillerWords: input.fillerWords }));
  }
  for (const m of input.manualCuts ?? []) {
    const r = snapToWords({ start: m.start, end: m.end }, words);
    content.push({ ...r, reason: "manual", ...(m.label ? { label: m.label } : {}) });
  }
  const contentCuts = content
    .map((c) => ({ ...c, start: Math.max(0, c.start), end: Math.min(duration, c.end) }))
    .filter((c) => c.end > c.start);
  const inContent = (t: number) => contentCuts.some((c) => t >= c.start && t <= c.end);
  const kept = words.filter((w) => !inContent((w.start + spokenEnd(w)) / 2));

  // Energy: protect sounding tails / early onsets the transcript timings miss.
  const env = input.energy?.db.length ? { hop: input.energy.hop, db: smooth(input.energy.db) } : undefined;
  const lv = input.levels ?? (env ? adaptiveLevels(env.db) : undefined);
  const gate = lv ? Math.max(lv.thresholdDb, (lv.floorDb + lv.speechDb) / 2) : 0;
  const loudAt = (t: number) => !!env && (env.db[Math.floor(t / env.hop)] ?? -120) > gate;
  const nextStart = new Map<Word, number>();
  words.forEach((w, i) => nextStart.set(w, words[i + 1]?.start ?? duration));
  const tailEnd = (w: Word) => {
    let e = spokenEnd(w);
    // A tail may ring past the (estimated) word end, but not into the next word.
    const limit = Math.min(nextStart.get(w) ?? duration, Math.max(w.end, e) + 0.35);
    if (env) while (e < limit && loudAt(e)) e += env.hop;
    return e;
  };
  const onset = (w: Word) => {
    let s = w.start;
    if (env) for (let k = 0; k < 15 && s > 0 && loudAt(s - env.hop); k++) s -= env.hop;
    return s;
  };
  const speech: TimeRange[] = kept.map((w) => ({ start: onset(w), end: tailEnd(w) }));

  // 2. Regions: union of pauses and content, minus kept speech.
  const regions = mergeCuts([
    ...(input.silences ?? []).map((s) => ({ start: Math.max(0, s.start), end: Math.min(duration, s.end), reason: "silence" as CutReason })),
    ...contentCuts,
  ]);
  const cuts: Cut[] = [];
  for (const reg of regions) {
    for (const sub of subtract(reg.start, reg.end, speech)) {
      const core = contentCuts.filter((c) => c.start < sub.end && c.end > sub.start);
      const ca = core.length ? Math.max(sub.start, Math.min(...core.map((c) => c.start))) : NaN;
      const cb = core.length ? Math.min(sub.end, Math.max(...core.map((c) => c.end))) : NaN;
      // Speech edges around the region.
      const prevEnd = speech.filter((r) => r.end <= sub.start + 1e-6).reduce((m, r) => Math.max(m, r.end), -Infinity);
      const nextStart = speech.filter((r) => r.start >= sub.end - 1e-6).reduce((m, r) => Math.min(m, r.start), Infinity);
      const Ls = core.length && Number.isFinite(prevEnd) ? Math.min(ca, prevEnd) : sub.start;
      const Rs = core.length && Number.isFinite(nextStart) ? Math.max(cb, nextStart) : sub.end;
      const atStart = Ls <= 0.001 && !Number.isFinite(prevEnd);
      const atEnd = Rs >= duration - 0.001 && !Number.isFinite(nextStart);
      const prevWord = [...kept].reverse().find((w) => w.start < Ls + 1e-6);
      const prevText = prevWord?.text.trim() ?? "";
      const P = keepPause * (SENTENCE_END.test(prevText) ? 1.3 : BREAK_AFTER.test(prevText) ? 1 : 0.8);
      let tail: number;
      let head: number;
      if (input.padding !== undefined) {
        tail = head = input.padding;
      } else {
        tail = Math.max(MIN_TAIL, P * TAIL_SHARE);
        head = Math.max(MIN_HEAD, P - tail);
      }
      if (atStart) tail = 0;
      if (atStart) head = Math.max(head, 0.12); // lead-in before the first word
      if (atEnd) head = 0;
      if (atEnd) tail = Math.max(tail, 0.45); // let the last word ring out
      let a: number;
      let b: number;
      if (core.length) {
        // Leave up to the wanted pause around removed content, borrowing from the side with room.
        const SL = ca - Ls;
        const SR = Rs - cb;
        let t = Math.min(SL, tail);
        let h = Math.min(SR, head);
        const want = atStart || atEnd ? t + h : tail + head;
        if (t + h < want) t = Math.min(SL, t + (want - t - h));
        if (t + h < want) h = Math.min(SR, h + (want - t - h));
        a = Ls + t;
        b = Rs - h;
      } else {
        if (Rs - Ls - tail - head < MIN_REMOVE) continue;
        a = Ls + tail;
        b = Rs - head;
      }
      // Land each edge on the quietest 10 ms nearby, without eating into the protected tail/onset.
      if (input.energy?.db.length) {
        const fine = input.energy;
        if (!atStart) a = quietestNear(fine, a, Math.max(Ls + Math.min(MIN_TAIL, a - Ls), a - SNAP_WINDOW), core.length ? Math.min(a + SNAP_WINDOW, ca) : Math.min(a + SNAP_WINDOW, b - 0.05));
        if (!atEnd) b = quietestNear(fine, b, core.length ? Math.max(b - SNAP_WINDOW, cb) : Math.max(b - SNAP_WINDOW, a + 0.05), Math.min(Rs - Math.min(MIN_HEAD, Rs - b), b + SNAP_WINDOW));
      }
      if (atStart) a = 0;
      if (atEnd) b = duration;
      if (b - a < (core.length ? 0.02 : MIN_REMOVE * 0.75)) continue;
      const reason = core.length ? (core.length === 1 ? core[0].reason : mergeCuts(core)[0].reason) : "silence";
      const labels = [...new Set(core.map((c) => c.label).filter(Boolean))];
      cuts.push({ start: a, end: b, reason, ...(labels.length ? { label: labels.join("; ") } : {}) });
    }
  }
  let merged = mergeCuts(cuts);

  // 3. Micro-segments: a kept piece shorter than minKeep is merged with a neighbour.
  const accepted = new Set<number>();
  for (let iter = 0; iter < 200; iter++) {
    const keeps = invertRanges(merged, duration);
    const short = keeps.find((k) => k.end - k.start < minKeep && keeps.length > 1 && !accepted.has(Math.round(k.start * 1000)));
    if (!short) break;
    const hasSpeech = words.length
      ? kept.some((w) => (w.start + spokenEnd(w)) / 2 > short.start && (w.start + spokenEnd(w)) / 2 < short.end)
      : true;
    const left = merged.findIndex((c) => Math.abs(c.end - short.start) < 0.002);
    const right = merged.findIndex((c) => Math.abs(c.start - short.end) < 0.002);
    if (!hasSpeech) {
      merged = mergeCuts([...merged, { start: short.start, end: short.end, reason: merged[left]?.reason ?? merged[right]?.reason ?? "silence" }]);
      continue;
    }
    // Restore the shorter adjacent pause cut; never drop speech.
    const cands = [left, right].filter((i) => i >= 0 && merged[i].reason === "silence");
    if (!cands.length) {
      // Between two content cuts: nothing safe to restore; keep the (short) speech.
      accepted.add(Math.round(short.start * 1000));
      continue;
    }
    const pick = cands.sort((x, y) => merged[x].end - merged[x].start - (merged[y].end - merged[y].start))[0];
    merged = merged.filter((_, i) => i !== pick);
  }

  const keep = invertRanges(merged, duration).map((k) => ({ start: round3(k.start), end: round3(k.end) }));
  return {
    source,
    duration,
    keep,
    cuts: merged.map((c) => ({ ...c, start: round3(c.start), end: round3(c.end) })),
  };
}

export interface PlanSummary {
  originalDuration: number;
  editedDuration: number;
  timeSaved: number;
  percentSaved: number;
  keptSegments: number;
  cutsByReason: Record<CutReason, { count: number; seconds: number }>;
}

export function summarizePlan(plan: CutPlan): PlanSummary {
  const edited = editDuration(plan);
  const cutsByReason: PlanSummary["cutsByReason"] = {
    silence: { count: 0, seconds: 0 },
    filler: { count: 0, seconds: 0 },
    retake: { count: 0, seconds: 0 },
    manual: { count: 0, seconds: 0 },
  };
  for (const c of plan.cuts) {
    cutsByReason[c.reason].count++;
    cutsByReason[c.reason].seconds = round3(cutsByReason[c.reason].seconds + (c.end - c.start));
  }
  return {
    originalDuration: round3(plan.duration),
    editedDuration: round3(edited),
    timeSaved: round3(plan.duration - edited),
    percentSaved: plan.duration ? Math.round(((plan.duration - edited) / plan.duration) * 1000) / 10 : 0,
    keptSegments: plan.keep.length,
    cutsByReason,
  };
}
