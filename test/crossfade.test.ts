import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audioJoinChain, buildRenderGraph, joinCrossfades, renderCutPlan } from "../src/engine/render.js";
import type { CutPlan } from "../src/hosts/types.js";

describe("audio crossfades at joins (graph)", () => {
  const info = { path: "/in.mp4", duration: 10, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true };
  const plan: CutPlan = { source: "/in.mp4", duration: 10, keep: [{ start: 0, end: 2 }, { start: 4, end: 7.5 }], cuts: [] };

  it("keeps video a hard cut and crossfades audio over 40 ms, extending each side by half", () => {
    const g = buildRenderGraph(plan, info, {});
    expect(g.graph).toContain("[v0][v1]concat=n=2:v=1:a=0[vcat]");
    expect(g.graph).toContain("[0:a:0]atrim=start=0:end=2.02,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.01[a0]");
    expect(g.graph).toContain("[0:a:0]atrim=start=3.98:end=7.5,asetpts=PTS-STARTPTS,afade=t=out:st=3.51:d=0.01[a1]");
    expect(g.graph).toContain("[a0][a1]acrossfade=d=0.04:c1=qsin:c2=qsin[acat]");
    expect(g.graph).not.toMatch(/afade=t=out:st=1\.99/); // no per-segment dip at the join
    expect(g.duration).toBe(5.5);
  });

  it("single keep: no crossfade, edge fades only", () => {
    const lines = audioJoinChain([{ start: 1, end: 3 }], 10, {}, "acat");
    expect(lines).toEqual(["[0:a:0]atrim=start=1:end=3,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.01,afade=t=out:st=1.99:d=0.01[acat]"]);
  });

  it("shortens the crossfade for very short keeps and at the source bounds", () => {
    const keep = [{ start: 0, end: 1 }, { start: 2, end: 2.012 }, { start: 3, end: 5 }, { start: 5.01, end: 9.99 }];
    expect(joinCrossfades(keep, 10, 0.04)).toEqual([0.012, 0.012, 0.04]);
    // The edges of the source clamp the extension.
    expect(joinCrossfades([{ start: 0.005, end: 1 }, { start: 1.5, end: 2 }], 1.01, 0.04)).toEqual([0.02]);
    // Contiguous keeps (nothing cut) and slivers below 4 ms are butt-joined.
    expect(joinCrossfades([{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 3, end: 3.003 }], 10)).toEqual([0, 0]);
    const lines = audioJoinChain([{ start: 0, end: 1 }, { start: 1, end: 2 }], 10, {}, "acat");
    expect(lines.at(-1)).toBe("[a0][a1]concat=n=2:v=0:a=1[acat]");
  });

  it("the edit length is preserved: sum of extended lengths minus crossfades = sum of keeps", () => {
    const keep = [{ start: 0.3, end: 1.27 }, { start: 1.9, end: 1.93 }, { start: 2.5, end: 4.111 }, { start: 6, end: 7.7 }];
    const xf = joinCrossfades(keep, 8, 0.04);
    const ext = keep.map((k, i) => k.end - k.start + (i > 0 ? xf[i - 1] / 2 : 0) + (i < keep.length - 1 ? xf[i] / 2 : 0));
    const total = ext.reduce((a, b) => a + b, 0) - xf.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(keep.reduce((a, k) => a + k.end - k.start, 0), 9);
  });
});

// ------------------------------------------------------------------ real ffmpeg render

const RATE = 48000;
const FPS = 30;

function pcm(file: string): Float32Array {
  const buf = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"], {
    maxBuffer: 1 << 28,
  });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
function rmsDb(x: Float32Array, a: number, b: number): number {
  const i0 = Math.max(0, Math.round(a * RATE));
  const i1 = Math.min(x.length, Math.round(b * RATE));
  let s = 0;
  for (let i = i0; i < i1; i++) s += x[i] * x[i];
  return 10 * Math.log10(s / Math.max(1, i1 - i0) + 1e-12);
}
function streamDur(file: string, sel: "a" | "v"): number {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", `${sel}:0`, "-count_packets", "-show_entries", "stream=duration", "-of", "csv=p=0", file]);
  return Number(String(out).trim().split(/\s+/)[0]);
}

