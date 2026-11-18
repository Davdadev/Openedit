/**
 * Directed sequences: the edit Claude designs shot by shot, rendered cleanly.
 *
 * plan_cuts trims a talking head and build_montage cuts mechanically to a beat grid. Neither
 * lets an editor DIRECT a piece: choose each shot and how long it plays, how it enters
 * (cut, dissolve, dip, flash, whip, slide), its speed (constant, eased ramp, reverse, a held
 * last frame), a camera move (push-in, pull-out, drift), one grade over the whole piece with
 * per-shot exposure matching, titles from the graphics catalog, sound effects and a music
 * bed that ends on its own resolution, all loudness-normalised. That is what ads, promos,
 * product films, trailers and travel pieces are made of; this module renders it.
 *
 * Timeline model: shot k starts at the sum of the earlier shots' durations. A transition
 * INTO shot k starts at that cut point and lasts `transition.duration`, so shot k-1 is
 * rendered that much longer (its tail plays under the transition) and the total length is
 * exactly the sum of durations. Everything except rendering is pure and unit-tested.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { MediaInfo, SpeedRamp } from "../hosts/types.js";
import { detectBeats } from "./beats.js";
import { probe, resolveMediaPath } from "./media.js";
import { fitFilter, fitMusic } from "./music.js";
import { encodeArgs, ffmpegEncoders, type GraphInput, loudnormFilter, parseLoudnormJson, runGraph, type LoudnormStats } from "./render.js";
import { ease, rampSteps, type RampCurve, type SpeedStep, setptsExpression } from "./speed.js";

export const TRANSITIONS = [
  "cut",
  "dissolve",
  "dip-black",
  "dip-white",
  "flash",
  "whip-left",
  "whip-right",
  "whip-up",
  "whip-down",
  "slide-left",
  "slide-right",
  "zoom",
  "wipe-left",
  "wipe-right",
  "circle-open",
] as const;
export type TransitionType = (typeof TRANSITIONS)[number];

export const MOVES = ["none", "push-in", "pull-out", "drift-left", "drift-right", "drift-up", "drift-down"] as const;
export type MoveType = (typeof MOVES)[number];

export const LOOKS = ["natural", "punchy", "candy", "warm-film", "cool-clean", "moody", "bright-airy", "mono"] as const;
export type LookPreset = (typeof LOOKS)[number];

/** ffmpeg xfade transition and default length (s) for each transition type. */
const XFADE: Record<Exclude<TransitionType, "cut">, { x: string; d: number; blur?: number }> = {
  dissolve: { x: "fade", d: 0.5 },
  "dip-black": { x: "fadeblack", d: 0.6 },
  "dip-white": { x: "fadewhite", d: 0.5 },
  flash: { x: "fadewhite", d: 0.16 },
  "whip-left": { x: "smoothleft", d: 0.22, blur: 0 },
  "whip-right": { x: "smoothright", d: 0.22, blur: 0 },
  "whip-up": { x: "smoothup", d: 0.22, blur: 90 },
  "whip-down": { x: "smoothdown", d: 0.22, blur: 90 },
  "slide-left": { x: "slideleft", d: 0.35 },
  "slide-right": { x: "slideright", d: 0.35 },
  zoom: { x: "zoomin", d: 0.35 },
  "wipe-left": { x: "wipeleft", d: 0.4 },
  "wipe-right": { x: "wiperight", d: 0.4 },
  "circle-open": { x: "circleopen", d: 0.5 },
};

export interface SequenceShotInput {
  path: string;
  /** Source in point (s). Default: the middle of the clip for the span needed. */
  in?: number;
  /** Seconds this shot plays on the timeline (including any held last frame). */
  duration: number;
  /** Constant speed (0.25 = 4x slow motion). */
  speed?: number;
  /** Eased speed change across the shot (e.g. {from:1, to:0.3, curve:"ease-out"} to ramp into a moment). */
  ramp?: { from: number; to: number; curve?: RampCurve };
  reverse?: boolean;
  /** Hold the last frame this many seconds (part of `duration`). */
  holdEnd?: number;
  /** Slow-motion frame synthesis when slower than 1x. */
  slowmo?: "frames" | "blend" | "optical";
  move?: { type: MoveType; amount?: number };
  /** How this shot enters (ignored on the first shot unless it is a dip/fade from black or white). */
  transition?: { type: TransitionType; duration?: number };
  /** Exposure correction in stops (-2..2), applied before the look. */
  exposure?: number;
  /** Per-shot saturation multiplier (0..2). */
  saturation?: number;
  /** This shot's own sound under the mix, dB (omit = silent). Muted on ramps and reverse. */
  natSoundDb?: number;
  note?: string;
}

