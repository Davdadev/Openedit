/**
 * Shot insight from a small LOCAL vision-language model (Ollama; default gemma3:4b).
 *
 * Apple Vision gives labels ("ball", "textile") and feature prints; it cannot tell an editor
 * that the candy is held up by a skewer, that an LED panel is in frame, or that a shot is just
 * grass. A 4B VLM can, in ~2-5 s per frame on Apple silicon, entirely on the machine. Insights
 * are cached per shot and model, so a library is only looked at once.
 *
 * Off when Ollama is not running or the model is not pulled: every caller degrades to the
 * plain analysis. Configure with OLLAMA_HOST and OPENEDIT_VLM_MODEL.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../exec.js";
import { type FootageAnalysis, type Shot, analysisDir } from "./analyze.js";

export interface ShotInsight {
  caption: string;
  subject?: string;
  /** A stick, skewer, wire, string or stand visibly holding the subject. */
  rig: boolean;
  /** Lights, cameras, tripods, cables in frame. */
  gear: boolean;
  hands: boolean;
  /** Nothing of interest: ground, floor, wall, sky, an accidental frame. */
  noSubject: boolean;
  /** Subject focus as the model sees it. */
  focus?: "sharp" | "soft" | "missed";
  /** 1-10 as an advert frame (coarse; use for ranking only). */
  beauty?: number;
  mood?: string;
  model: string;
}

export const DEFAULT_VLM = "gemma3:4b";

/** Small models describe a lawn shot as subject "grass" but leave no_subject false (pure). */
export function isBareSubject(subject: string | undefined): boolean {
  return !!subject && /^(?:(?:some|a|the|patch of|close-up of|dry|green|brown)\s+)*(?:grass|lawn|ground|soil|dirt|floor|wall|sky|clouds?|concrete|pavement|carpet|ceiling|roof)$/i.test(subject.trim());
}

function host(): string {
  const h = process.env.OLLAMA_HOST || "127.0.0.1:11434";
  return h.startsWith("http") ? h.replace(/\/$/, "") : `http://${h}`;
}
export function vlmModel(): string {
  return process.env.OPENEDIT_VLM_MODEL || DEFAULT_VLM;
}

