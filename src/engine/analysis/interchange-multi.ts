/**
 * NLE interchange for multi-source edits (multicam switches, assembled shots): FCP7 XML (Premiere,
 * Resolve via ImportTimelineFromFile) and FCPXML 1.10 (Final Cut Pro, Resolve). One video track
 * cutting between sources over one audio track (A1/A2 = the audio source's channels).
 * Edit points are snapped to frames and accumulated in frames (no drift).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import type { MultiTrackEdit } from "../../hosts/types.js";
import { type FrameRate, fcpTime, fileUrl, frameRate, framesToTimecode, timecodeToFrames, xmlEscape } from "../interchange.js";

export interface MultiSourceInfo {
  width?: number;
  height?: number;
  fps?: number;
  hasAudio: boolean;
  hasVideo: boolean;
  /** Total frames when known. */
  frames?: number;
  audioChannels?: number;
  audioRate?: number;
}

export interface MultiInterchangeInput {
  edit: MultiTrackEdit;
  /** Per source, same order as edit.sources. */
  info: MultiSourceInfo[];
  name?: string;
}

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
    return `<${tag}${a}>\n${inner.join("\n").replace(/^/gm, "  ")}\n</${tag}>`;
  }
  return `<${tag}${a}>${body}</${tag}>`;
}
const t = (tag: string, text: string | number) => `<${tag}>${xmlEscape(String(text))}</${tag}>`;

export interface SnappedMulti {
  source: number;
  srcIn: number;
  srcOut: number;
  recIn: number;
  recOut: number;
}

/** Snap record and source times to whole frames; record positions accumulate (contiguous). Pure. */
export function snapMulti(edit: MultiTrackEdit, rate: FrameRate): { video: SnappedMulti[]; audio: SnappedMulti[] } {
  const video: SnappedMulti[] = [];
  for (const s of edit.segments) {
    const recIn = Math.round(s.recIn * rate.fps);
    const recOut = Math.round(s.recOut * rate.fps);
    if (recOut <= recIn) continue;
    const srcIn = Math.max(0, Math.round(s.srcIn * rate.fps));
    video.push({ source: s.source, srcIn, srcOut: srcIn + (recOut - recIn), recIn, recOut });
  }
  for (let i = 1; i < video.length; i++) {
    if (video[i].recIn !== video[i - 1].recOut) {
      const d = video[i - 1].recOut - video[i].recIn;
      video[i].recIn += d;
      video[i].srcIn += d;
    }
  }
  const audio = edit.audio.map((a) => {
    const recIn = Math.round(a.recIn * rate.fps);
    const srcIn = Math.max(0, Math.round(a.srcIn * rate.fps));
    const len = Math.round((a.srcOut - a.srcIn) * rate.fps);
    return { source: a.source, srcIn, srcOut: srcIn + len, recIn, recOut: recIn + len };
  });
  return { video, audio };
}

const rateXml = (r: FrameRate) => el("rate", {}, [t("timebase", r.timebase), t("ntsc", r.ntsc ? "TRUE" : "FALSE")]);

function seqName(input: MultiInterchangeInput): string {
  return input.name ?? input.edit.name ?? `${basename(input.edit.sources[0].path, extname(input.edit.sources[0].path))} - multicam`;
}

