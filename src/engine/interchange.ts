/**
 * NLE interchange: turn a cut plan (plus optional markers, captions and zooms)
 * into timeline files any editor can open, so OpenEdit works without a live
 * editor bridge (Final Cut Pro, free DaVinci Resolve, Premiere without the
 * panel, Avid, Vegas, Kdenlive…).
 *
 *  - fcp7    Final Cut Pro 7 XML ("xmeml" v5). Premiere Pro (File > Import) and Resolve
 *            (File > Import > Timeline) both read it.
 *  - fcpxml  FCPXML 1.10. Final Cut Pro 10.6+ and Resolve.
 *  - edl     CMX 3600 EDL. Every NLE; one video + two audio channels, markers as comments.
 *  - srt     The captions alone.
 *
 * All edit points are snapped to whole source frames and record positions are
 * accumulated in frames, so a long edit never drifts. NTSC rates (23.976,
 * 29.97, 59.94) use timebase 24/30/60 with the ntsc flag (FCP7), exact
 * rational frame durations (FCPXML) and drop-frame timecode for 29.97/59.94
 * (EDL). Written from Apple's "Final Cut Pro XML" (xmeml) and "FCPXML" reference.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { CaptionCue, CutPlan, MediaInfo, Marker, Zoom } from "../hosts/types.js";
import { toSRT } from "./captions.js";
import { run } from "./exec.js";
import { hasRetiming, timePieces } from "./speed.js";

export type InterchangeFormat = "fcp7" | "fcpxml" | "edl" | "srt";
export const INTERCHANGE_FORMATS: InterchangeFormat[] = ["fcp7", "fcpxml", "edl", "srt"];
export const INTERCHANGE_EXT: Record<InterchangeFormat, string> = { fcp7: ".xml", fcpxml: ".fcpxml", edl: ".edl", srt: ".srt" };

// ---------------------------------------------------------------------------
// Frame rates and timecode
// ---------------------------------------------------------------------------

export interface FrameRate {
  /** Frames per second as a fraction num/den (30000/1001 for 29.97). */
  num: number;
  den: number;
  /** Whole-number timebase used by FCP7 XML and timecode (24, 25, 30, 60…). */
  timebase: number;
  ntsc: boolean;
  /** True for 29.97 / 59.94: EDL timecode is drop-frame. */
  dropFrame: boolean;
  fps: number;
}

/** Normalise a probed frame rate to an exact editorial rate. */
export function frameRate(fps?: number): FrameRate {
  const f = fps && Number.isFinite(fps) && fps > 0 ? fps : 25;
  for (const tb of [24, 30, 48, 60, 120]) {
    const ntsc = (tb * 1000) / 1001;
    if (Math.abs(f - ntsc) < 0.006) {
      return { num: tb * 1000, den: 1001, timebase: tb, ntsc: true, dropFrame: tb === 30 || tb === 60, fps: ntsc };
    }
  }
  const tb = Math.max(1, Math.round(f));
  return { num: tb, den: 1, timebase: tb, ntsc: false, dropFrame: false, fps: tb };
}

