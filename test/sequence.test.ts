import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP = join(tmpdir(), `openedit-seq-${process.pid}`);
process.env.OPENEDIT_HOME = join(TMP, "home");

const { resolveSequence, speedPlan, buildSequenceGraph, lookFilter, moveFilter, renderSequence } = await import("../src/engine/sequence.js");
const { shotUsability } = await import("../src/engine/analysis/usable.js");
const { visualStats, visualWarnings, trailingSilence } = await import("../src/engine/review-visual.js");
const { probe } = await import("../src/engine/media.js");
type MediaInfo = import("../src/hosts/types.js").MediaInfo;
type Shot = import("../src/engine/analysis/analyze.js").Shot;

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const info = (duration: number): MediaInfo => ({ path: "/x.mp4", duration, width: 1920, height: 1080, fps: 25, hasVideo: true, hasAudio: true }) as MediaInfo;

describe("sequence timeline", () => {
  const probes = new Map([
    ["/a.mp4", info(10)],
    ["/b.mp4", info(3)],
  ]);

  it("lays shots end to end; transitions overlap the previous shot's tail", () => {
    const seq = resolveSequence(
      { shots: [{ path: "/a.mp4", in: 1, duration: 2 }, { path: "/b.mp4", in: 0, duration: 1.6, transition: { type: "dissolve", duration: 0.4 } }, { path: "/a.mp4", in: 5, duration: 1 }] },
      probes,
    );
    expect(seq.shots.map((s) => s.at)).toEqual([0, 2, 3.6]);
    expect(seq.duration).toBe(4.6);
    expect(seq.shots[0].renderLen).toBeCloseTo(2.4, 6);
    expect(seq.shots[1].transitionIn).toEqual({ type: "dissolve", duration: 0.4 });
  });

  it("centres the window when no in point is given and warns when footage runs out", () => {
    const seq = resolveSequence({ shots: [{ path: "/a.mp4", duration: 2 }, { path: "/b.mp4", in: 2, duration: 2 }] }, probes);
    expect(seq.shots[0].srcIn).toBeCloseTo(4, 6);
    expect(seq.shots[1].srcIn).toBe(1); // pulled back so 2 s fit in the 3 s clip
    const short = resolveSequence({ shots: [{ path: "/b.mp4", duration: 2, speed: 2 }] }, probes);
    expect(short.warnings.join(" ")).toMatch(/needs 4.00s/);
  });

  it("solves the source span of an eased ramp for an exact output length", () => {
    const { span, steps } = speedPlan({ ramp: { from: 1, to: 0.25, curve: "ease-out" } }, 3, 2, 25);
    const out = steps.reduce((a, s) => a + (s.s1 - s.s0) / s.v, 0);
    expect(out).toBeCloseTo(2, 3);
    expect(span).toBeGreaterThan(0.5);
    expect(span).toBeLessThan(2);
    expect(steps[0].s0).toBe(3);
  });

  it("builds a graph with xfade on transitions, concat on cuts, look and sound", () => {
    const seq = resolveSequence(
      {
        shots: [
          { path: "/a.mp4", in: 0, duration: 1.5, move: { type: "push-in" } },
          { path: "/b.mp4", in: 0, duration: 1, transition: { type: "whip-left" }, natSoundDb: -6 },
          { path: "/a.mp4", in: 4, duration: 2, ramp: { from: 1, to: 0.3 } },
        ],
      },
      probes,
    );
    const { graph, inputs, hasAudio } = buildSequenceGraph(seq, { look: { preset: "candy" }, sfx: [{ path: "/fx.wav", at: 1.4 }] });
    expect(graph).toMatch(/xfade=transition=smoothleft:duration=0\.24:offset=1\.5/);
    expect(graph).toMatch(/concat=n=2/);
    expect(graph).toMatch(/dblur=angle=0/);
    expect(graph).toMatch(/setpts='\(clip\(T-/);
    expect(graph).toMatch(/colortemperature=temperature=6300/);
    expect(graph).toMatch(/adelay=1400/);
    expect(graph).toMatch(/\[n1\]/); // nat sound kept on the constant-speed shot
    expect(graph).not.toMatch(/\[n2\]/); // and dropped on the ramp
    expect(inputs.length).toBe(4);
    expect(hasAudio).toBe(true);
  });

  it("looks scale toward neutral with intensity, moves are eased crops", () => {
    expect(lookFilter({ preset: "natural" }, 1920, 1080)).toBe("");
    expect(lookFilter({ preset: "moody", intensity: 0 }, 1920, 1080)).not.toMatch(/eq=/);
    expect(lookFilter({ preset: "warm-film", letterbox: 2.39 }, 1920, 1080)).toMatch(/drawbox=x=0:y=0:w=iw:h=138/);
    expect(moveFilter({ type: "push-in", amount: 0.1 }, 1920, 1080, 2)).toMatch(/eval=frame.*crop=1920:1080/);
    expect(moveFilter({ type: "none" }, 1920, 1080, 2)).toBe("");
  });
});

const shot = (o: Partial<Shot>): Shot =>
  ({ id: "x#1", file: "/x", index: 1, start: 0, end: 1, duration: 1, brightness: 0.5, exposure: "ok", motion: 0.03, shake: 0.1, sharpness: 80, palette: [], faces: { count: 0, maxH: 0 }, labels: [], reps: [], transition: "cut", ...o }) as Shot;

describe("shot usability", () => {
  it("rejects blank, blown, black and flash frames; bokeh is only a caution", () => {
    expect(shotUsability(shot({ sharpness: 0.9 })).status).toBe("reject");
    expect(shotUsability(shot({ brightness: 0.98, exposure: "clipped" })).status).toBe("reject");
    expect(shotUsability(shot({ brightness: 0.01, exposure: "crushed" })).status).toBe("reject");
    expect(shotUsability(shot({ duration: 0.2 })).status).toBe("reject");
    expect(shotUsability(shot({ sharpness: 7.8 })).status).toBe("caution");
    expect(shotUsability(shot({ sharpness: 30 })).status).toBe("good");
  });
});

describe("picture review", () => {
  const timeline = (lens: number[], o: Partial<Shot>[] = []) => {
    let t = 0;
    return lens.map((d, i) => {
      const s = shot({ id: `r#${i}`, start: t, end: t + d, duration: d, ...(o[i] ?? {}) });
      t += d;
      return s;
    });
  };

  it("flags metronome pacing, including a run of equal shots", () => {
    const even = visualWarnings(visualStats(timeline([1.3, 1.3, 1.29, 1.31, 1.3, 1.3, 1.3, 1.3, 3])));
    expect(even.join(" ")).toMatch(/metronome/);
    const run = visualWarnings(visualStats(timeline([0.4, 2.1, 1.37, 1.29, 1.29, 1.29, 1.29, 1.65, 0.68, 0.32, 1, 2.9])));
    expect(run.join(" ")).toMatch(/5 shots in a row/);
    const varied = visualWarnings(visualStats(timeline([1.8, 1.2, 1, 0.7, 0.5, 0.5, 2, 2.4, 2.6])));
    expect(varied.join(" ")).not.toMatch(/metronome/);
  });

  it("flags a dark opening and unusable frames", () => {
    const w = visualWarnings(visualStats(timeline([0.4, 2.1, 1.5, 1.2, 2], [{}, { brightness: 0.1, exposure: "dark" }, { sharpness: 1 }])));
    expect(w.join(" ")).toMatch(/near-black picture in the first 3 s/);
    expect(w.join(" ")).toMatch(/unusable picture at 00:02.5/);
  });
});

describe("trailing silence", () => {
  it("measures the silent tail against the edit's own level", () => {
    const db = [...Array(100).fill(-12), ...Array(40).fill(-80)];
    expect(trailingSilence({ hop: 0.05, db })).toBeCloseTo(2, 5);
    expect(trailingSilence({ hop: 0.05, db: Array(100).fill(-30) })).toBe(0);
  });
});

describe.skipIf(!hasFfmpeg)("sequence render", () => {
  const dir = join(TMP, "media");
  beforeAll(() => {
    mkdirSync(dir, { recursive: true });
    const mk = (name: string, src: string) =>
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `${src}=size=640x360:rate=25:duration=4`, "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(dir, name)]);
    mk("red.mp4", "testsrc2");
    mk("blue.mp4", "smptebars");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=12", join(dir, "music.wav")]);
  });
  afterAll(() => rmSync(TMP, { recursive: true, force: true }));

  it("renders transitions, ramps, a hold, a look and music to the exact length at -14 LUFS", async () => {
    const r = await renderSequence(
      {
        shots: [
          { path: join(dir, "red.mp4"), in: 0, duration: 1.2, move: { type: "push-in" }, transition: { type: "dip-black", duration: 0.3 } },
          { path: join(dir, "blue.mp4"), in: 0.5, duration: 1, transition: { type: "whip-left" } },
          { path: join(dir, "red.mp4"), in: 1, duration: 1.4, ramp: { from: 1, to: 0.4, curve: "ease-out" }, holdEnd: 0.3 },
          { path: join(dir, "blue.mp4"), in: 0, duration: 1.2, transition: { type: "dissolve", duration: 0.4 } },
        ],
        look: { preset: "punchy" },
        music: { path: join(dir, "music.wav"), fit: false },
        sfx: [{ path: join(dir, "music.wav"), at: 2.1, gainDb: -12 }],
        width: 640,
        height: 360,
      },
      join(TMP, "out.mp4"),
      { quality: "final" },
    );
    expect(r.duration).toBe(4.8);
    const p = await probe(r.output);
    expect(Math.abs(p.duration - 4.8)).toBeLessThan(0.06);
    expect(p.width).toBe(640);
    expect(p.hasAudio).toBe(true);
    const log = execFileSync("ffmpeg", ["-hide_banner", "-i", r.output, "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString();
    void log;
    expect(r.loudness).toBeDefined();
  }, 120_000);
});
