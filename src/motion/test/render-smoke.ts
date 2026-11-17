/**
 * Motion smoke test: renders a 3 s title-card and a 3 s caption overlay, then
 * verifies them with ffprobe (duration, ProRes 4444 + alpha pixel format) and
 * extracts a PNG still from each (composited over grey so alpha is visible).
 *
 * Run:  npx tsx src/motion/test/render-smoke.ts [outDir]
 *   or: node src/motion/test/render-smoke.ts [outDir]   (Node ≥ 22.18 type stripping)
 * Env:  OPENEDIT_HYPERFRAMES_BIN=/path/to/hyperframes.mjs to use a local CLI,
 *       otherwise `npx hyperframes@<pinned>` is used.
 *
 * Not a vitest file on purpose: it needs Chrome + ffmpeg and takes ~30 s.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { listTemplates, renderCaptionOverlay, renderTemplate } from "../index.js";
import type { CaptionCue } from "../../hosts/types.js";

const outDir = resolve(process.argv[2] ?? join(tmpdir(), "openedit-motion-smoke"));
mkdirSync(outDir, { recursive: true });

function probe(file: string): { duration: number; pixFmt: string; codec: string; profile: string; w: number; h: number } {
  const json = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,profile,pix_fmt,width,height:format=duration", "-of", "json", file], {
    encoding: "utf8",
  });
  const j = JSON.parse(json) as { streams: { codec_name: string; profile?: string; pix_fmt: string; width: number; height: number }[]; format: { duration: string } };
  const s = j.streams[0]!;
  return { duration: Number(j.format.duration), pixFmt: s.pix_fmt, codec: s.codec_name, profile: s.profile ?? "", w: s.width, h: s.height };
}

/** Mean alpha (0–255) of the frame at time t: proves the background is transparent. */
function meanAlpha(file: string, t: number): number {
  const r = spawnSync(
    "ffmpeg",
    ["-v", "info", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "alphaextract,format=gray,signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const m = /YAVG=([0-9.]+)/.exec(r.stderr ?? "");
  return m ? Number(m[1]) : NaN;
}

function still(file: string, t: number, png: string, w: number, h: number): void {
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `color=c=0x3a4250:s=${w}x${h}`,
    "-ss", String(t), "-i", file,
    "-filter_complex", "[1:v]format=rgba[o];[0:v][o]overlay=shortest=1",
    "-frames:v", "1", png,
  ]);
}

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  if (!ok) failures++;
}

const templates = listTemplates();
check("listTemplates", templates.length >= 7, templates.map((t) => t.id).join(", "));

// 1) title-card
const titleOut = join(outDir, "title-card.mov");
let t0 = Date.now();
await renderTemplate({
  template: "title-card",
  params: { title: "The Future of Editing", subtitle: "Local. Open source. Driven by Claude.", eyebrow: "OpenEdit", highlight: "Editing" },
  output: titleOut,
  width: 1920,
  height: 1080,
  fps: 30,
  duration: 3,
});
let p = probe(titleOut);
check("title-card rendered", existsSync(titleOut), `${((Date.now() - t0) / 1000).toFixed(1)} s`);
check("title-card duration", Math.abs(p.duration - 3) < 0.07, `${p.duration}s`);
check("title-card alpha", /^yuva/.test(p.pixFmt) && p.codec === "prores", `${p.codec}/${p.profile}/${p.pixFmt} ${p.w}x${p.h}`);
let a = meanAlpha(titleOut, 1.5);
check("title-card mostly transparent", a > 0 && a < 128, `mean alpha ${a}`);
still(titleOut, 1.5, join(outDir, "title-card-1.5s.png"), 1920, 1080);

// 2) caption overlay (bold-pop, word timings on the first cue, synthesized on the second)
const cues: CaptionCue[] = [
  {
    start: 0,
    end: 1.6,
    text: "This is how you edit videos",
    words: [
      { text: "This", start: 0.0, end: 0.25 },
      { text: "is", start: 0.25, end: 0.4 },
      { text: "how", start: 0.4, end: 0.62 },
      { text: "you", start: 0.62, end: 0.8 },
      { text: "edit", start: 0.8, end: 1.15 },
      { text: "videos", start: 1.15, end: 1.6 },
    ],
  },
  { start: 1.7, end: 3.0, text: "ten times faster with AI." },
];
const capOut = join(outDir, "captions-bold-pop.mov");
t0 = Date.now();
await renderCaptionOverlay({ cues, style: "bold-pop", output: capOut, width: 1920, height: 1080, fps: 30 });
p = probe(capOut);
check("captions rendered", existsSync(capOut), `${((Date.now() - t0) / 1000).toFixed(1)} s`);
check("captions duration", Math.abs(p.duration - 3.05) < 0.1, `${p.duration}s`);
check("captions alpha", /^yuva/.test(p.pixFmt) && p.codec === "prores", `${p.codec}/${p.profile}/${p.pixFmt} ${p.w}x${p.h}`);
a = meanAlpha(capOut, 0.9);
check("captions mostly transparent", a > 0 && a < 64, `mean alpha ${a}`);
still(capOut, 0.9, join(outDir, "captions-bold-pop-0.9s.png"), 1920, 1080);

console.log(`\nOutputs in ${outDir}`);
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("All motion checks passed.");