/** Frame index -> timecode. Drop-frame uses ";" before the frames field. */
export function framesToTimecode(frame: number, rate: Pick<FrameRate, "timebase" | "dropFrame">): string {
  const tb = rate.timebase;
  let n = Math.max(0, Math.round(frame));
  if (rate.dropFrame) {
    const drop = Math.round(tb / 15); // 2 for 29.97, 4 for 59.94
    const perMinute = tb * 60 - drop;
    const per10Min = tb * 600 - drop * 9;
    const d = Math.floor(n / per10Min);
    const m = n % per10Min;
    n += drop * 9 * d + (m > drop ? drop * Math.floor((m - drop) / perMinute) : 0);
  }
  const ff = n % tb;
  const totalSec = Math.floor(n / tb);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600) % 24;
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(hh)}:${p(mm)}:${p(ss)}${rate.dropFrame ? ";" : ":"}${p(ff)}`;
}

/** Timecode ("01:00:00:00" or "01:00:00;00") -> frame index. */
export function timecodeToFrames(tc: string, rate: Pick<FrameRate, "timebase" | "dropFrame">): number {
  const m = /^(\d+):(\d+):(\d+)[:;.,](\d+)$/.exec(tc.trim());
  if (!m) throw new Error(`Bad timecode "${tc}"`);
  const [hh, mm, ss, ff] = m.slice(1).map(Number);
  const tb = rate.timebase;
  let frames = (hh * 3600 + mm * 60 + ss) * tb + ff;
  if (rate.dropFrame) {
    const drop = Math.round(tb / 15);
    const totalMinutes = hh * 60 + mm;
    frames -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Frame-snapped edit list
// ---------------------------------------------------------------------------

export interface SnappedEdit {
  /** Index into plan.keep. */
  index: number;
  /** Source frames, out exclusive. */
  srcIn: number;
  srcOut: number;
  /** Record (timeline) frames, out exclusive. */
  recIn: number;
  recOut: number;
}

/** Snap every kept range to whole source frames and lay them end to end. Ranges under one frame are dropped. */
export function snapPlan(plan: Pick<CutPlan, "keep">, rate: FrameRate, mediaFrames?: number): SnappedEdit[] {
  const out: SnappedEdit[] = [];
  let rec = 0;
  plan.keep.forEach((k, index) => {
    let a = Math.round(k.start * rate.fps);
    let b = Math.round(k.end * rate.fps);
    if (mediaFrames) {
      a = Math.min(a, mediaFrames);
      b = Math.min(b, mediaFrames);
    }
    a = Math.max(0, a);
    if (b <= a) return;
    out.push({ index, srcIn: a, srcOut: b, recIn: rec, recOut: rec + (b - a) });
    rec += b - a;
  });
  return out;
}

/**
 * Map a time on the (unsnapped) edited timeline to a record frame on the
 * snapped timeline, so markers/captions/zooms stay on the same picture.
 */
export function editTimeToFrame(plan: Pick<CutPlan, "keep"> & Partial<Pick<CutPlan, "ramps" | "freezes">>, edits: SnappedEdit[], t: number, rate: FrameRate): number {
  if (!edits.length) return 0;
  // Retimed edits are laid out on the edit timeline directly (see recordClips).
  if (hasRetiming(plan)) return Math.min(Math.max(Math.round(t * rate.fps), edits[0].recIn), edits[edits.length - 1].recOut);
  let acc = 0;
  let source: number | null = null;
  let segIndex = -1;
  for (let i = 0; i < plan.keep.length; i++) {
    const k = plan.keep[i];
    const len = k.end - k.start;
    if (t <= acc + len + 1e-9 || i === plan.keep.length - 1) {
      source = k.start + Math.min(Math.max(t - acc, 0), len);
      segIndex = i;
      break;
    }
    acc += len;
  }
  const e = edits.find((x) => x.index === segIndex) ?? edits.find((x) => x.index > segIndex) ?? edits[edits.length - 1];
  if (source === null || e.index !== segIndex) return e.index > segIndex ? e.recIn : e.recOut;
  const f = e.recIn + (Math.round(source * rate.fps) - e.srcIn);
  return Math.min(Math.max(f, e.recIn), e.recOut);
}

/** A record clip: a snapped edit plus its retiming and the range of its (linked) sound. */
export interface RecordClip extends SnappedEdit {
  /** Playback speed in percent (100 = normal; source frames / record frames). */
  speed?: number;
  reverse?: boolean;
  /** Variable speed: (record frame, source frame) points, clip-relative record frames (FCPXML timeMap). */
  timeMap?: { rec: number; src: number }[];
  /** Variable speed as constant-speed steps (FCP7 / Premiere: one clipitem each). */
  substeps?: { srcIn: number; srcOut: number; recIn: number; recOut: number; speed: number }[];
  /** The clip's sound: same frames as the picture ("same"), a different range (split edit), or none (muted ramp). */
  audio: "same" | null | { srcIn: number; srcOut: number; recIn: number; recOut: number };
}

/**
 * Record clips for interchange. Plain plans: the snapped edits, with split edits (J/L) moving the
 * sound (or picture) edit point by whole frames. Retimed plans: one clip per time piece (plain,
 * ramp, freeze, reverse) laid out on the edit timeline; variable-speed ramps become up to four
 * constant-speed steps (FCP7 / Premiere "Time Remap" speed) and carry the exact curve as a
 * timeMap (FCPXML). Pure.
 */
export function recordClips(plan: Pick<CutPlan, "keep"> & Partial<Pick<CutPlan, "splits" | "ramps" | "freezes">>, rate: FrameRate, mediaFrames?: number): RecordClip[] {
  const fps = rate.fps;
  if (!hasRetiming(plan)) {
    const edits = snapPlan(plan, rate, mediaFrames);
    const clips: RecordClip[] = edits.map((e) => ({ ...e, audio: "same" }));
    const byIndex = new Map(clips.map((c, i) => [c.index, i]));
    const own = (c: RecordClip) => (c.audio === "same" || c.audio === null ? { srcIn: c.srcIn, srcOut: c.srcOut, recIn: c.recIn, recOut: c.recOut } : c.audio);
    for (const sp of plan.splits ?? []) {
      const ia = byIndex.get(sp.index);
      const ib = byIndex.get(sp.index + 1);
      if (ia === undefined || ib === undefined) continue;
      const A = clips[ia];
      const B = clips[ib];
      const d = Math.max(0, Math.round(sp.seconds * fps));
      if (!d) continue;
      const sh = sp.type === "J" ? -d : d;
      if ((sp.roll ?? "audio") === "audio") {
        const a = own(A);
        const b = own(B);
        A.audio = { ...a, srcOut: a.srcOut + sh, recOut: a.recOut + sh };
        B.audio = { ...b, srcIn: Math.max(0, b.srcIn + sh), recIn: b.recIn + sh };
      } else {
        // The picture edit point moves; the sound keeps the original join.
        const a = own(A);
        const b = own(B);
        A.audio = a;
        B.audio = b;
        A.srcOut -= sh;
        A.recOut -= sh;
        B.srcIn -= sh;
        B.recIn -= sh;
      }
    }
    return clips;
  }
  const clips: RecordClip[] = [];
  for (const p of timePieces(plan, fps)) {
    const recIn = Math.round(p.editStart * fps);
    const recOut = Math.round(p.editEnd * fps);
    if (recOut <= recIn) continue;
    const srcIn = Math.round(p.srcStart * fps);
    let srcOut = Math.round(p.srcEnd * fps);
    if (mediaFrames) srcOut = Math.min(srcOut, mediaFrames);
    const index = p.keep;
    if (p.kind === "normal") {
      clips.push({ index, srcIn, srcOut: srcIn + (recOut - recIn), recIn, recOut, audio: "same" });
    } else if (p.kind === "freeze") {
      clips.push({ index, srcIn, srcOut: srcIn + 1, recIn, recOut, speed: round2((1 / (recOut - recIn)) * 100), audio: null });
    } else if (p.kind === "reverse") {
      clips.push({ index, srcIn, srcOut, recIn, recOut, reverse: true, speed: round2(((srcOut - srcIn) / (recOut - recIn)) * 100), audio: null });
    } else {
      const steps = p.steps ?? [];
      const audio: RecordClip["audio"] = p.audio === "pitch" ? "same" : null;
      // Exact curve as a timeMap (FCPXML).
      const pts: { rec: number; src: number }[] = [{ rec: 0, src: 0 }];
      let t = 0;
      for (const st of steps) {
        t += (st.s1 - st.s0) / st.v;
        pts.push({ rec: Math.round(t * fps * 100) / 100, src: Math.round((st.s1 - p.srcStart) * fps * 100) / 100 });
      }
      // Up to four constant-speed steps (FCP7 / Premiere expand the clip into these).
      const groups = Math.min(4, steps.length);
      const substeps: NonNullable<RecordClip["substeps"]> = [];
      let r0 = recIn;
      let s0 = srcIn;
      for (let g = 0; g < groups; g++) {
        const last = steps[Math.round(((g + 1) * steps.length) / groups) - 1];
        const outT = p.editStart + steps.filter((st) => st.s1 <= last.s1 + 1e-9).reduce((acc, st) => acc + (st.s1 - st.s0) / st.v, 0);
        const r1 = g === groups - 1 ? recOut : Math.round(outT * fps);
        const s1 = g === groups - 1 ? srcOut : Math.round(last.s1 * fps);
        if (r1 > r0 && s1 > s0) {
          substeps.push({ srcIn: s0, srcOut: s1, recIn: r0, recOut: r1, speed: round2(((s1 - s0) / (r1 - r0)) * 100) });
          r0 = r1;
          s0 = s1;
        }
      }
      clips.push({ index, srcIn, srcOut, recIn, recOut, speed: round2(((srcOut - srcIn) / (recOut - recIn)) * 100), timeMap: pts, substeps, audio });
    }
  }
  return clips;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface SourceDetails {
  /** Audio channels of the first audio stream (default 2). */
  audioChannels?: number;
  /** Audio sample rate (default 48000). */
  audioRate?: number;
  /** Embedded start timecode of the source (EDL source in/out are offset by it). */
  timecode?: string;
  /** Total video frames of the source, when known. */
  frames?: number;
}

export interface InterchangeInput {
  plan: CutPlan;
  info: MediaInfo;
  /** Sequence / project name. */
  name?: string;
  markers?: Marker[];
  captions?: CaptionCue[];
  zooms?: Zoom[];
  source?: SourceDetails;
  /** Record start timecode for EDL / FCPXML (default 01:00:00:00, the NLE convention). */
  startTimecode?: string;
  /** Caption language for FCPXML caption roles (default "en"). */
  language?: string;
}

/** Read the few extra details interchange needs (channels, sample rate, start timecode, frame count). */
export async function probeSourceDetails(path: string): Promise<SourceDetails> {
  try {
    const { stdout } = await run(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=codec_type,channels,sample_rate,nb_frames:stream_tags=timecode:format_tags=timecode", "-of", "json", path],
      { timeoutMs: 30_000 },
    );
    const j = JSON.parse(stdout) as {
      streams?: { codec_type?: string; channels?: number; sample_rate?: string; nb_frames?: string; tags?: { timecode?: string } }[];
      format?: { tags?: { timecode?: string } };
    };
    const a = j.streams?.find((s) => s.codec_type === "audio");
    const v = j.streams?.find((s) => s.codec_type === "video");
    const tc = j.format?.tags?.timecode ?? j.streams?.find((s) => s.tags?.timecode)?.tags?.timecode;
    const frames = Number(v?.nb_frames);
    return {
      audioChannels: a?.channels,
      audioRate: a?.sample_rate ? Number(a.sample_rate) : undefined,
      timecode: tc,
      frames: Number.isFinite(frames) && frames > 0 ? frames : undefined,
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // Characters XML 1.0 forbids outright.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

/** Tiny XML builder: el("a", {x: 1}, [children]) or el("a", {}, "text"). */
type Child = string | null | undefined | false;
function el(tag: string, attrs: Record<string, string | number | undefined> = {}, body?: Child | Child[]): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${xmlEscape(String(v))}"`)
    .join("");
  if (body === undefined || body === null || body === false) return `<${tag}${a}/>`;
  if (Array.isArray(body)) {
    const inner = body.filter((c): c is string => typeof c === "string" && c.length > 0);
    if (!inner.length) return `<${tag}${a}/>`;
    return `<${tag}${a}>\n${indent(inner.join("\n"))}\n</${tag}>`;
  }
  return `<${tag}${a}>${body}</${tag}>`;
}
const t = (tag: string, text: string | number) => `<${tag}>${xmlEscape(String(text))}</${tag}>`;
const indent = (s: string) => s.replace(/^/gm, "  ");

