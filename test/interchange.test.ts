import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildInterchange,
  editTimeToFrame,
  fcpTime,
  fileUrl,
  frameRate,
  framesToTimecode,
  reelName,
  snapPlan,
  timecodeToFrames,
  type InterchangeInput,
} from "../src/engine/interchange.js";
import type { CutPlan, MediaInfo } from "../src/hosts/types.js";

const hasXmllint = spawnSync("xmllint", ["--version"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "openedit-interchange-"));

function wellFormed(xml: string, name: string): void {
  if (!hasXmllint) {
    // Minimal fallback: balanced tags.
    const open = (xml.match(/<[A-Za-z][^>]*[^/]>/g) ?? []).filter((t) => !t.startsWith("<?") && !t.startsWith("<!")).length;
    const close = (xml.match(/<\/[A-Za-z][^>]*>/g) ?? []).length;
    expect(open).toBe(close);
    return;
  }
  const f = join(dir, name);
  writeFileSync(f, xml);
  // --noout prints nothing when the document is well-formed; throws on a parse error.
  execFileSync("xmllint", ["--noout", "--nonet", f]);
}

const plan: CutPlan = {
  source: "/Volumes/Media/My Talk & Co.mp4",
  duration: 60,
  keep: [
    { start: 0, end: 2.02 },
    { start: 3.5, end: 7.25 },
    { start: 7.26, end: 7.27 }, // shorter than a frame: dropped
    { start: 10, end: 20 },
  ],
  cuts: [],
};

function input(fps: number, extra: Partial<InterchangeInput> = {}): InterchangeInput {
  const info: MediaInfo = { path: plan.source, duration: 60, width: 1920, height: 1080, fps, hasAudio: true, hasVideo: true };
  return {
    plan,
    info,
    source: { audioChannels: 2, audioRate: 48000 },
    markers: [{ time: 1, name: "Intro <hook>", color: "red", comment: "a & b" }, { time: 8, name: "Chapter 2" }],
    captions: [
      { start: 0.5, end: 1.8, text: "Hello & welcome" },
      { start: 1.9, end: 3.0, text: "spans the cut" },
    ],
    zooms: [{ start: 6, end: 9, scale: 112 }],
    ...extra,
  };
}

describe("frame rates and timecode", () => {
  it("normalises NTSC and integer rates", () => {
    expect(frameRate(29.97002997)).toMatchObject({ num: 30000, den: 1001, timebase: 30, ntsc: true, dropFrame: true });
    expect(frameRate(23.976)).toMatchObject({ num: 24000, den: 1001, timebase: 24, ntsc: true, dropFrame: false });
    expect(frameRate(59.94)).toMatchObject({ timebase: 60, ntsc: true, dropFrame: true });
    expect(frameRate(25)).toMatchObject({ num: 25, den: 1, timebase: 25, ntsc: false });
    expect(frameRate(undefined).timebase).toBe(25);
  });
  it("converts drop-frame timecode both ways", () => {
    const df = frameRate(29.97);
    expect(framesToTimecode(1800, df)).toBe("00:01:00;02"); // frames 0 and 1 of minute 1 are skipped
    expect(framesToTimecode(17982, df)).toBe("00:10:00;00"); // every 10th minute keeps them
    expect(timecodeToFrames("01:00:00;00", df)).toBe(107892);
    for (const f of [0, 1, 1799, 1800, 1801, 17981, 17982, 107892, 123456]) {
      expect(timecodeToFrames(framesToTimecode(f, df), df)).toBe(f);
    }
    const ndf = frameRate(25);
    expect(framesToTimecode(90000, ndf)).toBe("01:00:00:00");
    expect(timecodeToFrames("01:00:00:00", ndf)).toBe(90000);
  });
  it("snaps edits to frames and accumulates record time without drift", () => {
    const r = frameRate(25);
    const e = snapPlan(plan, r);
    expect(e.map((x) => [x.srcIn, x.srcOut, x.recIn, x.recOut])).toEqual([
      [0, 51, 0, 51],
      [88, 181, 51, 144],
      [250, 500, 144, 394],
    ]);
    expect(e.map((x) => x.index)).toEqual([0, 1, 3]);
    // Edit time 2.02 + 1.0 lies 1 s into the second kept range: source 4.5 s = frame 112.5 -> 113 - 88 + 51
    expect(editTimeToFrame(plan, e, 3.02, r)).toBe(76);
    expect(fcpTime(3, frameRate(29.97))).toBe("1001/10000s");
    expect(fcpTime(50, r)).toBe("2s");
    expect(fcpTime(51, r)).toBe("51/25s");
  });
  it("builds safe file URLs and reel names", () => {
    expect(fileUrl("/Volumes/Media/My Talk & Co.mp4")).toBe("file://localhost/Volumes/Media/My%20Talk%20&%20Co.mp4");
    expect(reelName("/x/my talk-2024.final.mov")).toBe("MY_TALK_");
  });
});