/** FCP7 XML (xmeml v5): Premiere File > Import, Resolve File > Import > Timeline. */
export function multiToFCP7(input: MultiInterchangeInput): string {
  const { edit, info } = input;
  const rate = frameRate(edit.fps ?? info[0]?.fps);
  const { video, audio } = snapMulti(edit, rate);
  if (!video.length) throw new Error("edit has no picture segments longer than a frame");
  const total = Math.max(video[video.length - 1].recOut, ...audio.map((a) => a.recOut));
  const W = edit.width ?? info[0]?.width ?? 1920;
  const H = edit.height ?? info[0]?.height ?? 1080;
  const written = new Set<number>();
  const fileXml = (i: number) => {
    const id = `file-${i + 1}`;
    if (written.has(i)) return el("file", { id });
    written.add(i);
    const inf = info[i];
    const r = frameRate(inf?.fps ?? edit.fps);
    const media: string[] = [];
    if (inf?.hasVideo !== false) {
      media.push(el("video", {}, [el("samplecharacteristics", {}, [rateXml(r), t("width", inf?.width ?? W), t("height", inf?.height ?? H), t("anamorphic", "FALSE"), t("pixelaspectratio", "square"), t("fielddominance", "none")])]));
    }
    if (inf?.hasAudio) media.push(el("audio", {}, [el("samplecharacteristics", {}, [t("depth", 16), t("samplerate", inf.audioRate ?? 48000)]), t("channelcount", Math.min(2, inf.audioChannels ?? 2))]));
    return el("file", { id }, [
      t("name", basename(edit.sources[i].path)),
      t("pathurl", fileUrl(edit.sources[i].path)),
      rateXml(r),
      "<duration></duration>",
      el("timecode", {}, [rateXml(r), t("string", "00:00:00:00"), t("displayformat", r.dropFrame ? "DF" : "NDF")]),
      el("media", {}, media),
    ]);
  };
  let id = 0;
  const clip = (s: SnappedMulti, kind: "video" | "audio", track: number) =>
    el("clipitem", { id: `clipitem-${++id}` }, [
      t("masterclipid", `masterclip-${s.source + 1}`),
      t("name", basename(edit.sources[s.source].path)),
      t("enabled", "TRUE"),
      info[s.source]?.frames ? t("duration", info[s.source].frames as number) : undefined,
      rateXml(rate),
      t("start", s.recIn),
      t("end", s.recOut),
      t("in", s.srcIn),
      t("out", s.srcOut),
      fileXml(s.source),
      el("sourcetrack", {}, [t("mediatype", kind), t("trackindex", track)]),
    ]);
  const vTrack = el("track", {}, video.map((s) => clip(s, "video", 1)));
  const channels = Math.min(2, Math.max(1, info[audio[0]?.source ?? 0]?.audioChannels ?? 2));
  const aTracks: string[] = [];
  for (let c = 0; c < channels; c++) aTracks.push(el("track", {}, audio.map((s) => clip(s, "audio", c + 1))));
  const seq = el("sequence", { id: "sequence-1" }, [
    t("name", seqName(input)),
    t("duration", total),
    rateXml(rate),
    el("timecode", {}, [rateXml(rate), t("string", framesToTimecode(0, rate)), t("frame", 0), t("displayformat", rate.dropFrame ? "DF" : "NDF")]),
    el("media", {}, [
      el("video", {}, [el("format", {}, [el("samplecharacteristics", {}, [rateXml(rate), t("width", W), t("height", H), t("anamorphic", "FALSE"), t("pixelaspectratio", "square"), t("fielddominance", "none")])]), vTrack]),
      el("audio", {}, [t("numOutputChannels", 2), el("format", {}, [el("samplecharacteristics", {}, [t("depth", 16), t("samplerate", 48000)])]), ...aTracks]),
    ]),
  ]);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n${el("xmeml", { version: 5 }, [seq])}\n`;
}

/** FCPXML 1.10: picture segments in the spine (video only), the audio source as a connected clip below. */
export function multiToFCPXML(input: MultiInterchangeInput): string {
  const { edit, info } = input;
  const rate = frameRate(edit.fps ?? info[0]?.fps);
  const { video, audio } = snapMulti(edit, rate);
  if (!video.length) throw new Error("edit has no picture segments longer than a frame");
  const total = Math.max(video[video.length - 1].recOut, ...audio.map((a) => a.recOut));
  const W = edit.width ?? info[0]?.width ?? 1920;
  const H = edit.height ?? info[0]?.height ?? 1080;
  const startTc = rate.dropFrame ? "01:00:00;00" : "01:00:00:00";
  const startFrames = timecodeToFrames(startTc, rate);
  const assets = edit.sources.map((s, i) => {
    const inf = info[i];
    const frames = inf?.frames ?? Math.max(...[...video, ...audio].filter((v) => v.source === i).map((v) => v.srcOut), 1);
    return el(
      "asset",
      {
        id: `r${i + 2}`,
        name: basename(s.path),
        start: "0s",
        duration: fcpTime(frames, rate),
        hasVideo: inf?.hasVideo !== false ? 1 : undefined,
        format: inf?.hasVideo !== false ? "r1" : undefined,
        videoSources: inf?.hasVideo !== false ? 1 : undefined,
        hasAudio: inf?.hasAudio ? 1 : undefined,
        audioSources: inf?.hasAudio ? 1 : undefined,
        audioChannels: inf?.hasAudio ? Math.min(2, inf.audioChannels ?? 2) : undefined,
        audioRate: inf?.hasAudio ? (inf.audioRate ?? 48000) : undefined,
      },
      [el("media-rep", { kind: "original-media", src: fileUrl(s.path, false) })],
    );
  });
  const clips = video.map((v, j) => {
    // Audio clips connect to the first spine clip (lane -1), in that clip's source time.
    const connected =
      j === 0
        ? audio.map((a) =>
            el("asset-clip", {
              ref: `r${a.source + 2}`,
              lane: -1,
              offset: fcpTime(v.srcIn + (a.recIn - v.recIn), rate),
              name: basename(edit.sources[a.source].path),
              start: fcpTime(a.srcIn, rate),
              duration: fcpTime(a.recOut - a.recIn, rate),
              srcEnable: "audio",
              audioRole: "dialogue",
            }),
          )
        : [];
    return el(
      "asset-clip",
      {
        ref: `r${v.source + 2}`,
        offset: fcpTime(startFrames + v.recIn, rate),
        name: basename(edit.sources[v.source].path),
        start: fcpTime(v.srcIn, rate),
        duration: fcpTime(v.recOut - v.recIn, rate),
        format: "r1",
        srcEnable: "video",
        tcFormat: rate.dropFrame ? "DF" : "NDF",
      },
      connected.length ? connected : undefined,
    );
  });
  const resources = el("resources", {}, [el("format", { id: "r1", frameDuration: fcpTime(1, rate), width: W, height: H, colorSpace: "1-1-1 (Rec. 709)" }), ...assets]);
  const sequence = el(
    "sequence",
    { format: "r1", duration: fcpTime(total, rate), tcStart: fcpTime(startFrames, rate), tcFormat: rate.dropFrame ? "DF" : "NDF", audioLayout: "stereo", audioRate: "48k" },
    [el("spine", {}, clips)],
  );
  const library = el("library", {}, [el("event", { name: "OpenEdit" }, [el("project", { name: seqName(input) }, [sequence])])]);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n${el("fcpxml", { version: "1.10" }, [resources, library])}\n`;
}

export function writeMultiInterchange(format: "fcp7" | "fcpxml", input: MultiInterchangeInput, output: string): string {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, format === "fcp7" ? multiToFCP7(input) : multiToFCPXML(input));
  return output;
}
