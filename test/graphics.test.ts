// Motion graphics: MOGRT parsing (synthetic .mogrt built here — never a commercial file),
// pack indexing (Motion Bro-style temp folder and .mbr archive), fonts, Figma code conversion,
// create_motion_template validation/sanitisation, Fusion .setting generator, placement routing,
// the MCP tools, and a real HyperFrames render of a Figma-style lower third.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = mkdtempSync(join(tmpdir(), "openedit-graphics-test-"));
process.env.OPENEDIT_HOME = join(TMP, "home");
process.env.OPENEDIT_HOST = "standalone";
process.env.OPENEDIT_STUDIO = "off";
process.env.OPENEDIT_GRAPHICS_NO_WARM = "1";
process.env.OPENEDIT_MOTION_TMP ??= join(TMP, "motion-tmp");

const { writeZip, listZip, readZipEntry, readZipBufferEntry } = await import("../src/graphics/zip.js");
const { parseMogrtDefinition, mogrtBridgeParams, rgbaToHex, hexToRgba255 } = await import("../src/graphics/mogrt.js");
const { importTemplatePack, searchCatalog, getTemplate, loadLibrary, setTemplatesRoot, graphicsPaths } = await import("../src/graphics/library.js");
const { setInstalledFontsForTest, missingFonts, familyOf } = await import("../src/graphics/fonts.js");
const { convertFigmaCode, tailwindToCss } = await import("../src/graphics/figma-code.js");
const { createMotionTemplate } = await import("../src/graphics/create.js");
const { sanitizeFragment } = await import("../src/graphics/sanitize.js");
const { buildFusionTitle, fusionTitleSpec } = await import("../src/graphics/fusion.js");
const { validateMotion, PRESETS } = await import("../src/graphics/presets.js");
const { placeGraphic, alternatives } = await import("../src/graphics/place.js");

setTemplatesRoot(() => join(ROOT, "templates"));
const ff = (args: string[]) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);
const hasHyperframes = existsSync(join(ROOT, "node_modules", "hyperframes", "package.json")) && process.env.OPENEDIT_SKIP_RENDER !== "1";

/** A definition.json of our own, shaped like an After Effects-authored MOGRT. */
function syntheticDefinition(name: string) {
  const loc = (s: string) => ({ strDB: [{ localeString: "en_US", str: s }] });
  return {
    capsuleName: name,
    capsuleNameLocalized: loc(name),
    authorApp: "aefx",
    capsuleTags: ["test"],
    clientControls: [
      { id: "g1", type: 10, uiName: loc("Text"), value: ["t1", "t2"] },
      { id: "t1", type: 6, uiName: loc("Title"), value: loc("Hello World"), fonteditinfo: { fontEditValue: "TestSans-Bold", fontSizeEditValue: 96 } },
      { id: "t2", type: 6, uiName: loc("Subtitle"), value: loc("Second line"), fonteditinfo: { fontEditValue: "Helvetica" } },
      { id: "sp", type: 8, uiName: loc(""), value: loc("") },
      { id: "g2", type: 10, uiName: loc("Style"), value: ["c1", "s1", "p1", "k1", "d1", "a1"] },
      { id: "c1", type: 4, uiName: loc("Accent Color"), value: [1, 0.4, 0.2, 1] },
      { id: "s1", type: 2, uiName: loc("Scale"), value: 100, min: 0, max: 250 },
      { id: "p1", type: 5, uiName: loc("Position"), value: { x: 960, y: 540 } },
      { id: "k1", type: 1, uiName: loc("Show Bar"), value: true },
      { id: "d1", type: 7, uiName: loc("Layout"), value: 0, menuItems: ["Left", "Center", "Right"] },
      { id: "a1", type: 3, uiName: loc("Tilt"), value: 0 },
    ],
    sourceInfoLocalized: {
      en_US: { duration: { scale: 30, value: 150 }, framerate: { ticksperframe: 8467200000 }, framesize: { size: { x: 1920, y: 1080 } } },
    },
    usedFontsLocalized: { en_US: ["TestSans-Bold"] },
    usedEffects: ["ADBE Fill"],
  };
}

