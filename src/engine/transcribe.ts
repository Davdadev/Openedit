import { createWriteStream, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Segment, TimeRange, Transcript, Word } from "../hosts/types.js";
import { run } from "./exec.js";
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
  const part = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(part));
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

/** Convert whisper.cpp `-ojf` output into a word-level Transcript. Exported for tests. */
export function parseWhisperJson(json: WhisperJson, duration: number): Transcript {
  const segments: Segment[] = [];
  for (const seg of json.transcription ?? []) {
    const words: Word[] = [];
    let cur: { text: string; start: number; end: number; probs: number[] } | null = null;
    const flush = () => {
      if (cur && cur.text.trim()) {
        const conf = cur.probs.length ? cur.probs.reduce((a, b) => a + b, 0) / cur.probs.length : undefined;
        words.push({
          text: cur.text.trim(),
          start: round3(cur.start),
          end: round3(Math.max(cur.end, cur.start + 0.01)),
          ...(conf !== undefined ? { confidence: Math.round(conf * 1000) / 1000 } : {}),
        });
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
        if (!isPunct(tok.text)) cur.end = Math.max(cur.end, to);
        if (tok.p !== undefined) cur.probs.push(tok.p);
        continue;
      }
      if (!startsWord && !cur && isPunct(tok.text) && words.length) {
        words[words.length - 1].text += tok.text.trim();
        continue;
      }
      flush();
      cur = { text: tok.text, start: from, end: to, probs: tok.p !== undefined ? [tok.p] : [] };
    }
    flush();
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
  const jsonPath = join(paths.transcripts(), `${key}.${model}.${language}${refine ? "" : ".raw"}.json`);
  if (!opts.force && existsSync(jsonPath)) {
    return { transcript: JSON.parse(readFileSync(jsonPath, "utf8")) as Transcript, jsonPath, cached: true };
  }

  const info = await probe(abs);
  if (!info.hasAudio) throw new Error(`No audio stream in ${abs}`);
  const modelFile = await ensureModel(model, opts.onProgress);
  const wav = await extractAudio(abs);
  const outBase = join(paths.tmp(), `whisper-${key}-${process.pid}-${Date.now()}`);
  opts.onProgress?.(`Transcribing ${abs} with whisper ${model}`);
  await run(
    "whisper-cli",
    ["-m", modelFile, "-f", wav, "-l", language, "-ojf", "-of", outBase, "-np", "-t", String(threads())],
    { timeoutMs: Math.max(10 * 60_000, info.duration * 1000 * 4) },
  );
  const rawPath = `${outBase}.json`;
  if (!existsSync(rawPath)) throw new Error("whisper-cli produced no JSON output");
  const raw = JSON.parse(readFileSync(rawPath, "utf8")) as WhisperJson;
  rmSync(rawPath, { force: true });

  let transcript = parseWhisperJson(raw, info.duration);
  if (refine && transcript.segments.length) {
    const silences = await detectSilences(abs, { thresholdDb: -40, minDuration: 0.25 });
    transcript = refineWords(transcript, silences);
  }
  writeFileSync(jsonPath, JSON.stringify(transcript, null, 1));
  return { transcript, jsonPath, cached: false };
}

function threads(): number {
  return Math.max(2, Math.min(8, availableParallelism()));
}

/** "[mm:ss.s]" timestamp. */
export function stamp(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
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
