/**
 * Multicam: sync angles by audio, work out who is speaking when, and switch angles the way an
 * editor cuts an interview:
 *  - open on the widest angle, then go to whoever speaks;
 *  - cut in the pause just before a new speaker (or a beat after they start when they overlap);
 *  - never hold a shot shorter than `minShot`; no ping-pong on quick exchanges (go wide instead);
 *  - during a long answer: a listener reaction or a wide "reset" at a sentence end every ~20 s;
 *  - alternate a speaker's own angles (medium/close) for variety, not on every sentence.
 *
 * Speaker activity per angle comes from isolated mics (per-angle level relative to the others)
 * when the mics really are isolated, else from face presence + mouth movement (Vision landmarks).
 * planMulticam is pure (unit tested); buildMulticam does the analysis.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { CaptionCue, MultiTrackEdit, Transcript } from "../hosts/types.js";
import { decodeAudio, SYNC_RATE, syncAngles, type SyncResult } from "./analysis/sync.js";
import { visionMouths } from "./analysis/vision.js";
import { run } from "./exec.js";
import { probe } from "./media.js";
import { paths } from "./paths.js";

export type AngleRole = "wide" | "medium" | "close";

export interface AngleInfo {
  index: number;
  role: AngleRole;
  /** Person this angle frames (angles of the same person share it); undefined for wides. */
  person?: number;
  /** Median height of the main face (0..1), 0 when none. */
  faceH: number;
  /** Master time of this angle's t=0. */
  offset: number;
  duration: number;
}

export interface MulticamRules {
  /** Shortest shot (s). Default 1.8. */
  minShot?: number;
  /** Cut this long after a speaker starts when there is no pause to cut in (s). Default 0.3. */
  cutDelay?: number;
  /** Longest stretch on one speaker's close shots before a reaction / wide reset (s). Default 20. */
  maxCloseRun?: number;
  /** Hold for a wide reset (s). Default 3. */
  wideHold?: number;
  /** Hold for a listener reaction (s). Default 2. */
  reactionHold?: number;
  /** Turns shorter than this in a quick exchange go to the wide instead of ping-ponging (s). Default 2.5. */
  pingPong?: number;
  /** Switch between a speaker's own angles after this long (s), at a sentence end. Default 12. */
  varietyAfter?: number;
  /** Use reaction cutaways (default true). */
  reactions?: boolean;
  /** Open on the wide for this long (s). Default 3. */
  openWide?: number;
}

export interface PlanInput {
  angles: AngleInfo[];
  /** Bin size (s) and master time of bin 0. */
  dt: number;
  t0: number;
  /** Speech present (audio source) per bin. */
  speech: boolean[];
  /** Speaker activity per PERSON per bin (0..1). */
  activity: number[][];
  /** Master times where sentences end (cut points). */
  sentenceEnds: number[];
  /** Master range to cut. */
  start: number;
  end: number;
}

export interface Decision {
  start: number;
  end: number;
  angle: number;
  why: string;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Who speaks in each bin (person index or -1), with hysteresis and short-run removal. */
export function speakerTrack(input: Pick<PlanInput, "speech" | "activity" | "dt">, o: { minTurn?: number; threshold?: number } = {}): number[] {
  const n = input.speech.length;
  const P = input.activity.length;
  const thr = o.threshold ?? 0.3;
  const raw: number[] = new Array(n).fill(-1);
  let prev = -1;
  for (let i = 0; i < n; i++) {
    if (!input.speech[i]) {
      raw[i] = -1;
      continue;
    }
    let best = -1;
    let bv = 0;
    let second = 0;
    for (let p = 0; p < P; p++) {
      const v = input.activity[p][i] ?? 0;
      if (v > bv) {
        second = bv;
        bv = v;
        best = p;
      } else if (v > second) second = v;
    }
    if (best >= 0 && bv >= thr && (prev < 0 || best === prev || bv > (input.activity[prev][i] ?? 0) * 1.25)) prev = best;
    else if (prev < 0 && best >= 0 && bv >= thr) prev = best;
    raw[i] = prev;
  }
  // Remove turns shorter than minTurn (merge into the previous speaker).
  const minBins = Math.max(1, Math.round((o.minTurn ?? 0.8) / input.dt));
  const out = [...raw];
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && out[j] === out[i]) j++;
    if (out[i] >= 0 && j - i < minBins) {
      const fill = i > 0 ? out[i - 1] : j < n ? out[j] : -1;
      for (let k = i; k < j; k++) out[k] = fill;
    }
    i = j;
  }
  return out;
}

