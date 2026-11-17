// OpenEdit Studio event bus: a tiny in-process pub/sub that tools emit into
// and the studio server (or a forwarder to another process's studio) listens to.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export type TargetKind = "file" | "clip" | "timeline" | "media" | "caption" | "range";

export interface StudioTarget {
  kind: TargetKind;
  label: string;
  path?: string;
  start?: number;
  end?: number;
  /** CSS selector for the injectable overlay (/overlay.js) on arbitrary pages. */
  selector?: string;
}

export interface TimelineCut {
  start: number;
  end: number;
  reason: string;
  label?: string;
}

export interface StudioMediaItem {
  path: string;
  title?: string;
  kind?: "video" | "image" | "audio" | "caption" | "data" | "other";
  license?: string;
  source?: string;
  url?: string;
}

interface Base {
  /** Milliseconds since epoch; filled in by emitStudio. */
  at?: number;
  /** Monotonic sequence number; filled in by emitStudio. */
  seq?: number;
}

export type StudioEvent = Base &
  (
    | { type: "session"; session: string; version?: string; pid?: number }
    | { type: "tool_start"; id: string; tool: string; title: string; args?: string; target?: StudioTarget }
    | { type: "progress"; id?: string; fraction?: number; detail?: string }
    | { type: "tool_end"; id: string; tool: string; ok: boolean; summary?: string; outputs?: string[]; ms?: number }
    | { type: "log"; level?: "info" | "warn" | "error"; message: string }
    | {
        type: "timeline";
        plan?: { id?: string; source: string; duration: number; keep: { start: number; end: number }[]; cuts: TimelineCut[] };
        applied?: boolean;
        captions?: { start: number; end: number; text: string }[];
        zooms?: { start: number; end: number; scale: number }[];
        clips?: { path: string; at: number; duration?: number; track?: number }[];
      }
    | { type: "media"; items: StudioMediaItem[] }
  );

export type StudioListener = (evt: StudioEvent) => void;

const listeners = new Set<StudioListener>();
let seq = 0;

export const SESSION_ID = randomBytes(4).toString("hex");

/** Publish an event to every listener. Never throws. */
export function emitStudio(evt: StudioEvent): StudioEvent {
  const full = { ...evt, at: evt.at ?? Date.now(), seq: ++seq } as StudioEvent;
  for (const l of listeners) {
    try {
      l(full);
    } catch {
      /* a broken listener must never break a tool */
    }
  }
  return full;
}

export function onStudio(listener: StudioListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current tool call, so deep engine code can report progress without plumbing ids. */
const callContext = new AsyncLocalStorage<{ id: string; tool: string }>();

export function runInToolContext<T>(ctx: { id: string; tool: string }, fn: () => T): T {
  return callContext.run(ctx, fn);
}

/** Report progress (0..1, or undefined for indeterminate) for the tool call in progress. */
export function reportProgress(fraction: number | undefined, detail?: string): void {
  const ctx = callContext.getStore();
  emitStudio({ type: "progress", id: ctx?.id, fraction: fraction === undefined ? undefined : Math.max(0, Math.min(1, fraction)), detail });
}

export function studioLog(message: string, level: "info" | "warn" | "error" = "info"): void {
  emitStudio({ type: "log", level, message });
}

export function newCallId(): string {
  return randomBytes(5).toString("hex");
}
