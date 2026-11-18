import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { type CaptionStyle, toASS, toSRT } from "../engine/captions.js";
import { mediaKind, probe, resolveMediaPath } from "../engine/media.js";
import { paths, sidecarPath } from "../engine/paths.js";
import { editDuration, editSegments } from "../engine/remap.js";
import { planReframe, type ReframeMode } from "../engine/reframe.js";
import {
  type AudioMixSpec,
  type Reframe,
  type RenderQuality,
  type RenderResult,
  type VideoOverlaySpec,
  type ZoomSpec,
  canBurnAss,
  hasAlpha,
  reframeSize,
  renderCutPlan,
} from "../engine/render.js";
import { loadMotion } from "../motion-loader.js";
import type {
  CaptionCue,
  ClipPlacement,
  CutPlan,
  EditorHost,
  HostStatus,
  MediaInfo,
  Marker,
  TimelineClip,
  TimelineInfo,
  Zoom,
} from "./types.js";

/** Standalone-only extras a placement may carry (ignored by Premiere/Resolve). */
export interface StandalonePlacement extends ClipPlacement {
  /** Still images: how long to show (s). Default 3. */
  duration?: number;
  /** Audio: duck under dialogue by ~N dB (music beds). */
  duckDb?: number;
  /** Audio: loop until the end of the edit. */
  loop?: boolean;
  /** Audio: fade out over the last N seconds. */
  fadeOut?: number;
  /**
   * Set when the clip is a motion-graphics render: lets the renderer re-render the template at
   * the output size (e.g. 9:16) instead of cropping a 16:9 graphic.
   */
  motion?: MotionSource;
}

/** How a motion-graphics overlay was made (enough to render it again at another size). */
export interface MotionSource {
  template: string;
  params: Record<string, unknown>;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
}

export interface StandaloneProject {
  version: 1;
  name: string;
  source?: string;
  info?: MediaInfo;
  plan?: CutPlan;
  markers: Marker[];
  captions: CaptionCue[];
  captionStyle: CaptionStyle;
  zooms: ZoomSpec[];
  placements: StandalonePlacement[];
  media: string[];
  lastRender?: string;
  /** Output aspect of the last render (or set by render): render_motion defaults to it. */
  outputAspect?: Reframe;
  /** Motion-graphics files rendered this project, by path, so placements can be re-rendered at the output size. */
  motionRenders?: Record<string, MotionSource>;
}

export interface StandaloneRenderOptions {
  output: string;
  /** x264 preset (ultrafast … veryslow). */
  preset?: string;
  reframe?: Reframe;
  /** Reframe placement: auto (follow faces), center, or manual (focusX/focusY). Default auto. */
  reframeMode?: ReframeMode;
  focusX?: number;
  focusY?: number;
  /** Burn the timeline's captions into the picture. Default true when captions exist. */
  burnCaptions?: boolean;
  loudnorm?: boolean;
  /** draft = fast preview (hardware encode, lighter caption render); final (default) = full quality. */
  quality?: RenderQuality;
}

/** Temporary sibling of a cache file, keeping its extension (the renderer picks the format from it). */
const partName = (file: string) => file.replace(/(\.[^./\\]*)?$/, (ext) => `.${process.pid}-${randomBytes(4).toString("hex")}.part${ext}`);

const hash = (v: unknown) => createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 16);

function emptyProject(): StandaloneProject {
  return { version: 1, name: "OpenEdit", markers: [], captions: [], captionStyle: "bold-pop", zooms: [], placements: [], media: [] };
}

/**
 * Editor-free host: keeps a small project file describing the "timeline"
 * (source, cut plan, captions, zooms, markers, placed clips) and renders it
 * with ffmpeg in a single pass.
 */
export class StandaloneHost implements EditorHost {
  readonly name = "standalone" as const;
  private project: StandaloneProject;

  constructor(private readonly projectFile = join(paths.projects(), "standalone.json")) {
    this.project = this.load();
  }

  private load(): StandaloneProject {
    try {
      if (existsSync(this.projectFile)) return { ...emptyProject(), ...JSON.parse(readFileSync(this.projectFile, "utf8")) };
    } catch {
      /* corrupt project file: start fresh */
    }
    return emptyProject();
  }

