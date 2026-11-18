import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Segment, TimeRange, Transcript, Word } from "../hosts/types.js";
import { run, runWithSignal } from "./exec.js";
import { extractAudio, fileKey, probe, resolveMediaPath } from "./media.js";
import { paths } from "./paths.js";
import { detectSilences } from "./silence.js";

export type WhisperModel = "tiny" | "base" | "small" | "medium" | "large-v3-turbo";
export const WHISPER_MODELS: WhisperModel[] = ["tiny", "base", "small", "medium", "large-v3-turbo"];

export interface TranscribeOptions {
  model?: WhisperModel;
  /** ISO language code, or "auto" (default) to let whisper detect it. */
  language?: string;
  /** Snap word boundaries out of detected silences (whisper timings drift into pauses). Default true. */
  refineWithSilences?: boolean;
  /**
   * Initial prompt for whisper. Default VERBATIM_PROMPT, which makes whisper
   * keep "um"/"uh"/"like" instead of cleaning them out. Pass "" for none.
   */
  prompt?: string;
  /** Ignore the cache. */
  force?: boolean;
  /** Called with human-readable progress (e.g. model download). */
  onProgress?: (msg: string) => void;
}

export interface TranscribeResult {
  transcript: Transcript;
  /** Path to the cached full JSON transcript. */
  jsonPath: string;
  cached: boolean;
}

/** Disfluent example text: whisper imitates the prompt's style and transcribes fillers verbatim. */
export const VERBATIM_PROMPT = "Umm, let me think like, hmm... Okay, here's what I'm, like, thinking. Uh, so, um, yeah.";

/** Cache-key fragment for a prompt ("" when none). */
export function promptKey(prompt: string): string {
  return prompt ? `.p${createHash("sha1").update(prompt).digest("hex").slice(0, 8)}` : "";
}

export function modelPath(model: WhisperModel): string {
  return join(paths.models(), `ggml-${model}.bin`);
}

/** Download the ggml model from Hugging Face if it is not present yet. */
export async function ensureModel(model: WhisperModel, onProgress?: (msg: string) => void): Promise<string> {
  if (!WHISPER_MODELS.includes(model)) throw new Error(`Unknown whisper model "${model}"`);
  const dest = modelPath(model);
  if (existsSync(dest)) return dest;
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`;
  onProgress?.(`Downloading whisper model ${model} from ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Model download failed (${res.status}) for ${url}`);
  // Unique partial name: two first-run transcriptions must not write into the same file.
  const part = `${dest}.${process.pid}-${randomBytes(4).toString("hex")}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(part));
    const expected = Number(res.headers.get("content-length"));
    const got = statSync(part).size;
    if (expected > 0 && got !== expected) throw new Error(`Model download incomplete for ${url}: got ${got} of ${expected} bytes`);
    if (!got) throw new Error(`Model download incomplete for ${url}: empty file`);
    renameSync(part, dest);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  return dest;
}

// ---- whisper.cpp full-JSON parsing ----

interface WhisperToken {
  text: string;
  offsets: { from: number; to: number };
  p?: number;
  /** DTW token time in centiseconds (whisper-cli --dtw); -1 when unavailable. */
  t_dtw?: number;
}

interface WhisperSegment {
  offsets: { from: number; to: number };
  text: string;
  tokens?: WhisperToken[];
}

interface WhisperJson {
  result?: { language?: string };
  transcription: WhisperSegment[];
}

const isSpecial = (t: string) => /^\[_[A-Z]+_?\d*\]$/.test(t.trim()) || /^<\|.*\|>$/.test(t.trim());
const isPunct = (t: string) => /^[\s]*[.,!?;:%)"'\]…–—-]+$/.test(t);

/**
 * whisper sometimes "repeats" a phrase it already heard: the duplicate comes back
 * as a run of words that all have zero length at one instant. Those words were
 * never spoken (and would trigger false retake cuts of the real phrase), so drop
 * runs of 3+ zero-length words. Mutates `dtw` in step with the returned words.
 */
function dropCollapsedRuns(words: Word[], collapsed: boolean[], dtw: (number | undefined)[]): Word[] {
  const drop = new Set<number>();
  for (let i = 0; i < words.length; ) {
    let j = i;
    while (j < words.length && collapsed[j]) j++;
    if (j - i >= 3) for (let k = i; k < j; k++) drop.add(k);
    i = j > i ? j : i + 1;
  }
  if (!drop.size) return words;
  const keptDtw = dtw.filter((_, i) => !drop.has(i));
  dtw.length = 0;
  dtw.push(...keptDtw);
  return words.filter((_, i) => !drop.has(i));
}

/**
 * Use DTW token times (whisper-cli --dtw) for word starts: they are far closer to
 * the audio than the decoder's offsets, which drift by up to ~1 s with small
 * models. A word ends where the next one starts (silence refinement trims it later).
 */