/** file://localhost/abs/path with percent-encoding (what Premiere and Resolve expect in pathurl). */
export function fileUrl(path: string, localhost = true): string {
  const href = pathToFileURL(path).href; // file:///abs/path%20with%20spaces
  return localhost ? href.replace(/^file:\/\//, "file://localhost") : href;
}

/** Zoom scale (percent) at edit time t, with the same ease shape the renderer uses. */
export function zoomAt(zooms: (Zoom & { ease?: number })[], t: number): number {
  let s = 100;
  for (const z of zooms) {
    if (t < z.start || t > z.end || z.end <= z.start) continue;
    const ease = Math.min(z.ease ?? 0.15, (z.end - z.start) / 3);
    const k = ease <= 0.001 ? 1 : Math.min(1, (t - z.start) / ease, (z.end - t) / ease);
    s += (z.scale - 100) * k;
  }
  return Math.round(s * 100) / 100;
}

/** Scale keyframes for one clip (clip-relative record frames), or a single value when constant. */
function zoomKeys(
  input: InterchangeInput,
  edits: SnappedEdit[],
  e: SnappedEdit,
  rate: FrameRate,
): { frame: number; value: number }[] {
  const zooms = input.zooms ?? [];
  if (!zooms.length) return [];
  const times = new Set<number>();
  for (const z of zooms) {
    const ease = Math.min((z as { ease?: number }).ease ?? 0.15, (z.end - z.start) / 3);
    for (const tt of [z.start, z.start + ease, z.end - ease, z.end]) {
      const f = editTimeToFrame(input.plan, edits, tt, rate);
      if (f > e.recIn && f < e.recOut) times.add(f);
    }
  }
  const frames = [e.recIn, ...[...times].sort((a, b) => a - b), e.recOut - 1].filter((f, i, arr) => i === 0 || f > arr[i - 1]);
  // Sample at frame centres of the record timeline (convert back to edit seconds approximately).
  const keys = frames.map((f) => ({ frame: f - e.recIn, value: zoomAt(zooms, recordFrameToEditTime(input.plan, edits, f, rate)) }));
  if (keys.every((k) => k.value === 100)) return [];
  if (keys.every((k) => k.value === keys[0].value)) return [{ frame: 0, value: keys[0].value }];
  return keys;
}

function recordFrameToEditTime(plan: Pick<CutPlan, "keep"> & Partial<Pick<CutPlan, "ramps" | "freezes">>, edits: SnappedEdit[], f: number, rate: FrameRate): number {
  if (hasRetiming(plan)) return f / rate.fps;
  const e = edits.find((x) => f >= x.recIn && f < x.recOut) ?? edits[edits.length - 1];
  const src = (e.srcIn + (f - e.recIn)) / rate.fps;
  let acc = 0;
  for (let i = 0; i < e.index; i++) acc += plan.keep[i].end - plan.keep[i].start;
  return acc + Math.max(0, src - plan.keep[e.index].start);
}

function sourceName(input: InterchangeInput): string {
  return basename(input.plan.source);
}
function seqName(input: InterchangeInput): string {
  return input.name ?? `${basename(input.plan.source, extname(input.plan.source))} - OpenEdit`;
}

function prepare(input: InterchangeInput) {
  const rate = frameRate(input.info.fps);
  const mediaFrames = input.source?.frames ?? (input.info.duration ? Math.round(input.info.duration * rate.fps) : undefined);
  const clips = recordClips(input.plan, rate, mediaFrames);
  const edits: SnappedEdit[] = clips.map(({ index, srcIn, srcOut, recIn, recOut }) => ({ index, srcIn, srcOut, recIn, recOut }));
  if (!edits.length) throw new Error("Cut plan keeps nothing longer than one frame");
  const total = Math.max(...clips.map((c) => Math.max(c.recOut, c.audio && c.audio !== "same" ? c.audio.recOut : 0)));
  const channels = input.info.hasAudio ? Math.max(1, Math.min(2, input.source?.audioChannels ?? 2)) : 0;
  return { rate, edits, clips, total, mediaFrames, channels, audioRate: input.source?.audioRate ?? 48000 };
}

// ---------------------------------------------------------------------------
// FCP7 XML (xmeml v5)
// ---------------------------------------------------------------------------

const rateXml = (r: FrameRate) => el("rate", {}, [t("timebase", r.timebase), t("ntsc", r.ntsc ? "TRUE" : "FALSE")]);

/** Final Cut Pro 7 XML (xmeml version 5): imports into Premiere Pro and DaVinci Resolve. */
export function toFCP7(input: InterchangeInput): string {
  const { rate, edits, clips, total, mediaFrames, channels, audioRate } = prepare(input);
  const { info } = input;
  const name = sourceName(input);
  const W = info.width ?? 1920;
  const H = info.height ?? 1080;
  const hasV = info.hasVideo;
  // Link groups: one picture item and its sound (same range, a split range, or none). Variable-speed
  // ramps expand into their constant-speed steps.
  type Seg = { srcIn: number; srcOut: number; recIn: number; recOut: number; speed?: number; reverse?: boolean };
  const groups: { e: SnappedEdit; v: Seg; a: Seg | null }[] = [];
  clips.forEach((c, k) => {
    const e = edits[k];
    const parts: Seg[] = c.substeps?.length ? c.substeps : [{ srcIn: c.srcIn, srcOut: c.srcOut, recIn: c.recIn, recOut: c.recOut, speed: c.speed, reverse: c.reverse }];
    for (const v of parts) {
      const a: Seg | null = c.audio === null ? null : c.audio === "same" ? v : { ...c.audio };
      groups.push({ e, v, a });
    }
  });
  const n = groups.length;
  // clipitem ids: video 1..n, audio track c: c*n+1..(c+1)*n
  const vId = (j: number) => `clipitem-${j + 1}`;
  const aId = (c: number, j: number) => `clipitem-${(hasV ? n : 0) + c * n + j + 1}`;
  let fileWritten = false;

  const fileXml = () => {
    if (fileWritten) return el("file", { id: "file-1" });
    fileWritten = true;
    const media: string[] = [];
    if (hasV) {
      media.push(
        el("video", {}, [
          el("samplecharacteristics", {}, [rateXml(rate), t("width", W), t("height", H), t("anamorphic", "FALSE"), t("pixelaspectratio", "square"), t("fielddominance", "none")]),
        ]),
      );
    }
    if (channels) {
      media.push(el("audio", {}, [el("samplecharacteristics", {}, [t("depth", 16), t("samplerate", audioRate)]), t("channelcount", channels)]));
    }
    return el("file", { id: "file-1" }, [
      t("name", name),
      t("pathurl", fileUrl(input.plan.source)),
      rateXml(rate),
      // Left empty on purpose: Resolve rejects a mismatching length, Premiere reads it from the media.
      "<duration></duration>",
      el("timecode", {}, [rateXml(rate), t("string", input.source?.timecode ?? "00:00:00:00"), t("displayformat", rate.dropFrame ? "DF" : "NDF")]),
      el("media", {}, media),
    ]);
  };

  // Position of each group's sound item in the audio tracks (groups without sound have none).
  const aIndex: number[] = [];
  groups.reduce((acc, g, j) => ((aIndex[j] = g.a ? acc + 1 : 0), g.a ? acc + 1 : acc), 0);
  const links = (j: number) => {
    const out: string[] = [];
    if (hasV) out.push(el("link", {}, [t("linkclipref", vId(j)), t("mediatype", "video"), t("trackindex", 1), t("clipindex", j + 1)]));
    if (groups[j].a) {
      for (let c = 0; c < channels; c++) {
        out.push(el("link", {}, [t("linkclipref", aId(c, j)), t("mediatype", "audio"), t("trackindex", c + 1), t("clipindex", aIndex[j]), t("groupindex", 1)]));
      }
    }
    return out.length > 1 ? out : [];
  };

  /** Premiere / FCP7 "Time Remap" (constant speed, optional reverse). */
  const speedFilter = (sg: Seg, mediatype: "video" | "audio") =>
    (sg.speed !== undefined && Math.abs(sg.speed - 100) > 0.01) || sg.reverse
      ? el("filter", {}, [
          el("effect", {}, [
            t("name", "Time Remap"),
            t("effectid", "timeremap"),
            t("effectcategory", "motion"),
            t("effecttype", "motion"),
            t("mediatype", mediatype),
            el("parameter", { authoringApp: "PremierePro" }, [t("parameterid", "variablespeed"), t("name", "variablespeed"), t("valuemin", 0), t("valuemax", 1), t("value", 0)]),
            el("parameter", { authoringApp: "PremierePro" }, [t("parameterid", "speed"), t("name", "speed"), t("valuemin", -100000), t("valuemax", 100000), t("value", sg.speed ?? 100)]),
            el("parameter", { authoringApp: "PremierePro" }, [t("parameterid", "reverse"), t("name", "reverse"), t("value", sg.reverse ? "TRUE" : "FALSE")]),
            el("parameter", { authoringApp: "PremierePro" }, [t("parameterid", "frameblending"), t("name", "frameblending"), t("value", "FALSE")]),
          ]),
        ])
      : undefined;

  const motionFilter = (e: SnappedEdit) => {
    const keys = zoomKeys(input, edits, e, rate);
    if (!keys.length) return undefined;
    const param =
      keys.length === 1
        ? el("parameter", { authoringApp: "PremierePro" }, [t("parameterid", "scale"), t("name", "Scale"), t("valuemin", 0), t("valuemax", 1000), t("value", keys[0].value)])
        : el("parameter", { authoringApp: "PremierePro" }, [
            t("parameterid", "scale"),
            t("name", "Scale"),
            t("valuemin", 0),
            t("valuemax", 1000),
            t("value", keys[0].value),
            ...keys.map((k) => el("keyframe", {}, [t("when", e.srcIn + k.frame), t("value", k.value)])),
          ]);
    return el("filter", {}, [
      el("effect", {}, [t("name", "Basic Motion"), t("effectid", "basic"), t("effectcategory", "motion"), t("effecttype", "motion"), t("mediatype", "video"), param]),
    ]);
  };

  const clip = (id: string, sg: Seg, e: SnappedEdit, j: number, kind: "video" | "audio", trackIndex: number) =>
    el("clipitem", { id }, [
      t("masterclipid", "masterclip-1"),
      t("name", name),
      t("enabled", "TRUE"),
      mediaFrames ? t("duration", mediaFrames) : undefined,
      rateXml(rate),
      t("start", sg.recIn),
      t("end", sg.recOut),
      t("in", sg.srcIn),
      t("out", sg.srcOut),
      fileXml(),
      el("sourcetrack", {}, [t("mediatype", kind), t("trackindex", trackIndex)]),
      kind === "video" && sg === groups[j].v && sg.srcIn === e.srcIn ? motionFilter(e) : undefined,
      speedFilter(sg, kind),
      ...links(j),
    ]);

  const videoTracks: string[] = [];
  if (hasV) videoTracks.push(el("track", {}, groups.map((g, j) => clip(vId(j), g.v, g.e, j, "video", 1))));
  const audioTracks: string[] = [];
  for (let c = 0; c < channels; c++) {
    audioTracks.push(el("track", {}, groups.flatMap((g, j) => (g.a ? [clip(aId(c, j), g.a, g.e, j, "audio", c + 1)] : []))));
  }

  const markers = (input.markers ?? []).map((m) => {
    const f = editTimeToFrame(input.plan, edits, m.time, rate);
    const out = m.duration ? editTimeToFrame(input.plan, edits, m.time + m.duration, rate) : -1;
    return el("marker", {}, [t("name", m.name), t("comment", m.comment ?? ""), t("in", f), t("out", out > f ? out : -1)]);
  });

  const seq = el("sequence", { id: "sequence-1" }, [
    t("name", seqName(input)),
    t("duration", total),
    rateXml(rate),
    el("timecode", {}, [rateXml(rate), t("string", framesToTimecode(0, rate)), t("frame", 0), t("displayformat", rate.dropFrame ? "DF" : "NDF")]),
    el("media", {}, [
      el("video", {}, [
        el("format", {}, [
          el("samplecharacteristics", {}, [rateXml(rate), t("width", W), t("height", H), t("anamorphic", "FALSE"), t("pixelaspectratio", "square"), t("fielddominance", "none")]),
        ]),
        ...videoTracks,
      ]),
      el("audio", {}, [
        t("numOutputChannels", 2),
        el("format", {}, [el("samplecharacteristics", {}, [t("depth", 16), t("samplerate", audioRate)])]),
        ...audioTracks,
      ]),
    ]),
    ...markers,
  ]);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n${el("xmeml", { version: 5 }, [seq])}\n`;
}

// ---------------------------------------------------------------------------
// FCPXML 1.10
// ---------------------------------------------------------------------------

/** Rational seconds for a frame count, as FCPXML wants ("1001/30000s", "0s"). */
export function fcpTime(frames: number, rate: FrameRate): string {
  if (frames === 0) return "0s";
  const num = frames * rate.den;
  const den = rate.num;
  const g = gcd(Math.abs(num), den);
  return den / g === 1 ? `${num / g}s` : `${num / g}/${den / g}s`;
}
function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

/** FCPXML 1.10: Final Cut Pro 10.6+ and DaVinci Resolve. */
export function toFCPXML(input: InterchangeInput): string {
  const { rate, edits, clips: recClips, total, mediaFrames, channels, audioRate } = prepare(input);
  const { info } = input;
  const W = info.width ?? 1920;
  const H = info.height ?? 1080;
  const name = sourceName(input);
  const assetFrames = mediaFrames ?? edits[edits.length - 1].srcOut;
  const lang = input.language ?? "en";
  const tcFormat = rate.dropFrame ? "DF" : "NDF";
  const startTc = input.startTimecode ?? (rate.dropFrame ? "01:00:00;00" : "01:00:00:00");
  const startFrames = timecodeToFrames(startTc, rate);
  const srcTcFrames = input.source?.timecode ? safeTc(input.source.timecode, rate) : 0;

  let styleN = 0;
  const clips = edits.map((e, j) => {
    // Inside an asset-clip, child times are in the asset's own time (source time).
    const local = (recFrame: number) => fcpTime(srcTcFrames + e.srcIn + (recFrame - e.recIn), rate);
    const keys = info.hasVideo ? zoomKeys(input, edits, e, rate) : [];
    const transform =
      keys.length === 0
        ? undefined
        : keys.length === 1
          ? el("adjust-transform", { scale: `${r4(keys[0].value / 100)} ${r4(keys[0].value / 100)}` })
          : el("adjust-transform", {}, [
              el("param", { name: "scale" }, [
                el(
                  "keyframeAnimation",
                  {},
                  keys.map((k) => el("keyframe", { time: local(e.recIn + k.frame), value: `${r4(k.value / 100)} ${r4(k.value / 100)}` })),
                ),
              ]),
            ]);
    const captions = (input.captions ?? []).flatMap((c) => {
      const a = Math.max(editTimeToFrame(input.plan, edits, c.start, rate), e.recIn);
      const b = Math.min(editTimeToFrame(input.plan, edits, c.end, rate), e.recOut);
      if (b <= a) return [];
      const id = `ts${++styleN}`;
      return [
        el("caption", { lane: 1, offset: local(a), name: c.text.slice(0, 64), duration: fcpTime(b - a, rate), role: `SRT?captionFormat=SRT.${lang}` }, [
          // Inline on purpose: whitespace inside <text> would become part of the caption.
          el("text", { placement: "bottom" }, el("text-style", { ref: id }, xmlEscape(c.text))),
          el("text-style-def", { id }, [el("text-style", { font: ".AppleSystemUIFont", fontSize: 13, fontFace: "Regular", fontColor: "1 1 1 1", backgroundColor: "0 0 0 1" })]),
        ]),
      ];
    });
    const markers = (input.markers ?? []).flatMap((m) => {
      const f = editTimeToFrame(input.plan, edits, m.time, rate);
      const inClip = f >= e.recIn && (f < e.recOut || (j === edits.length - 1 && f === e.recOut));
      if (!inClip) return [];
      const dur = m.duration ? Math.max(1, editTimeToFrame(input.plan, edits, m.time + m.duration, rate) - f) : 1;
      return [el("marker", { start: local(Math.min(f, e.recOut - 1)), duration: fcpTime(dur, rate), value: m.name, note: m.comment })];
    });
    const rc = recClips[j];
    // Split edit: the sound covers a different source range (FCPXML audioStart / audioDuration).
    const split = rc.audio && rc.audio !== "same" ? rc.audio : undefined;
    // Retimed clip: timeMap of (clip-local time, source time) points.
    let timeMap: string | undefined;
    if (rc.speed !== undefined || rc.reverse) {
      const len = e.recOut - e.recIn;
      const srcLen = rc.srcOut - rc.srcIn;
      const pts = rc.timeMap?.length
        ? rc.timeMap.map((p) => ({ rec: Math.round(p.rec), src: Math.round(p.src) }))
        : rc.reverse
          ? [{ rec: 0, src: srcLen }, { rec: len, src: 0 }]
          : srcLen <= 1
            ? [{ rec: 0, src: 0 }, { rec: len, src: 0 }]
            : [{ rec: 0, src: 0 }, { rec: len, src: srcLen }];
      pts[pts.length - 1].rec = len;
      timeMap = el(
        "timeMap",
        {},
        pts.map((p) => el("timept", { time: local(e.recIn + p.rec), value: fcpTime(srcTcFrames + rc.srcIn + p.src, rate), interp: rc.timeMap ? "smooth2" : "linear" })),
      );
    }
    return el(
      "asset-clip",
      {
        ref: "r2",
        offset: fcpTime(startFrames + e.recIn, rate),
        name,
        start: fcpTime(srcTcFrames + e.srcIn, rate),
        duration: fcpTime(e.recOut - e.recIn, rate),
        format: info.hasVideo ? "r1" : undefined,
        tcFormat,
        audioRole: channels && rc.audio !== null ? "dialogue" : undefined,
        audioStart: split && channels ? fcpTime(srcTcFrames + split.srcIn, rate) : undefined,
        audioDuration: split && channels ? fcpTime(split.srcOut - split.srcIn, rate) : undefined,
        srcEnable: rc.audio === null && channels && info.hasVideo ? "video" : undefined,
      },
      [timeMap, transform, ...captions, ...markers],
    );
  });

  const resources = el("resources", {}, [
    el("format", { id: "r1", frameDuration: fcpTime(1, rate), width: W, height: H, colorSpace: "1-1-1 (Rec. 709)" }),
    el(
      "asset",
      {
        id: "r2",
        name,
        start: fcpTime(srcTcFrames, rate),
        duration: fcpTime(assetFrames, rate),
        hasVideo: info.hasVideo ? 1 : undefined,
        format: info.hasVideo ? "r1" : undefined,
        videoSources: info.hasVideo ? 1 : undefined,
        hasAudio: channels ? 1 : undefined,
        audioSources: channels ? 1 : undefined,
        audioChannels: channels || undefined,
        audioRate: channels ? audioRate : undefined,
      },
      [el("media-rep", { kind: "original-media", src: fileUrl(input.plan.source, false) })],
    ),
  ]);

  const sequence = el(
    "sequence",
    { format: "r1", duration: fcpTime(total, rate), tcStart: fcpTime(startFrames, rate), tcFormat, audioLayout: "stereo", audioRate: audioRate >= 96000 ? "96k" : audioRate >= 48000 ? "48k" : "44.1k" },
    [el("spine", {}, clips)],
  );
  const library = el("library", {}, [el("event", { name: "OpenEdit" }, [el("project", { name: seqName(input) }, [sequence])])]);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n${el("fcpxml", { version: "1.10" }, [resources, library])}\n`;
}

const r4 = (n: number) => String(Math.round(n * 10000) / 10000);

function safeTc(tc: string, rate: FrameRate): number {
  try {
    return timecodeToFrames(tc, rate);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// CMX 3600 EDL
// ---------------------------------------------------------------------------

/** Reel name: up to 8 of [A-Z0-9_] from the file stem (CMX 3600 limit). */
export function reelName(path: string): string {
  const stem = basename(path, extname(path)).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return (stem || "AX").slice(0, 8);
}

/** CMX 3600 EDL (one picture track + A1/A2), cut-only, frame-accurate. */
export function toEDL(input: InterchangeInput): string {
  const { rate, edits, clips, channels } = prepare(input);
  const startTc = input.startTimecode ?? (rate.dropFrame ? "01:00:00;00" : "01:00:00:00");
  const recBase = timecodeToFrames(startTc, rate);
  const srcBase = input.source?.timecode ? safeTc(input.source.timecode, rate) : 0;
  const tc = (f: number) => framesToTimecode(f, rate);
  const hasV = input.info.hasVideo;
  const track = hasV ? (channels >= 2 ? "AA/V" : channels === 1 ? "B" : "V") : channels >= 2 ? "AA" : "A";
  const reel = reelName(input.plan.source);
  const title = seqName(input).replace(/[\r\n]+/g, " ").slice(0, 70);
  const lines = [`TITLE: ${title}`, `FCM: ${rate.dropFrame ? "DROP FRAME" : "NON-DROP FRAME"}`, ""];
  if (input.plan.splits?.length) lines.splice(2, 0, `* NOTE: ${input.plan.splits.length} SPLIT EDITS (J/L) ARE NOT REPRESENTED IN CMX 3600; USE FCP7 XML OR FCPXML`);
  const markers = [...(input.markers ?? [])].map((m) => ({ m, f: editTimeToFrame(input.plan, edits, m.time, rate) }));
  edits.forEach((e, i) => {
    const num = String(i + 1).padStart(3, "0");
    lines.push(
      `${num}  ${reel.padEnd(8)} ${track.padEnd(5)} C        ${tc(srcBase + e.srcIn)} ${tc(srcBase + e.srcOut)} ${tc(recBase + e.recIn)} ${tc(recBase + e.recOut)}`,
    );
    // Motion (speed) effect: CMX 3600 M2 line, speed in frames per second (negative = reverse).
    const sp = clips[i]?.speed;
    if (sp !== undefined || clips[i]?.reverse) {
      const fpsEff = ((clips[i].reverse ? -1 : 1) * ((sp ?? 100) / 100) * rate.timebase).toFixed(1).padStart(5, "0");
      lines.push(`M2   ${reel.padEnd(8)}       ${fpsEff}    ${tc(srcBase + e.srcIn)}`);
    }
    lines.push(`* FROM CLIP NAME: ${basename(input.plan.source)}`);
    for (const { m, f } of markers) {
      const last = i === edits.length - 1;
      if (f >= e.recIn && (f < e.recOut || (last && f === e.recOut))) {
        // Avid-style locator comment; editors that don't read locators keep it as a note.
        lines.push(`* LOC: ${tc(recBase + f)} ${(m.color ?? "blue").toUpperCase().padEnd(7)} ${m.name.replace(/[\r\n]+/g, " ")}`);
      }
    }
    lines.push("");
  });
  return lines.join("\r\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Render the timeline in `format` (no file I/O). */
export function buildInterchange(format: InterchangeFormat, input: InterchangeInput): string {
  switch (format) {
    case "fcp7":
      return toFCP7(input);
    case "fcpxml":
      return toFCPXML(input);
    case "edl":
      return toEDL(input);
    case "srt":
      if (!input.captions?.length) throw new Error("No captions to export as SRT (the plan has no transcript; run transcribe/make_captions first).");
      return toSRT(input.captions);
  }
}

/** Write the timeline file; returns the path written. */
export function writeInterchange(format: InterchangeFormat, input: InterchangeInput, output: string): string {
  const body = buildInterchange(format, input);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, body);
  return output;
}