/** Turns: runs of one speaker (silences inside a speaker's run are absorbed). */
export function speakerTurns(track: number[], dt: number, t0: number): { person: number; start: number; end: number; firstWord: number }[] {
  const turns: { person: number; start: number; end: number; firstWord: number }[] = [];
  for (let i = 0; i < track.length; i++) {
    const p = track[i];
    if (p < 0) continue;
    const last = turns[turns.length - 1];
    const t = t0 + i * dt;
    if (last && last.person === p) last.end = t + dt;
    else turns.push({ person: p, start: t, end: t + dt, firstWord: t });
  }
  return turns;
}

/** Build the switched edit (master-time decisions). Pure. */
export function planMulticam(input: PlanInput, rules: MulticamRules = {}): Decision[] {
  const minShot = rules.minShot ?? 1.8;
  const cutDelay = rules.cutDelay ?? 0.3;
  const maxRun = rules.maxCloseRun ?? 20;
  const wideHold = rules.wideHold ?? 3;
  const reactionHold = rules.reactionHold ?? 2;
  const pingPong = rules.pingPong ?? 2.5;
  const variety = rules.varietyAfter ?? 12;
  const openWide = rules.openWide ?? 3;
  const { angles, start, end } = input;
  const covers = (a: AngleInfo, s: number, e: number) => a.offset <= s + 1e-6 && a.offset + a.duration >= e - 1e-6;
  const widest = (s: number, e: number, not?: number) =>
    angles
      .filter((a) => covers(a, s, e) && a.index !== not)
      .sort((x, y) => (x.role === "wide" ? 0 : 1) - (y.role === "wide" ? 0 : 1) || x.faceH - y.faceH || x.index - y.index)[0];
  const hasWide = angles.some((a) => a.role === "wide");
  const people = [...new Set(angles.map((a) => a.person).filter((p): p is number => p !== undefined))];
  // A pseudo person for footage without detectable speakers: every non-wide angle (or all).
  const anglesOf = (p: number) => {
    const list = p >= 0 ? angles.filter((a) => a.person === p) : angles.filter((a) => a.role !== "wide");
    return (list.length ? list : angles).sort((x, y) => y.faceH - x.faceH || x.index - y.index);
  };

  let turns = speakerTurns(speakerTrack(input, { minTurn: 0.8 }), input.dt, input.t0)
    .map((t) => ({ ...t, start: Math.max(t.start, start), end: Math.min(t.end, end) }))
    .filter((t) => t.end - t.start > 0.2);
  if (!turns.length) turns = [{ person: -1, start, end, firstWord: start }];
  // Turns own the time up to the next turn (silences belong to the last speaker).
  const spans = turns.map((t, i) => ({ ...t, until: i + 1 < turns.length ? turns[i + 1].start : end }));
  const sentenceEnds = [...input.sentenceEnds].sort((a, b) => a - b);
  const nextSentenceEnd = (after: number, before: number) => sentenceEnds.find((t) => t >= after && t <= before);

  const events: { t: number; angle: number; why: string }[] = [];
  const opening = widest(start, Math.min(end, start + openWide));
  if (opening) events.push({ t: start, angle: opening.index, why: hasWide ? "open on the wide" : "open on the widest angle" });
  const rot = new Map<number, number>();
  const pick = (p: number, s: number, e: number, avoid?: number) => {
    const list = anglesOf(p).filter((a) => covers(a, s, e));
    if (!list.length) return widest(s, e)?.index;
    const choices = list.length > 1 && avoid !== undefined ? list.filter((a) => a.index !== avoid) : list;
    const k = ((rot.get(p) ?? -1) + 1) % choices.length;
    rot.set(p, k);
    return choices[k].index;
  };

  let current = opening?.index ?? -1;
  for (let k = 0; k < spans.length; k++) {
    const turn = spans[k];
    const prev = spans[k - 1];
    const gap = prev ? turn.start - prev.end : 0;
    let cut: number;
    let how: string;
    if (k === 0 && opening && hasWide) {
      cut = Math.max(start + openWide, turn.start + cutDelay);
      how = "after the opening wide";
    } else if (gap >= 0.25) {
      cut = turn.start - Math.min(0.2, gap / 2);
      how = "in the pause just before they speak";
    } else {
      cut = turn.start + cutDelay;
      how = `a beat (${cutDelay}s) after they start`;
    }
    if (k === 0 && !hasWide) cut = start + (opening ? Math.min(openWide, Math.max(0, turn.start + cutDelay - start)) : 0);
    if (cut >= turn.until - 0.5) continue;
    const len = turn.end - turn.start;
    const quick = len < pingPong && !!prev && prev.end - prev.start < pingPong && prev.person !== turn.person;
    let target: number | undefined;
    let why: string;
    if (quick && hasWide) {
      target = widest(cut, turn.until)?.index;
      why = "quick exchange: stay wide instead of ping-ponging";
    } else {
      target = pick(turn.person, cut, turn.until, prev && prev.person === turn.person ? current : undefined);
      why = turn.person >= 0 ? `speaker ${turn.person + 1}: cut ${how}` : "no clear speaker: alternate angles at sentence ends";
    }
    if (target === undefined) continue;
    if (target !== current) {
      events.push({ t: cut, angle: target, why });
      current = target;
    }
    // Long turn: variety (own angles), listener reactions and wide resets at sentence ends.
    let lastChange = cut;
    let closeSince = cut;
    let reactionNext = rules.reactions !== false;
    for (let guard = 0; guard < 1000; guard++) {
      const due = Math.min(lastChange + variety, closeSince + maxRun);
      if (due + minShot >= turn.until) break;
      const at = nextSentenceEnd(due, turn.until - minShot);
      if (at === undefined) break;
      const onWidest = current === widest(at, Math.min(turn.until, at + 1))?.index;
      if (onWidest) closeSince = Math.max(closeSince, at);
      const longRun = !onWidest && at >= closeSince + maxRun;
      if (longRun) {
        const listeners = angles.filter((a) => a.person !== undefined && a.person !== turn.person && a.role !== "wide" && covers(a, at, at + reactionHold));
        let alt: number | undefined;
        let hold = 0;
        let altWhy = "";
        if (reactionNext && listeners.length && turn.person >= 0) {
          alt = listeners.sort((x, y) => y.faceH - x.faceH || x.index - y.index)[0].index;
          hold = reactionHold;
          altWhy = "listener reaction during a long answer";
        } else {
          const w = widest(at, at + wideHold);
          // Already on the widest framing: that is the reset.
          if (w && w.index !== current && w.faceH < (angles.find((a) => a.index === current)?.faceH ?? 1) * 0.85) {
            alt = w.index;
            hold = wideHold;
            altWhy = "wide reset after a long close stretch";
          }
        }
        reactionNext = !reactionNext;
        if (alt !== undefined && at + hold + minShot <= turn.until) {
          events.push({ t: at, angle: alt, why: altWhy });
          const back = pick(turn.person, at + hold, turn.until, current) ?? current;
          events.push({ t: at + hold, angle: back, why: "back to the speaker" });
          current = back;
          lastChange = closeSince = at + hold;
          continue;
        }
        closeSince = at;
        lastChange = at;
        continue;
      }
      const cur = angles.find((a) => a.index === current);
      // Only a real change of size reads as intentional; near-identical framings look like a jump cut.
      const own = anglesOf(turn.person).filter(
        (a) => a.index !== current && covers(a, at, Math.min(turn.until, at + variety)) && (!cur || a.role !== cur.role || Math.abs(Math.log((a.faceH || 0.01) / (cur.faceH || 0.01))) > 0.18),
      );
      if (own.length) {
        current = own[0].index;
        events.push({ t: at, angle: current, why: "change shot size on the same speaker (at a sentence end)" });
        if (current === widest(at, Math.min(turn.until, at + 1))?.index) closeSince = at;
      }
      lastChange = at;
    }
  }

  if (process.env.OPENEDIT_DEBUG_MULTICAM) process.stderr.write(`events ${JSON.stringify(events.map((e) => [r3(e.t), e.angle, e.why.slice(0, 20)]))}\nends ${JSON.stringify(sentenceEnds)}\n`);
  // Events -> contiguous shots; drop no-op switches; enforce the minimum shot length.
  events.sort((a, b) => a.t - b.t);
  const shots: Decision[] = [];
  for (const e of events) {
    const t = Math.min(end, Math.max(start, e.t));
    const last = shots[shots.length - 1];
    if (last && last.angle === e.angle) continue;
    if (last) last.end = t;
    shots.push({ start: t, end, angle: e.angle, why: e.why });
  }
  if (!shots.length) {
    const w = widest(start, end) ?? angles[0];
    shots.push({ start, end, angle: w.index, why: "single angle" });
  }
  const merged: Decision[] = [];
  for (const d of shots) {
    if (d.end - d.start <= 1e-3) continue;
    const last = merged[merged.length - 1];
    if (last && last.angle === d.angle) {
      last.end = d.end;
      continue;
    }
    // A too-short previous shot: hold it longer by starting this one later.
    if (last && last.end - last.start < minShot) {
      const shift = minShot - (last.end - last.start);
      if (d.end - (d.start + shift) >= minShot) {
        last.end += shift;
        d.start += shift;
      } else {
        last.end = d.end;
        continue;
      }
    }
    merged.push({ ...d });
  }
  const tail = merged[merged.length - 1];
  if (merged.length > 1 && tail.end - tail.start < minShot) {
    merged[merged.length - 2].end = tail.end;
    merged.pop();
  }
  // Coverage: an angle that stops (or starts) recording inside a shot hands over to the widest angle that is rolling.
  const final: Decision[] = [];
  for (const d of merged) {
    const a = angles.find((x) => x.index === d.angle);
    if (a && covers(a, d.start, d.end)) {
      final.push(d);
      continue;
    }
    const aStart = a ? a.offset : Infinity;
    const aEnd = a ? a.offset + a.duration : -Infinity;
    const ok = a && aEnd - d.start >= minShot && aStart <= d.start + 1e-6;
    if (ok) {
      final.push({ ...d, end: aEnd });
      const w = widest(aEnd, d.end);
      if (w) final.push({ start: aEnd, end: d.end, angle: w.index, why: `angle ${d.angle + 1} stops recording: widest available` });
      else final[final.length - 1].end = d.end;
    } else {
      const w = widest(d.start, d.end);
      final.push(w ? { ...d, angle: w.index, why: `${d.why} (preferred angle not recording: widest available)` } : d);
    }
  }
  const out: Decision[] = [];
  for (const d of final) {
    const last = out[out.length - 1];
    if (last && last.angle === d.angle) last.end = d.end;
    else out.push({ ...d });
  }
  void people;
  return out.map((d) => ({ ...d, start: r3(d.start), end: r3(d.end) }));
}

