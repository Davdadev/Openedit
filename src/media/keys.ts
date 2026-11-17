import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../engine/paths.js";

/** API keys OpenEdit's media providers can use. All are free. */
export interface KeySpec {
  env: string;
  provider: string;
  signupUrl: string;
  note: string;
}

export const KEY_SPECS: KeySpec[] = [
  { env: "PEXELS_API_KEY", provider: "Pexels", signupUrl: "https://www.pexels.com/api/new/", note: "free stock video + photos" },
  { env: "PIXABAY_API_KEY", provider: "Pixabay", signupUrl: "https://pixabay.com/api/docs/", note: "free stock video + images (key shown on the docs page once logged in)" },
  { env: "UNSPLASH_ACCESS_KEY", provider: "Unsplash", signupUrl: "https://unsplash.com/oauth/applications", note: "photos (use the app's Access Key)" },
  { env: "FREESOUND_API_KEY", provider: "Freesound", signupUrl: "https://freesound.org/apiv2/apply/", note: "sound effects (API key, token auth)" },
  { env: "JAMENDO_CLIENT_ID", provider: "Jamendo", signupUrl: "https://devportal.jamendo.com/", note: "Creative Commons music (client id)" },
];

export function envFilePath(): string {
  return join(paths.home(), ".env");
}

/** Parse a dotenv-style file: KEY=value, optional quotes, # comments, optional `export `. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.startsWith("#") ? "" : v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

export function readEnvFile(file = envFilePath()): Record<string, string> {
  if (!existsSync(file)) return {};
  try {
    return parseEnv(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** Merge `updates` into ~/.openedit/.env (empty value removes the key) and chmod 600. */
export function writeEnvFile(updates: Record<string, string | undefined>, file = envFilePath()): string {
  const current = readEnvFile(file);
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    if (v === "") delete current[k];
    else current[k] = v;
  }
  const body =
    "# OpenEdit API keys (written by `openedit keys`). Keep this file private.\n" +
    Object.entries(current)
      .map(([k, v]) => `${k}=${/[\s#"']/.test(v) ? JSON.stringify(v) : v}`)
      .join("\n") +
    "\n";
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** Look up a key: process env wins over ~/.openedit/.env. Re-read each call so new keys apply without restart. */
export function getKey(env: string): string | undefined {
  const v = process.env[env]?.trim() || readEnvFile()[env]?.trim();
  return v || undefined;
}

export function maskKey(v: string): string {
  if (v.length <= 8) return "*".repeat(v.length);
  return `${v.slice(0, 4)}${"*".repeat(Math.min(12, v.length - 8))}${v.slice(-4)}`;
}

export interface KeyStatus extends KeySpec {
  set: boolean;
  source?: "env" | "file";
  masked?: string;
}

export function keyStatus(): KeyStatus[] {
  const file = readEnvFile();
  return KEY_SPECS.map((k) => {
    const fromEnv = process.env[k.env]?.trim();
    const v = fromEnv || file[k.env]?.trim();
    return { ...k, set: !!v, source: v ? (fromEnv ? "env" : "file") : undefined, masked: v ? maskKey(v) : undefined };
  });
}