export interface SequenceLook {
  preset?: LookPreset;
  /** 0..1, how strongly the preset is applied (default 1). */
  intensity?: number;
  /** A .cube LUT applied after the preset. */
  lut?: string;
  grain?: number;
  vignette?: number;
  /** Letterbox to this aspect (e.g. 2.39). */
  letterbox?: number;
}

export interface SequenceSpec {
  shots: SequenceShotInput[];
  fps?: number;
  width?: number;
  height?: number;
  look?: SequenceLook;
  music?: { path: string; gainDb?: number; fit?: boolean; start?: number; fadeOut?: number };
  sfx?: { path: string; at: number; gainDb?: number }[];
  /** Pre-rendered overlays (alpha .mov/.webm or opaque video) at timeline times. */
  overlays?: { path: string; at: number; duration?: number }[];
  /** Fade the picture in from / out to black at the ends (s). */
  fadeIn?: number;
  fadeOut?: number;
}

export interface ResolvedShot extends SequenceShotInput {
  index: number;
  /** Timeline start (s). */
  at: number;
  /** Rendered length: duration plus the next transition's overlap. */
  renderLen: number;
  /** Source seconds consumed. */
  span: number;
  srcIn: number;
  /** Moving (non-held) part of the rendered length. */
  moving: number;
  steps: SpeedStep[];
  transitionIn?: { type: Exclude<TransitionType, "cut">; duration: number };
  sourceDuration: number;
  hasAudio: boolean;
}

export interface ResolvedSequence {
  shots: ResolvedShot[];
  duration: number;
  fps: number;
  width: number;
  height: number;
  warnings: string[];
}

const n3 = (n: number) => String(Math.round(n * 1000) / 1000);
const n6 = (n: number) => String(Math.round(n * 1e6) / 1e6);
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Output seconds of a speed-step list. */
const outLen = (steps: SpeedStep[]) => steps.reduce((a, s) => a + (s.s1 - s.s0) / s.v, 0);

/**
 * Speed steps playing `target` output seconds starting at source `srcIn`, for a constant
 * speed or an eased ramp. Ramps are defined over the source range, so the source span is
 * found by bisection (output length is monotone in span).
 */
export function speedPlan(shot: Pick<SequenceShotInput, "speed" | "ramp">, srcIn: number, target: number, fps: number): { span: number; steps: SpeedStep[] } {
  if (!shot.ramp) {
    const v = clamp(shot.speed ?? 1, 0.05, 16);
    return { span: target * v, steps: [{ s0: srcIn, s1: srcIn + target * v, v }] };
  }
  const r = (span: number): SpeedRamp => ({ start: srcIn, end: srcIn + span, from: shot.ramp!.from, to: shot.ramp!.to, curve: shot.ramp!.curve ?? "ease-in-out" });
  const vmax = Math.max(shot.ramp.from, shot.ramp.to);
  let lo = 0;
  let hi = target * vmax + 1e-3;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (outLen(rampSteps(r(mid), srcIn, srcIn + mid, fps)) < target) lo = mid;
    else hi = mid;
  }
  const span = hi;
  return { span, steps: rampSteps(r(span), srcIn, srcIn + span, fps) };
}