/** Decisions (master time) -> MultiTrackEdit (record time from `start`, single audio clip from the audio source). */
export function decisionsToEdit(decisions: Decision[], angles: AngleInfo[], files: string[], audioSource: number, start: number, end: number, o: { fps?: number; width?: number; height?: number; name?: string } = {}): MultiTrackEdit {
  const off = (i: number) => angles.find((a) => a.index === i)?.offset ?? 0;
  return {
    name: o.name,
    fps: o.fps,
    width: o.width,
    height: o.height,
    sources: files.map((p, i) => ({ path: p, name: basename(p), role: angles.find((a) => a.index === i)?.role })),
    segments: decisions.map((d) => ({ source: d.angle, srcIn: r3(d.start - off(d.angle)), srcOut: r3(d.end - off(d.angle)), recIn: r3(d.start - start), recOut: r3(d.end - start), note: d.why })),
    audio: [{ source: audioSource, srcIn: r3(start - off(audioSource)), srcOut: r3(end - off(audioSource)), recIn: 0 }],
  };
}

/** Map captions from audio-source time to record time through the edit's audio clips. */
export function remapCaptions(cues: CaptionCue[], edit: MultiTrackEdit, audioSource = edit.audio[0]?.source): CaptionCue[] {
  const out: CaptionCue[] = [];
  for (const c of cues) {
    for (const a of edit.audio.filter((x) => x.source === audioSource)) {
      const s = Math.max(c.start, a.srcIn);
      const e = Math.min(c.end, a.srcOut);
      if (e - s < 0.05) continue;
      const shift = a.recIn - a.srcIn;
      out.push({
        ...c,
        start: r3(s + shift),
        end: r3(e + shift),
        words: c.words?.filter((w) => w.start >= a.srcIn && w.end <= a.srcOut).map((w) => ({ ...w, start: r3(w.start + shift), end: r3(w.end + shift) })),
      });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

// ---------------------------------------------------------------------------
// Analysis (I/O)
// ---------------------------------------------------------------------------

/** RMS level (dB) per bin. */
export function levels(x: Float32Array, rate: number, dt: number): Float64Array {
  const hop = Math.round(rate * dt);
  const n = Math.floor(x.length / hop);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) s += x[j] * x[j];
    out[i] = 10 * Math.log10(s / hop + 1e-10);
  }
  return out;
}

function percentile(v: ArrayLike<number>, p: number): number {
  const s = Array.from(v).filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return 0;
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

/** Mouth-movement activity per sample: |Δ openness| smoothed over ~0.6 s, normalised to 0..1 by the 90th percentile. */
export function mouthActivity(open: (number | null)[], step: number): number[] {
  const d = open.map((v, i) => (v === null || i === 0 || open[i - 1] === null ? 0 : Math.abs(v - (open[i - 1] as number))));
  const w = Math.max(1, Math.round(0.6 / step));
  const sm = d.map((_, i) => {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(d.length - 1, i + w); j++, c++) s += d[j];
    return s / c;
  });
  const p90 = percentile(sm, 0.9) || 1;
  return sm.map((v, i) => (open[i] === null ? 0 : Math.min(1, v / p90)));
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] / n;
    mb += b[i] / n;
  }
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    ab += (a[i] - ma) * (b[i] - mb);
    aa += (a[i] - ma) ** 2;
    bb += (b[i] - mb) ** 2;
  }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