describe("audio crossfades at joins (ffmpeg)", () => {
  let dir: string;
  let src: string;
  let out: string;
  // Source: white-noise "music bed" + a 440 Hz tone, with a click AND a white video flash at 6.000 s.
  const plan: CutPlan = {
    source: "",
    duration: 12,
    keep: [{ start: 0.5, end: 2.5 }, { start: 3.2, end: 4.6 }, { start: 5.1, end: 7.0 }, { start: 7.8, end: 7.815 }, { start: 8.4, end: 11.5 }],
    cuts: [],
  };
  const joinsAt = [2.0, 3.4, 5.3, 5.315];
  const clapEdited = 2.0 + 1.4 + (6.0 - 5.1); // 4.3

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "oe-xfade-"));
    src = join(dir, "src.mp4");
    out = join(dir, "out.mp4");
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", `color=c=black:s=320x180:r=${FPS}:d=12`,
      "-f", "lavfi", "-i", `anoisesrc=color=white:amplitude=0.08:seed=7:r=${RATE}:d=12`,
      "-f", "lavfi", "-i", `aevalsrc=0.1*sin(2*PI*440*t)+0.9*between(t\\,6\\,6.004):s=${RATE}:d=12`,
      "-filter_complex", "[0:v]drawbox=c=white:t=fill:enable='between(t,6,6.03)'[v];[1:a][2:a]amix=inputs=2:normalize=0[a]",
      "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-ar", String(RATE),
      src.replace(/\.mp4$/, ".mov"),
    ]);
    src = src.replace(/\.mp4$/, ".mov");
    plan.source = src;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("no level dip at joins, A/V lengths match, a clap lands at the same time in audio and video", async () => {
    const r = await renderCutPlan(plan, out, {});
    const edit = plan.keep.reduce((a, k) => a + k.end - k.start, 0);
    expect(Math.abs(r.duration - edit)).toBeLessThan(1e-6);
    const a = streamDur(out, "a");
    const v = streamDur(out, "v");
    expect(Math.abs(a - v)).toBeLessThanOrEqual(1 / FPS + 0.025); // AAC priming/frame granularity
    expect(Math.abs(v - edit)).toBeLessThanOrEqual(1 / FPS + 1e-3);

    const x = pcm(out);
    // RMS in a 10 ms window centred on each join vs the neighbourhood 60–160 ms either side.
    for (const j of joinsAt.slice(0, 3)) {
      const at = rmsDb(x, j - 0.005, j + 0.005);
      const around = (rmsDb(x, j - 0.16, j - 0.06) + rmsDb(x, j + 0.06, j + 0.16)) / 2;
      // Old per-segment 10 ms fades dipped well over 6 dB here; an equal-power crossfade stays flat (±3 dB).
      expect(Math.abs(around - at), `level change at join ${j}`).toBeLessThan(3);
    }

    // Clap: loudest sample in the audio; flash: brightest frame in the video.
    let peak = 0;
    let peakAt = 0;
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > peak) [peak, peakAt] = [Math.abs(x[i]), i / RATE];
    expect(Math.abs(peakAt - clapEdited)).toBeLessThan(0.01);
    const frames = execFileSync("ffmpeg", ["-v", "error", "-i", out, "-map", "0:v:0", "-vf", "scale=16:9,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 26 });
    let best = -1;
    let bestMean = -1;
    for (let f = 0; f * 144 < frames.length; f++) {
      let s = 0;
      for (let i = 0; i < 144; i++) s += frames[f * 144 + i];
      if (s > bestMean) [best, bestMean] = [f, s];
    }
    expect(Math.abs(best / FPS - clapEdited)).toBeLessThanOrEqual(1 / FPS + 1e-3);
  });
});