/** Is the local VLM usable? Returns a reason when not (for the tool text). */
export async function insightStatus(): Promise<{ ok: boolean; model: string; reason?: string }> {
  const model = vlmModel();
  try {
    const r = await fetch(`${host()}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { ok: false, model, reason: `Ollama answered ${r.status}` };
    const tags = (await r.json()) as { models?: { name: string }[] };
    const have = (tags.models ?? []).some((m) => m.name === model || m.name === `${model}:latest`);
    return have ? { ok: true, model } : { ok: false, model, reason: `model ${model} not pulled (run: ollama pull ${model})` };
  } catch {
    return { ok: false, model, reason: "Ollama is not running (install from ollama.com, then: ollama pull gemma3:4b)" };
  }
}

const PROMPT = (context?: string) => `Describe this video frame for a film editor${context ? ` working on: ${context}` : ""}. Reply with JSON only:
{"caption": "<what is in the frame, specific, one sentence>",
 "subject": "<main subject, 1-4 words>",
 "rig_visible": <true if a stick, skewer, wire, string or stand is visibly holding the main subject>,
 "equipment_visible": <true if a light panel, LED light, camera, tripod, microphone or cable is visible>,
 "hands_visible": <true if human hands are visible>,
 "no_subject": <true if it is only ground, grass, floor, wall or sky with nothing of interest>,
 "focus": "<sharp|soft|missed> for the main subject",
 "beauty": <1-10 how attractive this frame is as an advert shot>,
 "mood": "<2-4 words>"}`;

/** Parse the model's JSON answer leniently (pure). */
export function parseInsight(text: string, model: string): ShotInsight | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const b = (v: unknown) => v === true || v === "true" || v === "yes";
  const caption = typeof j.caption === "string" ? j.caption.trim() : "";
  if (!caption) return null;
  const focus = typeof j.focus === "string" && ["sharp", "soft", "missed"].includes(j.focus) ? (j.focus as ShotInsight["focus"]) : undefined;
  const beauty = Number(j.beauty);
  const subject = typeof j.subject === "string" ? j.subject.trim() : undefined;
  return {
    caption,
    subject,
    rig: b(j.rig_visible),
    gear: b(j.equipment_visible),
    hands: b(j.hands_visible),
    noSubject: b(j.no_subject) || isBareSubject(subject),
    focus,
    beauty: Number.isFinite(beauty) ? Math.max(1, Math.min(10, Math.round(beauty))) : undefined,
    mood: typeof j.mood === "string" ? j.mood : undefined,
    model,
  };
}

async function askFrame(jpeg: string, model: string, context?: string): Promise<ShotInsight | null> {
  const body = {
    model,
    prompt: PROMPT(context),
    images: [readFileSync(jpeg).toString("base64")],
    format: "json",
    stream: false,
    keep_alive: "10m",
    options: { temperature: 0, num_predict: 200 },
  };
  const r = await fetch(`${host()}/api/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { response?: string };
  return parseInsight(j.response ?? "", model);
}

/**
 * Add `insight` to the shots of these analyses (in place), from the cache or the model. The
 * frame is the shot's middle representative time, re-extracted at 448 px for detail.
 */
export async function addInsights(
  analyses: FootageAnalysis[],
  o: { context?: string; maxShots?: number; minDuration?: number; force?: boolean } = {},
): Promise<{ done: number; cached: number; skipped: number; seconds: number; model: string; reason?: string }> {
  const st = await insightStatus();
  if (!st.ok) return { done: 0, cached: 0, skipped: 0, seconds: 0, model: st.model, reason: st.reason };
  const t0 = Date.now();
  const dir = join(analysisDir(), "insight");
  mkdirSync(dir, { recursive: true });
  let done = 0;
  let cached = 0;
  let skipped = 0;
  const max = o.maxShots ?? 400;
  for (const a of analyses) {
    const cacheFile = join(dir, `${a.key}-${st.model.replace(/[^a-z0-9.]+/gi, "_")}.json`);
    const cache: Record<string, ShotInsight> = existsSync(cacheFile) && !o.force ? safeJson(cacheFile) : {};
    let dirty = false;
    for (const s of a.shots) {
      if (cache[s.id]) {
        s.insight = cache[s.id];
        cached++;
        continue;
      }
      if (s.duration < (o.minDuration ?? 0.4) || done >= max || isBlank(s)) {
        skipped++;
        continue;
      }
      const rep = s.reps[Math.floor(s.reps.length / 2)] ?? s.reps[0];
      const t = rep ? rep.t : (s.start + s.end) / 2;
      const frame = join(dir, `${a.key}-${s.index}.jpg`);
      await run("ffmpeg", ["-v", "error", "-y", "-ss", t.toFixed(3), "-i", a.path, "-frames:v", "1", "-vf", "scale=448:-2", "-q:v", "3", frame], { timeoutMs: 60_000 });
      try {
        const ins = await askFrame(frame, st.model, o.context);
        if (ins) {
          s.insight = ins;
          cache[s.id] = ins;
          dirty = true;
          done++;
        }
      } catch (e) {
        process.stderr.write(`openedit: insight failed for ${s.id}: ${(e as Error).message}\n`);
      }
    }
    if (dirty) writeFileSync(cacheFile, JSON.stringify(cache));
  }
  return { done, cached, skipped, seconds: (Date.now() - t0) / 1000, model: st.model };
}

/** Blank/black/blown shots are rejected without asking the model. */
function isBlank(s: Shot): boolean {
  return s.brightness >= 0.93 || s.brightness <= 0.06 || (s.sharpness !== undefined && s.sharpness < 4);
}

function safeJson(f: string): Record<string, ShotInsight> {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return {};
  }
}

/** Flags worth an editor's attention, in words (pure). */
export function insightFlags(i: ShotInsight | undefined): string[] {
  if (!i) return [];
  const f: string[] = [];
  if (i.rig) f.push("rig visible (stick/stand/wire holding the subject)");
  if (i.gear) f.push("production gear in frame");
  if (i.noSubject) f.push("no subject (ground/wall/sky)");
  if (i.hands) f.push("hands in frame");
  if (i.focus === "missed") f.push("focus missed");
  return f;
}