describe("FCP7 XML (xmeml v5)", () => {
  const xml = buildInterchange("fcp7", input(29.97));
  it("is well-formed with NTSC rates, linked A/V, markers and zooms", () => {
    wellFormed(xml, "fcp7.xml");
    expect(xml).toContain('<xmeml version="5">');
    expect(xml).toContain("<timebase>30</timebase>");
    expect(xml).toContain("<ntsc>TRUE</ntsc>");
    // 3 video + 2×3 mono audio clipitems, each linked to its 3 siblings
    expect(xml.match(/<clipitem /g)?.length).toBe(9);
    expect(xml.match(/<link>/g)?.length).toBe(27);
    expect(xml).toContain("<pathurl>file://localhost/Volumes/Media/My%20Talk%20&amp;%20Co.mp4</pathurl>");
    // full file definition once, references after
    expect(xml.match(/<file id="file-1">/g)?.length).toBe(1);
    expect(xml).toContain("<name>Intro &lt;hook&gt;</name>");
    expect(xml).toContain("<effectid>basic</effectid>");
    expect(xml).toContain("<parameterid>scale</parameterid>");
    // first clip: in 0, out 61 frames (2.02 s × 29.97)
    expect(xml).toMatch(/<in>0<\/in>\s*<out>61<\/out>/);
  });
  it("handles audio-only sources", () => {
    const i = input(25);
    const x = buildInterchange("fcp7", { ...i, info: { ...i.info, hasVideo: false, width: undefined, height: undefined } });
    wellFormed(x, "fcp7-audio.xml");
    expect(x).not.toContain("<mediatype>video</mediatype>");
  });
});

describe("FCPXML 1.10", () => {
  const xml = buildInterchange("fcpxml", input(23.976));
  it("is well-formed with rational frame times, media-rep, captions and markers", () => {
    wellFormed(xml, "timeline.fcpxml");
    expect(xml).toContain('<fcpxml version="1.10">');
    expect(xml).toContain('frameDuration="1001/24000s"');
    expect(xml).toContain('<media-rep kind="original-media" src="file:///Volumes/Media/My%20Talk%20&amp;%20Co.mp4"/>');
    expect(xml.match(/<asset-clip /g)?.length).toBe(3);
    expect(xml).toContain('role="SRT?captionFormat=SRT.en"');
    // "spans the cut" is split across the two clips it touches
    expect(xml.match(/name="spans the cut"/g)?.length).toBe(2);
    expect(xml).toContain('value="Intro &lt;hook&gt;"');
    expect(xml).toContain("adjust-transform");
    // every time attribute is a whole number of frames
    for (const m of xml.matchAll(/(?:offset|start|duration)="(\d+)(?:\/(\d+))?s"/g)) {
      const secs = Number(m[1]) / Number(m[2] ?? 1);
      const frames = (secs * 24000) / 1001;
      expect(Math.abs(frames - Math.round(frames))).toBeLessThan(1e-6);
    }
  });
  it("starts the sequence at 01:00:00:00", () => {
    const x = buildInterchange("fcpxml", input(25));
    expect(x).toContain('tcStart="3600s"');
    expect(x).toMatch(/<asset-clip ref="r2" offset="3600s"/);
  });
});

describe("CMX 3600 EDL", () => {
  it("writes drop-frame events with clip names and locators", () => {
    const edl = buildInterchange("edl", input(29.97));
    const lines = edl.split("\r\n");
    expect(lines[0]).toBe("TITLE: My Talk & Co - OpenEdit");
    expect(lines[1]).toBe("FCM: DROP FRAME");
    const events = lines.filter((l) => /^\d{3} /.test(l));
    expect(events).toHaveLength(3);
    expect(events[0]).toBe("001  MY_TALK_ AA/V  C        00:00:00;00 00:00:02;01 01:00:00;00 01:00:02;01");
    // record in of each event = record out of the previous one
    const rec = events.map((e) => e.trim().split(/\s+/).slice(-2));
    expect(rec[1][0]).toBe(rec[0][1]);
    expect(rec[2][0]).toBe(rec[1][1]);
    expect(edl).toContain("* FROM CLIP NAME: My Talk & Co.mp4");
    expect(edl).toContain("* LOC: 01:00:01;00 RED     Intro <hook>");
  });
  it("uses non-drop frame at 25 fps and offsets by the source timecode", () => {
    const edl = buildInterchange("edl", input(25, { source: { audioChannels: 1, timecode: "10:00:00:00" } }));
    expect(edl).toContain("FCM: NON-DROP FRAME");
    expect(edl).toContain("001  MY_TALK_ B     C        10:00:00:00 10:00:02:01 01:00:00:00 01:00:02:01");
  });
});

describe("SRT export", () => {
  it("writes captions and refuses when there are none", () => {
    expect(buildInterchange("srt", input(25))).toContain("Hello & welcome");
    expect(() => buildInterchange("srt", input(25, { captions: [] }))).toThrow(/No captions/);
  });
});
