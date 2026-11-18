// Shared contract for OpenEdit. Every module builds against these types.
// Times are always SECONDS (float) on the source media / sequence timeline.

export interface TimeRange {
  start: number;
  end: number;
}

export interface Word {
  text: string;
  start: number;
  end: number;
  confidence?: number;
}

export interface Segment {
  text: string;
  start: number;
  end: number;
  words: Word[];
}

export interface Transcript {
  language: string;
  duration: number;
  segments: Segment[];
}

export interface MediaInfo {
  path: string;
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
  /** ffprobe codec_name of the main video stream, e.g. "h264", "vp9", "av1". */
  videoCodec?: string;
  /**
   * Display rotation in degrees (phone video). width/height are already the DISPLAYED size
   * (swapped for ±90°), matching the frames ffmpeg decodes with its default autorotate.
   */
  rotation?: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

/** Why a range is being removed. */
export type CutReason = "silence" | "filler" | "retake" | "manual";

export interface Cut extends TimeRange {
  reason: CutReason;
  label?: string;
}

/**
 * A cut plan is the core edit decision: the source ranges to KEEP, in order.
 * `cuts` is informational (what was removed and why).
 */
export interface CutPlan {
  source: string;
  duration: number;
  keep: TimeRange[];
  cuts: Cut[];
  /** Optional split edits (J / L cuts) at joins between kept ranges. Hosts that ignore it get straight cuts. */
  splits?: SplitEdit[];
  /** Optional speed ramps / reverse on SOURCE ranges inside kept ranges. */
  ramps?: SpeedRamp[];
  /** Optional freeze frames (source time, held for `duration` edited seconds). */
  freezes?: FreezeFrame[];
}

/**
 * A split edit at the join between keep[index] and keep[index + 1].
 *  - "J": the incoming clip's audio starts `seconds` BEFORE its picture.
 *  - "L": the outgoing clip's audio continues `seconds` AFTER the picture cut.
 * `roll` says which edit point moves: "audio" (default; the picture cut stays where it is and the
 * audio uses source handles beyond the kept range) or "video" (the audio cut stays, the picture
 * cut moves). Both keep audio and picture in sync; total duration is unchanged.
 */
export interface SplitEdit {
  index: number;
  type: "J" | "L";
  seconds: number;
  roll?: "audio" | "video";
}

/** Speed change over a SOURCE range (inside one kept range). */
export interface SpeedRamp extends TimeRange {
  /** Constant speed (0.25 = 4x slow motion, 2 = double speed). */
  speed?: number;
  /** Variable speed: speed at the start / end of the range, eased by `curve`. */
  from?: number;
  to?: number;
  curve?: "linear" | "ease-in" | "ease-out" | "ease-in-out";
  /** Play the range backwards (constant speed only). */
  reverse?: boolean;
  /** Slow-motion frames: "frames" (duplicate, default), "blend" (frame blending), "optical" (motion-interpolated). */
  quality?: "frames" | "blend" | "optical";
  /** Source audio over the ramp: "mute" (default; lay music / SFX over it) or "pitch" (time-stretched, pitch kept). */
  audio?: "mute" | "pitch";
}

export interface FreezeFrame {
  /** Source time of the frame to hold. */
  at: number;
  /** Edited seconds to hold it. */
  duration: number;
}

/** One picture segment of a multi-source edit (multicam switch, assembled shots). */
export interface MultiSegment {
  /** Index into MultiTrackEdit.sources. */
  source: number;
  /** Source in/out (seconds in that file). */
  srcIn: number;
  srcOut: number;
  /** Record in/out on the edit timeline (seconds). */
  recIn: number;
  recOut: number;
  /** Why this shot (for review). */
  note?: string;
}

/** A clip on the single audio track of a multi-source edit. */
export interface MultiAudioClip {
  source: number;
  srcIn: number;
  srcOut: number;
  recIn: number;
}

/** Multi-source edit: one video track switching between sources over one continuous audio track. */
export interface MultiTrackEdit {
  name?: string;
  sources: { path: string; name?: string; role?: string }[];
  segments: MultiSegment[];
  audio: MultiAudioClip[];
  width?: number;
  height?: number;
  fps?: number;
}

export interface Marker {
  time: number;
  duration?: number;
  name: string;
  comment?: string;
  color?: "red" | "green" | "blue" | "yellow" | "purple" | "orange" | "white";
}

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
  words?: Word[];
}

export interface ClipPlacement {
  path: string;
  /** Sequence time to place at. */
  at: number;
  /** Optional in/out in the source clip. */
  sourceIn?: number;
  sourceOut?: number;
  /** 1-based track number; video for video files, audio for audio files. */
  track?: number;
  /** For audio: gain in dB. */
  gainDb?: number;
}

export interface Zoom extends TimeRange {
  /** Scale percent, e.g. 115 = 15% punch-in. */
  scale: number;
}

export interface TimelineClip {
  name: string;
  path?: string;
  track: number;
  kind: "video" | "audio";
  start: number;
  end: number;
  sourceIn: number;
  sourceOut: number;
}

export interface TimelineInfo {
  name: string;
  duration: number;
  fps: number;
  width?: number;
  height?: number;
  videoTracks: number;
  audioTracks: number;
  clips: TimelineClip[];
  markers: Marker[];
}

export type HostName = "standalone" | "premiere" | "resolve";

export interface HostStatus {
  host: HostName;
  connected: boolean;
  version?: string;
  project?: string;
  sequence?: string;
  detail?: string;
}

/**
 * Every editor adapter implements this. Methods not supported by a host
 * must throw an Error whose message starts with "unsupported:".
 */
export interface EditorHost {
  readonly name: HostName;
  status(): Promise<HostStatus>;
  getTimeline(): Promise<TimelineInfo>;
  /** Source media of the active sequence (first video clip), exported or located for analysis. */
  getSourceMedia(): Promise<string[]>;
  /** Build a NEW sequence/timeline from a cut plan (never destroys the original). */
  applyCutPlan(plan: CutPlan, opts?: { sequenceName?: string }): Promise<{ sequence: string; output?: string }>;
  addMarkers(markers: Marker[]): Promise<number>;
  importMedia(paths: string[]): Promise<number>;
  placeClips(clips: ClipPlacement[]): Promise<number>;
  addCaptions(cues: CaptionCue[], opts?: { srtPath?: string }): Promise<{ added: number; file?: string }>;
  addZooms(zooms: Zoom[]): Promise<number>;
  render(opts: { output: string; preset?: string }): Promise<{ output: string }>;
}

// ---- Bridge wire protocol (Premiere CEP panel over HTTP, Resolve Python over stdio) ----
// Request:  { "id": string, "cmd": BridgeCommand, "args": object }
// Response: { "id": string, "ok": true, "result": any } | { "id": string, "ok": false, "error": string }
export type BridgeCommand =
  | "ping"
  | "status"
  | "getTimeline"
  | "getSourceMedia"
  | "applyCutPlan"
  | "addMarkers"
  | "importMedia"
  | "placeClips"
  | "addCaptions"
  | "addZooms"
  | "render"
  | "importTimeline"
  // graphics: Premiere MOGRT placement, Resolve editable Fusion Text+ title
  | "applyMogrt"
  | "addFusionTitle";

export interface BridgeRequest {
  id: string;
  cmd: BridgeCommand;
  args: Record<string, unknown>;
}

export type BridgeResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

export const PREMIERE_BRIDGE_PORT = 47821;
