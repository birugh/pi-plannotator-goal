/**
 * Plan text parsing: the pure, I/O-free half of the old `buildIR`.
 *
 * This module reads structure out of a plan file that conforms to the Universal Adapter
 * Contract v1 (`docs/ADAPTER-CONTRACT.md` is the source of truth for the accepted
 * format):
 * - the `Goal:` line
 * - task checkboxes, their ids, titles and implied depth, only inside `## S-<nn>`
 *   story sections and never inside fenced code blocks
 * - completion requirement bullets
 * - the optional `Execution order:` declaration
 * - the context sections that turn into the objective's Scope/Out of scope/Constraints
 *
 * The parser is deterministic and fail-closed. A checkbox that the contract does not
 * define as a task (in Notes, in a code fence, in an unknown section) is never a task.
 * A checkbox-shaped line that the parser cannot classify is a typed rejection: the
 * adapter stops instead of guessing, and no LLM is ever asked to reinterpret the plan.
 * The full rules live in docs/ADAPTER-CONTRACT.md; this module implements that
 * contract, and `CONTRACT_VERSION` is the version it implements.
 */

import { fail, ok, reject, type Result, type RejectReason } from "./types.ts";

/** The contract version this parser implements. Must match docs/ADAPTER-CONTRACT.md. */
export const CONTRACT_VERSION = "v1" as const;

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

/** A task id with no sub-steps, e.g. `T-01`. Dotted ids express nesting. */
export const TASK_ID_RE = /^T-\d{2,3}(\.\d+)*$/;

/** A checkbox line, with optional leading indentation (indentation is not significant). */
const CHECKBOX_RE = /^\s*[-*]\s*\[[ xX]\]\s+(\S+)\s*(.*)$/;

/**
 * A checkbox-shaped line that does not match the strict task form. Used only inside task
 * sections, where an unrecognizable checkbox is a rejection, never a silent ignore.
 */
const CHECKBOX_LIKE_RE = /^\s*[-*]\s*\[[ xX]\]\s*\S/;

const REQUIREMENT_RE = /^[-*]\s*(CR-\d{2,3})\s*:\s*(.+)$/;
const GOAL_RE = /^Goal:\s*\S/;
const EXECUTION_ORDER_RE = /^Execution order:\s*(\S.*)$/;

/** A fenced code block: an odd number of fences toggles the state. */
const FENCE_RE = /^\s*(```|~~~)/;

/** A top-level section heading (H2). */
const H2_RE = /^##\s+/;

/** A task section heading: `## S-<nn> ...`, matched case-insensitively. */
const TASK_SECTION_RE = /^##\s+S-\d+\s/i;

/**
 * The three context sections that survive into the objective, in the order they are
 * emitted. Headings are matched case-insensitively and exactly (no H3 sub-structure).
 */
const CONTEXT_SECTIONS: Array<[heading: string, label: string]> = [
  ["## scope", "Scope"],
  ["## out of scope", "Out of scope"],
  ["## risks / constraints", "Constraints"],
];

/**
 * Number of fenced blocks open by the time `lines` ends. Passed around so the heading
 * index search can stop at the right section boundary.
 */
function splitLines(text: string): string[] {
  // CRLF and LF both parse identically; the raw text stays untouched for hashing.
  return text.split(/\r?\n/);
}

/** The lines of one section body: after `start`, up to the next H2 heading. */
function sectionBody(lines: string[], start: number): { end: number; body: string[] } {
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (H2_RE.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return { end, body: lines.slice(start + 1, end) };
}

/**
 * Precompute, per line, whether it sits inside a fenced code block. Fence markers
 * themselves are not content, so a checkbox can never hide behind one.
 */
function fenceMap(lines: string[]): boolean[] {
  const map: boolean[] = [];
  let open = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) open = !open;
    map.push(open);
  }
  return map;
}

function contextText(lines: string[], fences: boolean[]): string {
  const out: string[] = [];
  for (const [heading, label] of CONTEXT_SECTIONS) {
    const start = lines.findIndex((l, j) => !fences[j] && l.trim().toLowerCase() === heading);
    if (start < 0) continue;
    const { body } = sectionBody(lines, start);
    const text = body
      .filter((_, j) => !fences[start + 1 + j])
      .map((l) => l.trim().replace(/^[-*]\s+/, ""))
      .filter((l) => l && !/^(Scope:|\[)/.test(l));
    if (text.length) out.push(`${label}: ${text.join(" ")}`);
  }
  return out.join(" | ");
}

/**
 * Parse a plan's text into structure. Returns a typed rejection when the text does not
 * satisfy the Universal Adapter Contract v1.
 */
export function parsePlanText(text: string): Result<ParsedPlan, RejectReason> {
  const lines = splitLines(text);
  const fences = fenceMap(lines);

  const goalLine = lines.find((l, j) => !fences[j] && GOAL_RE.test(l))?.trim();
  if (goalLine === undefined) {
    return fail(reject("missing-goal-line", "PLAN.md has no 'Goal: <outcome>' line."));
  }

  const tasks: ParsedTask[] = [];
  const seen = new Set<string>();

  // One pass: track the current top-level section. Only `## S-<nn>` sections carry tasks.
  let section: { kind: "task"; heading: string } | { kind: "prose"; heading: string } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (fences[i]) continue;

    if (H2_RE.test(line)) {
      section = TASK_SECTION_RE.test(line)
        ? { kind: "task", heading: line }
        : { kind: "prose", heading: line };
      continue;
    }

    const box = CHECKBOX_RE.exec(line);

    // A checkbox before the first top-level section is stranded: the parser cannot say
    // whether it is a task, so it stops (contract: no guessing, no mending).
    if (section === null) {
      if (box !== null || CHECKBOX_LIKE_RE.test(line)) {
        return fail(
          reject(
            "stranded-checkbox",
            "A checkbox-shaped line appears before any '## S-<nn>' section; the adapter cannot classify it.",
          ),
        );
      }
      continue;
    }

    if (section.kind === "prose") {
      // Checkboxes inside Notes, Documentation, code examples, or any non-task section
      // are prose by definition and never become tasks (contract).
      continue;
    }

    // Task section: a checkbox must parse exactly, otherwise reject rather than guess.
    if (box === null) {
      if (CHECKBOX_LIKE_RE.test(line)) {
        return fail(
          reject(
            "malformed-task",
            `In section '${section.heading}', a checkbox does not match the task form '- [ ] T-<nn> <title>': '${line.trim()}'`,
          ),
        );
      }
      continue;
    }

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
  for (let i = 0; i < lines.length; i++) {
    if (fences[i]) continue;
    const cr = REQUIREMENT_RE.exec(lines[i] ?? "");
    if (cr) requirements.push(`${cr[1]} ${(cr[2] ?? "").trim()}`);
  }

  let executionOrder: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (fences[i]) continue;
    const order = EXECUTION_ORDER_RE.exec(lines[i] ?? "");
    if (order) {
      executionOrder = order[1]?.trim() ?? null;
      break;
    }
  }

  return ok({
    text,
    goalLine,
    tasks,
    requirements,
    executionOrder,
    context: contextText(lines, fences),
  });
}

/** The task ids that are referenced as parents by at least one sub-task. */
export function referencedParents(tasks: ParsedTask[]): Set<string> {
  const parents = new Set<string>();
  for (const t of tasks) if (t.depth > 0) parents.add(t.id.split(".")[0] ?? "");
  return parents;
}