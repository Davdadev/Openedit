// Fixture data for the inline MCP Apps views, built with the same builders the tools use.
import { buildCutPlan } from "../src/engine/cutplan.js";
import type { Transcript, Word } from "../src/hosts/types.js";
import type { RankedResult } from "../src/media/search.js";
import { cardFromResult, cutPlanView, type CutPlanView, type MediaView, statusView, transcriptView } from "../src/ui/data.js";
import { revisePlan } from "../src/ui/tools.js";

const SCRIPT: string[] = [
  "Hey everyone, welcome back to the channel.",
  "Um, today we're going to look at how I edit my videos, uh, completely locally.",
  "So the first thing I do is, the first thing I do is drop the footage into a new project.",
  "Then I let the transcript, you know, tell me where the dead air is.",
  "Uh, honestly this saves me like an hour per video.",
  "Most editing tools want you to upload everything to the cloud.",
  "I don't love that, um, for client work especially.",
  "So everything here runs on my own machine with ffmpeg and whisper.",
  "Let's cut the silences, the ums, and the retakes, and then add some captions.",
  "And, uh, at the end we'll render a vertical version for shorts.",
  "Okay let's, okay let's jump right in.",
  "If you found this useful, hit subscribe and I'll see you in the next one.",
];

/** A believable word-timed transcript with pauses between sentences. */
export function fixtureTranscript(): Transcript {
  let t = 0.6;
  let seed = 11;
  const rnd = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const segments: Transcript["segments"] = SCRIPT.map((line, i) => {
    const words: Word[] = line.split(" ").map((w) => {
      const len = 0.16 + w.length * 0.045 + rnd() * 0.08;
      const word = { text: w, start: Math.round(t * 1000) / 1000, end: Math.round((t + len) * 1000) / 1000 };
      t += len + 0.04 + (/[,]$/.test(w) ? 0.25 : 0) + (/^(um|uh),?$/i.test(w) ? 0.3 : 0);
      return word;
    });
    const seg = { text: line, start: words[0].start, end: words[words.length - 1].end, words };
    t += [1.6, 0.4, 2.2, 0.5, 1.1, 3.1, 0.6, 0.9, 2.4, 0.5, 1.3, 0.2][i] ?? 0.8;
    return seg;
  });
  return { language: "en", duration: Math.round((t + 1.2) * 1000) / 1000, segments };
}

/** Pauses between words longer than 0.45s, like ffmpeg silencedetect would find. */
export function fixtureSilences(t: Transcript): { start: number; end: number }[] {
  const words = t.segments.flatMap((s) => s.words);
  const out: { start: number; end: number }[] = [];
  let prev = 0;
  for (const w of words) {
    if (w.start - prev >= 0.45) out.push({ start: prev, end: w.start });
    prev = w.end;
  }
  if (t.duration - prev >= 0.45) out.push({ start: prev, end: t.duration });
  return out;
}

/** Speech-shaped peaks (loud in words, quiet in gaps). */
export function fixturePeaks(t: Transcript, n = 480): number[] {
  const words = t.segments.flatMap((s) => s.words);
  let seed = 3;
  const rnd = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  return Array.from({ length: n }, (_, i) => {
    const at = ((i + 0.5) / n) * t.duration;
    const w = words.find((x) => at >= x.start - 0.03 && at <= x.end + 0.03);
    if (!w) return Math.round((0.03 + rnd() * 0.05) * 1000) / 1000;
    const pos = (at - w.start) / Math.max(0.05, w.end - w.start);
    const env = Math.sin(Math.PI * Math.min(1, Math.max(0, pos)));
    return Math.round(Math.min(1, 0.35 + env * 0.5 + rnd() * 0.25) * 1000) / 1000;
  });
}

export const SOURCE = "/Users/demo/Movies/how-i-edit-locally.mp4";

export async function fixtureCutPlan(): Promise<CutPlanView> {
  const transcript = fixtureTranscript();
  const plan = buildCutPlan({
    source: SOURCE,
    duration: transcript.duration,
    silences: fixtureSilences(transcript),
    transcript,
    removeFillers: true,
    removeRetakes: true,
    fillerWords: ["um", "uh", "you know"],
    manualCuts: [{ start: 27.2, end: 29.0, label: "tangent about the cloud" }],
  });
  const v = await cutPlanView({ id: "how-i-edit-locally-3fa2c1", plan }, { transcript, waveform: false });
  return { ...v, waveform: fixturePeaks(transcript) };
}

/** What revise_plan would return for restoring the given cut indices. */
export async function fixtureRevised(base: CutPlanView, restore: number[]): Promise<CutPlanView> {
  const transcript = fixtureTranscript();
  const plan = revisePlan({ source: base.source, duration: base.duration, keep: base.keep, cuts: base.cuts }, restore);
  const v = await cutPlanView({ id: "how-i-edit-locally-9b71d0", plan, options: { revisedFrom: base.planId } }, { transcript, waveform: false });
  return { ...v, waveform: base.waveform };
}

export function fixtureTranscriptView() {
  const t = fixtureTranscript();
  return transcriptView(SOURCE, t, "/Users/demo/.openedit/cache/transcripts/how-i-edit-locally-base.json", true);
}