function applyDtw(words: Word[], dtw: number[], duration: number): Word[] {
  const out = words.map((w, i) => ({ ...w, start: round3(Math.min(dtw[i], duration)) }));
  for (let i = 0; i < out.length; i++) {
    if (i > 0 && out[i].start < out[i - 1].start) out[i].start = out[i - 1].start;
  }
  for (let i = 0; i < out.length; i++) {
    const len = Math.min(Math.max(words[i].end - words[i].start, 0.1), 0.8);
    const next = out[i + 1]?.start;
    const end = next !== undefined && next > out[i].start ? next : Math.min(duration, out[i].start + len);
    out[i].end = round3(Math.max(end, out[i].start + 0.01));
  }
  return out;
}

/** Convert whisper.cpp `-ojf` output into a word-level Transcript. Exported for tests. */
export function parseWhisperJson(json: WhisperJson, duration: number): Transcript {
  const segments: Segment[] = [];
  for (const seg of json.transcription ?? []) {
    let words: Word[] = [];
    // Per-word extras, parallel to `words`: DTW start time and whether whisper gave it zero length.
    const dtw: (number | undefined)[] = [];
    const collapsed: boolean[] = [];
    let cur: { text: string; start: number; end: number; probs: number[]; dtw?: number; zero: boolean } | null = null;
    const flush = () => {
      if (cur && cur.text.trim()) {
        const conf = cur.probs.length ? cur.probs.reduce((a, b) => a + b, 0) / cur.probs.length : undefined;
        words.push({
          text: cur.text.trim(),
          start: round3(cur.start),
          end: round3(Math.max(cur.end, cur.start + 0.01)),
          ...(conf !== undefined ? { confidence: Math.round(conf * 1000) / 1000 } : {}),
        });
        dtw.push(cur.dtw);
        collapsed.push(cur.zero);
      }
      cur = null;
    };
    for (const tok of seg.tokens ?? []) {
      if (!tok.text || isSpecial(tok.text)) continue;
      const from = tok.offsets.from / 1000;
      const to = tok.offsets.to / 1000;
      const startsWord = tok.text.startsWith(" ");
      if (cur && !startsWord) {
        // Continuation of the current word (sub-word piece or trailing punctuation).
        cur.text += tok.text;
        if (!isPunct(tok.text)) {
          cur.end = Math.max(cur.end, to);
          if (to > from) cur.zero = false;
        }
        if (tok.p !== undefined) cur.probs.push(tok.p);
        continue;
      }
      if (!startsWord && !cur && isPunct(tok.text) && words.length) {
        words[words.length - 1].text += tok.text.trim();
        continue;
      }
      flush();
      cur = {
        text: tok.text,
        start: from,
        end: to,
        probs: tok.p !== undefined ? [tok.p] : [],
        dtw: typeof tok.t_dtw === "number" && tok.t_dtw >= 0 ? tok.t_dtw / 100 : undefined,
        zero: !(to > from),
      };
    }
    flush();
    words = dropCollapsedRuns(words, collapsed, dtw);
    if (dtw.length && dtw.every((d) => d !== undefined)) words = applyDtw(words, dtw as number[], duration);
    if (!words.length) continue;
    segments.push({
      text: words.map((w) => w.text).join(" "),
      start: words[0].start,
      end: words[words.length - 1].end,
      words,
    });
  }
  return { language: json.result?.language ?? "en", duration, segments };
}

/**
 * whisper's token timestamps drift into pauses (badly so with small models).
 * Using detected silences as ground truth: trim words that overlap a silence
 * back onto the speech side, and move words that fall entirely inside a
 * silence to the nearer edge of that silence. Order is kept monotonic.
 */
