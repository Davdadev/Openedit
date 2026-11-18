// Synthetic footage for the shot / multicam tests: a concatenation with known cuts, a dissolve,
// a fade through black and a flash frame; and multicam "angles" with known audio offsets.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TESTCLIPS = process.env.OPENEDIT_TESTCLIPS || "/Volumes/DavidsData/openedit/testclips";
export const ABC = join(TESTCLIPS, "abc-explains.webm");
export const DIEGO = join(TESTCLIPS, "diego", "diego.webm");

export function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Work dir for test outputs (OPENEDIT_TEST_WORK keeps them off the system disk). */
export function workDir(name: string): string {
  const root = process.env.OPENEDIT_TEST_WORK || tmpdir();
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, `${name}-`));
}

const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });

const FPS = 25;
const SIZE = "640x360";

interface Seg {
  /** lavfi source or a real clip with in point. */
  lavfi?: string;
  clip?: string;
  ss?: number;
  frames: number;
  /** Extra filter (e.g. a pan crop). */
  vf?: string;
}

/**
 * Build the synthetic cut test: returns the file and the ground-truth boundary frames
 * (first frame of each new shot) with their kinds.
 */
export function buildCutFixture(dir: string): { file: string; truth: { frame: number; kind: string }[]; frames: number } {
  const useReal = existsSync(ABC) && existsSync(DIEGO);
  const segs: Seg[] = [
    { lavfi: `testsrc2=s=${SIZE}:r=${FPS}`, frames: 75 },
    { lavfi: `mandelbrot=s=${SIZE}:r=${FPS}`, frames: 60 },
    // A fast pan over a still (no cut inside): crop moving across a 2x image.
    { lavfi: `testsrc=s=1280x360:r=${FPS}`, frames: 70, vf: `crop=640:360:'min(640,t*300)':0` },
    { lavfi: `life=s=${SIZE}:r=${FPS}:mold=10:ratio=0.1:death_color=#202040:life_color=#e0c060`, frames: 50 },
    { lavfi: `smptehdbars=s=${SIZE}:r=${FPS}`, frames: 40, vf: "noise=alls=12:allf=t" },
    { lavfi: `cellauto=s=${SIZE}:r=${FPS}:rule=110`, frames: 55 },
    { lavfi: `gradients=s=${SIZE}:r=${FPS}:speed=0.05`, frames: 75 },
  ];
  if (useReal) {
    segs.push(
      { clip: ABC, ss: 65, frames: 75 },
      { clip: DIEGO, ss: 73, frames: 75 }, // dissolve from previous
      { clip: ABC, ss: 110, frames: 75 }, // hard cut
      { clip: DIEGO, ss: 37.5, frames: 75 }, // fade through black from previous
      { clip: ABC, ss: 66, frames: 60 },
    );
  } else {
    segs.push(
      { lavfi: `rgbtestsrc=s=${SIZE}:r=${FPS}`, frames: 75 },
      { lavfi: `testsrc2=s=${SIZE}:r=${FPS},hue=h=120`, frames: 75 },
      { lavfi: `pal100bars=s=${SIZE}:r=${FPS}`, frames: 75 },
      { lavfi: `yuvtestsrc=s=${SIZE}:r=${FPS}`, frames: 75 },
      { lavfi: `testsrc=s=${SIZE}:r=${FPS}`, frames: 60 },
    );
  }
  const files: string[] = [];
  segs.forEach((s, i) => {
    const out = join(dir, `seg${i}.mp4`);
    const vf = [s.vf, `scale=${SIZE.replace("x", ":")},setsar=1,fps=${FPS},format=yuv420p`].filter(Boolean).join(",");
    const input = s.lavfi ? ["-f", "lavfi", "-i", s.lavfi] : ["-ss", String(s.ss), "-i", s.clip!];
    ff([...input, "-an", "-vf", vf, "-frames:v", String(s.frames), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", out]);
    files.push(out);
  });
  // Indices (into segs) of the transitions into segment i.
  const dissolveInto = 8;
  const fadeInto = 10;
  const D = 20; // dissolve frames
  const F = 6; // fade out / in frames each side
  // Build the graph: concat everything; xfade for the dissolve; fades for the fade.
  const parts: string[] = [];
  const labels: string[] = [];
  segs.forEach((s, i) => {
    let chain = `[${i}:v]setpts=PTS-STARTPTS`;
    if (i === fadeInto - 1) chain += `,fade=t=out:st=${(s.frames - F) / FPS}:d=${F / FPS}`;
    if (i === fadeInto) chain += `,fade=t=in:st=0:d=${F / FPS}`;
    // A flash: one white frame inside segment 6 (not a cut).
    if (i === 6) chain += `,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n\\,30)'`;
    parts.push(`${chain}[v${i}]`);
    labels.push(`v${i}`);
  });
  // xfade between dissolveInto-1 and dissolveInto.
  const a = dissolveInto - 1;
  parts.push(`[v${a}][v${dissolveInto}]xfade=transition=fade:duration=${D / FPS}:offset=${(segs[a].frames - D) / FPS}[x]`);
  const seq = labels.filter((l) => l !== `v${a}` && l !== `v${dissolveInto}`);
  seq.splice(a, 0, "x");
  parts.push(`${seq.map((l) => `[${l}]`).join("")}concat=n=${seq.length}:v=1:a=0[o]`);
  const file = join(dir, "cuts.mp4");
  ff([...files.flatMap((f) => ["-i", f]), "-filter_complex", parts.join(";"), "-map", "[o]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", String(FPS), file]);
  // Ground truth.
  const truth: { frame: number; kind: string }[] = [];
  let pos = 0;
  segs.forEach((s, i) => {
    if (i > 0) {
      if (i === dissolveInto) truth.push({ frame: pos - D + D / 2, kind: "dissolve" });
      else truth.push({ frame: pos - (i > dissolveInto ? D : 0), kind: i === fadeInto ? "fade" : "cut" });
    }
    pos += s.frames;
  });
  return { file, truth, frames: pos - D };
}

export interface AngleSpec {
  /** Seconds of master time this angle's file starts at (its audio is the master shifted). */
  start: number;
  duration: number;
  vf: string;
  gainDb: number;
  noise: number;
}

/**
 * Multicam "angles" cut from one recording: each angle covers [start, start+duration) of the
 * master with its own framing, gain and noise. True offset of angle i relative to angle 0 =
 * start_i - start_0 (master time of the angle's t=0).
 */
export function buildAngles(dir: string, master: string, specs: AngleSpec[]): string[] {
  return specs.map((s, i) => {
    const out = join(dir, `angle${i}.mp4`);
    ff([
      "-ss", String(s.start), "-t", String(s.duration), "-i", master,
      "-f", "lavfi", "-t", String(s.duration), "-i", `anoisesrc=color=pink:amplitude=${s.noise}:r=48000:seed=${i + 3}`,
      "-filter_complex", `[0:v]${s.vf},fps=25,format=yuv420p[v];[0:a]aresample=48000,volume=${s.gainDb}dB[a0];[a0][1:a]amix=inputs=2:normalize=0:duration=first[a]`,
      "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", out,
    ]);
    return out;
  });
}
