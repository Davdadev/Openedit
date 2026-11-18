import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import type { CutPlan, MediaInfo, Zoom } from "../hosts/types.js";
import { run } from "./exec.js";
import { mediaKind, probe, resolveMediaPath } from "./media.js";
import { cropSize, planReframe, type ReframeMode, type ReframePlan } from "./reframe.js";
import { editDuration } from "./remap.js";
import { splitRanges } from "./jl.js";
import { type Montage, fitFilter } from "./music.js";
import { type TimePiece, atempoChain, audioSteps, hasRetiming, setptsExpression, timePieces } from "./speed.js";

export type Reframe = "9:16" | "1:1" | "16:9" | "4:5";
export type RenderQuality = "draft" | "final";

/** Measured loudness from loudnorm's first pass (print_format=json). */
export interface LoudnormStats {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

export const LOUDNORM_TARGET = { I: -14, TP: -1.5, LRA: 11 };

/** A zoom with an optional ease (seconds to ramp in/out; 0 = hard punch-in). */
export interface ZoomSpec extends Zoom {
  ease?: number;
}

/** A video/image laid over the edit (b-roll, motion graphics, caption overlays). Times are edit time. */
export interface VideoOverlaySpec {
  path: string;
  at: number;
  sourceIn?: number;
  sourceOut?: number;
  /** Required for still images; defaults to 3 s. */
  duration?: number;
  /**
   * "cover" fills the output frame (b-roll), "contain" fits the whole overlay inside it (graphics made
   * for another aspect), "none" keeps its own size, centred. Default "cover".
   */
  fit?: "cover" | "contain" | "none";
  /** Video codec of the overlay (filled in by renderCutPlan). Only VP9 .webm needs the libvpx decoder for alpha. */
  codec?: string;
}

/** An audio file mixed under the edit (music, SFX). Times are edit time. */
export interface AudioMixSpec {
  path: string;
  at: number;
  sourceIn?: number;
  sourceOut?: number;
  gainDb?: number;
  /** Duck this track under the main dialogue by roughly this many dB. */
  duckDb?: number;
  /** Loop the file until the end of the edit (music beds). */
  loop?: boolean;
  /** Fade out over the last N seconds. */
  fadeOut?: number;
  /** Fade in over the first N seconds (e.g. b-roll natural sound leading its picture). */
  fadeIn?: number;
}

export interface RenderOptions {
  /** Burn in an .ass subtitle file (requires an ffmpeg built with libass). */
  burnCaptions?: string;
  /** Which libass filter to use for burnCaptions; resolved automatically by renderCutPlan. */
  assFilter?: "ass" | "subtitles";
  /** Alternative to burnCaptions: a pre-rendered transparent caption video laid over the final frame. */
  captionOverlay?: string;
  reframe?: Reframe;
  /** How to place the reframe crop: follow faces (auto, default), centre, or a manual focus point. */
  reframeMode?: ReframeMode;
  /** Horizontal focus 0..1 for manual mode, and the auto fallback when no face is found. */
  focusX?: number;
  /** Vertical focus 0..1 (vertical source cropped to a wider aspect). */
  focusY?: number;
  /** Resolved crop (filled in by renderCutPlan from reframe/reframeMode). x/y may be expressions of t. */
  crop?: Pick<ReframePlan, "width" | "height" | "x" | "y">;
  /** EBU R128 loudness normalisation to -14 LUFS / -1.5 dBTP (social media standard). */
  loudnorm?: boolean;
  /** Measured values from a first loudnorm pass: the second pass then applies a linear gain. */
  loudnormStats?: LoudnormStats;
  /** Make-up gain (dB) for the limiter path, measured by renderCutPlan so integrated loudness lands on target. */
  loudnormTrimDb?: number;
  /** "draft": hardware encode + single-pass loudnorm for fast previews. "final" (default): x264 + two-pass loudnorm. */
  quality?: RenderQuality;
  zooms?: ZoomSpec[];
  overlays?: VideoOverlaySpec[];
  audio?: AudioMixSpec[];
  /** x264 CRF, default 20. */
  crf?: number;
  /** x264 preset, default "veryfast". */
  preset?: string;
  /** Audio fade-in/out at the very start and end of the edit (s). Default 0.01. */
  edgeFade?: number;
  /** Audio crossfade at each join (s), equal-power; video stays a hard cut. Default 0.04. 0 = butt joins. */
  crossfade?: number;
}

export interface RenderResult {
  output: string;
  duration: number;
  width?: number;
  height?: number;
  /** How the reframe crop was placed (faces / manual / center) and why. */
  reframe?: { mode: string; coverage?: number; note?: string; keys?: number };
  /** Measured loudness of the first pass, when two-pass loudnorm ran. */
  loudness?: { measuredI: number; measuredTP: number };
  encoder?: string;
  seconds?: number;
}

let filterCache: Set<string> | null = null;

/** Names of the filters compiled into the local ffmpeg. */
export async function ffmpegFilters(): Promise<Set<string>> {
  if (filterCache) return filterCache;
  const { stdout } = await run("ffmpeg", ["-hide_banner", "-filters"]);
  filterCache = new Set(
    stdout
      .split("\n")
      .map((l) => /^\s*[TSC.|]{2,3}\s+(\S+)\s/.exec(l)?.[1])
      .filter((x): x is string => Boolean(x)),
  );
  return filterCache;
}

/** The libass filter this ffmpeg offers ("ass" preferred, else "subtitles"), or null if built without libass. */
export async function assFilterName(): Promise<"ass" | "subtitles" | null> {
  const f = await ffmpegFilters();
  return f.has("ass") ? "ass" : f.has("subtitles") ? "subtitles" : null;
}

export async function canBurnAss(): Promise<boolean> {
  return (await assFilterName()) !== null;
}

const n3 = (n: number) => (Math.round(n * 1000) / 1000).toString();
const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** Output frame size after an aspect-ratio crop (no upscaling). */
export function reframeSize(width: number, height: number, reframe?: Reframe): { width: number; height: number } {
  return cropSize(width, height, reframe);
}

/**
 * Escape a path for use as an (unquoted) filter option value inside a filtergraph.
 * Two levels: the option parser (\\ : ') and then the graph parser (\\ ' [ ] , ;).
 * Windows backslashes become forward slashes, which ffmpeg accepts.
 */
export function filterPath(p: string): string {
  const option = p.replace(/\\/g, "/").replace(/[\\:']/g, "\\$&");
  return option.replace(/[\\'[\],;]/g, "\\$&");
}

/** zoompan z-expression: 1 + sum of eased bumps over each zoom range. */
export function zoomExpression(zooms: ZoomSpec[]): string {
  if (!zooms.length) return "1";
  const terms = zooms
    .filter((z) => z.end > z.start && z.scale !== 100)
    .map((z) => {
      const amt = n3(z.scale / 100 - 1);
      const len = z.end - z.start;
      const ease = Math.min(z.ease ?? 0.15, len / 3);
      const a = n3(z.start);
      const b = n3(z.end);
      if (ease <= 0.001) return `${amt}*between(it,${a},${b})`;
      const e = n3(ease);
      return `${amt}*between(it,${a},${b})*min(1,min((it-${a})/${e},(${b}-it)/${e}))`;
    });
  return terms.length ? `1+${terms.join("+")}` : "1";
}

export interface GraphInput {
  args: string[];
}

/**
 * Crossfade length (s) for each join between consecutive kept ranges: the requested
 * length, shortened so it never exceeds either neighbouring keep and so the half-length
 * extensions stay inside the source. Snapped to 2 ms so half of it is a whole millisecond
 * (keeps the edit duration exact after rounding). 0 = plain butt join. Pure.
 */
export function joinCrossfades(keep: { start: number; end: number }[], sourceDuration: number, crossfade = 0.04): number[] {
  const out: number[] = [];
  const srcEnd = sourceDuration > 0 ? sourceDuration : Infinity;
  for (let j = 0; j < keep.length - 1; j++) {
    const a = keep[j];
    const b = keep[j + 1];
    if (b.start - a.end < 0.001) {
      out.push(0); // contiguous: nothing was cut, so nothing to hide
      continue;
    }
    let d = Math.min(crossfade, a.end - a.start, b.end - b.start, 2 * (srcEnd - a.end), 2 * b.start);
    d = Math.floor(Math.max(0, d) * 500 + 1e-6) / 500;
    out.push(d >= 0.004 ? d : 0);
  }
  return out;
}

/**
 * Audio filter lines for the kept ranges joined by short crossfades. Each keep's audio
 * is extended by half the crossfade on each joined side, so source time keep[i].start
 * still lands at the edited time sum(len of keeps before i) and the total length equals
 * the plan's edit duration. The very start and end get a tiny fade-in/out. Pure.
 */
export function audioJoinChain(
  keep: { start: number; end: number }[],
  sourceDuration: number,
  o: { crossfade?: number; edgeFade?: number },
  outLabel: string,
): string[] {
  const n = keep.length;
  const xf = joinCrossfades(keep, sourceDuration, o.crossfade ?? 0.04);
  const edge = o.edgeFade ?? 0.01;
  const lines: string[] = [];
  keep.forEach((k, i) => {
    const s = k.start - (i > 0 ? xf[i - 1] / 2 : 0);
    const e = k.end + (i < n - 1 ? xf[i] / 2 : 0);
    const len = e - s;
    const fades: string[] = [];
    const f = Math.min(edge, (k.end - k.start) / 4);
    if (i === 0 && f > 0) fades.push(`afade=t=in:st=0:d=${n3(f)}`);
    if (i === n - 1 && f > 0) fades.push(`afade=t=out:st=${n3(len - f)}:d=${n3(f)}`);
    const label = n === 1 ? outLabel : `a${i}`;
    lines.push(`[0:a:0]atrim=start=${n3(s)}:end=${n3(e)},asetpts=PTS-STARTPTS${fades.map((x) => `,${x}`).join("")}[${label}]`);
  });
  let acc = "a0";
  for (let j = 0; j < n - 1; j++) {
    const out = j === n - 2 ? outLabel : `ax${j + 1}`;
    lines.push(
      xf[j] > 0
        ? `[${acc}][a${j + 1}]acrossfade=d=${n3(xf[j])}:c1=qsin:c2=qsin[${out}]`
        : `[${acc}][a${j + 1}]concat=n=2:v=0:a=1[${out}]`,
    );
    acc = out;
  }
  return lines;
}

const n6 = (n: number) => String(Math.round(n * 1e6) / 1e6);

/**
 * The plan's pieces with split edits applied to their outer edges: the first piece of keep i
 * starts at the split-adjusted range start, the last ends at its end. Splits never touch a
 * retimed edge (normalizeSplits), so only "normal" pieces move.
 */
function splitPieces(plan: CutPlan, fps: number, track: "video" | "audio"): TimePiece[][] {
  const ranges = splitRanges(plan)[track];
  const pieces = timePieces(plan, fps);
  return plan.keep.map((_, i) => {
    const mine = pieces.filter((p) => p.keep === i).map((p) => ({ ...p }));
    if (!mine.length) return mine;
    const first = mine[0];
    const last = mine[mine.length - 1];
    if (first.kind === "normal") first.srcStart = ranges[i].start;
    if (last.kind === "normal") last.srcEnd = ranges[i].end;
    return mine;
  });
}

const pieceLen = (p: TimePiece) =>
  p.kind === "normal" ? p.srcEnd - p.srcStart : p.kind === "freeze" ? p.editEnd - p.editStart : (p.steps ?? []).reduce((a, st) => a + (st.s1 - st.s0) / st.v, 0);

/**
 * Picture of a retimed / split edit: one trim per piece. Ramps re-time frames with a piecewise
 * setpts (frame blending or motion interpolation optional for slow motion), freezes clone one
 * frame, reverse plays a range backwards; every non-plain piece is resampled to the source rate
 * and padded/trimmed to an exact frame count so picture and sound stay in sync. Pure.
 */
export function pieceVideoChain(plan: CutPlan, fps: number, outLabel: string): string[] {
  const lines: string[] = [];
  const labels: string[] = [];
  const F = n3(fps);
  splitPieces(plan, fps, "video").flat().forEach((p, k) => {
    const label = `vp${k}`;
    labels.push(`[${label}]`);
    const frames = Math.max(1, Math.round(pieceLen(p) * fps));
    const exact = `fps=${F},tpad=stop_mode=clone:stop_duration=${n3(2 / fps)},trim=end_frame=${frames},setpts=PTS-STARTPTS`;
    if (p.kind === "normal") {
      lines.push(`[0:v:0]trim=start=${n6(p.srcStart)}:end=${n6(p.srcEnd)},setpts=PTS-STARTPTS[${label}]`);
    } else if (p.kind === "freeze") {
      lines.push(
        `[0:v:0]trim=start=${n6(p.srcStart)}:duration=${n3(4 / fps)},setpts=PTS-STARTPTS,trim=end_frame=1,` +
          `tpad=stop_mode=clone:stop_duration=${n6(pieceLen(p) + 1 / fps)},${exact}[${label}]`,
      );
    } else if (p.kind === "reverse") {
      const v = p.steps?.[0].v ?? 1;
      lines.push(
        `[0:v:0]trim=start=${n6(p.srcStart)}:end=${n6(p.srcEnd)},setpts=PTS-STARTPTS,reverse,setpts=PTS-STARTPTS` +
          `${Math.abs(v - 1) > 1e-6 ? `,setpts=PTS/${n6(v)}` : ""},${exact}[${label}]`,
      );
    } else {
      const slow = (p.steps ?? []).some((st) => st.v < 0.999);
      const interp =
        slow && p.quality === "optical"
          ? `minterpolate=fps=${F}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,`
          : slow && p.quality === "blend"
            ? `minterpolate=fps=${F}:mi_mode=blend,`
            : "";
      lines.push(
        `[0:v:0]trim=start=${n6(p.srcStart)}:end=${n6(p.srcEnd)},setpts=PTS-STARTPTS,setpts='${setptsExpression(p.steps ?? [], p.srcStart)}',${interp}${exact}[${label}]`,
      );
    }
  });
  lines.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0[${outLabel}]`);
  return lines;
}

/**
 * Sound of a retimed / split edit: per kept range, its pieces (plain, time-stretched with the
 * pitch kept, or muted for ramps / freezes / reverse unless audio "pitch"), then the usual short
 * equal-power crossfade at each join (only where both sides are plain sound). Split edits move
 * each piece's sound edges by the split amounts. Pure.
 */
export function pieceAudioChain(
  plan: CutPlan,
  sourceDuration: number,
  o: { crossfade?: number; edgeFade?: number },
  outLabel: string,
  fps = 30,
): string[] {
  const perKeep = splitPieces(plan, fps, "audio");
  const ranges = splitRanges(plan).audio;
  const xf = joinCrossfades(ranges, sourceDuration, o.crossfade ?? 0.04).map((d, j) => {
    const a = perKeep[j].at(-1);
    const b = perKeep[j + 1]?.[0];
    return a?.kind === "normal" && b?.kind === "normal" ? d : 0;
  });
  const edge = o.edgeFade ?? 0.01;
  const n = perKeep.length;
  const lines: string[] = [];
  let seq = 0;
  perKeep.forEach((pieces, i) => {
    const labels: string[] = [];
    pieces.forEach((p, k) => {
      const label = `ap${seq++}`;
      labels.push(`[${label}]`);
      const len = pieceLen(p);
      let s = p.srcStart;
      let e = p.srcEnd;
      if (p.kind === "normal") {
        if (k === 0 && i > 0) s -= xf[i - 1] / 2;
        if (k === pieces.length - 1 && i < n - 1) e += xf[i] / 2;
        lines.push(`[0:a:0]atrim=start=${n6(s)}:end=${n6(e)},asetpts=PTS-STARTPTS[${label}]`);
        return;
      }
      const exact = `apad,atrim=duration=${n6(len)},asetpts=PTS-STARTPTS`;
      if (p.kind === "freeze" || p.audio !== "pitch") {
        // Silence with the source's own format (so it can be joined to the plain pieces).
        lines.push(`[0:a:0]atrim=start=${n6(p.srcStart)}:duration=${n6(Math.max(0.05, len))},asetpts=PTS-STARTPTS,volume=0,${exact}[${label}]`);
        return;
      }
      if (p.kind === "reverse") {
        const v = p.steps?.[0].v ?? 1;
        lines.push(`[0:a:0]atrim=start=${n6(s)}:end=${n6(e)},asetpts=PTS-STARTPTS,areverse,${atempoChain(v)},${exact}[${label}]`);
        return;
      }
      const steps = audioSteps(p.steps ?? []);
      const sub = steps.map((st, m) => {
        const l = `${label}s${m}`;
        // Each stretched chunk padded/trimmed to its exact length: atempo's flush makes short runs drift.
        lines.push(`[0:a:0]atrim=start=${n6(st.s0)}:end=${n6(st.s1)},asetpts=PTS-STARTPTS,${atempoChain(st.v)},apad,atrim=duration=${n6((st.s1 - st.s0) / st.v)},asetpts=PTS-STARTPTS[${l}]`);
        return `[${l}]`;
      });
      lines.push(`${sub.join("")}concat=n=${sub.length}:v=0:a=1,${exact}[${label}]`);
    });
    const keepLen = pieces.reduce((acc, p) => acc + pieceLen(p), 0);
    const fades: string[] = [];
    const f = Math.min(edge, keepLen / 4);
    const total = keepLen + (i > 0 ? xf[i - 1] / 2 : 0) + (i < n - 1 ? xf[i] / 2 : 0);
    if (i === 0 && f > 0) fades.push(`afade=t=in:st=0:d=${n3(f)}`);
    if (i === n - 1 && f > 0) fades.push(`afade=t=out:st=${n3(total - f)}:d=${n3(f)}`);
    const out = n === 1 ? outLabel : `a${i}`;
    const join = labels.length > 1 ? `${labels.join("")}concat=n=${labels.length}:v=0:a=1` : `${labels[0]}anull`;
    lines.push(`${join}${fades.map((x) => `,${x}`).join("")}[${out}]`);
  });
  let acc = "a0";
  for (let j = 0; j < n - 1; j++) {
    const out = j === n - 2 ? outLabel : `ax${j + 1}`;
    lines.push(xf[j] > 0 ? `[${acc}][a${j + 1}]acrossfade=d=${n3(xf[j])}:c1=qsin:c2=qsin[${out}]` : `[${acc}][a${j + 1}]concat=n=2:v=0:a=1[${out}]`);
    acc = out;
  }
  return lines;
}

/** Assemble the full ffmpeg invocation for a cut plan plus layers. Exported for tests. */
export function buildRenderGraph(
  plan: CutPlan,
  info: MediaInfo,
  opts: RenderOptions,
): { inputs: GraphInput[]; graph: string; maps: string[]; outSize?: { width: number; height: number }; duration: number } {
  if (!plan.keep.length) throw new Error("Cut plan keeps nothing");
  const minLen = info.hasVideo ? 1 / (info.fps && info.fps > 0 ? info.fps : 30) : 0.01;
  if (editDuration(plan) < minLen) {
    throw new Error(`The edit is ${editDuration(plan).toFixed(3)}s long, shorter than one frame: nothing to render. Keep more of the source.`);
  }
  const inputs: GraphInput[] = [{ args: ["-i", info.path] }];
  const lines: string[] = [];
  const hasV = info.hasVideo;
  const hasA = info.hasAudio;
  const total = editDuration(plan);
  const fade = opts.edgeFade ?? 0.01;

  // 1. Trim every kept range. Video: hard cuts, concatenated. Audio: a short
  //    equal-power crossfade at each join (no level dip, no discontinuity in a music bed).
  const n = plan.keep.length;
  const fpsIn = info.fps && info.fps > 0 && info.fps < 240 ? info.fps : 30;
  if (hasRetiming(plan) || plan.splits?.length) {
    // Speed ramps / freeze frames / reverse and split edits (J/L): picture and sound as pieces.
    if (hasV) lines.push(...pieceVideoChain(plan, fpsIn, "vcat"));
    if (hasA) lines.push(...pieceAudioChain(plan, info.duration, { crossfade: opts.crossfade, edgeFade: fade }, "acat", fpsIn));
  } else {
    if (hasV) {
      plan.keep.forEach((k, i) => lines.push(`[0:v:0]trim=start=${n3(k.start)}:end=${n3(k.end)},setpts=PTS-STARTPTS[v${i}]`));
      lines.push(`${plan.keep.map((_, i) => `[v${i}]`).join("")}concat=n=${n}:v=1:a=0[vcat]`);
    }
    if (hasA) lines.push(...audioJoinChain(plan.keep, info.duration, { crossfade: opts.crossfade, edgeFade: fade }, "acat"));
  }

  let vLabel = hasV ? "vcat" : "";
  let aLabel = hasA ? "acat" : "";
  let outSize: { width: number; height: number } | undefined;

  if (hasV) {
    const W = even(info.width ?? 1920);
    const H = even(info.height ?? 1080);
    const fps = info.fps && info.fps > 0 && info.fps < 240 ? info.fps : 30;
    lines.push(`[${vLabel}]scale=${W}:${H},setsar=1[vbase]`);
    vLabel = "vbase";

    // 2. Reframe the CAMERA first (subject-aware crop), so every layer below is
    //    composited at the output size and nothing placed left/right gets cropped away.
    const size = opts.crop ? { width: opts.crop.width, height: opts.crop.height } : reframeSize(W, H, opts.reframe);
    if (opts.reframe || opts.crop) {
      const x = opts.crop?.x ?? `(iw-${size.width})/2`;
      const y = opts.crop?.y ?? `(ih-${size.height})/2`;
      lines.push(`[${vLabel}]crop=${size.width}:${size.height}:x='${x}':y='${y}'[vref]`);
      vLabel = "vref";
    }
    const OW = size.width;
    const OH = size.height;
    outSize = size;

    // 3. Zooms (punch-ins) on the reframed camera, centred on the (already subject-centred) crop.
    if (opts.zooms?.length) {
      const z = zoomExpression(opts.zooms);
      if (z !== "1") {
        lines.push(
          `[${vLabel}]zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${OW}x${OH}:fps=${n3(fps)}[vzoom]`,
        );
        vLabel = "vzoom";
      }
    }

    // 4. B-roll / graphics overlays, at output size.
    (opts.overlays ?? []).forEach((o, k) => {
      const idx = inputs.length;
      const kind = mediaKind(o.path);
      const span =
        kind === "image"
          ? (o.duration ?? 3)
          : o.sourceOut !== undefined
            ? o.sourceOut - (o.sourceIn ?? 0)
            : o.duration;
      const args: string[] = [];
      if (kind === "image") args.push("-loop", "1", "-t", n3(span ?? 3));
      else {
        if (o.sourceIn) args.push("-ss", n3(o.sourceIn));
        if (span) args.push("-t", n3(span));
        // ffmpeg's native VP9 decoder drops alpha; libvpx keeps it. Forcing libvpx on
        // a non-VP9 .webm (AV1, VP8) makes the input undecodable, so only do it for VP9.
        if (extname(o.path).toLowerCase() === ".webm" && (o.codec ?? "vp9") === "vp9") args.push("-c:v", "libvpx-vp9");
      }
      args.push("-i", resolve(o.path));
      inputs.push({ args });
      const mode = o.fit ?? "cover";
      const fit =
        mode === "cover"
          ? `scale=${OW}:${OH}:force_original_aspect_ratio=increase,crop=${OW}:${OH},`
          : mode === "contain"
            ? `scale=${OW}:${OH}:force_original_aspect_ratio=decrease,`
            : "";
      const end = span ? `${n3(o.at + span)}` : n3(total);
      lines.push(`[${idx}:v:0]${fit}setsar=1,format=yuva420p,setpts=PTS-STARTPTS+${n3(o.at)}/TB[ov${k}]`);
      lines.push(
        `[${vLabel}][ov${k}]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass:enable='between(t,${n3(o.at)},${end})'[vov${k}]`,
      );
      vLabel = `vov${k}`;
    });

    // 5. Captions, on top of everything at final size.
    if (opts.burnCaptions) {
      lines.push(`[${vLabel}]${opts.assFilter ?? "ass"}=filename=${filterPath(opts.burnCaptions)}[vsub]`);
      vLabel = "vsub";
    } else if (opts.captionOverlay) {
      const idx = inputs.length;
      const args: string[] = [];
      if (extname(opts.captionOverlay).toLowerCase() === ".webm") args.push("-c:v", "libvpx-vp9");
      args.push("-i", resolve(opts.captionOverlay));
      inputs.push({ args });
      lines.push(`[${idx}:v:0]scale=${OW}:${OH},format=yuva420p[capov]`);
      lines.push(`[${vLabel}][capov]overlay=0:0:eof_action=pass[vcap]`);
      vLabel = "vcap";
    }
    lines.push(`[${vLabel}]format=yuv420p[vout]`);
    vLabel = "vout";
  }

  // 6. Music / SFX.
  const audioLayers = opts.audio ?? [];
  if (audioLayers.length) {
    const plain: string[] = [];
    const ducked: { label: string; duckDb: number }[] = [];
    audioLayers.forEach((a, k) => {
      const idx = inputs.length;
      const args: string[] = [];
      if (a.loop) args.push("-stream_loop", "-1");
      if (a.sourceIn) args.push("-ss", n3(a.sourceIn));
      args.push("-i", resolve(a.path));
      inputs.push({ args });
      const remaining = Math.max(0.01, total - a.at);
      const span = a.sourceOut !== undefined ? Math.min(a.sourceOut - (a.sourceIn ?? 0), remaining) : remaining;
      const chain = [
        `atrim=duration=${n3(span)}`,
        "asetpts=PTS-STARTPTS",
        "aformat=sample_rates=48000:channel_layouts=stereo",
        `volume=${a.gainDb ?? 0}dB`,
      ];
      if (a.fadeIn && a.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${n3(Math.min(a.fadeIn, span))}`);
      if (a.fadeOut && a.fadeOut > 0) chain.push(`afade=t=out:st=${n3(Math.max(0, span - a.fadeOut))}:d=${n3(a.fadeOut)}`);
      if (a.at > 0) chain.push(`adelay=${Math.round(a.at * 1000)}:all=1`);
      lines.push(`[${idx}:a:0]${chain.join(",")}[mx${k}]`);
      if (a.duckDb && a.duckDb > 0 && hasA) ducked.push({ label: `mx${k}`, duckDb: a.duckDb });
      else plain.push(`mx${k}`);
    });
    const mixInputs: string[] = [];
    if (hasA) {
      lines.push(`[${aLabel}]aformat=sample_rates=48000:channel_layouts=stereo[amain0]`);
      aLabel = "amain0";
      if (ducked.length) {
        lines.push(`[${aLabel}]asplit=2[amain][asc]`);
        aLabel = "amain";
        const duckIn = ducked.map((d) => `[${d.label}]`).join("");
        const pre = ducked.length > 1 ? `${duckIn}amix=inputs=${ducked.length}:normalize=0[duckin];[duckin]` : duckIn;
        const duckDb = Math.max(...ducked.map((d) => d.duckDb));
        // Speech sits ~20 dB over the -40 dB threshold: reduction ≈ 20·(1 − 1/ratio).
        const ratio = Math.min(20, 1 / Math.max(0.05, 1 - Math.min(duckDb, 19) / 20));
        lines.push(`${pre}[asc]sidechaincompress=threshold=0.01:ratio=${n3(ratio)}:attack=20:release=400[ducked]`);
        mixInputs.push(`[${aLabel}]`, "[ducked]");
      } else mixInputs.push(`[${aLabel}]`);
    }
    mixInputs.push(...plain.map((p) => `[${p}]`));
    if (mixInputs.length > 1) {
      lines.push(`${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=first:normalize=0[amix]`);
      aLabel = "amix";
    } else aLabel = mixInputs[0].slice(1, -1);
  }

  if (aLabel) {
    const post = opts.loudnorm ? `${loudnormFilter(opts.loudnormStats, opts.loudnormTrimDb)},aresample=48000` : "aresample=48000";
    lines.push(`[${aLabel}]${post}[aout]`);
    aLabel = "aout";
  }

  const maps: string[] = [];
  if (vLabel) maps.push("-map", `[${vLabel}]`);
  if (aLabel) maps.push("-map", `[${aLabel}]`);
  return { inputs, graph: lines.join(";\n"), maps, outSize, duration: total };
}

/** Headroom kept below the true-peak target for the AAC encoder's overshoot (dB). */
export const TP_CODEC_MARGIN = 1;

/**
 * Loudness filter chain.
 *  - no stats: single-pass (dynamic) loudnorm.
 *  - stats, and a plain gain keeps true peak under target: loudnorm second pass, linear=true.
 *  - stats, but the gain would push peaks over: the same linear gain followed by a 4x-oversampled
 *    limiter (an approximate true-peak limiter), instead of letting loudnorm silently switch to its
 *    dynamic mode (which overshoots the ceiling after AAC encoding).
 */
export function loudnormFilter(stats?: LoudnormStats, trimDb = 0): string {
  const { I, TP, LRA } = LOUDNORM_TARGET;
  const base = `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}`;
  if (!stats) return base;
  const gain = I - Number(stats.input_i);
  const ceiling = TP - TP_CODEC_MARGIN;
  if (Number(stats.input_tp) + gain <= ceiling) {
    return (
      `loudnorm=I=${I}:TP=${ceiling}:LRA=${Math.max(LRA, Math.ceil(Number(stats.input_lra)) + 1)}` +
      `:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}` +
      `:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true`
    );
  }
  const limit = Math.pow(10, ceiling / 20);
  return `volume=${n3(gain + trimDb)}dB,aresample=192000,alimiter=limit=${n3(limit)}:attack=2:release=60:level=false,aresample=48000`;
}

/** Pull the JSON block loudnorm prints (print_format=json) out of ffmpeg's stderr. */
export function parseLoudnormJson(stderr: string): LoudnormStats | null {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const j = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
    const keys = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"] as const;
    if (!keys.every((k) => j[k] !== undefined && Number.isFinite(Number(j[k])))) return null;
    return { input_i: j.input_i, input_tp: j.input_tp, input_lra: j.input_lra, input_thresh: j.input_thresh, target_offset: j.target_offset };
  } catch {
    return null;
  }
}