function syntheticMogrt(name: string, thumb?: Buffer): Buffer {
  return writeZip([
    { name: "definition.json", data: JSON.stringify(syntheticDefinition(name)) },
    { name: "project.aegraphic", data: writeZip([{ name: "x.aep", data: "not a real project" }]) },
    ...(thumb ? [{ name: "thumb.png", data: thumb }] : []),
  ]);
}

let thumbPng: Buffer;
let packDir: string;

beforeAll(() => {
  setInstalledFontsForTest(["Helvetica", "Helvetica Neue", "Avenir Next"]);
  const t = join(TMP, "thumb.png");
  ff(["-f", "lavfi", "-i", "color=c=0x2a9d8f:s=640x360", "-frames:v", "1", t]);
  thumbPng = readFileSync(t);
  // A Motion Bro-like pack: pack.info, numbered category folders, (Preview)/(Thumbnails), .settings, demos, .aep.
  packDir = join(TMP, "packs", "My Titles", "x");
  const mk = (p: string) => mkdirSync(join(packDir, p), { recursive: true });
  for (const d of ["(Assets)", "01. Clean/(Preview)", "01. Clean/(Thumbnails)", "02. Emoji/01. Happy", "02. Emoji/(Preview)", "02. Emoji/(Thumbnails)"]) mk(d);
  writeFileSync(join(packDir, "pack.info"), "packName = My Titles for Premiere Pro\nauthor = Test Studio\nversion = 1.0\napps = PP\n");
  writeFileSync(join(packDir, "01. Clean", ".settings"), "presetType = layer\n");
  writeFileSync(join(packDir, "01. Clean", "Clean Title 01.mogrt"), syntheticMogrt("Clean Title 01", thumbPng));
  writeFileSync(join(packDir, "01. Clean", "Clean Title 02.demo"), "");
  writeFileSync(join(packDir, "02. Emoji", "01. Happy", "Happy Emoji 01.aep"), "not a real aep");
  ff(["-f", "lavfi", "-i", "testsrc2=size=480x270:rate=24:duration=2", "-pix_fmt", "yuv420p", join(packDir, "01. Clean", "(Preview)", "Clean Title 02.mp4")]);
  ff(["-f", "lavfi", "-i", "color=c=0xe76f51:s=480x270", "-frames:v", "1", join(packDir, "01. Clean", "(Thumbnails)", "Clean Title 02.jpg")]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=480x270:rate=24:duration=2", "-pix_fmt", "yuv420p", join(packDir, "02. Emoji", "(Preview)", "Happy Emoji 01.mp4")]);
});

describe("zip", () => {
  it("round-trips entries, nested archives and UTF-8 names", () => {
    const inner = writeZip([{ name: "definition.json", data: '{"a":1}' }]);
    const z = writeZip([{ name: "a/b é.txt", data: "hello" }, { name: "x.mogrt", data: inner }]);
    const p = join(TMP, "t.zip");
    writeFileSync(p, z);
    expect(listZip(p).map((e) => e.name)).toEqual(["a/b é.txt", "x.mogrt"]);
    expect(readZipEntry(p, "a/b é.txt").toString()).toBe("hello");
    expect(readZipBufferEntry(readZipEntry(p, "x.mogrt"), "definition.json")?.toString()).toBe('{"a":1}');
    // System unzip agrees (our writer is standard).
    const r = spawnSync("unzip", ["-l", p], { encoding: "utf8" });
    if (r.status === 0) expect(r.stdout).toContain("x.mogrt");
  });
});

describe("mogrt parser", () => {
  it("turns clientControls into a clean schema with groups, fonts, duration and size", () => {
    const m = parseMogrtDefinition(syntheticDefinition("Lower Third A"));
    expect(m.name).toBe("Lower Third A");
    expect(m.authorApp).toBe("aefx");
    expect(m.duration).toBe(5);
    expect(m.fps).toBe(30);
    expect([m.width, m.height]).toEqual([1920, 1080]);
    expect(m.fonts).toEqual(["TestSans-Bold", "Helvetica"]);
    expect(m.params.map((p) => [p.id, p.type])).toEqual([
      ["title", "text"],
      ["subtitle", "text"],
      ["accent-color", "color"],
      ["scale", "slider"],
      ["position", "point"],
      ["show-bar", "checkbox"],
      ["layout", "dropdown"],
      ["tilt", "angle"],
    ]);
    const byId = Object.fromEntries(m.params.map((p) => [p.id, p]));
    expect(byId.title).toMatchObject({ name: "Title", default: "Hello World", font: "TestSans-Bold", fontSize: 96, group: "Text" });
    expect(byId["accent-color"]!.default).toBe("#FF6633");
    expect(byId.scale).toMatchObject({ min: 0, max: 250, default: 100, group: "Style" });
    expect(byId.position!.default).toEqual([960, 540]);
    expect(byId.layout!.options).toEqual(["Left", "Center", "Right"]);
    expect(m.groups.map((g) => [g.name, g.params.length])).toEqual([["Text", 2], ["Style", 6]]);
    expect(() => parseMogrtDefinition({ nope: 1 })).toThrow(/clientControls/);
  });

  it("converts place_graphic values for the Premiere bridge", () => {
    const m = parseMogrtDefinition(syntheticDefinition("X"));
    const { params, unknown } = mogrtBridgeParams(
      m.params,
      { title: "Maya", "Accent Color": "#00ff80", scale: 400, position: [480, 810], show_bar: false, layout: "Right", missing: 1 },
      { width: 1920, height: 1080 },
    );
    expect(unknown).toEqual(["show_bar", "missing"]);
    expect(params).toEqual([
      { name: "Title", type: "text", value: "Maya" },
      { name: "Accent Color", type: "color", value: [0, 255, 128, 255] },
      { name: "Scale", type: "slider", value: 250 },
      { name: "Position", type: "point", value: [0.25, 0.75] },
      { name: "Layout", type: "dropdown", value: 2 },
    ]);
    expect(() => mogrtBridgeParams(m.params, { "accent-color": "red" })).toThrow(/#RRGGBB/);
    expect(rgbaToHex([0, 0.5, 1, 0.5])).toBe("#0080FF80");
    expect(hexToRgba255("#abc")).toEqual([170, 187, 204, 255]);
  });
});

describe("fonts", () => {
  it("matches PostScript names to installed families and reports the rest", () => {
    expect(familyOf("ArchivoItalic-BlackItalic")).toBe("Archivo");
    expect(familyOf("Unbounded-SemiBold")).toBe("Unbounded");
    expect(missingFonts(["Helvetica-Bold", "HelveticaNeue-Medium", "AvenirNext-DemiBold", "Inter:Bold", "TestSans-Bold"])).toEqual(["Inter:Bold", "TestSans-Bold"]);
  });
});

describe("template pack library", () => {
  it("indexes a Motion Bro-style folder in place (paths + small thumbnails, no copies)", async () => {
    const r = await importTemplatePack(packDir);
    expect(r.pack).toMatchObject({ id: "my-titles", name: "My Titles for Premiere Pro", author: "Test Studio", apps: "PP", type: "folder" });
    expect(r.pack.counts).toMatchObject({ mogrt: 1, aep: 1, demo: 1, items: 3, usable: 1 });
    const byName = Object.fromEntries(r.items.map((i) => [i.name, i]));
    const mogrt = byName["Clean Title 01"]!;
    expect(mogrt).toMatchObject({ id: "my-titles/clean-title-01", kind: "mogrt", usable: true, category: "Clean", apps: ["premiere"], duration: 5 });
    expect(mogrt.source).toEqual({ path: join(packDir, "01. Clean", "Clean Title 01.mogrt") });
    expect(mogrt.missingFonts).toEqual(["TestSans-Bold"]);
    expect(mogrt.tags).toContain("presetType=layer");
    expect(mogrt.thumb && existsSync(mogrt.thumb)).toBe(true);
    const demo = byName["Clean Title 02"]!;
    expect(demo).toMatchObject({ kind: "demo", locked: true, usable: false });
    expect(demo.preview?.path).toBe(join(packDir, "01. Clean", "(Preview)", "Clean Title 02.mp4"));
    expect(demo.image?.path).toBe(join(packDir, "01. Clean", "(Thumbnails)", "Clean Title 02.jpg"));
    const aep = byName["Happy Emoji 01"]!;
    expect(aep).toMatchObject({ kind: "aep", usable: false, category: "Emoji / Happy", apps: ["aftereffects"] });
    expect(aep.preview?.path).toBe(join(packDir, "02. Emoji", "(Preview)", "Happy Emoji 01.mp4")); // found in an ancestor's (Preview)
    expect(aep.note).toMatch(/After Effects/);
    // Thumbnails are small JPEGs; nothing heavy is copied into OPENEDIT_HOME.
    for (const it of r.items) {
      expect(it.thumb, it.id).toBeTruthy();
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=width", "-of", "csv=p=0", it.thumb!], { encoding: "utf8" });
      expect(Number(probe.stdout.trim())).toBeLessThanOrEqual(320);
    }
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    const stored = walk(graphicsPaths.root());
    expect(stored.some((f) => /\.(mogrt|aep|mp4|mbr)$/.test(f))).toBe(false);
    expect(loadLibrary().items.filter((i) => i.pack === "my-titles")).toHaveLength(3);
  });

  it("indexes the same pack as a .mbr archive and extracts a .mogrt only when needed", async () => {
    const files: { name: string; data: Buffer }[] = [];
    const walk = (d: string, rel = "") => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        const r = rel ? `${rel}/${f}` : f;
        if (statSync(p).isDirectory()) walk(p, r);
        else files.push({ name: r, data: readFileSync(p) });
      }
    };
    walk(packDir);
    const mbr = join(TMP, "My Titles.mbr");
    writeFileSync(mbr, writeZip(files));
    const r = await importTemplatePack(mbr, { id: "my-titles-mbr" });
    expect(r.pack.type).toBe("archive");
    expect(r.items.map((i) => i.kind).sort()).toEqual(["aep", "demo", "mogrt"]);
    const m = r.items.find((i) => i.kind === "mogrt")!;
    expect(m.source).toEqual({ archive: mbr, path: "01. Clean/Clean Title 01.mogrt" });
    expect(m.params.length).toBe(8);
    // Re-import replaces (idempotent).
    await importTemplatePack(mbr, { id: "my-titles-mbr" });
    expect(loadLibrary().items.filter((i) => i.pack === "my-titles-mbr")).toHaveLength(3);
  });

  it("catalog merges packs, OpenEdit templates and filters by host", () => {
    const all = searchCatalog();
    expect(all.some((i) => i.id === "lower-third" && i.kind === "hyperframes")).toBe(true);
    const resolveOk = searchCatalog({ app: "resolve" });
    expect(resolveOk.every((i) => i.kind === "hyperframes" || i.kind === "user")).toBe(true);
    expect(searchCatalog({ app: "premiere", query: "clean" }).map((i) => i.id)).toContain("my-titles/clean-title-01");
    expect(searchCatalog({ category: "emoji" }).every((i) => i.kind === "aep")).toBe(true);
    expect(() => getTemplate("nope-nothing")).toThrow(/Unknown graphics template/);
  });
});