/** Correlation of two angles' activity over the bins where both see a face. */
export function sharedCorrelation(act: number[][], valid: boolean[][], i: number, j: number): number {
  const a: number[] = [];
  const b: number[] = [];
  for (let k = 0; k < act[i].length; k++) {
    if (valid[i][k] && valid[j][k]) {
      a.push(act[i][k]);
      b.push(act[j][k]);
    }
  }
  return a.length >= 20 ? pearson(a, b) : 0;
}

export interface MulticamAnalysis {
  files: string[];
  sync: SyncResult[];
  angles: AngleInfo[];
  isolatedMics: boolean;
  plan: PlanInput;
  decisions: Decision[];
  edit: MultiTrackEdit;
  warnings: string[];
}

/**
 * Full multicam build: sync, per-angle face/mouth analysis (and mic levels), speaker activity,
 * then planMulticam. `transcript` (audio-source time) supplies sentence ends; else pauses do.
 */
export async function buildMulticam(
  files: string[],
  o: { audioSource?: number; rules?: MulticamRules; transcript?: Transcript; sampleFps?: number; maxOffset?: number; isolatedMics?: boolean; name?: string } = {},
): Promise<MulticamAnalysis> {
  if (files.length < 2) throw new Error("multicam needs at least two angles");
  const warnings: string[] = [];
  const sync = await syncAngles(files, { maxOffset: o.maxOffset });
  sync.forEach((s, i) => {
    if (i && s.confidence < 0.3) warnings.push(`angle ${i + 1} (${basename(files[i])}) synced with low confidence ${s.confidence}: check the offset by eye`);
    if (s.driftPpm !== undefined && Math.abs(s.driftPpm) > 40) warnings.push(`angle ${i + 1} drifts ${s.driftPpm} ppm against angle 1 (resample/conform it for long takes)`);
  });
  const infos = await Promise.all(files.map((f) => probe(f)));
  const dt = 0.2;
  const step = 1 / (o.sampleFps ?? 5);
  // Faces + mouths per angle.
  const work = mkdtempSync(join(paths.tmp(), "multicam-"));
  const faceSeries: { t: number; faces: number[][] }[][] = [];
  try {
    for (let i = 0; i < files.length; i++) {
      const dir = join(work, `a${i}`);
      mkdirSync(dir, { recursive: true });
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", files[i], "-an", "-sn", "-vf", `fps=${1 / step},scale=320:-2`, "-q:v", "5", join(dir, "%06d.jpg")], { timeoutMs: 60 * 60_000 });
      const rows = (await visionMouths(dir)) ?? [];
      if (!rows.length) warnings.push("Vision unavailable: speaker detection falls back to mic levels only");
      faceSeries.push(rows.map((r, k) => ({ t: k * step, faces: r.faces })));
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  // Angle roles.
  const angles: AngleInfo[] = files.map((_, i) => {
    const s = faceSeries[i];
    const main = s.map((x) => x.faces.reduce((m, f) => Math.max(m, f[3]), 0));
    const counts = s.map((x) => x.faces.filter((f) => f[3] > 0.05).length);
    const faceH = percentile(main.filter((v) => v > 0), 0.5);
    const multi = percentile(counts, 0.5) >= 2;
    const role: AngleRole = multi || (faceH > 0 && faceH < 0.14) ? "wide" : faceH >= 0.33 ? "close" : "medium";
    return { index: i, role, faceH: Math.round(faceH * 1000) / 1000, offset: sync[i].offset, duration: infos[i].duration };
  });
  if (!angles.some((a) => a.role === "wide")) {
    // The widest framing acts as the wide.
    const w = [...angles].sort((a, b) => a.faceH - b.faceH)[0];
    if (w.faceH === 0) w.role = "wide";
  }
  // Master range: the audio source's coverage.
  const audioSource = o.audioSource ?? 0;
  const aInfo = angles[audioSource];
  const start = Math.max(aInfo.offset, Math.min(...angles.map((a) => a.offset)));
  const end = Math.min(aInfo.offset + aInfo.duration, Math.max(...angles.map((a) => a.offset + a.duration)));
  const n = Math.max(0, Math.floor((end - start) / dt));
  // Mic levels in master time.
  const sig = await Promise.all(files.map((f) => decodeAudio(f)));
  const lv = sig.map((x) => levels(x, SYNC_RATE, dt));
  const at = (i: number, master: number) => {
    const k = Math.floor((master - angles[i].offset) / dt);
    return k >= 0 && k < lv[i].length ? lv[i][k] : Number.NaN;
  };
  const src = Array.from({ length: n }, (_, k) => at(audioSource, start + k * dt));
  const floor = percentile(src, 0.15);
  const speech = src.map((v) => Number.isFinite(v) && v > floor + 9);
  // Isolated mics? Per-angle level relative to the mean swings a lot when each mic hears mostly its own speaker.
  let isolated = o.isolatedMics;
  if (isolated === undefined) {
    const diffs: number[] = [];
    for (let k = 0; k < n; k += 2) {
      if (!speech[k]) continue;
      const vals = files.map((_, i) => at(i, start + k * dt)).filter(Number.isFinite);
      if (vals.length < 2) continue;
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      diffs.push(...vals.map((v) => v - mean));
    }
    const sd = Math.sqrt(diffs.reduce((s, v) => s + v * v, 0) / Math.max(1, diffs.length) - (diffs.reduce((s, v) => s + v, 0) / Math.max(1, diffs.length)) ** 2);
    isolated = sd > 6;
  }
  // Activity per angle (0..1) in master bins.
  const valid: boolean[][] = files.map(() => new Array<boolean>(n).fill(true));
  const angleAct: number[][] = files.map((_, i) => {
    const s = faceSeries[i];
    const open = s.map((x) => {
      const f = x.faces.filter((q) => q[4] >= 0).sort((a, b) => b[3] - a[3])[0];
      return f ? f[4] : null;
    });
    const act = mouthActivity(open, step);
    return Array.from({ length: n }, (_, k) => {
      const tl = start + k * dt - angles[i].offset;
      const j = Math.round(tl / step);
      if (!(j >= 0 && j < open.length && open[j] !== null)) valid[i][k] = false;
      let v = j >= 0 && j < act.length ? act[j] : 0;
      if (isolated) {
        const own = at(i, start + k * dt);
        const others = files.map((_, q) => (q === i ? Number.NaN : at(q, start + k * dt))).filter(Number.isFinite);
        const rel = others.length ? own - Math.max(...others) : 0;
        const mic = Math.max(0, Math.min(1, (rel + 3) / 9));
        v = Number.isFinite(own) ? 0.7 * mic + 0.3 * v : v;
      }
      return v;
    });
  });
  // People: non-wide angles whose activity correlates frame the same person.
  let nextPerson = 0;
  for (const a of angles) {
    if (a.role === "wide") continue;
    const same = angles.find((b) => b.person !== undefined && b.index !== a.index && sharedCorrelation(angleAct, valid, a.index, b.index) > 0.45);
    a.person = same ? same.person : nextPerson++;
  }
  const people = Math.max(0, nextPerson);
  const activity = Array.from({ length: people }, (_, p) =>
    Array.from({ length: n }, (_, k) => Math.max(0, ...angles.filter((a) => a.person === p).map((a) => angleAct[a.index][k]))),
  );
  // Sentence ends: transcript (audio-source time) else pauses ≥ 0.35 s in speech.
  let sentenceEnds: number[] = [];
  if (o.transcript) {
    const shift = angles[audioSource].offset;
    for (const seg of o.transcript.segments) {
      for (const w of seg.words) if (/[.!?]$/.test(w.text.trim())) sentenceEnds.push(r3(w.end + shift + 0.05));
      sentenceEnds.push(r3(seg.end + shift + 0.05));
    }
    sentenceEnds = [...new Set(sentenceEnds)].sort((a, b) => a - b);
  } else {
    for (let k = 1; k < n; k++) {
      if (speech[k - 1] && !speech[k]) {
        let j = k;
        while (j < n && !speech[j]) j++;
        if ((j - k) * dt >= 0.35) sentenceEnds.push(r3(start + k * dt + 0.1));
      }
    }
  }
  const plan: PlanInput = { angles, dt, t0: start, speech, activity, sentenceEnds, start, end };
  const decisions = planMulticam(plan, o.rules);
  const v = infos.reduce((m, x) => ((x.width ?? 0) * (x.height ?? 0) > (m.width ?? 0) * (m.height ?? 0) ? x : m), infos[0]);
  const edit = decisionsToEdit(decisions, angles, files, audioSource, start, end, { fps: v.fps, width: v.width, height: v.height, name: o.name });
  if (!people) warnings.push("no faces found in the close angles: cutting on a timer at sentence ends");
  if (process.env.OPENEDIT_DEBUG_MULTICAM) {
    for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) process.stderr.write(`corr ${i}-${j}: ${sharedCorrelation(angleAct, valid, i, j).toFixed(3)}\n`);
  }
  return { files, sync, angles, isolatedMics: !!isolated, plan, decisions, edit, warnings };
}