/** Lay the shots on the timeline and check they can be played (pure: probes are passed in). */
export function resolveSequence(spec: SequenceSpec, probes: Map<string, MediaInfo>): ResolvedSequence {
  if (!spec.shots.length) throw new Error("A sequence needs at least one shot");
  const warnings: string[] = [];
  const first = probes.get(spec.shots[0].path);
  const fps = spec.fps ?? (first?.fps && first.fps < 120 ? first.fps : 30);
  let W = even(spec.width ?? first?.width ?? 1920);
  let H = even(spec.height ?? first?.height ?? 1080);
  if (!spec.width && !spec.height && W * H > 1920 * 1080) {
    const k = Math.sqrt((1920 * 1080) / (W * H));
    W = even(W * k);
    H = even(H * k);
  }
  const frame = 1 / fps;
  const q = (t: number) => Math.round(t * fps) / fps;
  const shots: ResolvedShot[] = [];
  let at = 0;
  spec.shots.forEach((s, k) => {
    const info = probes.get(s.path);
    if (!info) throw new Error(`shot ${k + 1}: ${s.path} was not probed`);
    const duration = Math.max(frame, q(s.duration));
    const nextT = spec.shots[k + 1]?.transition;
    const nextLen = nextT && nextT.type !== "cut" ? q(nextT.duration ?? XFADE[nextT.type].d) : 0;
    const t = s.transition && s.transition.type !== "cut" ? { type: s.transition.type, duration: q(s.transition.duration ?? XFADE[s.transition.type].d) } : undefined;
    if (t && t.duration >= duration) warnings.push(`shot ${k + 1}: its ${t.type} (${t.duration}s) is as long as the shot (${duration}s)`);
    if (nextLen > duration * 0.8) warnings.push(`shot ${k + 1}: the transition after it (${nextLen}s) eats most of the shot`);
    const renderLen = duration + nextLen;
    const hold = clamp(s.holdEnd ?? 0, 0, Math.max(0, renderLen - frame));
    const moving = Math.max(frame, renderLen - hold);
    const srcDur = info.duration || 0;
    // Span needed at the chosen speed, then the in point (default: centred in the clip).
    const probeIn = s.in ?? 0;
    let { span, steps } = speedPlan(s, probeIn, moving, fps);
    let srcIn = s.in ?? Math.max(0, (srcDur - span) / 2);
    if (s.in === undefined) ({ span, steps } = speedPlan(s, srcIn, moving, fps));
    if (srcDur && srcIn + span > srcDur + 0.05) {
      const short = srcIn + span - srcDur;
      if (s.in === undefined || srcIn - short >= 0) {
        srcIn = Math.max(0, srcDur - span);
        ({ span, steps } = speedPlan(s, srcIn, moving, fps));
      }
      if (srcIn + span > srcDur + 0.05) {
        warnings.push(`shot ${k + 1}: ${basename(s.path)} has only ${(srcDur - srcIn).toFixed(2)}s from ${srcIn.toFixed(2)}s but needs ${span.toFixed(2)}s at this speed; its last frame is held`);
      }
    }
    if (s.ramp && Math.max(s.ramp.from, s.ramp.to) / Math.min(s.ramp.from, s.ramp.to) > 8) warnings.push(`shot ${k + 1}: an ${s.ramp.from}→${s.ramp.to} ramp jumps more than 8x and will look like a glitch`);
    if (k === 0 && t && !["dip-black", "dip-white", "dissolve"].includes(t.type)) warnings.push(`shot 1: a ${t.type} needs a shot before it; ignored`);
    shots.push({
      ...s,
      index: k,
      at: q(at),
      duration,
      renderLen,
      span,
      srcIn,
      moving,
      steps,
      transitionIn: k === 0 ? undefined : t,
      sourceDuration: srcDur,
      hasAudio: !!info.hasAudio,
    });
    at += duration;
  });
  // First shot may fade up from black/white: treat as a picture fade-in.
  return { shots, duration: q(at), fps, width: W, height: H, warnings };
}

interface LookParams {
  contrast: number;
  saturation: number;
  gamma: number;
  vibrance: number;
  temperature?: number;
  curves?: string;
  sharpen: number;
  grain: number;
  vignette: number;
}

