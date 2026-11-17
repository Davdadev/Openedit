import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import type { CutPlan, MediaInfo, Zoom } from "../hosts/types.js";
import { run } from "./exec.js";
import { mediaKind, probe, resolveMediaPath } from "./media.js";
import { editDuration } from "./remap.js";

export type Reframe = "9:16" | "1:1" | "16:9" | "4:5";

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
  /** "cover" fills the frame (b-roll), "none" keeps its own size, centred. Default "cover". */
  fit?: "cover" | "none";
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
}

export interface RenderOptions {
  /** Burn in an .ass subtitle file (requires an ffmpeg built with libass). */
  burnCaptions?: string;
  /** Which libass filter to use for burnCaptions; resolved automatically by renderCutPlan. */
  assFilter?: "ass" | "subtitles";
  /** Alternative to burnCaptions: a pre-rendered transparent caption video laid over the final frame. */
  captionOverlay?: string;
  reframe?: Reframe;
  /** EBU R128 loudness normalisation to -14 LUFS (social media standard). */
  loudnorm?: boolean;
  zooms?: ZoomSpec[];
  overlays?: VideoOverlaySpec[];
  audio?: AudioMixSpec[];
  /** x264 CRF, default 20. */
  crf?: number;
  /** x264 preset, default "veryfast". */
  preset?: string;
  /** Audio fade at each cut boundary to avoid clicks (s). Default 0.01. */
  edgeFade?: number;
}