describe("Figma code → HTML", () => {
  it("maps common Tailwind utilities (incl. arbitrary values) to CSS", () => {
    const g = {};
    expect(tailwindToCss("rounded-tr-[18px]", g)).toEqual(["border-top-right-radius: 18px"]);
    expect(tailwindToCss("font-['Inter:Semi_Bold',_sans-serif]", g)).toEqual(["font-family: 'Inter', sans-serif", "font-weight: 600"]);
    expect(tailwindToCss("text-[56px]", g)).toEqual(["font-size: 56px"]);
    expect(tailwindToCss("text-[#b9bdc8]", g)).toEqual(["color: #b9bdc8"]);
    expect(tailwindToCss("tracking-[-0.02em]", g)).toEqual(["letter-spacing: -0.02em"]);
    expect(tailwindToCss("-translate-x-1/2", g)).toEqual(["translate: -50% 0"]);
    expect(tailwindToCss("gap-4", g)).toEqual(["gap: 16px"]);
    expect(tailwindToCss("bg-[var(--brand,#fff)]", g)).toEqual(["background-color: var(--brand,#fff)"]);
    expect(tailwindToCss("shadow-[0px_4px_8px_0px_rgba(0,0,0,0.25)]", g)).toEqual(["box-shadow: 0px 4px 8px 0px rgba(0,0,0,0.25)"]);
    expect(tailwindToCss("hover:bg-red-500", g)).toEqual([]);
    expect(tailwindToCss("frobnicate-3", g)).toBeNull();
  });

  it("converts get_design_context-style React into HTML with fields from layer names and variables", () => {
    const c = convertFigmaCode(readFileSync(join(ROOT, "test", "fixtures", "figma", "lower-third.tsx"), "utf8"));
    expect(c.width).toBe(1920);
    expect(c.height).toBe(1080);
    expect(c.html).not.toMatch(/className|\{|\}|=>/);
    expect(c.html).toContain('data-oe-field="name"');
    expect(c.html).toMatch(/font-family: 'Avenir Next', 'Helvetica Neue', sans-serif; font-weight: 700/);
    expect(c.fields).toEqual([
      { id: "accent", type: "color", selector: '[data-oe-field="accent"]', style: "background-color", default: "var(--brand-accent,#ff6a3d)" },
      { id: "name", type: "text", selector: '[data-oe-field="name"]', text: true, default: "Maya Okafor" },
      { id: "role", type: "text", selector: '[data-oe-field="role"]', text: true, default: "Head of Product · Northwind" },
      { id: "brand_accent", type: "color", selector: ":root", style: "--brand-accent", default: "#ff6a3d" },
    ]);
    expect(c.assets).toEqual([{ name: "imgAccent", url: "http://localhost:3845/assets/3f2a9c1d.svg", file: "accent.svg" }]);
    expect(c.unknownClasses).toEqual([]);
    const t = convertFigmaCode(readFileSync(join(ROOT, "test", "fixtures", "figma", "title-card.tsx"), "utf8"));
    expect(t.html).toContain('stroke-width="2"');
    expect(t.html).toContain('stroke-linecap="round"');
    expect(t.html).toMatch(/<path[^>]*><\/path>/);
    expect(t.fields.map((f) => f.id)).toEqual(["kicker", "title", "subtitle", "brand_accent"]);
  });
});