const LOOK_PARAMS: Record<LookPreset, LookParams> = {
  natural: { contrast: 1, saturation: 1, gamma: 1, vibrance: 0, sharpen: 0, grain: 0, vignette: 0 },
  punchy: { contrast: 1.1, saturation: 1.15, gamma: 0.98, vibrance: 0.2, curves: "0/0 0.25/0.22 0.75/0.79 1/1", sharpen: 0.35, grain: 0, vignette: 0.15 },
  candy: { contrast: 1.08, saturation: 1.28, gamma: 1.02, vibrance: 0.3, temperature: 6300, curves: "0/0.01 0.3/0.28 0.7/0.74 1/1", sharpen: 0.45, grain: 0, vignette: 0.1 },
  "warm-film": { contrast: 1.04, saturation: 0.95, gamma: 1, vibrance: 0, temperature: 5300, curves: "0/0.05 0.5/0.5 1/0.95", sharpen: 0, grain: 7, vignette: 0.35 },
  "cool-clean": { contrast: 1.06, saturation: 1, gamma: 1.02, vibrance: 0.1, temperature: 7400, sharpen: 0.25, grain: 0, vignette: 0 },
  moody: { contrast: 1.16, saturation: 0.82, gamma: 0.93, vibrance: 0, temperature: 6000, curves: "0/0 0.2/0.13 0.8/0.84 1/0.97", sharpen: 0.2, grain: 4, vignette: 0.45 },
  "bright-airy": { contrast: 0.96, saturation: 1.05, gamma: 1.1, vibrance: 0.1, temperature: 6800, curves: "0/0.04 1/1", sharpen: 0.15, grain: 0, vignette: 0 },
  mono: { contrast: 1.14, saturation: 0, gamma: 0.98, vibrance: 0, curves: "0/0 0.25/0.2 0.75/0.8 1/1", sharpen: 0.25, grain: 5, vignette: 0.3 },
};

/** The grade as an ffmpeg filter chain ("" for none). Intensity scales every parameter toward neutral. */
export function lookFilter(look: SequenceLook | undefined, W: number, H: number): string {
  if (!look) return "";
  const p = LOOK_PARAMS[look.preset ?? "natural"];
  const k = clamp(look.intensity ?? 1, 0, 1);
  const mix = (v: number, neutral: number) => neutral + (v - neutral) * k;
  const f: string[] = [];
  if (p.temperature) f.push(`colortemperature=temperature=${Math.round(mix(p.temperature, 6500))}:mix=${n3(0.8 * k)}`);
  const c = mix(p.contrast, 1);
  const s = mix(p.saturation, 1);
  const g = mix(p.gamma, 1);
  if (c !== 1 || s !== 1 || g !== 1) f.push(`eq=contrast=${n3(c)}:saturation=${n3(s)}:gamma=${n3(g)}`);
  if (p.vibrance) f.push(`vibrance=intensity=${n3(p.vibrance * k)}`);
  if (p.curves && k > 0) f.push(`curves=all='${p.curves}'`);
  if (look.lut) f.push(`lut3d=file='${resolve(look.lut).replace(/\\/g, "/").replace(/'/g, "\\'")}'`);
  if (p.sharpen) f.push(`unsharp=5:5:${n3(p.sharpen * k)}`);
  const vig = look.vignette ?? p.vignette * k;
  if (vig > 0) f.push(`vignette=angle=${n3(0.2 + 0.5 * clamp(vig, 0, 1))}`);
  const grain = look.grain ?? p.grain * k;
  if (grain > 0) f.push(`noise=alls=${Math.round(clamp(grain, 0, 30))}:allf=t+u`);
  if (look.letterbox && look.letterbox > W / H) {
    const bar = even((H - W / look.letterbox) / 2);
    f.push(`drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill,drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill`);
  }
  return f.join(",");
}

/** Camera move as scale(eval=frame)+crop on a W×H stream of length D seconds. */
export function moveFilter(move: SequenceShotInput["move"], W: number, H: number, D: number): string {
  if (!move || move.type === "none") return "";
  const a = clamp(move.amount ?? 0.08, 0.01, 0.4);
  const p = `min(1,t/${n6(Math.max(0.04, D))})`;
  const eased = `(${p}*${p}*(3-2*${p}))`;
  let z = `(1+${n6(a)})`;
  let x = "(iw-ow)/2";
  let y = "(ih-oh)/2";
  switch (move.type) {
    case "push-in":
      z = `(1+${n6(a)}*${eased})`;
      break;
    case "pull-out":
      z = `(1+${n6(a)}*(1-${eased}))`;
      break;
    case "drift-left":
      x = `(iw-ow)*(1-${eased})`;
      break;
    case "drift-right":
      x = `(iw-ow)*${eased}`;
      break;
    case "drift-up":
      y = `(ih-oh)*(1-${eased})`;
      break;
    case "drift-down":
      y = `(ih-oh)*${eased}`;
      break;
  }
  return `scale=w='2*trunc(${W}*${z}/2)':h='2*trunc(${H}*${z}/2)':eval=frame:flags=bicubic,crop=${W}:${H}:'${x}':'${y}',setsar=1`;
}

