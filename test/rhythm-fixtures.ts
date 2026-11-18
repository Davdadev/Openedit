// Synthetic music with exact ground truth for the rhythm tests (beats, downbeats, sections).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SongPart {
  bars: number;
  /** 0..1 overall level. */
  level?: number;
  kick?: boolean;
  snare?: boolean;
  hats?: boolean;
  bass?: boolean;
  /** Snare roll getting denser (build). */
  roll?: boolean;
}

export interface SynthOptions {
  bpm: number;
  /** Beats per bar (4 or 3). */
  meter?: number;
  /** Offbeat 8th position as a fraction of the beat: 0.5 straight, ~0.62 swing. */
  swing?: number;
  bars?: number;
  parts?: SongPart[];
  sr?: number;
  /** Silence before the first beat (s). */
  lead?: number;
  /** Ring-out after the last bar (s). */
  tail?: number;
  seed?: number;
}

export interface SynthSong {
  samples: Float32Array;
  sr: number;
  beats: number[];
  downbeats: number[];
  /** Part start times (s). */
  partStarts: number[];
  duration: number;
}

/** Drum + bass groove with known beat / downbeat / section times. */
export function synthSong(o: SynthOptions): SynthSong {
  const sr = o.sr ?? 22050;
  const meter = o.meter ?? 4;
  const P = 60 / o.bpm;
  const swing = o.swing ?? 0.5;
  const lead = o.lead ?? 0.5;
  const parts: SongPart[] = o.parts ?? [{ bars: o.bars ?? 16, kick: true, snare: true, hats: true, bass: true }];
  const totalBars = parts.reduce((a, p) => a + p.bars, 0);
  const duration = lead + totalBars * meter * P + (o.tail ?? 2);
  const out = new Float32Array(Math.ceil(duration * sr));
  let seed = o.seed ?? 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  };
  const add = (t0: number, len: number, f: (t: number) => number) => {
    const a = Math.round(t0 * sr);
    const n = Math.round(len * sr);
    for (let i = 0; i < n && a + i < out.length; i++) out[a + i] += f(i / sr);
  };
  const kick = (t0: number, g: number) => {
    let ph = 0;
    add(t0, 0.35, (t) => {
      ph += (2 * Math.PI * (45 + 110 * Math.exp(-t * 35))) / sr;
      return g * 0.9 * Math.sin(ph) * Math.exp(-t * 9);
    });
  };
  const snare = (t0: number, g: number) => add(t0, 0.25, (t) => g * (0.45 * rnd() * Math.exp(-t * 18) + 0.3 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 20)));
  const hat = (t0: number, g: number) => {
    let prev = 0;
    add(t0, 0.06, (t) => {
      const x = rnd();
      const y = x - prev;
      prev = x;
      return g * 0.25 * y * Math.exp(-t * 70);
    });
  };
  const crash = (t0: number, g: number) => {
    let prev = 0;
    add(t0, 1.2, (t) => {
      const x = rnd();
      const y = x - prev;
      prev = x;
      return g * 0.12 * y * Math.exp(-t * 3);
    });
  };
  const roots = [55, 73.42, 65.41, 49];
  const bassNote = (t0: number, len: number, f: number, g: number) =>
    add(t0, len, (t) => g * 0.28 * (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(4 * Math.PI * f * t)) * Math.min(1, t / 0.005) * Math.exp(-t * 0.8) * Math.min(1, (len - t) / 0.02));

  const beats: number[] = [];
  const downbeats: number[] = [];
  const partStarts: number[] = [];
  let bar = 0;
  for (const p of parts) {
    const g = p.level ?? 1;
    partStarts.push(lead + bar * meter * P);
    for (let b = 0; b < p.bars; b++, bar++) {
      const t0 = lead + bar * meter * P;
      downbeats.push(t0);
      if (p.bass !== false) bassNote(t0, meter * P, roots[bar % roots.length], g);
      if (p.kick !== false && p.snare !== false) crash(t0, g);
      for (let k = 0; k < meter; k++) {
        const t = t0 + k * P;
        beats.push(t);
        if (p.kick !== false && (k === 0 || (meter === 4 && k === 2))) kick(t, g);
        if (p.snare !== false && (meter === 4 ? k % 2 === 1 : k > 0)) snare(t, g * 0.9);
        if (p.hats !== false) {
          hat(t, g * 0.8);
          hat(t + swing * P, g * 0.6);
        }
        if (p.roll) {
          const frac = b / p.bars;
          const sub = frac < 0.5 ? 2 : 4;
          for (let s = 1; s < sub; s++) snare(t + (s * P) / sub, g * (0.3 + 0.6 * frac));
        }
      }
    }
  }
  // Gentle limiter.
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0.95) for (let i = 0; i < out.length; i++) out[i] *= 0.95 / peak;
  return { samples: out, sr, beats, downbeats, partStarts, duration };
}