let encoderCache: Set<string> | null = null;
/** Names of the encoders compiled into the local ffmpeg. */
export async function ffmpegEncoders(): Promise<Set<string>> {
  if (encoderCache) return encoderCache;
  try {
    const { stdout } = await run("ffmpeg", ["-hide_banner", "-encoders"]);
    encoderCache = new Set(
      stdout
        .split("\n")
        .map((l) => /^\s*[VAS][.A-Z]{5}\s+(\S+)\s/.exec(l)?.[1])
        .filter((x): x is string => Boolean(x)),
    );
  } catch {
    encoderCache = new Set();
  }
  return encoderCache;
}

/**
 * Video/audio encoder arguments. final: libx264 (CRF 20, preset veryfast unless given).
 * draft: the hardware H.264 encoder when present (VideoToolbox on macOS), else x264 ultrafast.
 */
export function encodeArgs(
  hasVideo: boolean,
  hasAudio: boolean,
  opts: { crf?: number; preset?: string; quality?: RenderQuality },
  hw: { videotoolbox?: boolean } = {},
): string[] {
  const args: string[] = [];
  if (hasVideo) {
    if (opts.quality === "draft" && hw.videotoolbox) {
      args.push("-c:v", "h264_videotoolbox", "-q:v", "55", "-allow_sw", "1", "-realtime", "0", "-pix_fmt", "yuv420p");
    } else if (opts.quality === "draft") {
      args.push("-c:v", "libx264", "-preset", opts.preset ?? "ultrafast", "-crf", String(opts.crf ?? 24));
    } else {
      args.push("-c:v", "libx264", "-preset", opts.preset ?? "veryfast", "-crf", String(opts.crf ?? 20));
    }
  }
  if (hasAudio) args.push("-c:a", "aac", "-b:a", "192k");
  args.push("-movflags", "+faststart");
  return args;
}