describe("create_motion_template validation and sanitisation", () => {
  it("strips scripts, handlers and remote assets; keeps Google Fonts for localisation", () => {
    const s = sanitizeFragment(
      `<div onclick="alert(1)" class="a"><script>alert(2)</script><img src="https://evil.example/x.png"><a href="javascript:alert(3)">x</a>
       <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@700&amp;display=swap"><iframe src="x"></iframe>
       <span style="background:url(https://evil.example/bg.png)">t</span></div>`,
      "@import url('https://evil.example/x.css'); .a{background:url(http://x.example/a.png)} @import url(https://fonts.googleapis.com/css2?family=Lora);",
    );
    expect(s.html).not.toMatch(/script|onclick|iframe|javascript:|evil\.example/i);
    expect(s.css).not.toMatch(/evil|x\.example/);
    expect(s.googleFonts).toEqual(["https://fonts.googleapis.com/css2?family=Inter:wght@700&display=swap", "https://fonts.googleapis.com/css2?family=Lora"]);
    expect(s.warnings.join("\n")).toMatch(/<script> removed/);
  });

  it("rejects invalid specs with every problem listed", async () => {
    await expect(
      createMotionTemplate({
        name: "Bad",
        html: "<div class='t'>{{title}}</div>",
        fields: [{ id: "9bad", type: "text" }, { id: "ok", style: "color;x" }],
        motion: [{ selector: ".t", preset: "wobble" }, { selector: ".t", preset: "rise", easing: "bouncy-ish" }],
        duration: 500,
        background: "url(x)",
      }),
    ).rejects.toThrow(/field id "9bad".*invalid CSS property.*unknown preset "wobble".*unknown easing "bouncy-ish"/s);
    await expect(createMotionTemplate({ name: "Nothing" })).rejects.toThrow(/html and\/or svg/);
  });

  it("writes a composition with bindings, assets and craft notes", async () => {
    const logo = join(TMP, "logo.svg");
    writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>');
    const r = await createMotionTemplate({
      name: "Unit Card",
      html: `<div class="card"><img src="${logo}"><h1 class="t">{{title}}</h1><p class="s">Sub</p><script>evil()</script></div>`,
      css: ".card{position:absolute;left:100px;top:100px;font-family:'Helvetica Neue'}",
      assets: [{ path: logo }],
      fields: [{ id: "title", default: "Hi" }, { id: "sub", selector: ".s", text: true, default: "Sub" }, { id: "accent", type: "color", selector: ":root", style: "--accent", default: "#ff0000" }],
      motion: [{ selector: ".t", preset: "mask-up", split: "words", stagger: 0.5 }, { selector: ".s", preset: "rise", delay: 4.2, easing: "linear" }],
      duration: 5,
    });
    expect(r.id).toBe("unit-card");
    const comp = readFileSync(join(r.dir, "composition.html"), "utf8");
    expect(comp).toContain('src="assets/logo.svg"');
    expect(comp).toContain("OE.motion.play(");
    expect(comp).not.toContain("evil()");
    expect(existsSync(join(r.dir, "assets", "logo.svg"))).toBe(true);
    const tj = JSON.parse(readFileSync(join(r.dir, "template.json"), "utf8"));
    expect(tj).toMatchObject({ id: "unit-card", duration: 5, width: 1920, height: 1080, defaults: { title: "Hi", sub: "Sub", accent: "#ff0000" } });
    expect(r.warnings.join("\n")).toMatch(/per-word stagger 0.5s is slow/);
    expect(r.warnings.join("\n")).toMatch(/entrances should decelerate/);
    expect(r.warnings.join("\n")).toMatch(/hold long enough/);
    expect(getTemplate("unit-card")).toMatchObject({ kind: "user", usable: true, apps: ["premiere", "resolve", "standalone"] });
  });

  it("knows every preset the runtime implements", () => {
    const runtime = readFileSync(join(ROOT, "templates", "_shared", "motion.js"), "utf8");
    for (const name of Object.keys(PRESETS)) expect(runtime, name).toContain(`${/^[a-z]+$/.test(name) ? name : `"${name}"`}:`);
    expect(validateMotion([{ selector: ".a", preset: "rise", easing: "cubic-bezier(0.2, 0, 0, 1)" }], 4).errors).toEqual([]);
  });
});