/** 16-bit PCM mono WAV. */
export function writeWav(path: string, samples: Float32Array, sr: number): string {
  mkdirSync(dirname(path), { recursive: true });
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  writeFileSync(path, buf);
  return path;
}

/** Encode a WAV to AAC .m4a with ffmpeg (exercises the real decode path). */
export function toM4a(wav: string, out: string): string {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-c:a", "aac", "-b:a", "160k", out]);
  return out;
}

/** mir_eval-style beat F-measure: one-to-one matches within +-tol seconds. */
export function beatF(est: number[], ref: number[], tol = 0.07): { f: number; p: number; r: number } {
  const used = new Set<number>();
  let hit = 0;
  for (const e of est) {
    let best = -1;
    let bd = Infinity;
    ref.forEach((r, i) => {
      const d = Math.abs(r - e);
      if (d <= tol && d < bd && !used.has(i)) [best, bd] = [i, d];
    });
    if (best >= 0) {
      used.add(best);
      hit++;
    }
  }
  const p = est.length ? hit / est.length : 0;
  const r = ref.length ? hit / ref.length : 0;
  return { f: p + r ? (2 * p * r) / (p + r) : 0, p, r };
}

/**
 * Clap + flash sync source: black video with a one-frame white flash and a 1 kHz 20 ms tone burst
 * at each event time (frame-aligned), over a quiet noise floor. Returns the event times.
 */
export function makeClapFlash(path: string, o: { duration: number; events: number[]; fps?: number; size?: string }): number[] {
  const fps = o.fps ?? 25;
  const ev = o.events.map((t) => Math.round(t * fps) / fps);
  const frames = ev.map((t) => Math.round(t * fps));
  const enable = frames.map((f) => `eq(n,${f})`).join("+");
  const tone = ev.map((t) => `between(t,${t.toFixed(4)},${(t + 0.02).toFixed(4)})`).join("+");
  mkdirSync(dirname(path), { recursive: true });
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=black:s=${o.size ?? "320x180"}:r=${fps}:d=${o.duration}`,
    "-f", "lavfi", "-i", `aevalsrc='0.7*sin(2*PI*1000*t)*(${tone})+0.003*(random(0)-0.5)':s=48000:d=${o.duration}`,
    "-vf", `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='${enable}'`,
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", path,
  ]);
  return ev;
}

/** Flash times (s) in a video: frames whose mean luma is > 128. */
export function detectFlashes(path: string, fps: number): number[] {
  const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path, "-vf", `fps=${fps},scale=16:9,format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 28 });
  const out: number[] = [];
  const px = 16 * 9;
  for (let f = 0; f * px < raw.length; f++) {
    let s = 0;
    for (let i = 0; i < px; i++) s += raw[f * px + i];
    if (s / px > 128) out.push(f / fps);
  }
  return out;
}

/** Tone-burst onsets (s) in a file's audio: 2 ms energy rising over -30 dBFS after >= 50 ms quiet. */
export function detectClaps(path: string): number[] {
  const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  const x = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
  const hop = 96;
  const out: number[] = [];
  let quiet = 0;
  for (let i = 0; i + hop <= x.length; i += hop) {
    let s = 0;
    for (let k = i; k < i + hop; k++) s += x[k] * x[k];
    const db = 10 * Math.log10(s / hop + 1e-12);
    if (db > -30) {
      if (quiet >= 25) out.push(i / 48000);
      quiet = 0;
    } else quiet++;
  }
  return out;
}