/** Exposure (stops) and saturation for one shot. */
function shotGrade(s: SequenceShotInput): string {
  const f: string[] = [];
  if (s.exposure) f.push(`exposure=exposure=${n3(clamp(s.exposure, -3, 3))}`);
  if (s.saturation !== undefined && s.saturation !== 1) f.push(`eq=saturation=${n3(clamp(s.saturation, 0, 3))}`);
  return f.join(",");
}

export interface SequenceGraphOptions {
  look?: SequenceLook;
  overlays?: { path: string; at: number; duration?: number }[];
  music?: { path: string; gainDb?: number; fitFilter?: string; start?: number; fadeOut?: number };
  sfx?: { path: string; at: number; gainDb?: number }[];
  fadeIn?: number;
  fadeOut?: number;
  loudnorm?: string;
  withVideo?: boolean;
}

/** The whole filter graph (pure). Inputs: one per shot, then overlays, music, sfx. */
export function buildSequenceGraph(seq: ResolvedSequence, o: SequenceGraphOptions): { inputs: GraphInput[]; graph: string; hasAudio: boolean } {
  const { width: W, height: H, fps: F, duration: T } = seq;
  const withVideo = o.withVideo !== false;
  const inputs: GraphInput[] = [];
  const lines: string[] = [];
  const audio: string[] = [];
  const frames = (t: number) => Math.max(1, Math.round(t * F));
  seq.shots.forEach((s, k) => {
    inputs.push({ args: ["-ss", n3(s.srcIn), "-t", n3(s.span + 0.5), "-i", resolve(s.path)] });
    if (withVideo) {
      const chain: string[] = ["setpts=PTS-STARTPTS"];
      if (s.reverse) chain.push(`trim=duration=${n3(s.span)}`, "reverse", "setpts=PTS-STARTPTS");
      const constant = s.steps.length === 1;
      chain.push(constant ? `setpts=(PTS-STARTPTS)/${n6(s.steps[0].v)}` : `setpts='${setptsExpression(s.steps, s.srcIn)}'`);
      const slow = Math.min(...s.steps.map((x) => x.v)) < 0.99;
      if (slow && s.slowmo === "optical") chain.push(`minterpolate=fps=${n3(F)}:mi_mode=mci:mc_mode=aobmc:vsbmc=1`);
      else if (slow && s.slowmo === "blend") chain.push(`minterpolate=fps=${n3(F)}:mi_mode=blend`);
      chain.push(`fps=${n3(F)}`, `scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`, "setsar=1", "format=yuv420p");
      const g = shotGrade(s);
      if (g) chain.push(g);
      const mv = moveFilter(s.move, W, H, s.renderLen);
      if (mv) chain.push(mv);
      // Whip: directional blur over the frames either side of the whip cut.
      const into = s.transitionIn && XFADE[s.transitionIn.type];
      const next = seq.shots[k + 1]?.transitionIn;
      const out = next && XFADE[next.type];
      if (into?.blur !== undefined) chain.push(`dblur=angle=${into.blur}:radius=60:enable='lt(t,${n3(s.transitionIn!.duration + 0.06)})'`);
      if (out?.blur !== undefined) chain.push(`dblur=angle=${out.blur}:radius=60:enable='gt(t,${n3(s.duration - 0.06)})'`);
      chain.push(`tpad=stop_mode=clone:stop_duration=${n3(s.renderLen + 1)}`, `trim=end_frame=${frames(s.renderLen)}`, "setpts=PTS-STARTPTS", "setsar=1", `fps=${n3(F)}`, `settb=1/${Math.round(F)}`);
      lines.push(`[${k}:v:0]${chain.join(",")}[s${k}]`);
    }
    const retimed = !!s.ramp || !!s.reverse;
    if (s.natSoundDb !== undefined && s.hasAudio && !retimed) {
      const v = s.steps[0].v;
      const tempo = Math.abs(v - 1) > 1e-3 ? `,${atempo(v)}` : "";
      const len = s.duration + (seq.shots[k + 1]?.transitionIn?.duration ?? 0);
      lines.push(
        `[${k}:a:0]asetpts=PTS-STARTPTS${tempo},atrim=duration=${n3(Math.min(len, s.moving))},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,` +
          `volume=${n3(s.natSoundDb)}dB,afade=t=in:d=0.03,afade=t=out:st=${n3(Math.max(0, Math.min(len, s.moving) - 0.08))}:d=0.08,adelay=${Math.round(s.at * 1000)}:all=1[n${k}]`,
      );
      audio.push(`[n${k}]`);
    }
  });
  if (withVideo) {
    // Join: concat on hard cuts, xfade on transitions (offset = cut point on the timeline).
    let acc = "s0";
    let accLen = seq.shots[0].renderLen;
    for (let k = 1; k < seq.shots.length; k++) {
      const s = seq.shots[k];
      const lbl = `j${k}`;
      if (s.transitionIn) {
        const x = XFADE[s.transitionIn.type];
        lines.push(`[${acc}][s${k}]xfade=transition=${x.x}:duration=${n3(s.transitionIn.duration)}:offset=${n3(s.at)},fps=${n3(F)},settb=1/${Math.round(F)}[${lbl}]`);
      } else {
        lines.push(`[${acc}][s${k}]concat=n=2:v=1:a=0,fps=${n3(F)},settb=1/${Math.round(F)}[${lbl}]`);
      }
      acc = lbl;
      accLen = s.at + s.renderLen;
    }
    void accLen;
    const post: string[] = [`trim=end_frame=${frames(T)}`, "setpts=PTS-STARTPTS"];
    const look = lookFilter(o.look, W, H);
    if (look) post.push(look);
    const firstT = seq.shots[0].transition;
    const fadeIn = o.fadeIn ?? (firstT && (firstT.type === "dip-black" || firstT.type === "dissolve") ? firstT.duration ?? 0.5 : 0);
    if (fadeIn > 0) post.push(`fade=t=in:d=${n3(fadeIn)}`);
    if (firstT?.type === "dip-white") post.push(`fade=t=in:d=${n3(firstT.duration ?? 0.5)}:color=white`);
    lines.push(`[${acc}]${post.join(",")}[graded]`);
    let v = "graded";
    (o.overlays ?? []).forEach((ov, i) => {
      const idx = inputs.length;
      inputs.push({ args: ["-i", resolve(ov.path)] });
      const dur = ov.duration ? `,trim=duration=${n3(ov.duration)}` : "";
      lines.push(`[${idx}:v:0]setpts=PTS-STARTPTS${dur},fps=${n3(F)},scale=${W}:${H},format=yuva420p,setpts=PTS-STARTPTS+${n3(ov.at)}/TB[ov${i}]`);
      lines.push(`[${v}][ov${i}]overlay=0:0:eof_action=pass:format=auto[vo${i}]`);
      v = `vo${i}`;
    });
    const tail: string[] = ["format=yuv420p"];
    if (o.fadeOut && o.fadeOut > 0) tail.push(`fade=t=out:st=${n3(Math.max(0, T - o.fadeOut))}:d=${n3(o.fadeOut)}`);
    lines.push(`[${v}]${tail.join(",")}[vout]`);
  }
  if (o.music) {
    const idx = inputs.length;
    inputs.push({ args: ["-i", resolve(o.music.path)] });
    if (o.music.fitFilter) {
      lines.push(o.music.fitFilter.replaceAll("[MUSICIN]", `[${idx}:a:0]`));
      lines.push(`[musicfit]volume=${n3(o.music.gainDb ?? 0)}dB[music]`);
    } else {
      const st = o.music.start ?? 0;
      const fo = o.music.fadeOut ?? 1.2;
      lines.push(
        `[${idx}:a:0]atrim=start=${n3(st)}:duration=${n3(T)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=${n3(o.music.gainDb ?? 0)}dB,` +
          `afade=t=out:st=${n3(Math.max(0, T - fo))}:d=${n3(fo)},apad,atrim=duration=${n3(T)}[music]`,
      );
    }
    audio.unshift("[music]");
  }
  (o.sfx ?? []).forEach((fx, i) => {
    const idx = inputs.length;
    inputs.push({ args: ["-i", resolve(fx.path)] });
    lines.push(`[${idx}:a:0]asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=${n3(fx.gainDb ?? 0)}dB,adelay=${Math.round(Math.max(0, fx.at) * 1000)}:all=1[fx${i}]`);
    audio.push(`[fx${i}]`);
  });
  let hasAudio = audio.length > 0;
  if (hasAudio) {
    const mixed = audio.length > 1 ? `${audio.join("")}amix=inputs=${audio.length}:duration=longest:normalize=0,` : `${audio[0]}`;
    const pre = audio.length > 1 ? mixed : `${mixed}anull,`;
    lines.push(`${pre}apad,atrim=duration=${n3(T)},${o.loudnorm ? `${o.loudnorm},` : ""}aresample=48000[aout]`);
  } else {
    hasAudio = false;
  }
  return { inputs, graph: lines.join(";\n"), hasAudio };
}

