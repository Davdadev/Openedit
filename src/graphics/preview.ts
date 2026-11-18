/**
 * Preview frames for catalog items: pack items from their preview video (ffmpeg),
 * own/user HyperFrames templates from `hyperframes snapshot` over a neutral backdrop.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadMotion } from "../motion-loader.js";
import { ffmpegBuffer, frameStrip, makeThumb } from "./images.js";
import { graphicsPaths, materialize, ownThumbPath } from "./library.js";
import type { CatalogItem } from "./types.js";

/** Neutral mid-dark backdrop: shows both light and dark graphics and judges contrast. */
export const PREVIEW_BG = "#3b3f47";

export interface PreviewResult {
  frames: { path: string; time: number }[];
  strip: Buffer;
  stripPath: string;
  source: "preview-video" | "snapshot" | "thumbnail";
}

function key(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

/** Times that show a graphic's story: entrance, settled, hold, exit. */
export function storyTimes(duration: number, n = 4): number[] {
  const d = Math.max(0.5, duration);
  if (n <= 1) return [Math.min(d * 0.5, 1.5)];
  const pts = [Math.min(0.3, d * 0.08), Math.min(1.1, d * 0.3), d * 0.55, Math.max(0, d - 0.22)];
  if (n === 4) return pts.map((t) => Math.round(t * 100) / 100);
  return Array.from({ length: n }, (_, i) => Math.round(((d * (i + 0.5)) / n) * 100) / 100);
}

function probeDuration(file: string): number {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8", timeout: 15_000 });
  return Number(r.stdout.trim()) || 4;
}

export async function previewTemplate(
  it: CatalogItem,
  opts: { params?: Record<string, unknown>; times?: number[]; count?: number; width?: number; height?: number } = {},
): Promise<PreviewResult> {
  const count = Math.max(1, Math.min(8, opts.count ?? 4));
  const outDir = join(graphicsPaths.cache(), "previews", key(`${it.id}|${JSON.stringify(opts.params ?? {})}|${(opts.times ?? []).join(",")}|${count}|${Date.now()}`));
  mkdirSync(outDir, { recursive: true });
  let frames: { path: string; time: number }[] = [];
  let source: PreviewResult["source"];

  if (it.kind === "hyperframes" || it.kind === "user") {
    const motion = await loadMotion();
    if (!motion.snapshotTemplate) throw new Error("This build of the motion module cannot snapshot templates.");
    const duration = it.duration ?? 4;
    const times = opts.times ?? storyTimes(duration, count);
    const files = await motion.snapshotTemplate({
      template: it.id,
      dir: it.kind === "user" ? it.dir : undefined,
      params: opts.params,
      times,
      outDir,
      width: opts.width ?? (it.kind === "hyperframes" ? 1280 : undefined),
      height: opts.height ?? (it.kind === "hyperframes" ? 720 : undefined),
      background: PREVIEW_BG,
    });
    frames = files.map((p, i) => ({ path: p, time: times[i] ?? 0 }));
    source = "snapshot";
    // Cache a catalog thumbnail from the "settled" frame.
    const settled = frames[Math.min(2, frames.length - 1)]!.path;
    if (!opts.params || !Object.keys(opts.params).length) {
      try {
        const thumb = it.kind === "user" && it.dir ? join(it.dir, "thumb.jpg") : ownThumbPath(it.id, it.dir ?? "");
        await makeThumb(settled, thumb, { width: 320 });
      } catch {
        /* thumbnail optional */
      }
    }
  } else if (it.preview) {
    const file = materialize(it.preview);
    const dur = probeDuration(file);
    const times = opts.times ?? Array.from({ length: count }, (_, i) => Math.round(((dur * (i + 0.5)) / count) * 100) / 100);
    frames = [];
    for (const [i, t] of times.entries()) {
      const out = join(outDir, `frame-${String(i).padStart(2, "0")}.jpg`);
      const buf = await ffmpegBuffer(["-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-q:v", "4", "-f", "mjpeg", "-"], undefined, 20_000);
      if (buf.length) {
        writeFileSync(out, buf);
        frames.push({ path: out, time: t });
      }
    }
    source = "preview-video";
  } else if (it.thumb || it.image) {
    const p = it.thumb ?? materialize(it.image!);
    frames = [{ path: p, time: 0 }];
    source = "thumbnail";
  } else throw new Error(`${it.id} has no preview video or thumbnail.`);

  const strip = await frameStrip(frames.map((f) => ({ path: f.path, label: `${f.time.toFixed(2)}s` })), { cols: Math.min(4, frames.length) });
  const stripPath = join(outDir, "strip.jpg");
  writeFileSync(stripPath, strip);
  pruneCache(join(graphicsPaths.cache(), "previews"), 40);
  return { frames, strip, stripPath, source };
}

/** Keep only the newest `keep` preview folders. */
function pruneCache(dir: string, keep: number): void {
  try {
    const ds = readdirSync(dir)
      .map((d) => ({ d, t: statSync(join(dir, d)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of ds.slice(keep)) rmSync(join(dir, x.d), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export function hasFile(p?: string): boolean {
  return !!p && existsSync(p);
}
