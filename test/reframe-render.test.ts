import { describe, expect, it } from "vitest";
import {
  cropFromFaces,
  fillGaps,
  medianFilter,
  piecewiseAt,
  piecewiseExpression,
  simplifyTrack,
  smoothTrack,
  staticCrop,
  subjectTrack,
  type FaceSample,
} from "../src/engine/reframe.js";
import { buildRenderGraph, encodeArgs, loudnormFilter, parseLoudnormJson } from "../src/engine/render.js";
import type { CutPlan } from "../src/hosts/types.js";

/** Evaluate an ffmpeg expression made of numbers, + - * , t, max(), clip() in JS. */
function evalExpr(expr: string, t: number): number {
  const js = expr.replace(/\bt\b/g, `(${t})`).replace(/max\(/g, "Math.max(").replace(/clip\(/g, "clipf(");
  return Function("clipf", `return ${js};`)((v: number, a: number, b: number) => Math.min(b, Math.max(a, v)));
}

const face = (cx: number, w = 0.16): FaceSample["faces"][number] => ({ x: cx - w / 2, y: 0.1, w, h: 0.28, conf: 0.9 });

describe("reframe tracking maths", () => {
  it("picks the largest face and sticks with the same person when sizes are similar", () => {
    const samples: FaceSample[] = [
      { t: 0, faces: [face(0.3, 0.1), face(0.7, 0.2)] },
      { t: 0.5, faces: [face(0.3, 0.19), face(0.7, 0.2)] }, // similar sizes: stay on the right one
      { t: 1, faces: [] },
    ];
    const tr = subjectTrack(samples);
    expect(tr[0].x).toBeCloseTo(0.7);
    expect(tr[1].x).toBeCloseTo(0.7);
    expect(tr[2].x).toBeNull();
    expect(fillGaps(tr).map((p) => p.x)).toEqual([0.7, 0.7, 0.7]);
    expect(fillGaps([{ t: 0, x: null }, { t: 1, x: 0.4 }]).map((p) => p.x)).toEqual([0.4, 0.4]);
    expect(fillGaps([{ t: 0, x: null }], 0.6)[0].x).toBe(0.6);
  });

  it("median filter removes single-sample detector spikes", () => {
    expect(medianFilter([0.5, 0.5, 0.9, 0.5, 0.5], 5)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5]);
  });

  it("holds still inside the dead zone and pans no faster than maxSpeed", () => {
    // Subject wobbles ±0.02 around 0.6, then walks to 0.3 at t=10.
    const track = Array.from({ length: 41 }, (_, i) => {
      const t = i * 0.5;
      return { t, x: t < 10 ? 0.6 + (i % 2 ? 0.02 : -0.02) : 0.3 };
    });
    const s = smoothTrack(track, { deadzone: 0.05, maxSpeed: 0.2 });
    const before = s.filter((p) => p.t < 10).map((p) => p.x);
    expect(new Set(before).size).toBe(1); // perfectly still while the subject only wobbles
    for (let i = 1; i < s.length; i++) {
      expect(Math.abs(s[i].x - s[i - 1].x)).toBeLessThanOrEqual(0.2 * 0.5 + 1e-9);
    }
    expect(s[s.length - 1].x).toBeCloseTo(0.3, 1); // settles on the new position
    const keys = simplifyTrack(s);
    expect(keys.length).toBeLessThan(s.length / 2);
  });

  it("clamps the crop centre inside the frame", () => {
    const s = smoothTrack([{ t: 0, x: 0.98 }, { t: 1, x: 0.98 }], { min: 0.16, max: 0.84 });
    expect(s.every((p) => p.x === 0.84)).toBe(true);
  });

  it("emits a flat piecewise-linear ffmpeg expression that matches the keyframes", () => {
    const keys = [{ t: 0, v: 900 }, { t: 4, v: 900 }, { t: 6, v: 500 }, { t: 9, v: 650 }];
    const e = piecewiseExpression(keys);
    expect(e).not.toContain("if(");
    for (const t of [0, 2, 4, 5, 6, 7.5, 9, 20]) expect(evalExpr(e, t)).toBeCloseTo(piecewiseAt(keys, t), 6);
    expect(piecewiseExpression([{ t: 0, v: 300 }, { t: 5, v: 300.2 }])).toBe("300");
  });

  it("maps source-time faces through the cut plan and centres the 9:16 crop on the speaker", () => {
    // Speaker sits right of centre (cx 0.68) the whole time; a cut removes 5-8 s.
    const samples: FaceSample[] = Array.from({ length: 24 }, (_, i) => ({ t: i * 0.5, faces: [face(0.68)] }));
    const plan: Pick<CutPlan, "keep"> = { keep: [{ start: 0, end: 5 }, { start: 8, end: 12 }] };
    const r = cropFromFaces(samples, plan, 1920, 1080, { aspect: "9:16" });
    expect(r).toMatchObject({ width: 606, height: 1080, mode: "faces", axis: "x", y: "0" });
    const x = Number(r.x);
    expect(x).toBe(Math.round(0.68 * 1920 - 303));
    // The face box (0.6..0.76 of 1920) lies fully inside the crop.
    expect(x).toBeLessThanOrEqual(0.6 * 1920);
    expect(x + 606).toBeGreaterThanOrEqual(0.76 * 1920);
    expect(r.keys.at(-1)!.t).toBeLessThanOrEqual(9.01); // edit timeline is 9 s long
  });

  it("falls back to focusX, then centre, without faces", () => {
    const none: FaceSample[] = [{ t: 0, faces: [] }, { t: 1, faces: [] }];
    const plan = { keep: [{ start: 0, end: 2 }] };
    const r = cropFromFaces(none, plan, 1920, 1080, { aspect: "9:16", focusX: 0.25 });
    expect(r.mode).toBe("manual");
    expect(r.x).toBe(String(Math.round(0.25 * 1920 - 303)));
    expect(staticCrop(1920, 1080, "9:16")).toMatchObject({ x: "657", mode: "center" });
    expect(staticCrop(1920, 1080, "9:16", 0.99).x).toBe(String(1920 - 606)); // clamped
  });
});

describe("loudness", () => {
  const stderr = `[Parsed_loudnorm_0 @ 0x1]
{
\t"input_i" : "-20.12",
\t"input_tp" : "-9.30",
\t"input_lra" : "5.30",
\t"input_thresh" : "-30.53",
\t"output_i" : "-14.02",
\t"output_tp" : "-1.50",
\t"output_lra" : "4.00",
\t"output_thresh" : "-24.40",
\t"normalization_type" : "dynamic",
\t"target_offset" : "-0.42"
}
[out#0/null @ 0x2] video:0KiB`;
  it("parses loudnorm's JSON report", () => {
    expect(parseLoudnormJson(stderr)).toEqual({ input_i: "-20.12", input_tp: "-9.30", input_lra: "5.30", input_thresh: "-30.53", target_offset: "-0.42" });
    expect(parseLoudnormJson("no json here")).toBeNull();
  });
  it("uses a linear second pass when the gain keeps peaks under the ceiling, else gain + true-peak limiter", () => {
    const linear = loudnormFilter(parseLoudnormJson(stderr)!);
    expect(linear).toContain("measured_I=-20.12");
    expect(linear).toContain("linear=true");
    const hot = loudnormFilter({ input_i: "-14.12", input_tp: "0.69", input_lra: "5", input_thresh: "-24", target_offset: "0" }, 0.2);
    expect(hot).toMatch(/^volume=0.32dB,aresample=192000,alimiter=limit=0.75/);
    expect(loudnormFilter()).toBe("loudnorm=I=-14:TP=-1.5:LRA=11");
  });
});

describe("render graph composition order", () => {
  const info = { path: "/in.mp4", duration: 10, width: 1920, height: 1080, fps: 25, hasAudio: true, hasVideo: true };
  const plan: CutPlan = { source: "/in.mp4", duration: 10, keep: [{ start: 0, end: 4 }, { start: 5, end: 9 }], cuts: [] };
  const g = buildRenderGraph(plan, info, {
    reframe: "9:16",
    crop: { width: 606, height: 1080, x: "clip(987+12*max(0,t-2),0,1314)", y: "0" },
    zooms: [{ start: 1, end: 3, scale: 112, ease: 0 }],
    overlays: [{ path: "/lower-third.mov", at: 1, fit: "contain" }, { path: "/broll.mp4", at: 5, duration: 2 }],
    captionOverlay: "/captions.mov",
  });
  const lines = g.graph.split(";\n");
  const idx = (re: RegExp) => lines.findIndex((l) => re.test(l));
  it("crops the camera first, then zooms, overlays and captions at output size", () => {
    const crop = idx(/crop=606:1080:x='clip\(987/);
    const zoom = idx(/zoompan=.*s=606x1080/);
    const ov = idx(/\[ov0\]overlay/);
    const cap = idx(/\[capov\]overlay/);
    expect(crop).toBeGreaterThan(0);
    expect(zoom).toBeGreaterThan(crop);
    expect(ov).toBeGreaterThan(zoom);
    expect(cap).toBeGreaterThan(ov);
    expect(g.graph).toContain("[1:v:0]scale=606:1080:force_original_aspect_ratio=decrease,"); // contain-fit graphic
    expect(g.graph).toContain("[2:v:0]scale=606:1080:force_original_aspect_ratio=increase,crop=606:1080,"); // cover b-roll
    expect(g.graph).toContain("[3:v:0]scale=606:1080,format=yuva420p[capov]");
    expect(g.outSize).toEqual({ width: 606, height: 1080 });
  });
  it("centre-crops when no crop plan is given", () => {
    const c = buildRenderGraph(plan, info, { reframe: "1:1" });
    expect(c.graph).toContain("crop=1080:1080:x='(iw-1080)/2':y='(ih-1080)/2'");
  });
  it("picks encoders by quality", () => {
    expect(encodeArgs(true, true, {})).toEqual(["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]);
    expect(encodeArgs(true, false, { quality: "draft" }, { videotoolbox: true }).slice(0, 4)).toEqual(["-c:v", "h264_videotoolbox", "-q:v", "55"]);
    expect(encodeArgs(true, false, { quality: "draft" }, {}).slice(0, 4)).toEqual(["-c:v", "libx264", "-preset", "ultrafast"]);
  });
});
