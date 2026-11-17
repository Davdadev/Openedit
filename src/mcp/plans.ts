import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { CutPlan } from "../hosts/types.js";
import { paths } from "../engine/paths.js";

export interface StoredPlan {
  id: string;
  createdAt: string;
  options: Record<string, unknown>;
  transcriptPath?: string;
  plan: CutPlan;
}

export function planPath(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid plan id "${id}"`);
  return join(paths.plans(), `${id}.json`);
}

export function savePlan(plan: CutPlan, options: Record<string, unknown>, transcriptPath?: string): StoredPlan {
  const stem = basename(plan.source, extname(plan.source)).replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 32) || "plan";
  const id = `${stem}-${randomBytes(3).toString("hex")}`;
  const stored: StoredPlan = { id, createdAt: new Date().toISOString(), options, transcriptPath, plan };
  writeFileSync(planPath(id), JSON.stringify(stored, null, 1));
  return stored;
}

export function loadPlan(id: string): StoredPlan {
  const p = planPath(id);
  if (!existsSync(p)) throw new Error(`No plan with id "${id}" (looked for ${p})`);
  return JSON.parse(readFileSync(p, "utf8")) as StoredPlan;
}
