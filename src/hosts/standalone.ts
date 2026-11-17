import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { type CaptionStyle, toASS, toSRT } from "../engine/captions.js";
import { mediaKind, probe, resolveMediaPath } from "../engine/media.js";
import { paths } from "../engine/paths.js";
import { editDuration, editSegments } from "../engine/remap.js";
import {
  type AudioMixSpec,
  type Reframe,
  type RenderResult,
  type VideoOverlaySpec,
  type ZoomSpec,
  canBurnAss,
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
}

export interface StandaloneRenderOptions {
  output: string;
  /** x264 preset (ultrafast … veryslow). */
  preset?: string;
  reframe?: Reframe;
  /** Burn the timeline's captions into the picture. Default true when captions exist. */
  burnCaptions?: boolean;
  loudnorm?: boolean;
}

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
    writeFileSync(this.projectFile, JSON.stringify(this.project, null, 1));
  }

  /** Snapshot of the project state (for tools and tests). */
  getProject(): StandaloneProject {
    return structuredClone(this.project);
  }

  reset(): void {
    this.project = emptyProject();
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
      this.project.placements.push({ ...c, path: p });
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
      } else {
        overlays.push({ path: c.path, at: c.at, sourceIn: c.sourceIn, sourceOut: c.sourceOut, duration: c.duration });
      }
    }

    let burnCaptions: string | undefined;
    let captionOverlay: string | undefined;
    let srt: string | undefined;
    const wantCaptions = (opts.burnCaptions ?? true) && p.captions.length > 0 && info.hasVideo;
    if (p.captions.length) {
      srt = output.replace(/\.[^.]+$/, "") + ".srt";
      writeFileSync(srt, toSRT(p.captions));
    }
    if (wantCaptions) {
      const size = reframeSize(info.width ?? 1920, info.height ?? 1080, opts.reframe);
      const stem = join(paths.renders(), `${basename(output, extname(output))}-${Date.now()}`);
      // Primary: animated caption overlay from the motion module (ProRes 4444 alpha),
      // composited with ffmpeg's overlay filter. Fallback: libass burn-in when available.
      let overlayError: string | undefined;
      try {
        const motion = await loadMotion();
        const r = await motion.renderCaptionOverlay({
          cues: p.captions,
          style: p.captionStyle,
          output: `${stem}-captions.mov`,
          width: size.width,
          height: size.height,
          fps: info.fps ?? 30,
        });
        captionOverlay = r.output;
      } catch (e) {
        overlayError = (e as Error).message.split("\n")[0];
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

    const result = await renderCutPlan(plan, output, {
      zooms: p.zooms,
      overlays,
      audio,
      reframe: opts.reframe,
      loudnorm: opts.loudnorm,
      burnCaptions,
      captionOverlay,
      preset: opts.preset,
    });
    p.lastRender = result.output;
    this.save();
    return { ...result, warnings, srt };
  }
}
