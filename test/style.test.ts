import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

process.env.OPENEDIT_HOME ??= join(tmpdir(), `openedit-style-${process.pid}`);

const { parseInsight, insightFlags } = await import("../src/engine/analysis/insight.js");
const { shotUsability } = await import("../src/engine/analysis/usable.js");
const { figmaMotionToCss, normalizeAnimationCss, normalizeAnimationValue } = await import("../src/graphics/figma-motion.js");
const { listTemplates } = await import("../src/motion/index.js");
type Shot = import("../src/engine/analysis/analyze.js").Shot;

describe("vision insight parsing", () => {
  it("reads the model's JSON leniently", () => {
    const i = parseInsight('Sure! {"caption":"A green M&M on a skewer","rig_visible":true,"equipment_visible":"false","no_subject":false,"focus":"soft","beauty":"7"} ', "gemma3:4b");
    expect(i).toMatchObject({ caption: "A green M&M on a skewer", rig: true, gear: false, noSubject: false, focus: "soft", beauty: 7, model: "gemma3:4b" });
    expect(parseInsight('{"caption":"Close-up of dry grass","subject":"green grass","no_subject":false}', "m")!.noSubject).toBe(true);
    expect(parseInsight('{"caption":"Candy on grass","subject":"M&M on grass","no_subject":false}', "m")!.noSubject).toBe(false);
    expect(parseInsight("no json here", "m")).toBeNull();
    expect(parseInsight('{"caption":""}', "m")).toBeNull();
    expect(insightFlags(i!)).toEqual(["rig visible (stick/stand/wire holding the subject)"]);
  });

  it("gear, no subject and missed focus reject a shot; a rig is a caution", () => {
    const base = { duration: 2, brightness: 0.5, exposure: "ok", motion: 0.03, shake: 0.1, sharpness: 80 } as unknown as Shot;
    const ins = (o: object) => ({ caption: "x", rig: false, gear: false, hands: false, noSubject: false, model: "m", ...o });
    expect(shotUsability({ ...base, insight: ins({ gear: true }) }).status).toBe("reject");
    expect(shotUsability({ ...base, insight: ins({ noSubject: true }) }).status).toBe("reject");
    expect(shotUsability({ ...base, insight: ins({ focus: "missed" }) }).status).toBe("reject");
    const rig = shotUsability({ ...base, insight: ins({ rig: true }) });
    expect(rig.status).toBe("caution");
    expect(rig.reasons.join(" ")).toMatch(/rig visible/);
    expect(shotUsability(base).status).toBe("good");
    // Bokeh read as lights: caution, not reject.
    expect(shotUsability({ ...base, sharpness: 7.8, insight: ins({ gear: true }) } as Shot).status).toBe("caution");
  });
});

describe("Figma motion to seekable CSS", () => {
  it("makes loops finite and fills every animation", () => {
    expect(normalizeAnimationValue("pulse 0.8s ease-in-out 1s infinite", 3)).toEqual(["pulse 0.8s ease-in-out 1s 4 both", expect.stringMatching(/finite/)]);
    expect(normalizeAnimationValue("a 500ms cubic-bezier(0.16, 1, 0.3, 1) forwards, b 1s linear", 2)[0]).toBe("a 500ms cubic-bezier(0.16, 1, 0.3, 1) both, b 1s linear both");
    expect(normalizeAnimationCss(".x{animation-iteration-count: infinite; animation-fill-mode: forwards}", 2).css).toBe(".x{animation-iteration-count: 2; animation-fill-mode: both}");
  });

  it("extracts keyframes and rules from a nested response with code fences, and maps selectors", () => {
    const response = {
      nodes: [{ id: "1:2", name: "Card" }],
      snippets: {
        css: "```css\n@keyframes card-in { 0% { opacity: 0 } 100% { opacity: 1 } }\n.frame-12 { animation: card-in 0.6s ease-out 0.2s; }\n```",
        extra: "@keyframes card-in { 0% { opacity: 0 } 100% { opacity: 1 } }\n@keyframes orphan { to { opacity: 0 } }",
      },
    };
    const r = figmaMotionToCss(JSON.stringify(response), { duration: 3, selectorMap: { ".frame-12": '[data-name="card"]' } });
    expect(r.keyframes).toEqual(["card-in", "orphan"]);
    expect(r.rules).toBe(1);
    expect(r.css).toMatch(/\[data-name="card"\] \{ animation: card-in 0\.6s ease-out 0\.2s both; \}/);
    expect(r.warnings.join(" ")).toMatch(/orphan is not applied/);
    expect(figmaMotionToCss({ text: "nothing" }, { duration: 2 }).warnings.join(" ")).toMatch(/no CSS @keyframes/);
  });
});

describe("title library", () => {
  it("ships the style templates with their fields", () => {
    const ids = listTemplates().map((t) => t.id);
    for (const id of ["pop-lines", "kinetic-stack", "tilt-tag", "chip-label", "stamp-badge", "speech-bubble", "end-card"]) expect(ids).toContain(id);
    const pop = listTemplates().find((t) => t.id === "pop-lines")!;
    expect(Object.keys(pop.params)).toEqual(expect.arrayContaining(["text", "position", "accent3", "ink"]));
  });
});