function atempo(v: number): string {
  const parts: string[] = [];
  let x = v;
  while (x < 0.5) {
    parts.push("atempo=0.5");
    x /= 0.5;
  }
  while (x > 2) {
    parts.push("atempo=2");
    x /= 2;
  }
  parts.push(`atempo=${n6(x)}`);
  return parts.join(",");
}

export interface SequenceRenderResult {
  output: string;
  duration: number;
  width: number;
  height: number;
  seconds: number;
  warnings: string[];
  shots: ResolvedShot[];
  loudness?: { measuredI: number; measuredTP: number };
  musicNote?: string;
  specPath: string;
}

/** Resolve, render (two-pass loudness when there is audio) and save the spec next to the output. */
export async function renderSequence(spec: SequenceSpec, output: string, opts: { quality?: "draft" | "final"; loudnorm?: boolean } = {}): Promise<SequenceRenderResult> {
  const t0 = Date.now();
  const norm = { ...spec, shots: spec.shots.map((s) => ({ ...s, path: resolveMediaPath(s.path) })) };
  const probes = new Map<string, MediaInfo>();
  for (const s of norm.shots) if (!probes.has(s.path)) probes.set(s.path, await probe(s.path));
  for (const p of [...(norm.overlays ?? []).map((x) => x.path), ...(norm.sfx ?? []).map((x) => x.path), ...(norm.music ? [norm.music.path] : [])]) {
    if (!existsSync(resolveMediaPath(p))) throw new Error(`file not found: ${p}`);
  }
  const seq = resolveSequence(norm, probes);
  let music: SequenceGraphOptions["music"];
  let musicNote: string | undefined;
  if (norm.music) {
    const mpath = resolveMediaPath(norm.music.path);
    if (norm.music.fit !== false) {
      try {
        const an = await detectBeats(mpath);
        // Never let the song stop before the picture: bar-line edits come in whole bars, so the
        // natural ending can land seconds early (silence under the end card). Try slightly longer
        // targets and keep the one whose ending lands closest to the end; a small overrun is
        // trimmed with a short fade on the last frames.
        let fit = fitMusic(an, seq.duration, { fps: seq.fps });
        let over = 0;
        if (fit.padEnd > 0.15) {
          for (let k = 1; k <= 16; k++) {
            const t = seq.duration + k * 0.25;
            const f = fitMusic(an, t, { fps: seq.fps });
            const ringOut = t - f.endsOn;
            // The final downbeat must land before the picture ends, with the ring-out under the last shot.
            if (f.padEnd <= 0.15 && f.endsOn <= seq.duration - 0.3 && ringOut > 0) {
              fit = f;
              over = t - seq.duration;
              break;
            }
          }
        }
        let filter = fitFilter(fit, "MUSICIN", "musicfit");
        if (over > 0) {
          const fade = Math.min(0.6, Math.max(0.25, over));
          filter = filter.replace(/\[musicfit\]$/, `,afade=t=out:st=${n3(seq.duration - fade)}:d=${n3(fade)},atrim=duration=${n3(seq.duration)}[musicfit]`);
        }
        music = { path: mpath, gainDb: norm.music.gainDb, fitFilter: filter };
        musicNote =
          `music fitted to ${seq.duration}s on its bar lines (${an.tempo} BPM), resolving on the downbeat at ${fit.endsOn.toFixed(2)}s` +
          (over > 0 ? ` (ring-out trimmed by ${over.toFixed(2)}s with a short fade, instead of ending early)` : "") +
          `: ${fit.notes.filter((x) => !x.includes("before the target") || over === 0).join("; ") || "used as is"}`;
        if (fit.padEnd > 0.15 && over === 0) seq.warnings.push(`the music ends ${fit.padEnd.toFixed(2)}s before the picture: choose a longer track or shorten the end card`);
      } catch (e) {
        music = { path: mpath, gainDb: norm.music.gainDb, start: norm.music.start, fadeOut: norm.music.fadeOut };
        musicNote = `music not fitted (${(e as Error).message}); trimmed with a ${norm.music.fadeOut ?? 1.2}s fade`;
      }
    } else {
      music = { path: mpath, gainDb: norm.music.gainDb, start: norm.music.start, fadeOut: norm.music.fadeOut };
    }
  }
  const sfx = (norm.sfx ?? []).map((x) => ({ ...x, path: resolveMediaPath(x.path) }));
  const overlays = (norm.overlays ?? []).map((x) => ({ ...x, path: resolveMediaPath(x.path) }));
  const base: SequenceGraphOptions = { look: norm.look, overlays, music, sfx, fadeIn: norm.fadeIn, fadeOut: norm.fadeOut };
  const out = resolve(output);
  mkdirSync(dirname(out), { recursive: true });
  let loudness: SequenceRenderResult["loudness"];
  let loud: string | undefined;
  const probeGraph = buildSequenceGraph(seq, { ...base, withVideo: false });
  if (probeGraph.hasAudio && opts.loudnorm !== false) {
    if (opts.quality !== "draft") {
      try {
        const g = probeGraph.graph.replace(/\[aout\]$/, ",loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json[aout]");
        const { stderr } = await runGraph(probeGraph.inputs, g, ["-map", "[aout]"], "-", ["-f", "null"], 10 * 60_000, "info");
        const stats: LoudnormStats | null = parseLoudnormJson(stderr);
        if (stats) {
          loudness = { measuredI: Number(stats.input_i), measuredTP: Number(stats.input_tp) };
          loud = loudnormFilter(stats);
        }
      } catch {
        loud = loudnormFilter();
      }
    } else loud = loudnormFilter();
  }
  const { inputs, graph, hasAudio } = buildSequenceGraph(seq, { ...base, loudnorm: loud });
  const hw = opts.quality === "draft" ? { videotoolbox: (await ffmpegEncoders()).has("h264_videotoolbox") } : {};
  const encode = encodeArgs(true, hasAudio, { quality: opts.quality }, hw);
  const maps = ["-map", "[vout]", ...(hasAudio ? ["-map", "[aout]"] : [])];
  await runGraph(inputs, graph, maps, out, [...encode, "-r", n3(seq.fps)], Math.max(10 * 60_000, seq.duration * 30_000));
  const specPath = join(dirname(out), `${basename(out, extname(out))}.sequence.json`);
  writeFileSync(specPath, JSON.stringify({ ...spec, renderedTo: out }, null, 2));
  return { output: out, duration: seq.duration, width: seq.width, height: seq.height, seconds: (Date.now() - t0) / 1000, warnings: seq.warnings, shots: seq.shots, loudness, musicNote, specPath };
}

