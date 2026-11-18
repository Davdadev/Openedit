/**
 * Smart b-roll choice: for each spoken phrase that would benefit from a cutaway, rank shots
 * from the user's footage library by how literally they show what is being said (Vision labels
 * and file names vs the words, with light lemmatisation and synonyms), visual quality, motion
 * appropriate to the speech energy, duration fit, continuity with neighbouring picks, and never
 * reusing a shot. Pure and deterministic; exported for tests.
 */
import type { Transcript, Word } from "../../hosts/types.js";
import { stem } from "../../media/search.js";
import { basename, extname } from "node:path";
import { cosine, paletteSimilarity } from "./shots.js";
import { type Shot, shotVector } from "./analyze.js";

export interface Phrase {
  text: string;
  start: number;
  end: number;
  words: Word[];
}

/** Words that never carry a picture. */
const STOP = new Set(
  (
    "a an and the of in on at to for with by from or is are was were be been being this that these those it its as into over under " +
    "i me my mine we us our you your he him his she her they them their there here what which who whom whose when where why how " +
    "not no yes so but if then than too very just also only really quite much many more most some any all each every both either " +
    "do does did done doing have has had having can could would should will shall may might must am " +
    "get gets got make makes made say says said tell told show shows showed want wants wanted like likes need needs needed " +
    "know knows think thinks thing things way ways going go goes went come comes came take takes took give gives gave use used " +
    "one two three four five first second third today now again just because about out up down off well even still back " +
    "something someone anything everything nothing important point mean means means meant called call kind sort lot lots " +
    "hi hello okay ok yeah um uh oh name work here able " +
    // Abstract words that read as nouns but never as pictures.
    "capacity focal version example level element design information access structure structured common imagine probably " +
    "complete contain related relate conclude facilitate quick quickly demonstrate wait alert empty means building build " +
    "important elements format copy open opening percent number numbers part parts problem idea reason fact case"
  ).split(/\s+/),
);

/** Concept groups: any member matches any other (weight 0.7). Vision identifiers included. */
const GROUPS: string[][] = [
  ["computer", "laptop", "pc", "notebook", "keyboard", "computer_keyboard", "key", "keys", "typing", "type", "screen", "monitor", "display", "consumer_electronics", "electronics", "desktop", "software", "digital"],
  ["book", "textbook", "library", "bookshelf", "shelf", "page", "read", "reading", "reader", "literature", "printed_page", "publication", "novel", "chapter", "libro"],
  ["document", "pdf", "file", "paper", "printed_page", "page", "text", "form", "print", "printed", "printing", "word", "sign"],
  ["braille", "blind", "visually", "impaired", "disability", "disabled", "accessible", "accessibility", "blindenbibliotheek"],
  ["listen", "hear", "aloud", "headphone", "headphones", "microphone"],
  ["ocean", "sea", "wave", "water", "beach", "shore", "coast", "liquid", "surf", "underwater"],
  ["city", "urban", "street", "traffic", "building", "skyscraper", "downtown", "cityscape", "road", "car", "vehicle"],
  ["forest", "tree", "trees", "wood", "woods", "nature", "plant", "foliage", "jungle", "harvester", "timber"],
  ["sky", "cloud", "sun", "sunset", "sunrise", "blue_sky", "weather"],
  ["space", "rocket", "launch", "astronaut", "nasa", "planet", "mars", "moon", "star", "celestial_body", "night_sky", "satellite", "orbit", "rover", "landsat"],
  ["crowd", "audience", "team", "meeting", "conference", "office", "colleague", "people"],
  ["food", "cook", "cooking", "kitchen", "meal", "eat", "restaurant"],
  ["money", "cash", "coin", "finance", "bank", "payment", "price"],
  ["phone", "smartphone", "mobile", "app", "cellphone"],
  ["clock", "time", "watch", "hour", "minute", "schedule", "consuming"],
  ["map", "world", "globe", "country", "travel", "flight", "airplane", "aircraft", "airport"],
  ["school", "student", "teacher", "classroom", "education", "learn", "study", "university"],
  ["factory", "industry", "machine", "manufacture", "production", "expo"],
  ["war", "attack", "destruction", "damage", "rubble", "explosion"],
];

