import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Root of all OpenEdit state. Override with OPENEDIT_HOME (used by tests). */
export function openeditHome(): string {
  return process.env.OPENEDIT_HOME || join(homedir(), ".openedit");
}

function dir(...parts: string[]): string {
  const p = join(...parts);
  mkdirSync(p, { recursive: true });
  return p;
}

export const paths = {
  home: () => dir(openeditHome()),
  cache: () => dir(openeditHome(), "cache"),
  audioCache: () => dir(openeditHome(), "cache", "audio"),
  transcripts: () => dir(openeditHome(), "cache", "transcripts"),
  /** Whisper models are large; OPENEDIT_MODELS lets tests share the user's model dir. */
  models: () => dir(process.env.OPENEDIT_MODELS || join(openeditHome(), "models")),
  plans: () => dir(openeditHome(), "plans"),
  captions: () => dir(openeditHome(), "captions"),
  renders: () => dir(openeditHome(), "renders"),
  projects: () => dir(openeditHome(), "projects"),
  tmp: () => dir(openeditHome(), "tmp"),
  token: () => join(dir(openeditHome()), "token"),
};