/** Middle frame of every shot of a render, for the contact sheet. */
export async function sequenceFrames(render: string, shots: ResolvedShot[], dir: string): Promise<string[]> {
  const { run } = await import("./exec.js");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const s of shots) {
    const t = s.at + Math.min(s.duration * 0.55, s.duration - 0.04);
    const f = join(dir, `shot-${String(s.index + 1).padStart(2, "0")}.jpg`);
    await run("ffmpeg", ["-v", "error", "-y", "-ss", n3(Math.max(0, t)), "-i", render, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", f], { timeoutMs: 60_000 });
    files.push(f);
  }
  return files;
}

/** Edit-time speed at output fraction u, for describing ramps (used in tool text). */
export function describeSpeed(s: Pick<SequenceShotInput, "speed" | "ramp" | "reverse" | "holdEnd">): string {
  const parts: string[] = [];
  if (s.ramp) parts.push(`ramp ${s.ramp.from}x→${s.ramp.to}x ${s.ramp.curve ?? "ease-in-out"}`);
  else if (s.speed && s.speed !== 1) parts.push(`${s.speed}x`);
  if (s.reverse) parts.push("reversed");
  if (s.holdEnd) parts.push(`hold ${s.holdEnd}s`);
  void ease;
  return parts.join(", ");
}
