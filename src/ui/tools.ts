// Tools that exist for the inline views (but are useful to the model too).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { invertRanges, mergeCuts, summarizePlan } from "../engine/cutplan.js";
import type { Cut, CutPlan } from "../hosts/types.js";
import { loadPlan, savePlan } from "../mcp/plans.js";
import { cutPlanView } from "./data.js";
import { uiMeta } from "./resources.js";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** New plan = old plan minus restored cuts plus extra manual cuts (no re-analysis). */
export function revisePlan(plan: CutPlan, restore: number[], add: { start: number; end: number; label?: string }[] = []): CutPlan {
  const drop = new Set(restore);
  const kept: Cut[] = plan.cuts.filter((_, i) => !drop.has(i));
  const extra: Cut[] = add
    .map((c) => ({ start: Math.max(0, c.start), end: Math.min(plan.duration, c.end), reason: "manual" as const, ...(c.label ? { label: c.label } : {}) }))
    .filter((c) => c.end > c.start);
  const cuts = mergeCuts([...kept, ...extra]).map((c) => ({ ...c, start: Math.round(c.start * 1000) / 1000, end: Math.round(c.end * 1000) / 1000 }));
  const keep = invertRanges(cuts, plan.duration).map((k) => ({ start: Math.round(k.start * 1000) / 1000, end: Math.round(k.end * 1000) / 1000 }));
  return { source: plan.source, duration: plan.duration, keep, cuts };
}

export function registerUiTools(server: McpServer): void {
  server.registerTool(
    "revise_plan",
    {
      title: "Revise a cut plan",
      description:
        "Adjust an existing cut plan without re-analysing: restore (un-cut) cuts by their 0-based index in the plan and/or add manual cut ranges (source seconds). Returns a NEW planId; apply that one. Used by the inline cut-plan view when the user toggles cuts.",
      inputSchema: {
        planId: z.string(),
        restore: z.array(z.number().int().min(0)).optional().describe("0-based indices of cuts to keep in the edit instead of removing"),
        addCuts: z
          .array(z.object({ start: z.number().min(0), end: z.number().min(0), label: z.string().optional() }))
          .optional()
          .describe("Extra source-time ranges to remove"),
      },
      _meta: uiMeta("cut-plan"),
    },
    async ({ planId, restore, addCuts }) => {
      try {
        const stored = loadPlan(planId);
        const plan = revisePlan(stored.plan, restore ?? [], addCuts ?? []);
        const next = savePlan(plan, { ...stored.options, revisedFrom: planId }, stored.transcriptPath);
        const sum = summarizePlan(plan);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `planId: ${next.id} (revised from ${planId}: ${restore?.length ?? 0} cut(s) restored, ${addCuts?.length ?? 0} added)\n` +
                `${r2(sum.originalDuration)}s -> ${r2(sum.editedDuration)}s (saves ${r2(sum.timeSaved)}s, ${sum.percentSaved}%), ${plan.cuts.length} cuts. ` +
                `Apply with apply_cuts {planId: "${next.id}"}.`,
            },
          ],
          structuredContent: { ...(await cutPlanView(next)) },
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );
}