  private save(): void {
    mkdirSync(dirname(this.projectFile), { recursive: true });
    // Atomic replace: a crash or full disk mid-write must not truncate the timeline (load() would
    // then silently start an empty project).
    const tmp = `${this.projectFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.project, null, 1));
    renameSync(tmp, this.projectFile);
  }

  /** Snapshot of the project state (for tools and tests). */
  getProject(): StandaloneProject {
    return structuredClone(this.project);
  }

  reset(): void {
    this.project = emptyProject();
    this.save();
  }

  /** Output frame size for an aspect (or the source size): what overlays should be rendered at. */
  outputSize(aspect?: Reframe | null): { width: number; height: number } | undefined {
    const info = this.project.info;
    if (!info?.hasVideo) return undefined;
    const a = aspect === null ? undefined : (aspect ?? this.project.outputAspect);
    return reframeSize(info.width ?? 1920, info.height ?? 1080, a);
  }

  /** Remember how a motion-graphics file was made (render_motion), so render can redo it at another size. */
  registerMotionRender(path: string, source: MotionSource): void {
    const renders = (this.project.motionRenders ??= {});
    renders[resolve(path)] = source;
    // Keep the registry small.
    const keys = Object.keys(renders);
    for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete renders[k];
    this.save();
  }

  setOutputAspect(aspect: Reframe | undefined): void {
    this.project.outputAspect = aspect;
    this.save();
  }

  setCaptionStyle(style: CaptionStyle): void {
    this.project.captionStyle = style;
    this.save();
  }

  private requirePlan(): CutPlan {
    if (!this.project.plan) {
      throw new Error("The standalone timeline is empty. Run apply_cuts (or import_media with a video) first.");
    }
    return this.project.plan;
  }

  private async setSource(path: string, plan?: CutPlan): Promise<void> {
    const info = await probe(path);
    this.project.source = info.path;
    this.project.info = info;
    this.project.plan = plan ?? { source: info.path, duration: info.duration, keep: [{ start: 0, end: info.duration }], cuts: [] };
  }

  async status(): Promise<HostStatus> {
    const p = this.project;
    return {
      host: "standalone",
      connected: true,
      version: "ffmpeg",
      project: this.projectFile,
      sequence: p.plan ? p.name : undefined,
      detail: p.plan
        ? `${basename(p.source ?? "")}: ${p.plan.keep.length} segments, ${editDuration(p.plan).toFixed(1)}s, ` +
          `${p.captions.length} captions, ${p.zooms.length} zooms, ${p.placements.length} placed clips` +
          (p.lastRender ? `, last render ${p.lastRender}` : "")
        : "No timeline yet (apply a cut plan or import a video).",
    };
  }

  async getTimeline(): Promise<TimelineInfo> {
    const p = this.project;
    if (!p.plan) {
      return { name: p.name, duration: 0, fps: 30, videoTracks: 1, audioTracks: 1, clips: [], markers: p.markers };
    }
    const name = basename(p.plan.source);
    const clips: TimelineClip[] = [];
    for (const seg of editSegments(p.plan)) {
      for (const kind of ["video", "audio"] as const) {
        if (kind === "video" && p.info && !p.info.hasVideo) continue;
        if (kind === "audio" && p.info && !p.info.hasAudio) continue;
        clips.push({
          name,
          path: p.plan.source,
          track: 1,
          kind,
          start: seg.start,
          end: seg.end,
          sourceIn: seg.sourceStart,
          sourceOut: seg.sourceEnd,
        });
      }
    }
    const total = editDuration(p.plan);
    let vTracks = 1;
    let aTracks = 1;
    for (const c of p.placements) {
      const kind = mediaKind(c.path) === "audio" ? "audio" : "video";
      const track = c.track ?? 2;
      const len =
        c.sourceOut !== undefined ? c.sourceOut - (c.sourceIn ?? 0) : (c.duration ?? (kind === "audio" ? total - c.at : 3));
      clips.push({
        name: basename(c.path),
        path: c.path,
        track,
        kind,
        start: c.at,
        end: Math.min(total, c.at + len),
        sourceIn: c.sourceIn ?? 0,
        sourceOut: (c.sourceIn ?? 0) + len,
      });
      if (kind === "audio") aTracks = Math.max(aTracks, track);
      else vTracks = Math.max(vTracks, track);
    }
    return {
      name: p.name,
      duration: total,
      fps: p.info?.fps ?? 30,
      width: p.info?.width,
      height: p.info?.height,
      videoTracks: vTracks,
      audioTracks: aTracks,
      clips,
      markers: p.markers,
    };
  }

  async getSourceMedia(): Promise<string[]> {
    const p = this.project;
    const list = [...(p.source ? [p.source] : []), ...p.media.filter((m) => mediaKind(m) === "video")];
    return [...new Set(list)];
  }

  async applyCutPlan(plan: CutPlan, opts: { sequenceName?: string } = {}): Promise<{ sequence: string; output?: string }> {
    const source = resolveMediaPath(plan.source);
    await this.setSource(source, { ...plan, source });
    // Captions, zooms, markers and placements were timed against the previous edit.
    this.project.captions = [];
    this.project.zooms = [];
    this.project.markers = [];
    this.project.placements = [];
    this.project.name = opts.sequenceName ?? `${basename(source, extname(source))} - OpenEdit`;
    this.save();
    return { sequence: this.project.name };
  }

  async addMarkers(markers: Marker[]): Promise<number> {
    this.project.markers.push(...markers);
    this.project.markers.sort((a, b) => a.time - b.time);
    this.save();
    return markers.length;
  }

  async importMedia(list: string[]): Promise<number> {
    let n = 0;
    for (const raw of list) {
      const p = resolveMediaPath(raw);
      if (!this.project.media.includes(p)) this.project.media.push(p);
      n++;
      if (!this.project.plan && mediaKind(p) === "video") {
        await this.setSource(p);
        this.project.name = `${basename(p, extname(p))} - OpenEdit`;
      }
    }
    this.save();
    return n;
  }

  async placeClips(clips: ClipPlacement[]): Promise<number> {
    this.requirePlan();
    for (const c of clips as StandalonePlacement[]) {
      const p = resolveMediaPath(c.path);
      const motion = c.motion ?? this.project.motionRenders?.[p];
      this.project.placements.push({ ...c, path: p, ...(motion ? { motion } : {}) });
      if (!this.project.media.includes(p)) this.project.media.push(p);
    }
    this.save();
    return clips.length;
  }

  async addCaptions(cues: CaptionCue[], opts: { srtPath?: string } = {}): Promise<{ added: number; file?: string }> {
    this.requirePlan();
    this.project.captions = [...cues].sort((a, b) => a.start - b.start);
    this.save();
    return { added: cues.length, file: opts.srtPath };
  }

  async addZooms(zooms: Zoom[]): Promise<number> {
    this.requirePlan();
    this.project.zooms.push(...zooms);
    this.project.zooms.sort((a, b) => a.start - b.start);
    this.save();
    return zooms.length;
  }

  async render(opts: { output: string; preset?: string }): Promise<{ output: string }> {
    const r = await this.renderTimeline(opts);
    return { output: r.output };
  }

  /** Full-featured render: reframe, caption burn-in, loudness normalisation. */
  async renderTimeline(opts: StandaloneRenderOptions): Promise<RenderResult & { warnings: string[]; srt?: string }> {
    const plan = this.requirePlan();
    const p = this.project;
    const info = p.info ?? (await probe(plan.source));
    const output = resolve(opts.output.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
    mkdirSync(dirname(output), { recursive: true });
    const warnings: string[] = [];

    const fps = info.fps ?? 30;
    const outSize = reframeSize(info.width ?? 1920, info.height ?? 1080, opts.reframe);
    const draft = opts.quality === "draft";

    // Plan the subject-aware crop (face detection) while the graphics render.
    const cropPromise =
      opts.reframe && info.hasVideo
        ? planReframe(plan, info, { aspect: opts.reframe, mode: opts.reframeMode, focusX: opts.focusX, focusY: opts.focusY })
        : Promise.resolve(undefined);
    cropPromise.catch(() => undefined);

    const overlays: VideoOverlaySpec[] = [];
    const audio: AudioMixSpec[] = [];
    for (const c of [...p.placements].sort((a, b) => (a.track ?? 2) - (b.track ?? 2))) {
      if (mediaKind(c.path) === "audio") {
        audio.push({
          path: c.path,
          at: c.at,
          sourceIn: c.sourceIn,
          sourceOut: c.sourceOut,
          gainDb: c.gainDb,
          duckDb: c.duckDb,
          loop: c.loop,
          fadeOut: c.fadeOut,
        });
        continue;
      }
      const spec: VideoOverlaySpec = { path: c.path, at: c.at, sourceIn: c.sourceIn, sourceOut: c.sourceOut, duration: c.duration };
      if (info.hasVideo) {
        const fitted = await this.fitOverlay(c, outSize, fps, warnings);
        spec.path = fitted.path;
        spec.fit = fitted.fit;
      }
      overlays.push(spec);
    }

    let burnCaptions: string | undefined;
    let captionOverlay: string | undefined;
    let srt: string | undefined;
    const wantCaptions = (opts.burnCaptions ?? true) && p.captions.length > 0 && info.hasVideo;
    if (p.captions.length) {
      srt = sidecarPath(output, ".srt");
      writeFileSync(srt, toSRT(p.captions));
    }
    if (wantCaptions) {
      const size = outSize;
      const stem = join(paths.renders(), `${basename(output, extname(output))}-${Date.now()}`);
      // Primary: animated caption overlay from the motion module (ProRes 4444 alpha),
      // composited with ffmpeg's overlay filter, cached by content so re-renders are free.
      // Draft renders the overlay at a lower frame rate. Fallback: libass burn-in when available.
      const capFps = draft ? Math.min(15, Math.round(fps)) : fps;
      const cached = join(paths.renders(), `captions-${hash({ c: p.captions, s: p.captionStyle, ...size, capFps })}.mov`);
      let overlayError: string | undefined;
      if (existsSync(cached)) captionOverlay = cached;
      else {
        try {
          const motion = await loadMotion();
          // Render beside the cache entry and rename on success: a killed/failed render must not
          // leave a partial file that every later render would pick up as cached.
          const part = partName(cached);
          try {
            const r = await motion.renderCaptionOverlay({
              cues: p.captions,
              style: p.captionStyle,
              output: part,
              width: size.width,
              height: size.height,
              fps: capFps,
            });
            renameSync(r.output, cached);
            captionOverlay = cached;
          } finally {
            rmSync(part, { force: true });
          }
        } catch (e) {
          overlayError = (e as Error).message.split("\n")[0];
        }
      }
      if (!captionOverlay) {
        if (await canBurnAss()) {
          burnCaptions = `${stem}.ass`;
          writeFileSync(burnCaptions, toASS(p.captions, { style: p.captionStyle, ...size }));
          warnings.push(`Caption overlay renderer failed (${overlayError}); burned captions with libass instead.`);
        } else {
          warnings.push(
            `Captions were not burned in: the caption overlay renderer failed (${overlayError}) and this ffmpeg ` +
              `has no libass ("ass"/"subtitles" filters). A sidecar SRT was written to ${srt}.`,
          );
        }
      }
    }

    const crop = await cropPromise.catch(() => undefined);
    const result = await renderCutPlan(plan, output, {
      zooms: p.zooms,
      overlays,
      audio,
      reframe: opts.reframe,
      reframeMode: opts.reframeMode,
      focusX: opts.focusX,
      focusY: opts.focusY,
      crop,
      loudnorm: opts.loudnorm,
      burnCaptions,
      captionOverlay,
      preset: opts.preset,
      quality: opts.quality,
    });
    if (crop) {
      result.reframe = { mode: crop.mode, coverage: crop.coverage, note: crop.note, keys: crop.keys.length };
      if (crop.note) warnings.push(`reframe: ${crop.note}`);
    }
    p.outputAspect = opts.reframe;
    p.lastRender = result.output;
    this.save();
    return { ...result, warnings, srt };
  }

  /**
   * Make an overlay suit the output frame. Motion graphics are re-rendered at the output size
   * (cached), so a left/right lower third stays inside a 9:16 frame. Other transparent graphics
   * made for another aspect are fitted inside the frame ("contain"); opaque b-roll fills it ("cover").
   */
  private async fitOverlay(
    c: StandalonePlacement,
    out: { width: number; height: number },
    fps: number,
    warnings: string[],
  ): Promise<{ path: string; fit: VideoOverlaySpec["fit"] }> {
    if (mediaKind(c.path) === "image") return { path: c.path, fit: (await hasAlpha(c.path)) ? "contain" : "cover" };
    let size: { width?: number; height?: number } = {};
    try {
      size = await probe(c.path);
    } catch {
      /* unreadable: let ffmpeg report it */
    }
    const sameSize = size.width === out.width && size.height === out.height;
    if (sameSize) return { path: c.path, fit: "cover" };
    if (c.motion) {
      const m = c.motion;
      const target = join(
        paths.renders(),
        `${m.template}-${hash({ t: m.template, p: m.params, d: m.duration, f: m.fps ?? fps })}-${out.width}x${out.height}.mov`,
      );
      if (existsSync(target)) return { path: target, fit: "cover" };
      try {
        const motion = await loadMotion();
        const part = partName(target);
        try {
          const r = await motion.renderTemplate({
            template: m.template,
            params: m.params,
            output: part,
            width: out.width,
            height: out.height,
            fps: m.fps ?? fps,
            duration: m.duration,
          });
          renameSync(r.output, target);
        } finally {
          rmSync(part, { force: true });
        }
        return { path: target, fit: "cover" };
      } catch (e) {
        warnings.push(`Could not re-render ${m.template} at ${out.width}x${out.height} (${(e as Error).message.split("\n")[0]}); fitted the original.`);
      }
    }
    const sameAspect = size.width && size.height && Math.abs(size.width / size.height - out.width / out.height) < 0.01;
    if (sameAspect) return { path: c.path, fit: "cover" };
    return { path: c.path, fit: (await hasAlpha(c.path)) ? "contain" : "cover" };
  }
}