export async function runGraph(
  inputs: GraphInput[],
  graph: string,
  maps: string[],
  output: string,
  encode: string[],
  timeoutMs: number,
  loglevel = "error",
): Promise<{ stderr: string }> {
  if (output !== "-") mkdirSync(dirname(output), { recursive: true });
  const script = join(tmpdir(), `openedit-graph-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  writeFileSync(script, graph);
  try {
    const r = await run(
      "ffmpeg",
      [
        "-hide_banner", "-nostats", "-loglevel", loglevel, "-y",
        ...inputs.flatMap((i) => i.args),
        "-/filter_complex", script,
        ...maps,
        ...encode,
        output,
      ],
      { timeoutMs },
    );
    return { stderr: r.stderr };
  } finally {
    rmSync(script, { force: true });
  }
}

/**
 * First loudnorm pass: run only the audio half of the graph (cuts, fades,
 * music, ducking) into loudnorm's analyser. Video is never decoded.
 */
export async function measureLoudness(plan: CutPlan, info: MediaInfo, opts: RenderOptions): Promise<LoudnormStats | null> {
  if (!info.hasAudio && !opts.audio?.length) return null;
  const audioOnly: MediaInfo = { ...info, hasVideo: false };
  // With opts.loudnorm unset this measures the raw mix; with stats set it measures the processed chain.
  const { inputs, graph } = buildRenderGraph(plan, audioOnly, { ...opts, overlays: [], captionOverlay: undefined, burnCaptions: undefined });
  const g = graph.replace(/aresample=48000\[aout\]$/, "aresample=48000,loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json[aout]");
  const timeout = Math.max(10 * 60_000, info.duration * 1000 * 5);
  const { stderr } = await runGraph(inputs, g, ["-map", "[aout]"], "-", ["-f", "null"], timeout, "info");
  return parseLoudnormJson(stderr);
}

/**
 * Render a cut plan to a file in one ffmpeg pass: trim/concat of the kept
 * ranges (with ~10 ms audio fades at every join so cuts never click), then
 * subject-aware reframe, zooms, overlays, captions, music and loudness
 * normalisation (two-pass, linear, for final quality).
 */
export async function renderCutPlan(plan: CutPlan, output: string, opts: RenderOptions = {}): Promise<RenderResult> {
  const t0 = Date.now();
  const info = await probe(plan.source);
  // Keep ranges past the real end of the source would make the reported duration a lie.
  if (info.duration > 0) {
    const keep = plan.keep
      .map((k) => ({ start: Math.max(0, k.start), end: Math.min(k.end, info.duration) }))
      .filter((k) => k.end - k.start > 1e-3);
    if (!keep.length) throw new Error(`The cut plan keeps nothing inside ${plan.source} (source is ${info.duration.toFixed(2)}s long).`);
    plan = { ...plan, keep };
  }
  const out = resolve(output);
  let assCopy: string | undefined;
  const o = { ...opts };
  if (o.burnCaptions) {
    const filter = await assFilterName();
    if (!filter) {
      throw new Error(
        "unsupported: this ffmpeg build has no libass (neither the \"ass\" nor \"subtitles\" filter exists), so .ass " +
          "captions cannot be burned in. Use captionOverlay (a transparent caption video from the motion renderer), " +
          "or install an ffmpeg built with libass (e.g. `brew install homebrew-ffmpeg/ffmpeg/ffmpeg`).",
      );
    }
    o.assFilter = filter;
    // Copy to a temp file with a filter-safe name.
    assCopy = join(tmpdir(), `openedit-captions-${process.pid}-${Date.now()}.ass`);
    copyFileSync(resolveMediaPath(o.burnCaptions), assCopy);
    o.burnCaptions = assCopy;
  }
  if (o.overlays?.length) {
    o.overlays = await Promise.all(
      o.overlays.map(async (ov) =>
        extname(ov.path).toLowerCase() === ".webm" && !ov.codec ? { ...ov, codec: (await probe(ov.path)).videoCodec } : ov,
      ),
    );
  }
  let reframeInfo: RenderResult["reframe"];
  if (o.reframe && !o.crop && info.hasVideo) {
    const rp = await planReframe(plan, info, { aspect: o.reframe, mode: o.reframeMode, focusX: o.focusX, focusY: o.focusY });
    o.crop = rp;
    reframeInfo = { mode: rp.mode, coverage: rp.coverage, note: rp.note, keys: rp.keys.length };
  }
  let loudness: RenderResult["loudness"];
  if (o.loudnorm && !o.loudnormStats && o.quality !== "draft") {
    const stats = await measureLoudness(plan, info, { ...o, loudnorm: false }).catch(() => null);
    if (stats) {
      o.loudnormStats = stats;
      loudness = { measuredI: Number(stats.input_i), measuredTP: Number(stats.input_tp) };
      // Limiter path: the limiter shaves a little loudness off the peaks; measure once more and make it up.
      if (loudnormFilter(stats).startsWith("volume=")) {
        const after = await measureLoudness(plan, info, o).catch(() => null);
        const trim = after ? LOUDNORM_TARGET.I - Number(after.input_i) : 0;
        if (Number.isFinite(trim) && Math.abs(trim) < 3) o.loudnormTrimDb = trim;
      }
    }
  }
  const hw = o.quality === "draft" ? { videotoolbox: (await ffmpegEncoders()).has("h264_videotoolbox") } : {};
  try {
    const { inputs, graph, maps, outSize, duration } = buildRenderGraph(plan, info, o);
    const timeout = Math.max(10 * 60_000, info.duration * 1000 * 10);
    const encode = encodeArgs(info.hasVideo, info.hasAudio || Boolean(o.audio?.length), o, hw);
    try {
      await runGraph(inputs, graph, maps, out, encode, timeout);
    } catch (e) {
      // Hardware encoders can refuse odd sizes or be busy: retry once in software.
      if (!encode.includes("h264_videotoolbox")) throw e;
      await runGraph(inputs, graph, maps, out, encodeArgs(info.hasVideo, info.hasAudio || Boolean(o.audio?.length), o, {}), timeout);
    }
    const encoder = encode.includes("-c:v") ? encode[encode.indexOf("-c:v") + 1] : undefined;
    return { output: out, duration, ...(outSize ?? {}), reframe: reframeInfo, loudness, encoder, seconds: (Date.now() - t0) / 1000 };
  } finally {
    if (assCopy) rmSync(assCopy, { force: true });
  }
}

/** Lay one video/image over `base` starting at `at` seconds (picture-in-picture or full-frame b-roll). */
export async function overlay(
  base: string,
  overlayPath: string,
  at: number,
  output: string,
  opts: Omit<VideoOverlaySpec, "path" | "at"> = {},
): Promise<RenderResult> {
  const info = await probe(base);
  const plan: CutPlan = { source: info.path, duration: info.duration, keep: [{ start: 0, end: info.duration }], cuts: [] };
  return renderCutPlan(plan, output, { overlays: [{ path: resolveMediaPath(overlayPath), at, ...opts }], edgeFade: 0 });
}

/** Mix a music bed under `base`, looped to length, ducked under speech, faded out at the end. */
export async function mixMusic(
  base: string,
  music: string,
  output: string,
  opts: { duckDb?: number; gainDb?: number; fadeOut?: number } = {},
): Promise<RenderResult> {
  const info = await probe(base);
  const plan: CutPlan = { source: info.path, duration: info.duration, keep: [{ start: 0, end: info.duration }], cuts: [] };
  return renderCutPlan(plan, output, {
    audio: [
      {
        path: resolveMediaPath(music),
        at: 0,
        loop: true,
        gainDb: opts.gainDb ?? -16,
        duckDb: opts.duckDb ?? 12,
        fadeOut: opts.fadeOut ?? 2,
      },
    ],
    edgeFade: 0,
  });
}

/** True when the first video stream carries an alpha channel (ProRes 4444, VP9 alpha, PNG/RGBA…). */
export async function hasAlpha(path: string): Promise<boolean> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=pix_fmt:stream_tags=alpha_mode", "-of", "json", resolveMediaPath(path),
    ], { timeoutMs: 30_000 });
    const s = (JSON.parse(stdout) as { streams?: { pix_fmt?: string; tags?: { alpha_mode?: string } }[] }).streams?.[0];
    if (!s) return false;
    if (s.tags?.alpha_mode === "1") return true;
    return /^(yuva|rgba|argb|bgra|abgr|gbrap|ya|pal8)/.test(s.pix_fmt ?? "");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- montage (cut to music)

export interface MontageRenderOptions {
  width?: number;
  height?: number;
  /** Mix each shot's own sound under the music at this gain (dB). Default: no natural sound. */
  natSoundDb?: number;
  /** Music gain (dB), default 0 (loudness normalisation follows). */
  musicGainDb?: number;
  loudnorm?: boolean;
  quality?: RenderQuality;
  crf?: number;
  preset?: string;
}

/**
 * Render a montage (multi-source shots cut to a fitted song) in one ffmpeg pass. Every shot is
 * cut to an exact frame count so the picture cuts land on the frame nearest each beat with no
 * drift; the song is rebuilt from its fitted segments (bar-line edits with short crossfades).
 */
export async function renderMontage(m: Montage, output: string, opts: MontageRenderOptions = {}): Promise<RenderResult> {
  const t0 = Date.now();
  if (!m.shots.length) throw new Error("Montage has no shots");
  const out = resolve(output);
  const first = await probe(m.shots[0].path);
  let W = even(opts.width ?? first.width ?? 1920);
  let H = even(opts.height ?? first.height ?? 1080);
  if (!opts.width && !opts.height && W * H > 1920 * 1080) {
    const k = Math.sqrt((1920 * 1080) / (W * H));
    W = even(W * k);
    H = even(H * k);
  }
  const F = m.fps;
  const probes = new Map<string, MediaInfo>();
  for (const s of m.shots) if (!probes.has(s.path)) probes.set(s.path, await probe(s.path));
  const build = (withVideo: boolean, stats?: LoudnormStats) => {
    const inputs: GraphInput[] = [];
    const lines: string[] = [];
    const labels: string[] = [];
    const nat: string[] = [];
    m.shots.forEach((s, k) => {
      const kind = mediaKind(s.path);
      inputs.push({ args: kind === "image" ? ["-loop", "1", "-t", n3(s.duration + 0.5), "-i", resolve(s.path)] : ["-ss", n3(s.in), "-t", n3(s.duration + 0.5), "-i", resolve(s.path)] });
      const frames = Math.round((s.at + s.duration) * F) - Math.round(s.at * F);
      if (withVideo) {
        lines.push(
          `[${k}:v:0]setpts=PTS-STARTPTS,fps=${n3(F)},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p,` +
            `tpad=stop_mode=clone:stop_duration=${n3(s.duration + 1)},trim=end_frame=${Math.max(1, frames)},setpts=PTS-STARTPTS[s${k}]`,
        );
        labels.push(`[s${k}]`);
      }
      if (opts.natSoundDb !== undefined && probes.get(s.path)?.hasAudio) {
        lines.push(
          `[${k}:a:0]atrim=duration=${n3(s.duration)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=${opts.natSoundDb}dB,` +
            `afade=t=in:d=0.02,afade=t=out:st=${n3(Math.max(0, s.duration - 0.04))}:d=0.04,adelay=${Math.round(s.at * 1000)}:all=1[n${k}]`,
        );
        nat.push(`[n${k}]`);
      }
    });
    if (withVideo) lines.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0[vout]`);
    const mi = inputs.length;
    inputs.push({ args: ["-i", resolve(m.music.source)] });
    lines.push(fitFilter(m.music, `${mi}:a:0`, "music0"));
    lines.push(`[music0]volume=${opts.musicGainDb ?? 0}dB[music]`);
    let a = "music";
    if (nat.length) {
      lines.push(`[music]${nat.join("")}amix=inputs=${nat.length + 1}:duration=first:normalize=0[mixed]`);
      a = "mixed";
    }
    const post = opts.loudnorm ? `${loudnormFilter(stats)},aresample=48000` : "aresample=48000";
    lines.push(`[${a}]${post},atrim=duration=${n3(m.duration)}[aout]`);
    return { inputs, graph: lines.join(";\n") };
  };
  let loudness: RenderResult["loudness"];
  let stats: LoudnormStats | undefined;
  if (opts.loudnorm && opts.quality !== "draft") {
    const { inputs, graph } = build(false);
    const g = graph.replace(/\[aout\]$/, ",loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json[aout]");
    try {
      const { stderr } = await runGraph(inputs, g, ["-map", "[aout]"], "-", ["-f", "null"], 10 * 60_000, "info");
      stats = parseLoudnormJson(stderr) ?? undefined;
      if (stats) loudness = { measuredI: Number(stats.input_i), measuredTP: Number(stats.input_tp) };
    } catch {
      stats = undefined;
    }
  }
  const { inputs, graph } = build(true, stats);
  const hw = opts.quality === "draft" ? { videotoolbox: (await ffmpegEncoders()).has("h264_videotoolbox") } : {};
  const encode = encodeArgs(true, true, opts, hw);
  await runGraph(inputs, graph, ["-map", "[vout]", "-map", "[aout]"], out, [...encode, "-r", n3(F)], Math.max(10 * 60_000, m.duration * 20_000));
  const encoder = encode[encode.indexOf("-c:v") + 1];
  return { output: out, duration: m.duration, width: W, height: H, loudness, encoder, seconds: (Date.now() - t0) / 1000 };
}
