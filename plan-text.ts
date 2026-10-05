/**
 * Plan text parsing: the pure, I/O-free half of the old `buildIR`.
 *
 * This module reads structure out of a validated milestone file:
 * - the `Goal:` line
 * - task checkboxes, their ids, titles and implied depth
 * - completion requirement bullets
 * - the optional `Execution order:` declaration
 * - the context sections that turn into the objective's Scope/Out of scope/Constraints
 *
 * Syntax problems (a malformed task id, a duplicate, an empty title) are values, not
 * throws. Everything about size and pi-goal semantics (task count, depth, contract
 * length, mode) belongs to ir.ts.
 *
 * Message strings are copied verbatim from the M3 adapter because the migrated probes
 * and the recorded evidence match on them.
 */

import { fail, ok, reject, type Result, type RejectReason } from "./types.ts";

export type ParsedTask = { id: string; title: string; depth: number };

export type ParsedPlan = {
  /** The raw plan text; hashed later as the source fingerprint. */
  text: string;
  /** The trimmed `Goal: ...` line. */
  goalLine: string;
  tasks: ParsedTask[];
  /** Requirement bullets normalized to `CR-<nn> <text>`. */
  requirements: string[];
  /** The raw value after `Execution order:`, or null when the line is absent. */
  executionOrder: string | null;
  /** `Scope: ... | Out of scope: ... | Constraints: ...`, empty when no section matches. */
  context: string;
};

/** A task id with no sub-steps, e.g. `T-01`. */
export const TASK_ID_RE = /^T-\d{2,3}(\.\d+)*$/;

const CHECKBOX_RE = /^[-*]\s*\[[ xX]\]\s+(\S+)\s*(.*)$/;
const REQUIREMENT_RE = /^[-*]\s*(CR-\d{2,3})\s*:\s*(.+)$/;
const GOAL_RE = /^Goal:\s*\S/;
const EXECUTION_ORDER_RE = /^Execution order:\s*(\S.*)$/im;

/**
 * The three context sections that survive into the objective, in the order they are
 * emitted. Headings are matched case-insensitively and exactly (no H3 sub-structure).
 */
const CONTEXT_SECTIONS: Array<[heading: string, label: string]> = [
  ["## scope", "Scope"],
  ["## out of scope", "Out of scope"],
  ["## risks / constraints", "Constraints"],
];

function contextText(lines: string[]): string {
  const out: string[] = [];
  for (const [heading, label] of CONTEXT_SECTIONS) {
    const start = lines.findIndex((l) => l.trim().toLowerCase() === heading);
    if (start < 0) continue;
    const end = lines.findIndex((l, j) => j > start && /^##\s+/.test(l));
    const body = lines
      .slice(start + 1, end < 0 ? undefined : end)
      .map((l) => l.trim().replace(/^[-*]\s+/, ""))
      .filter((l) => l && !/^(Scope:|\[)/.test(l));
    if (body.length) out.push(`${label}: ${body.join(" ")}`);
  }
  return out.join(" | ");
}

/**
 * Parse a plan's text into structure. Returns a typed rejection when the text is not a
 * recognizable milestone file at all.
 */
export function parsePlanText(text: string): Result<ParsedPlan, RejectReason> {
  const lines = text.split("\n");

  const goalLine = lines.find((l) => GOAL_RE.test(l));
  if (goalLine === undefined) {
    return fail(reject("missing-goal-line", "PLAN.md has no 'Goal: <outcome>' line."));
  }

  const tasks: ParsedTask[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const box = CHECKBOX_RE.exec(line);
    if (!box) continue;
    const id = box[1] ?? "";
    const title = (box[2] ?? "").trim();
    if (/^(M|S)-/.test(id)) {
      return fail(
        reject("milestone-or-story-id", `'${id}' is a milestone/story id, not an executable task.`),
      );
    }
    if (!TASK_ID_RE.test(id)) {
      return fail(reject("invalid-task-id", `'${id}' is not a valid task id (T-<nn> or T-<nn>.<m>).`));
    }
    if (seen.has(id)) return fail(reject("duplicate-task-id", `Duplicate task id '${id}'.`));
    seen.add(id);
    if (!title) return fail(reject("empty-task-title", `Task '${id}' has no title.`));
    tasks.push({ id, title, depth: id.split(".").length - 1 });
  }

  const requirements: string[] = [];
  for (const line of lines) {
    const cr = REQUIREMENT_RE.exec(line);
    if (cr) requirements.push(`${cr[1]} ${(cr[2] ?? "").trim()}`);
  }

  const orderMatch = EXECUTION_ORDER_RE.exec(text);
  const executionOrder = orderMatch?.[1]?.trim() ?? null;

  return ok({
    text,
    goalLine: goalLine.trim(),
    tasks,
    requirements,
    executionOrder,
    context: contextText(lines),
  });
}

/** The task ids that are referenced as parents by at least one sub-task. */
export function referencedParents(tasks: ParsedTask[]): Set<string> {
  const parents = new Set<string>();
  for (const t of tasks) if (t.depth > 0) parents.add(t.id.split(".")[0] ?? "");
  return parents;
}