export function refineWords(t: Transcript, silences: TimeRange[]): Transcript {
  const MIN = 0.04;
  const sil = [...silences].sort((a, b) => a.start - b.start);
  const segments = t.segments.map((seg) => {
    const words = seg.words.map((w, idx) => {
      let { start, end } = w;
      const len = end - start;
      const inside = sil.find((s) => s.start <= start && s.end >= end);
      if (inside) {
        // Snap to whichever edge of the pause the word is closer to.
        const mid = (start + end) / 2;
        const after = inside.end - mid <= mid - inside.start && inside.end < t.duration - MIN;
        const span = Math.min(len, 0.4);
        if (after) {
          const next = seg.words[idx + 1];
          const limit = next && next.start > inside.end ? next.start : Infinity;
          start = inside.end;
          end = Math.max(start + 0.05, Math.min(t.duration, inside.end + span, limit));
        } else {
          const prev = seg.words[idx - 1];
          const limit = prev && prev.end < inside.start ? prev.end : -Infinity;
          end = inside.start;
          start = Math.min(end - 0.05, Math.max(0, inside.start - span, limit));
        }
      } else {
        for (const s of sil) {
          if (s.end <= start || s.start >= end) continue;
          if (s.start <= start) start = s.end;
          else if (s.end >= end) end = s.start;
          // silence strictly inside the word: keep the longer side
          else if (s.start - start >= end - s.end) end = s.start;
          else start = s.end;
        }
        if (end - start < MIN) start = Math.max(0, end - MIN);
      }
      return { ...w, start: round3(start), end: round3(end) };
    });
    for (let i = 1; i < words.length; i++) {
      const prev = words[i - 1];
      if (words[i].start < prev.start) words[i].start = prev.start;
      if (words[i].end < words[i].start + 0.01) words[i].end = round3(words[i].start + 0.01);
      if (prev.end > words[i].start && words[i].start - prev.start >= MIN) prev.end = words[i].start;
    }
    return { ...seg, words, start: words[0].start, end: words[words.length - 1].end };
  });
  return { ...t, segments };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Transcribe a media file locally with whisper.cpp, with word-level timestamps. Cached. */
export async function transcribe(path: string, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
  const abs = resolveMediaPath(path);
  const model = opts.model ?? "base";
  const language = opts.language ?? "auto";
  const refine = opts.refineWithSilences ?? true;
  const key = await fileKey(abs);
  const prompt = opts.prompt ?? VERBATIM_PROMPT;
  const dtw = await dtwArgs(model);
  const jsonPath = join(
    paths.transcripts(),
    `${key}.${model}.${language}${dtw.length ? ".dtw" : ""}${promptKey(prompt)}${refine ? "" : ".raw"}.json`,
  );
  if (!opts.force && existsSync(jsonPath)) {
    return { transcript: JSON.parse(readFileSync(jsonPath, "utf8")) as Transcript, jsonPath, cached: true };
  }

  const info = await probe(abs);
  if (!info.hasAudio) throw new Error(`No audio stream in ${abs}`);
  const modelFile = await ensureModel(model, opts.onProgress);
  const wav = await extractAudio(abs);
  const outBase = join(paths.tmp(), `whisper-${key}-${process.pid}-${Date.now()}`);
  opts.onProgress?.(`Transcribing ${abs} with whisper ${model}`);
  const whisperArgs = ["-m", modelFile, "-f", wav, "-l", language, "-ojf", "-of", outBase, "-np", "-t", String(threads())];
  if (prompt) whisperArgs.push("--prompt", prompt);
  const timeoutMs = Math.max(10 * 60_000, info.duration * 1000 * 4);
  try {
    await run("whisper-cli", [...whisperArgs, ...dtw], { timeoutMs });
  } catch (e) {
    if (!dtw.length) throw e;
    // DTW is an accuracy bonus; never let it break transcription.
    await run("whisper-cli", whisperArgs, { timeoutMs });
  }
  const rawPath = `${outBase}.json`;
  if (!existsSync(rawPath)) throw new Error("whisper-cli produced no JSON output");
  const raw = JSON.parse(readFileSync(rawPath, "utf8")) as WhisperJson;
  rmSync(rawPath, { force: true });

  let transcript = parseWhisperJson(raw, info.duration);
  if (refine && transcript.segments.length) {
    const silences = await detectSilences(abs, { thresholdDb: -40, minDuration: 0.25 });
    transcript = refineWords(transcript, silences);
  }
  // Atomic: a concurrent reader (another tool call) must never see a half-written cache file.
  const tmpJson = `${jsonPath}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmpJson, JSON.stringify(transcript, null, 1));
  renameSync(tmpJson, jsonPath);
  return { transcript, jsonPath, cached: false };
}

let whisperHelp: Promise<string> | null = null;

/**
 * `--dtw <preset>` gives accurate token times. It needs flash attention off
 * (whisper.cpp >= 1.8 enables it by default), so only use it when this
 * whisper-cli offers both flags. Set OPENEDIT_WHISPER_DTW=0 to disable.
 */
async function dtwArgs(model: WhisperModel): Promise<string[]> {
  if (process.env.OPENEDIT_WHISPER_DTW === "0") return [];
  // Shared across calls: never tie it to (and cancel it with) the first caller's request.
  whisperHelp ??= runWithSignal(undefined, () => run("whisper-cli", ["-h"], { allowFailure: true, timeoutMs: 20_000 }))
    .then((r) => `${r.stdout}\n${r.stderr}`)
    .catch(() => "");
  const help = await whisperHelp;
  if (!/--dtw\b/.test(help)) return [];
  const args = ["-dtw", model.replace(/-/g, ".")];
  if (/--no-flash-attn\b/.test(help)) args.push("-nfa");
  else if (/--flash-attn\b/.test(help)) return []; // flash attention on and no way to turn it off
  return args;
}

function threads(): number {
  return Math.max(2, Math.min(8, availableParallelism()));
}

/** "[mm:ss.s]" timestamp. */
export function stamp(t: number): string {
  // Round to tenths first so 59.97 prints as 01:00.0, never 00:60.0.
  const tenths = Math.round(Math.max(0, t) * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return `[${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}]`;
}

/** Compact, Claude-friendly transcript: one line per segment with a timestamp. */
export function transcriptToText(t: Transcript): string {
  return t.segments.map((s) => `${stamp(s.start)} ${s.text}`).join("\n");
}

/** Flatten all words in order. */
export function allWords(t: Transcript): Word[] {
  return t.segments.flatMap((s) => s.words);
}
