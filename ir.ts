/**
 * IR assembly: turn a parsed plan into the goal IR the handoff message describes.
 *
 * This module owns every pi-goal limit, because these are the rules that make pi-goal
 * accept or refuse the creation payload:
 * - at most MAX_TASKS tasks
 * - subtask nesting of at most MAX_DEPTH
 * - objective and verification contract length caps
 * - the two supported modes, and the numbered-step requirement of sisyphus
 *
 * Rejection is returned as a `Result`, never thrown, so the caller owns logging and
 * notification. Message strings match the M3 adapter verbatim: the migrated probes and
 * the recorded evidence assert on them.
 */

import { createHash } from "node:crypto";
import { fail, ok, reject, type GoalIR, type Result, type RejectReason, type TaskIR } from "./types.ts";
import type { ParsedPlan } from "./plan-text.ts";

export const MAX_TASKS = 50;
export const MAX_DEPTH = 1;
export const MAX_OBJECTIVE = 1400;
export const MAX_CONTRACT = 700;

/** Short, stable fingerprint of the exact plan text that was approved. */
export function planSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export type PlanSourceInput = { planPath: string };

/** A sisyphus objective must carry numbered steps; pi-goal rejects it otherwise. */
const NUMBERED_STEP_RE = /\b\d{1,2}\s*[).:]|\bstep\s*\d+/i;

export function buildGoalIR(
  parsed: ParsedPlan,
  source: PlanSourceInput,
): Result<GoalIR, RejectReason> {
  const { tasks, requirements, context, goalLine, executionOrder, text } = parsed;

  if (tasks.length === 0) {
    return fail(reject("no-tasks", "PLAN.md has no '- [ ] T-<nn>' task checkbox."));
  }

  const tooDeep = tasks.find((t) => t.depth > MAX_DEPTH);
  if (tooDeep !== undefined) {
    return fail(
      reject(
        "task-too-deep",
        `Task ${tooDeep.id} exceeds pi-goal supported subtask depth (${MAX_DEPTH}). Flatten it or split the parent.`,
      ),
    );
  }

  if (tasks.length > MAX_TASKS) {
    return fail(
      reject("too-many-tasks", `PLAN.md has ${tasks.length} tasks; pi-goal allows at most ${MAX_TASKS}.`),
    );
  }

  const ids = new Set(tasks.map((t) => t.id));
  const irTasks: TaskIR[] = [];
  for (const t of tasks) {
    if (t.depth === 0) {
      irTasks.push({ id: t.id, title: t.title });
      continue;
    }
    const parentId = t.id.split(".")[0] ?? "";
    if (!ids.has(parentId)) {
      return fail(reject("missing-parent", `Task '${t.id}' references missing parent '${parentId}'.`));
    }
    irTasks.push({ id: t.id, title: t.title, parentId });
  }

  if (requirements.length === 0) {
    return fail(reject("no-requirements", "PLAN.md has no '- CR-<nn>: <text>' requirement."));
  }

  const contract = `Verification contract: ${requirements.join("; ")}`;
  const objective = [goalLine, context, contract].filter(Boolean).join("\n\n");

  if (objective.length > MAX_OBJECTIVE) {
    return fail(
      reject(
        "objective-too-long",
        `Objective would be ${objective.length} chars; the safe adapter limit is ${MAX_OBJECTIVE}. Shorten Scope/Risks prose in PLAN.md.`,
      ),
    );
  }

  if (contract.length > MAX_CONTRACT) {
    return fail(
      reject(
        "contract-too-long",
        `Verification contract line is ${contract.length} chars; the safe adapter limit is ${MAX_CONTRACT}. Shorten the CR texts.`,
      ),
    );
  }

  const mode: GoalIR["mode"] = executionOrder !== null && /^strict\b/i.test(executionOrder) ? "sisyphus" : "regular";

  if (executionOrder !== null && !/^strict\b/i.test(executionOrder)) {
    return fail(
      reject(
        "bad-execution-order",
        `PLAN.md declares 'Execution order: ${executionOrder}' but only 'strict' (sisyphus) is supported; omit the line for regular mode.`,
      ),
    );
  }

  if (mode === "sisyphus" && !NUMBERED_STEP_RE.test(objective)) {
    return fail(
      reject(
        "sisyphus-needs-steps",
        "PLAN.md declares 'Execution order: strict' but the objective has no numbered steps; pi-goal rejects that sisyphus objective.",
      ),
    );
  }

  return ok({
    objective,
    mode,
    tasks: irTasks,
    verificationContract: contract,
    blockCompletion: true,
    source: { planPath: source.planPath, planSha256: planSha256(text) },
  });
}

/** Attach the reviewer's note without touching the objective. */
export function withChangeSummary(ir: GoalIR, feedback: string | undefined): GoalIR {
  if (feedback === undefined || feedback === "") return ir;
  return { ...ir, changeSummary: feedback.slice(0, 240) };
}