/**
 * Standalone render of a MultiTrackEdit (multicam switch / assembled shots): every picture
 * segment is read with an accurate input seek, scaled/padded to the output frame and concatenated
 * (in chunks, so hundreds of segments stay cheap), then muxed with the single audio track.
 * Captions (remapped to the record timeline) are written as an SRT sidecar.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CaptionCue, MultiTrackEdit } from "../hosts/types.js";
import { toSRT } from "./captions.js";
import { run } from "./exec.js";
import { paths, sidecarPath } from "./paths.js";
import { encodeArgs, ffmpegEncoders, type RenderQuality } from "./render.js";

export interface MultiRenderOptions {
  quality?: RenderQuality;
  width?: number;
  height?: number;
  fps?: number;
  captions?: CaptionCue[];
  /** Segments per intermediate chunk (default 40). */
  chunk?: number;
}

export interface MultiRenderResult {
  output: string;
  duration: number;
  segments: number;
  srt?: string;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const f3 = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3);

/** Validate and normalise: contiguous record times, positive lengths. Exported for tests. */
export function checkEdit(edit: MultiTrackEdit): string[] {
  const problems: string[] = [];
  let t = 0;
  edit.segments.forEach((s, i) => {
    if (!(s.source >= 0 && s.source < edit.sources.length)) problems.push(`segment ${i + 1}: unknown source ${s.source}`);
    if (s.srcOut - s.srcIn <= 0) problems.push(`segment ${i + 1}: empty`);
    if (Math.abs(s.recOut - s.recIn - (s.srcOut - s.srcIn)) > 0.01) problems.push(`segment ${i + 1}: record and source lengths differ`);
    if (Math.abs(s.recIn - t) > 0.01) problems.push(`segment ${i + 1}: gap/overlap at ${s.recIn}s`);
    if (s.srcIn < -0.01) problems.push(`segment ${i + 1}: starts before its source (${s.srcIn}s)`);
    t = s.recOut;
  });
  return problems;
}

export async function renderMultiEdit(edit: MultiTrackEdit, output: string, o: MultiRenderOptions = {}): Promise<MultiRenderResult> {
  const problems = checkEdit(edit);
  if (problems.length) throw new Error(`Invalid multi-source edit:\n${problems.join("\n")}`);
  const W = even(o.width ?? edit.width ?? 1920);
  const H = even(o.height ?? edit.height ?? 1080);
  const fps = o.fps ?? edit.fps ?? 25;
  const quality = o.quality ?? "final";
  const hw = quality === "draft" ? { videotoolbox: (await ffmpegEncoders()).has("h264_videotoolbox") } : {};
  const venc = encodeArgs(true, false, { quality }, hw).filter((a) => a !== "-movflags" && a !== "+faststart");
  mkdirSync(dirname(output), { recursive: true });
  const work = join(paths.tmp(), `multi-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const total = edit.segments.length ? edit.segments[edit.segments.length - 1].recOut : 0;
  try {
    const size = o.chunk ?? 40;
    const chunks: string[] = [];
    for (let c = 0; c < edit.segments.length; c += size) {
      const segs = edit.segments.slice(c, c + size);
      const args = ["-hide_banner", "-loglevel", "error", "-y"];
      segs.forEach((s) => args.push("-ss", f3(Math.max(0, s.srcIn)), "-t", f3(s.srcOut - Math.max(0, s.srcIn)), "-i", edit.sources[s.source].path));
      const graph =
        segs
          .map(
            (s, i) =>
              `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},` +
              `trim=duration=${f3(s.recOut - s.recIn)},setpts=PTS-STARTPTS,format=yuv420p[v${i}]`,
          )
          .join(";") + `;${segs.map((_, i) => `[v${i}]`).join("")}concat=n=${segs.length}:v=1:a=0[out]`;
      const script = join(work, `graph-${c}.txt`);
      writeFileSync(script, graph);
      const file = join(work, `chunk-${String(c).padStart(5, "0")}.mp4`);
      await run("ffmpeg", [...args, "-/filter_complex", script, "-map", "[out]", ...venc, "-an", file], { timeoutMs: 6 * 60 * 60_000 });
      chunks.push(file);
    }
    const list = join(work, "list.txt");
    writeFileSync(list, chunks.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
    // Audio track: the clips of the single audio track, concatenated.
    const aArgs: string[] = [];
    const aGraph: string[] = [];
    edit.audio.forEach((a, i) => {
      aArgs.push("-ss", f3(Math.max(0, a.srcIn)), "-t", f3(a.srcOut - Math.max(0, a.srcIn)), "-i", edit.sources[a.source].path);
      const lead = a.recIn - (i ? edit.audio[i - 1].recIn + (edit.audio[i - 1].srcOut - edit.audio[i - 1].srcIn) : 0) + Math.max(0, -a.srcIn);
      aGraph.push(`[${i + 1}:a]aresample=48000,asetpts=PTS-STARTPTS${lead > 0.001 ? `,adelay=${Math.round(lead * 1000)}:all=1` : ""}[a${i}]`);
    });
    const graph = `${aGraph.join(";")};${edit.audio.map((_, i) => `[a${i}]`).join("")}concat=n=${edit.audio.length}:v=0:a=1,apad,atrim=duration=${f3(total)}[aout]`;
    const ascript = join(work, "audio.txt");
    writeFileSync(ascript, graph);
    await run(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-i", list,
        ...aArgs,
        "-/filter_complex", ascript,
        "-map", "0:v", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", f3(total), "-movflags", "+faststart",
        output,
      ],
      { timeoutMs: 6 * 60 * 60_000 },
    );
    let srt: string | undefined;
    if (o.captions?.length) {
      srt = sidecarPath(output, ".srt");
      writeFileSync(srt, toSRT(o.captions));
    }
    return { output, duration: total, segments: edit.segments.length, srt };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
