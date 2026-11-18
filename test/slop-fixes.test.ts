import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { synthSong } from "./rhythm-fixtures.js";

process.env.OPENEDIT_HOME ??= join(tmpdir(), `openedit-slop-${process.pid}`);

const { analyzeSamples } = await import("../src/engine/beats.js");
const { fitMusic, planMontage } = await import("../src/engine/music.js");
const { isChromaKey } = await import("../src/engine/analysis/broll.js");

describe("montage does not pad with repeated footage", () => {
  const s = synthSong({ bpm: 120, bars: 24, tail: 2, parts: [{ bars: 24, level: 0.8 }] });
  const fit = fitMusic(analyzeSamples(s.samples, s.sr, { path: "/song.wav" }), 30, { fps: 25 });

  it("uses every clip once when there are enough clips", () => {
    const clips = Array.from({ length: 20 }, (_, i) => ({ path: `/clip${i}.mp4`, duration: 12 }));
    const m = planMontage(clips, fit, "downbeats", { fps: 25 });
    const paths = m.shots.map((x) => x.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("holds shots longer instead of repeating when a little short of clips", () => {
    const enough = planMontage(
      Array.from({ length: 20 }, (_, i) => ({ path: `/c${i}.mp4`, duration: 12 })),
      fit,
      "on-beat",
      { fps: 25 },
    );
    const few = Math.ceil(enough.shots.length / 2);
    const m = planMontage(
      Array.from({ length: few }, (_, i) => ({ path: `/c${i}.mp4`, duration: 12 })),
      fit,
      "on-beat",
      { fps: 25 },
    );
    if (30 / few <= 4) {
      const paths = m.shots.map((x) => x.path);
      expect(new Set(paths).size).toBe(paths.length);
      expect(m.notes.join(" ")).toMatch(/held shots for longer/);
    } else {
      expect(m.notes.join(" ")).toMatch(/repeat/);
    }
  });
});

describe("chroma-key plates are not b-roll", () => {
  const p = (rgb: [number, number, number], weight: number) => ({ hex: "#000000", rgb, weight });

  it("flags a frame dominated by key green or key blue", () => {
    expect(isChromaKey([p([40, 200, 60], 0.6), p([30, 30, 30], 0.4)])).toBe(true);
    expect(isChromaKey([p([20, 80, 210], 0.5), p([200, 200, 200], 0.5)])).toBe(true);
  });

  it("leaves natural greens and skies alone", () => {
    expect(isChromaKey([p([70, 110, 60], 0.7), p([120, 100, 80], 0.3)])).toBe(false); // foliage
    expect(isChromaKey([p([130, 170, 220], 0.6), p([240, 240, 240], 0.4)])).toBe(false); // sky
    expect(isChromaKey([p([40, 200, 60], 0.1), p([90, 90, 90], 0.9)])).toBe(false); // small green object
  });
});