const R = (o: Partial<RankedResult> & Pick<RankedResult, "id" | "provider" | "title">): RankedResult => ({
  kind: "video",
  url: `https://example.org/${o.provider}/${o.id}`,
  downloadUrl: `https://example.org/${o.provider}/${o.id}.mp4`,
  tags: [],
  license: "Pexels License",
  licenseCode: "stock",
  attributionRequired: false,
  attributionText: "",
  gid: `${o.provider}:${o.id}`,
  score: 0.8,
  reason: "matches city, night",
  ...o,
});

export function fixtureMediaFind(): MediaView {
  const results: RankedResult[] = [
    R({ id: "3129671", provider: "pexels", title: "Aerial view of a city at night with traffic", author: "Kelly Lacy", previewUrl: "https://images.pexels.com/videos/3129671/thumb.jpeg", width: 3840, height: 2160, duration: 18, score: 0.94, reason: "matches city, night, aerial · 4K" }),
    R({ id: "21723", provider: "pixabay", title: "Night city lights timelapse", author: "Engin_Akyurt", previewUrl: "https://cdn.pixabay.com/video/21723/thumb.jpg", width: 1920, height: 1080, duration: 24.5, license: "Pixabay Content License", score: 0.88, reason: "matches city, night" }),
    R({ id: "a8f3e1", provider: "openverse", title: "Downtown skyline after dark", author: "Mark Dalton", previewUrl: "https://api.openverse.org/v1/images/a8f3e1/thumb/", kind: "image", width: 2400, height: 1600, license: "CC BY 2.0", licenseCode: "cc-by", attributionRequired: true, score: 0.79, reason: "matches city, night · image" }),
    R({ id: "Tokyo_night.webm", provider: "wikimedia", title: "Tokyo street crossing at night", author: "Basile Morin", previewUrl: "https://upload.wikimedia.org/thumb/tokyo-night.jpg", width: 1920, height: 1080, duration: 42, license: "CC BY-SA 4.0", licenseCode: "cc-by-sa", attributionRequired: true, score: 0.74, reason: "matches city, night" }),
    R({ id: "iss-night", provider: "nasa", title: "City lights seen from the ISS", author: "NASA", previewUrl: "https://images-assets.nasa.gov/video/iss-night/thumb.jpg", width: 1280, height: 720, duration: 61, license: "Public domain (NASA)", licenseCode: "pd", score: 0.66, reason: "matches city, night" }),
    R({ id: "8812", provider: "pexels", title: "Neon-lit street in the rain", author: "Ruvim Miksanskiy", previewUrl: "https://images.pexels.com/videos/8812/thumb.jpeg", width: 1080, height: 1920, duration: 12, score: 0.61, reason: "matches night · portrait" }),
  ];
  return {
    view: "media",
    mode: "find",
    query: "city at night",
    kind: "video",
    considered: 57,
    items: results.map(cardFromResult),
    providers: [
      { provider: "pexels", status: "ok", count: 24 },
      { provider: "pixabay", status: "ok", count: 18 },
      { provider: "openverse", status: "cached", count: 9 },
      { provider: "wikimedia", status: "ok", count: 4 },
      { provider: "nasa", status: "ok", count: 2 },
      { provider: "unsplash", status: "skipped", count: 0, detail: "needs UNSPLASH_ACCESS_KEY" },
    ],
  };
}

export function fixtureMediaAudio(): MediaView {
  return {
    view: "media",
    mode: "find",
    query: "upbeat lofi",
    kind: "music",
    considered: 21,
    items: [
      cardFromResult(R({ id: "1886257", provider: "jamendo", kind: "music", title: "Sunday Morning Lofi", author: "Ketsa", previewUrl: "https://prod-1.storage.jamendo.com/?trackid=1886257", duration: 154, license: "CC BY 3.0", licenseCode: "cc-by", attributionRequired: true, score: 0.9, reason: "matches lofi, upbeat" })),
      cardFromResult(R({ id: "612094", provider: "freesound", kind: "music", title: "Lo-fi chill loop 90bpm", author: "Seth_Makes_Sounds", previewUrl: "https://cdn.freesound.org/previews/612/612094_lq.mp3", duration: 32.4, license: "CC0", licenseCode: "cc0", score: 0.83, reason: "matches lofi" })),
      cardFromResult(R({ id: "771020", provider: "freesound", kind: "music", title: "Cozy beat with vinyl crackle", author: "Migfus20", previewUrl: "https://cdn.freesound.org/previews/771/771020_lq.mp3", duration: 61, license: "CC BY-NC 4.0", licenseCode: "cc-by-nc", attributionRequired: true, score: 0.7, reason: "matches lofi · non-commercial" })),
    ],
    providers: [
      { provider: "jamendo", status: "ok", count: 12 },
      { provider: "freesound", status: "ok", count: 9 },
    ],
  };
}

export function fixtureStatus() {
  return statusView(
    { host: "resolve", connected: true, version: "19.1.2", project: "Channel Ep. 42", sequence: "Main edit v3" },
    [
      { host: "premiere", connected: false, detail: "panel not answering" },
      { host: "resolve", connected: true },
    ],
    "http://127.0.0.1:47822/",
  );
}