export interface RenderResult {
  output: string;
  duration: number;
  width?: number;
  height?: number;
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

/** Output frame size after an aspect-ratio crop (centre crop, no upscaling). */
export function reframeSize(width: number, height: number, reframe?: Reframe): { width: number; height: number } {
  if (!reframe) return { width: even(width), height: even(height) };
  const [a, b] = reframe.split(":").map(Number);
  const r = a / b;
  if (width / height > r) return { width: even(height * r), height: even(height) };
  return { width: even(width), height: even(width / r) };
}

/** Escape a path for use as a filter option value inside a filtergraph. */
function filterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/([:'\\,;[\]])/g, "\\$1");
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

interface GraphInput {
  args: string[];
}

/** Assemble the full ffmpeg invocation for a cut plan plus layers. Exported for tests. */
export function buildRenderGraph(
  plan: CutPlan,
  info: MediaInfo,
  opts: RenderOptions,
): { inputs: GraphInput[]; graph: string; maps: string[]; outSize?: { width: number; height: number }; duration: number } {
  if (!plan.keep.length) throw new Error("Cut plan keeps nothing");
  const inputs: GraphInput[] = [{ args: ["-i", info.path] }];
  const lines: string[] = [];
  const hasV = info.hasVideo;
  const hasA = info.hasAudio;
  const total = editDuration(plan);
  const fade = opts.edgeFade ?? 0.01;

  // 1. Trim every kept range and concatenate.
  const concatIn: string[] = [];
  plan.keep.forEach((k, i) => {
    const len = k.end - k.start;
    if (hasV) {
      lines.push(`[0:v:0]trim=start=${n3(k.start)}:end=${n3(k.end)},setpts=PTS-STARTPTS[v${i}]`);
      concatIn.push(`[v${i}]`);
    }
    if (hasA) {
      const f = Math.min(fade, len / 4);
      const fades = f > 0 ? `,afade=t=in:st=0:d=${n3(f)},afade=t=out:st=${n3(len - f)}:d=${n3(f)}` : "";
      lines.push(`[0:a:0]atrim=start=${n3(k.start)}:end=${n3(k.end)},asetpts=PTS-STARTPTS${fades}[a${i}]`);
      concatIn.push(`[a${i}]`);
    }
  });
  const catOut = `${hasV ? "[vcat]" : ""}${hasA ? "[acat]" : ""}`;
  lines.push(`${concatIn.join("")}concat=n=${plan.keep.length}:v=${hasV ? 1 : 0}:a=${hasA ? 1 : 0}${catOut}`);

  let vLabel = hasV ? "vcat" : "";
  let aLabel = hasA ? "acat" : "";
  let outSize: { width: number; height: number } | undefined;

  if (hasV) {
    const W = even(info.width ?? 1920);
    const H = even(info.height ?? 1080);
    const fps = info.fps && info.fps > 0 && info.fps < 240 ? info.fps : 30;
    lines.push(`[${vLabel}]scale=${W}:${H},setsar=1[vbase]`);
    vLabel = "vbase";

    // 2. Zooms (punch-ins) on the main camera.
    if (opts.zooms?.length) {
      const z = zoomExpression(opts.zooms);
      if (z !== "1") {
        lines.push(
          `[${vLabel}]zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${n3(fps)}[vzoom]`,
        );
        vLabel = "vzoom";
      }
    }

    // 3. B-roll / graphics overlays.
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
        if (extname(o.path).toLowerCase() === ".webm") args.push("-c:v", "libvpx-vp9");
      }
      args.push("-i", resolve(o.path));
      inputs.push({ args });
      const fit =
        (o.fit ?? "cover") === "cover"
          ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},`
          : "";
      const end = span ? `${n3(o.at + span)}` : n3(total);
      lines.push(`[${idx}:v:0]${fit}setsar=1,format=yuva420p,setpts=PTS-STARTPTS+${n3(o.at)}/TB[ov${k}]`);
      lines.push(
        `[${vLabel}][ov${k}]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass:enable='between(t,${n3(o.at)},${end})'[vov${k}]`,
      );
      vLabel = `vov${k}`;
    });

    // 4. Reframe for vertical / square delivery.
    const size = reframeSize(W, H, opts.reframe);
    if (opts.reframe) {
      lines.push(`[${vLabel}]crop=${size.width}:${size.height}:(iw-${size.width})/2:(ih-${size.height})/2[vref]`);
      vLabel = "vref";
    }
    outSize = size;

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
      lines.push(`[${idx}:v:0]scale=${size.width}:${size.height},format=yuva420p[capov]`);
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
    const post = opts.loudnorm ? "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000" : "aresample=48000";
    lines.push(`[${aLabel}]${post}[aout]`);
    aLabel = "aout";
  }

  const maps: string[] = [];
  if (vLabel) maps.push("-map", `[${vLabel}]`);
  if (aLabel) maps.push("-map", `[${aLabel}]`);
  return { inputs, graph: lines.join(";\n"), maps, outSize, duration: total };
}

function encodeArgs(hasVideo: boolean, hasAudio: boolean, opts: { crf?: number; preset?: string }): string[] {
  const args: string[] = [];
  if (hasVideo) args.push("-c:v", "libx264", "-preset", opts.preset ?? "veryfast", "-crf", String(opts.crf ?? 20));
  if (hasAudio) args.push("-c:a", "aac", "-b:a", "192k");
  args.push("-movflags", "+faststart");
  return args;
}

async function runGraph(
  inputs: GraphInput[],
  graph: string,
  maps: string[],
  output: string,
  encode: string[],
  timeoutMs: number,
): Promise<void> {
  mkdirSync(dirname(output), { recursive: true });
  const script = join(tmpdir(), `openedit-graph-${process.pid}-${Date.now()}.txt`);
  writeFileSync(script, graph);
  try {
    await run(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-y",
        ...inputs.flatMap((i) => i.args),
        "-/filter_complex", script,
        ...maps,
        ...encode,
        output,
      ],
      { timeoutMs },
    );
  } finally {
    rmSync(script, { force: true });
  }
}

/**
 * Render a cut plan to a file in one ffmpeg pass: trim/concat of the kept
 * ranges (with ~10 ms audio fades at every join so cuts never click), then
 * zooms, overlays, reframe, captions, music and loudness normalisation.
 */
export async function renderCutPlan(plan: CutPlan, output: string, opts: RenderOptions = {}): Promise<RenderResult> {
  const info = await probe(plan.source);
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
  try {
    const { inputs, graph, maps, outSize, duration } = buildRenderGraph(plan, info, o);
    const timeout = Math.max(10 * 60_000, info.duration * 1000 * 10);
    await runGraph(inputs, graph, maps, out, encodeArgs(info.hasVideo, info.hasAudio, o), timeout);
    return { output: out, duration, ...(outSize ?? {}) };
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