/** Labels that are true of almost everything: weak evidence. */
const GENERIC = new Set(["people", "adult", "structure", "outdoor", "indoor", "material", "art", "decoration", "clothing", "interior_room", "conveyance", "consumer", "wood_processed", "wood", "processed", "liquid", "container"]);

const norm = (w: string) => stem(w.toLowerCase().replace(/[^a-z0-9_]/g, ""));
const GROUP_OF = new Map<string, number[]>();
GROUPS.forEach((g, i) => {
  for (const w of g) {
    for (const k of new Set([norm(w), ...w.split("_").map(norm)])) {
      if (!k) continue;
      const list = GROUP_OF.get(k) ?? [];
      if (!list.includes(i)) list.push(i);
      GROUP_OF.set(k, list);
    }
  }
});

/** Words with a known picture (in a concept group), minus sounds: usable as stock search terms. */
export function isVisualWord(w: string): boolean {
  const g = GROUP_OF.get(w);
  return !!g && !["listen", "hear", "aloud"].includes(w);
}

/** Content keywords of a phrase (stemmed, no stop words, no numbers). */
export function keywords(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[\p{L}][\p{L}'-]*/gu) ?? []) {
    const w = raw.replace(/'s$/, "").replace(/[^a-z-]/g, "");
    for (const part of w.split("-")) {
      if (part.length < 3 || STOP.has(part)) continue;
      const s = norm(part);
      if (s.length >= 3 && !STOP.has(s) && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

/** Terms describing a shot: Vision labels (with confidence) and its file-name words (weaker, literal only). */
export function shotTerms(shot: Shot): Map<string, { v: number; label: boolean }> {
  const m = new Map<string, { v: number; label: boolean }>();
  const add = (k: string, v: number, label: boolean) => {
    if (!k || k.length < 2) return;
    const cur = m.get(k);
    if (!cur || v > cur.v) m.set(k, { v, label: label || !!cur?.label });
  };
  for (const l of shot.labels) {
    const w = GENERIC.has(l.label) ? 0.3 : 1;
    add(norm(l.label), l.conf * w, true);
    for (const p of l.label.split("_")) add(norm(p), l.conf * (GENERIC.has(p) ? 0.3 : 0.85) * w, true);
  }
  const stemName = basename(shot.file, extname(shot.file))
    .replace(/-(wikimedia|nasa|pexels|pixabay|openverse|unsplash|freesound|jamendo)-.*$/i, "")
    .replace(/\d+/g, " ");
  for (const k of keywords(stemName.replace(/[-_]+/g, " "))) if (!FILE_NOISE.has(k)) add(k, 0.6, false);
  return m;
}

/** File-name words that say nothing about the picture. */
const FILE_NOISE = new Set(["video", "clip", "footage", "stock", "test", "sample", "example", "press", "kit", "campaign", "final", "edit", "copy", "untitled", "export", "render", "take", "scene", "shot", "cam", "camera", "img", "mov", "dsc", "gopro"].map((w) => stem(w)));

export interface KeywordMatch {
  score: number;
  /** Phrase words that matched, with what. */
  hits: { word: string; via: string; value: number }[];
}

/**
 * How literally a shot shows the phrase: probabilistic OR of the top term matches. Direct matches
 * count fully; synonyms (concept groups) count 0.7 and only against Vision labels, never file names.
 */
export function keywordMatch(words: string[], terms: Map<string, { v: number; label: boolean }>): KeywordMatch {
  const hits: KeywordMatch["hits"] = [];
  for (const w of words) {
    let best = 0;
    let via = "";
    const direct = terms.get(w);
    if (direct) {
      best = direct.v;
      via = w;
    }
    const groups = GROUP_OF.get(w) ?? [];
    if (groups.length) {
      for (const [t, { v, label }] of terms) {
        if (t === w || !label) continue;
        const tg = GROUP_OF.get(t) ?? [];
        if (tg.some((g) => groups.includes(g)) && v * 0.7 > best) {
          best = v * 0.7;
          via = t;
        }
      }
    }
    if (best > 0.05) hits.push({ word: w, via, value: Math.round(best * 1000) / 1000 });
  }
  hits.sort((a, b) => b.value - a.value || a.word.localeCompare(b.word));
  let miss = 1;
  for (const h of hits.slice(0, 3)) miss *= 1 - Math.min(0.95, h.value);
  return { score: Math.round((1 - miss) * 1000) / 1000, hits };
}

/** Split a transcript into sentence-ish phrases (on punctuation and pauses). */
export function phrasesFromTranscript(t: Transcript, o: { maxLen?: number; pause?: number } = {}): Phrase[] {
  const maxLen = o.maxLen ?? 8;
  const pause = o.pause ?? 0.6;
  const out: Phrase[] = [];
  for (const seg of t.segments) {
    const ws = seg.words.length ? seg.words : [{ text: seg.text, start: seg.start, end: seg.end }];
    let cur: Word[] = [];
    const flush = () => {
      if (!cur.length) return;
      out.push({ text: cur.map((w) => w.text.trim()).join(" ").replace(/\s+([,.!?;:])/g, "$1"), start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
      cur = [];
    };
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (cur.length && (w.start - cur[cur.length - 1].end > pause || w.end - cur[0].start > maxLen)) flush();
      cur.push(w);
      if (/[.!?;]$/.test(w.text.trim()) || (/,$/.test(w.text.trim()) && w.end - cur[0].start > 3)) flush();
    }
    flush();
  }
  return out;
}

export interface BrollOptions {
  /** Minimum confidence to propose (default 0.45). */
  minConfidence?: number;
  /** Allow shots with prominent faces (default false: no strangers talking). */
  allowFaces?: boolean;
  /** Hold range (s), default 2–5. */
  minHold?: number;
  maxHold?: number;
  /** Do not cover the first N seconds (let the speaker introduce themselves). Default 4. */
  skipStart?: number;
  /** Minimum gap between cutaways (s), default 3. */
  minGap?: number;
  /** Maximum share of the timeline covered by b-roll (default 0.4). */
  maxCoverage?: number;
  /** A-roll palette, for colour continuity. */
  arollPalette?: Shot["palette"];
  /** Candidates returned per phrase (default 3). */
  candidates?: number;
}

export interface BrollCandidate {
  shot: Shot;
  confidence: number;
  keyword: KeywordMatch;
  quality: number;
  motionFit: number;
  durationFit: number;
  continuity: number;
  sourceIn: number;
  sourceOut: number;
  reasons: string[];
}

export interface BrollProposal {
  phrase: Phrase;
  keywords: string[];
  /** Timeline time to cut to b-roll and how long to hold it. */
  at: number;
  duration: number;
  pick?: BrollCandidate;
  alternatives: BrollCandidate[];
  /** Why nothing was picked (no literal match / below confidence). */
  skipped?: string;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Cut to the b-roll a beat before its strongest keyword is said (literal to the line). */
function cutPoint(p: Phrase, c: { keyword: KeywordMatch }): number {
  const word = p.words.find((w) => c.keyword.hits.some((h) => keywords(w.text)[0] === h.word));
  return r3(Math.max(p.start, (word?.start ?? p.start) - 0.15));
}

/** Visual quality 0..1 and reasons. */
export function shotQuality(s: Shot, allowFaces: boolean): { q: number; why: string[] } {
  const why: string[] = [];
  let q = 1;
  if (s.sharpness !== undefined) {
    if (s.sharpness < 15) {
      q *= 0.45;
      why.push("soft");
    } else if (s.sharpness < 30) q *= 0.8;
  }
  if (s.exposure === "dark" || s.exposure === "crushed") {
    q *= 0.7;
    why.push(s.exposure);
  } else if (s.exposure === "clipped") q *= 0.85;
  if (!allowFaces && s.faces.count > 0 && (s.shotSize === "close-up" || s.shotSize === "extreme-close-up" || s.shotSize === "medium")) {
    q *= 0.35;
    why.push(`${s.shotSize} face (a stranger talking reads as a new speaker)`);
  }
  if (s.camera === "handheld" && s.shake > 0.15) {
    q *= 0.8;
    why.push("shaky");
  }
  // Title cards, credits and infographics read as "document"/"screenshot": not footage.
  const graphic = s.labels.find((l) => l.label === "screenshot" && l.conf >= 0.3);
  if (graphic) {
    q *= s.exposure === "dark" || s.exposure === "crushed" ? 0.15 : 0.5;
    why.push("graphic / title card, not footage");
  }
  if (s.motion > 0.12) {
    q *= 0.7;
    why.push("very busy");
  }
  // A chroma key (green / blue screen) is an unfinished plate, never finished b-roll.
  if (isChromaKey(s.palette)) {
    q *= 0.05;
    why.push("green/blue screen plate (needs keying), not usable as b-roll");
  }
  return { q: r3(q), why };
}

/** True when one flat, saturated key green or key blue covers a large part of the frame. */
export function isChromaKey(palette: Shot["palette"]): boolean {
  return palette.some(({ rgb: [r, g, b], weight }) => {
    if (weight < 0.25) return false;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    const keyGreen = g === max && g > 120 && g - Math.max(r, b) > 70 && sat > 0.55;
    const keyBlue = b === max && b > 120 && b - Math.max(r, g) > 80 && sat > 0.6 && g > r;
    return keyGreen || keyBlue;
  });
}

/** Motion appropriate to speech energy: fast talk tolerates movement, slow talk wants calm. */
export function motionFit(s: Shot, wordsPerSec: number): number {
  const energy = Math.min(1, Math.max(0, (wordsPerSec - 1.5) / 2.5));
  const m = Math.min(1, s.motion / 0.05) * 0.6 + (s.camera !== "static" && s.camera !== "handheld" ? 0.4 : 0);
  // Calm speech wants ~0.3 movement; energetic speech ~0.7.
  const target = 0.3 + 0.4 * energy;
  return r3(1 - Math.min(1, Math.abs(m - target)));
}

export function durationFit(shotDur: number, want: number): number {
  const usable = shotDur - 0.3;
  if (usable >= want) return 1;
  if (usable < 1.2) return 0;
  return r3(usable / want);
}

/**
 * Rank library shots for each phrase and choose greedily (best confidence first) without reuse.
 */
export function rankBroll(phrases: Phrase[], library: Shot[], o: BrollOptions = {}): BrollProposal[] {
  const minConf = o.minConfidence ?? 0.45;
  const minHold = o.minHold ?? 2;
  const maxHold = o.maxHold ?? 5;
  const skipStart = o.skipStart ?? 4;
  const minGap = o.minGap ?? 3;
  const nCand = o.candidates ?? 3;
  const termsOf = new Map(library.map((s) => [s.id, shotTerms(s)]));
  const vecOf = new Map(library.map((s) => [s.id, shotVector(s)]));
  const total = phrases.length ? phrases[phrases.length - 1].end - phrases[0].start : 0;

  const base: BrollProposal[] = phrases.map((p) => {
    const kws = keywords(p.text);
    const dur = p.end - p.start;
    const want = Math.min(maxHold, Math.max(minHold, dur));
    const wps = p.words.length / Math.max(0.5, dur);
    const cands: BrollCandidate[] = [];
    for (const s of library) {
      const km = keywordMatch(kws, termsOf.get(s.id)!);
      if (km.score <= 0) continue;
      const { q, why } = shotQuality(s, !!o.allowFaces);
      const mf = motionFit(s, wps);
      const df = durationFit(s.duration, want);
      if (df === 0) continue;
      const cont = o.arollPalette ? paletteSimilarity(s.palette, o.arollPalette) : 0.5;
      const conf = km.score * (0.3 + 0.45 * q + 0.1 * mf + 0.1 * df + 0.05 * cont);
      const hold = Math.min(want, s.duration - 0.3);
      // Start a little into the shot (skip the head), but use the move for camera moves.
      const sin = s.start + Math.min(0.3, Math.max(0, (s.duration - hold) / 2)) + (s.camera === "static" ? Math.max(0, (s.duration - hold) / 2 - 0.3) : 0);
      const reasons = [
        `matches ${km.hits.slice(0, 3).map((h) => (h.via === h.word ? `"${h.word}"` : `"${h.word}"~${h.via}`)).join(", ")}`,
        `${s.camera}${s.camera === "static" ? "" : " move"}, ${s.duration.toFixed(1)}s`,
        ...why,
      ];
      cands.push({ shot: s, confidence: r3(conf), keyword: km, quality: q, motionFit: mf, durationFit: df, continuity: r3(cont), sourceIn: r3(sin), sourceOut: r3(sin + hold), reasons });
    }
    cands.sort((a, b) => b.confidence - a.confidence || a.shot.id.localeCompare(b.shot.id));
    return { phrase: p, keywords: kws, at: cands[0] ? cutPoint(p, cands[0]) : r3(p.start), duration: r3(want), alternatives: cands, skipped: undefined };
  });

  // Greedy selection over (proposal, candidate) pairs, best first, with no reuse and spacing.
  const used = new Set<string>();
  const chosen: { i: number; c: BrollCandidate }[] = [];
  const pairs = base.flatMap((p, i) => p.alternatives.map((c) => ({ i, c })));
  pairs.sort((a, b) => b.c.confidence - a.c.confidence || a.i - b.i || a.c.shot.id.localeCompare(b.c.shot.id));
  let covered = 0;
  for (const { i, c } of pairs) {
    const p = base[i];
    if (p.pick || used.has(c.shot.id)) continue;
    if (c.confidence < minConf) break;
    const at = cutPoint(p.phrase, c);
    if (at < skipStart) continue;
    const dur = Math.min(p.duration, c.sourceOut - c.sourceIn);
    const clash = chosen.some(({ i: j }) => {
      const q = base[j];
      return at < q.at + q.duration + minGap && q.at < at + dur + minGap;
    });
    if (clash) continue;
    if (total > 0 && (covered + dur) / total > (o.maxCoverage ?? 0.4)) continue;
    // Continuity with already-chosen neighbours (feature print), small bonus/penalty for the reasons list.
    const prev = chosen.map(({ i: j, c: cj }) => ({ d: Math.abs(base[j].at - at), cj })).sort((a, b) => a.d - b.d)[0];
    if (prev && prev.d < 30) {
      const sim = cosine(vecOf.get(prev.cj.shot.id), vecOf.get(c.shot.id));
      if (sim > 0.5) c.reasons.push(`visually consistent with ${prev.cj.shot.id}`);
      if (prev.cj.shot.file === c.shot.file && prev.d < 10) c.reasons.push("same source as the previous cutaway");
    }
    p.pick = c;
    p.at = at;
    p.duration = r3(dur);
    used.add(c.shot.id);
    covered += dur;
    chosen.push({ i, c });
  }
  for (const p of base) {
    p.alternatives = p.alternatives.filter((c) => c !== p.pick).slice(0, nCand);
    if (!p.pick) {
      const best = p.alternatives[0];
      p.skipped = !p.keywords.length
        ? "no visual nouns"
        : !best
          ? `nothing in the library shows ${p.keywords.slice(0, 4).join("/")}`
          : best.confidence < minConf
            ? `best match ${best.shot.id} only ${best.confidence} (< ${minConf})`
            : p.at < skipStart
              ? "opening line stays on the speaker"
              : "spacing / coverage limit or shot already used";
    }
  }
  return base;
}
