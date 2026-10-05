/**
 * Message construction for the two things the adapter says to the agent:
 * the handoff instruction, and the rejection notice.
 *
 * Strings are byte-for-byte the M3 adapter's: the migrated probes and the recorded
 * evidence assert on their wording, and the handoff text is a contract with the model
 * (it dictates create_goal then set_goal_tasks then pause). Treat as frozen.
 */

import type { GoalIR } from "./types.ts";

/**
 * The approved-plan handoff. The numbered steps are the instruction the agent follows
 * verbatim; the prohibitions exist because a created-but-unpaused goal auto-continues
 * and would begin work before the user sees the task list.
 */
export function buildHandoffMessage(ir: GoalIR): string {
  const taskLines = ir.tasks
    .map((t) => `- ${t.id} — ${t.title}${t.parentId ? ` (parent_id: "${t.parentId}")` : ""}`)
    .join("\n");
  return [
    "A Plannotator plan has been approved. Create the pi-goal for it exactly as translated below.",
    "",
    "This is an approved user request. Use two steps, in order (create_goal returns terminate:true,",
    "so set_goal_tasks only runs on the continuation turn):",
    "  1. create_goal with objective and mode only.",
    "  2. set_goal_tasks with the task list and block_completion: true — a confirmation dialog appears;",
    "     the user must confirm it. Do not preselect for them.",
    "  3. update_goal({status: \"paused\"}) immediately after the task list is applied, BEFORE doing any",
    "     work. pi-goal auto-continues; pausing hands control back to the user. This is a handoff, not",
    "     an execution: do not run any task, test, or audit for this goal.",
    "",
    "Before step 1, if another goal is open in .pi/goals that does not belong to this plan, STOP:",
    "report that goal (id, status, mode, objective title, activePath) and ask the user to choose",
    "/goal-focus, /goal-unfocus, /goal-clear, or to proceed. Do not create a second goal until they answer.",
    "",
    "Do not reinterpret the plan. Do not invent tasks. Do not skip tasks. Do not rename ids.",
    "Do not create another goal. Do not execute any task now — this step only creates the goal.",
    "If creation or task application fails, STOP and report the exact tool output. Do not retry with",
    "another creation path (/goal-direct, /sisyphus-direct, /goal drafting).",
    "",
    "Objective (pass verbatim):",
    ir.objective,
    "",
    "Mode: " + ir.mode,
    "block_completion: true",
    "",
    "Tasks (ids, titles, parent_id are explicit):",
    taskLines,
    "",
    ir.changeSummary ? `Reviewer note (pass as change_summary, not into the objective): ${ir.changeSummary}` : "",
    "",
    "Completion requirements live in the objective's single-line 'Verification contract:'. Do not move",
    "them into per-task verification_contract fields.",
    "",
    "After creation, verify with get_goal that objective, task ids, parent-child links, verification",
    "contract and block_completion match this message, then reply with a one-line summary.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * The rejection notice. `planPath` is null when the event never identified a plan file.
 */
export function buildRejectionMessage(planPath: string | null, reason: string): string {
  return [
    "M3 adapter rejected PLAN.md.",
    "",
    `Plan:   ${planPath ?? "(unresolved)"}`,
    `Reason: ${reason}`,
    "Effect: No message was sent. No pi-goal goal was created.",
    "Fix:    Correct the plan file, re-validate, and resubmit through Plannotator.",
  ].join("\n");
}

/** The one-line session notification: the first three lines of a longer report. */
export function summarizeForNotice(text: string): string {
  return text.split("\n").slice(0, 3).join(" ");
}