describe("Fusion Text+ titles (Resolve)", () => {
  it("generates a stable .setting macro", () => {
    const { setting, spec } = buildFusionTitle({
      lines: ["Maya Okafor", "Head of Product"],
      font: "Open Sans",
      style: "Bold",
      size: 0.036,
      color: "#FFFFFF",
      plate: "#0C0D11",
      align: "left",
      center: [0.09, 0.17],
      animation: "fade",
      duration: 5,
      fps: 25,
      width: 1920,
      height: 1080,
      name: "OpenEditLowerThird",
    });
    expect(setting).toMatchSnapshot();
    expect(spec.durationFrames).toBe(125);
    expect(spec.keys.Opacity1).toEqual([[0, 0], [13, 1], [116, 1], [125, 0]]);
    expect(setting).toMatch(/^\{\n\tTools = ordered\(\) \{/);
    expect(setting.split("{").length).toBe(setting.split("}").length);
  });

  it("escapes text and supports write-on and pop", () => {
    const s = fusionTitleSpec({ lines: ['Say "hi"\\now'], duration: 2, fps: 30, animation: "write-on" });
    expect(s.keys.End).toEqual([[0, 0], [24, 1]]);
    const { setting } = buildFusionTitle({ lines: ['Say "hi"', "Ünï"], duration: 2, fps: 30, animation: "pop" });
    expect(setting).toContain('StyledText = Input { Value = "Say \\"hi\\"\\n\\220n\\239", },');
    expect(setting).toContain("OpenEditTitleSize = BezierSpline");
  });
});

describe("place_graphic routing", () => {
  const fakeHost = (name: "premiere" | "resolve" | "standalone") => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    return {
      calls,
      host: {
        name,
        status: async () => ({ host: name, connected: true }),
        getTimeline: async () => ({ name: "t", duration: 10, fps: 25, width: 1920, height: 1080, videoTracks: 1, audioTracks: 1, clips: [], markers: [] }),
        getSourceMedia: async () => [],
        applyCutPlan: async () => ({ sequence: "x" }),
        addMarkers: async () => 0,
        importMedia: async () => 0,
        placeClips: async (clips: unknown[]) => (calls.push({ cmd: "placeClips", args: { clips } }), clips.length),
        addCaptions: async () => ({ added: 0 }),
        addZooms: async () => 0,
        render: async () => ({ output: "" }),
        rpc: async (cmd: string, args: Record<string, unknown>) => (calls.push({ cmd, args }), cmd === "applyMogrt" ? { placed: true, track: 2, at: args.at, set: (args.params as unknown[]).length, missing: [], errors: [] } : { timecode: "01:00:04:00", notes: [] }),
      },
    };
  };

  it("Premiere: places a .mogrt natively with converted params", async () => {
    const { host, calls } = fakeHost("premiere");
    const it = getTemplate("my-titles-mbr/clean-title-01");
    const r = await placeGraphic(it, host as never, { at: 4, duration: 3, params: { title: "Maya", "accent-color": "#112233" } });
    expect(r.method).toBe("mogrt");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("applyMogrt");
    expect(calls[0]!.args).toMatchObject({ at: 4, duration: 3, track: 2, params: [{ name: "Title", type: "text", value: "Maya" }, { name: "Accent Color", type: "color", value: [17, 34, 51, 255] }] });
    const path = calls[0]!.args.path as string;
    expect(path.endsWith("Clean Title 01.mogrt") && existsSync(path)).toBe(true); // extracted from the .mbr on demand
    expect(r.text).toMatch(/fonts missing on this machine: TestSans-Bold/);
    await expect(placeGraphic(it, host as never, { at: 0, params: { nope: 1 } })).rejects.toThrow(/Unknown field\(s\).*nope/);
  });

  it("explains a .mogrt outside Premiere and offers OpenEdit templates", async () => {
    const { host } = fakeHost("resolve");
    await expect(placeGraphic(getTemplate("my-titles/clean-title-01"), host as never, { at: 0 })).rejects.toThrow(/Premiere MOGRT; resolve cannot render it.*Closest usable templates here: .*title-card/s);
    await expect(placeGraphic(getTemplate("my-titles/clean-title-02"), host as never, { at: 0 })).rejects.toThrow(/locked demo/);
    expect(alternatives(getTemplate("my-titles/clean-title-01"), "standalone").every((a) => a.kind === "hyperframes" || a.kind === "user")).toBe(true);
  });

  it("Resolve editable: inserts a Fusion title and writes the .setting", async () => {
    const { host, calls } = fakeHost("resolve");
    const r = await placeGraphic(getTemplate("lower-third"), host as never, { at: 4, editable: true, params: { name: "Maya Okafor", role: "Producer" } });
    expect(r.method).toBe("fusion-title");
    expect(calls[0]!.cmd).toBe("addFusionTitle");
    const spec = calls[0]!.args.spec as { inputs: { StyledText: string } };
    expect(spec.inputs.StyledText).toBe("Maya Okafor\nProducer");
    expect(existsSync(r.settingPath!)).toBe(true);
  });
});

describe("MCP tools", () => {
  let client: Client;
  beforeAll(async () => {
    const { createServer } = await import("../src/mcp/server.js");
    const server = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: "graphics-test", version: "0" });
    await client.connect(ct);
  });
  afterAll(async () => {
    await client?.close();
  });

  it("graphics_catalog returns a contact sheet image, a numbered list and view data", async () => {
    const r = (await client.callTool({ name: "graphics_catalog", arguments: { query: "clean" } })) as { content: { type: string; data?: string; text?: string }[]; structuredContent: { view: string; items: { id: string; thumb?: string }[] } };
    const img = r.content.find((c) => c.type === "image")!;
    expect(Buffer.from(img.data!, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
    const text = r.content.find((c) => c.type === "text")!.text!;
    expect(text).toMatch(/1\. my-titles\/clean-title-01 — Clean Title 01 \[Clean; mogrt, usable, premiere 5s\]/);
    expect(r.structuredContent.view).toBe("graphics");
    expect(r.structuredContent.items[0]!.thumb).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("import_template_pack and preview_template (pack preview video) work through MCP", async () => {
    const imp = (await client.callTool({ name: "import_template_pack", arguments: { path: packDir, id: "via-mcp" } })) as { content: { type: string; text?: string }[] };
    expect(imp.content.find((c) => c.type === "text")!.text).toMatch(/1 \.mogrt \(usable in Premiere\), 1 \.aep \(After Effects only\), 1 locked demos/);
    const pv = (await client.callTool({ name: "preview_template", arguments: { id: "via-mcp/clean-title-02", count: 3 } }, undefined, { timeout: 120_000 })) as { content: { type: string; text?: string }[]; isError?: boolean };
    expect(pv.isError).toBeFalsy();
    expect(pv.content[0]!.type).toBe("image");
    expect(pv.content[1]!.text).toMatch(/preview-video/);
  });
});

describe.runIf(hasHyperframes)("real render of a Figma-style lower third", () => {
  it("creates the template from Figma code, previews it and renders alpha ProRes", async () => {
    const { createServer } = await import("../src/mcp/server.js");
    const server = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "graphics-render", version: "0" });
    await client.connect(ct);
    try {
      const figmaCode = readFileSync(join(ROOT, "test", "fixtures", "figma", "lower-third.tsx"), "utf8");
      const r = (await client.callTool({
        name: "create_motion_template",
        arguments: {
          name: "Speaker lower third",
          figmaCode,
          category: "Lower thirds",
          duration: 5,
          motion: [
            { selector: '[data-oe-field="accent"]', preset: "grow-y", duration: 0.5 },
            { selector: '[data-name="plate"]', preset: "wipe-right", delay: 0.12, duration: 0.7, easing: "outExpo" },
            { selector: '[data-oe-field="name"]', preset: "mask-up", split: "words", delay: 0.3, stagger: 0.07 },
            { selector: '[data-name="dash"]', preset: "grow-x", delay: 0.55 },
            { selector: '[data-oe-field="role"]', preset: "tracking-in", delay: 0.6, from: 0.4, tracking: 0.16 },
          ],
        },
      }, undefined, { timeout: 280_000 })) as { content: { type: string; data?: string; text?: string }[]; isError?: boolean };
      expect(r.isError, r.content.map((c) => c.text).join("\n")).toBeFalsy();
      expect(r.content[0]!.type).toBe("image");
      const text = r.content.find((c) => c.type === "text")!.text!;
      expect(text).toMatch(/Created template speaker-lower-third/);
      expect(text).toMatch(/Layer selectors: .*\[data-name="plate"\]/);
      const outDir = join(TMP, "frames");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "lower-third-strip.jpg"), Buffer.from(r.content[0]!.data!, "base64"));
      if (process.env.OPENEDIT_GRAPHICS_ARTIFACTS) writeFileSync(join(process.env.OPENEDIT_GRAPHICS_ARTIFACTS, "lower-third-strip.jpg"), Buffer.from(r.content[0]!.data!, "base64"));

      const it = getTemplate("speaker-lower-third");
      const { renderGraphic } = await import("../src/graphics/place.js");
      const out = await renderGraphic(it, { params: { name: "Ada Lovelace", role: "Analyst", brand_accent: "#3d8bff" }, output: join(outDir, "lt.mov"), width: 1280, height: 720, duration: 3 });
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,pix_fmt,width,height", "-of", "json", out], { encoding: "utf8" })) as { streams: { codec_name: string; pix_fmt: string; width: number; height: number }[] };
      expect(probe.streams[0]).toMatchObject({ codec_name: "prores", width: 1280, height: 720 });
      expect(probe.streams[0]!.pix_fmt).toMatch(/yuva/);
      // Settled frame: the plate (dark) is opaque in the lower left and the top is transparent.
      const px = (t: number, x: number, y: number) => {
        const b = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", out, "-frames:v", "1", "-vf", `crop=1:1:${x}:${y},format=rgba`, "-f", "rawvideo", "-"]);
        return [...b];
      };
      const plate = px(1.6, 300, 600);
      expect(plate[3]).toBeGreaterThan(180);
      expect(plate[0]! + plate[1]! + plate[2]!).toBeLessThan(120);
      expect(px(1.6, 640, 100)[3]).toBe(0);
      expect(px(0.0, 300, 600)[3]).toBeLessThan(40); // not yet revealed
    } finally {
      await client.close();
    }
  }, 300_000);
});
