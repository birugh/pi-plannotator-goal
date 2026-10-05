/**
 * Reading open goals out of a resolved pool, and reporting them to the user.
 *
 * Behavior note (deviation from the milestone's task wording, recorded on purpose):
 * the task list said "over the pool and its archived directory", but pi-goal-x reads
 * open goals from the ACTIVE pool only: `scanActiveGoalFiles` matches
 * `/^active_goal_.*\.md$/` inside the goals root and never reads `archived/`
 * (`pi-goal-x/extensions/storage/goal-files.ts:530-546`). Scanning `archived/*.md` made
 * the M3 adapter stop before handoff on goals the user had already retired, so the
 * shipped behavior is active-pool only. This module implements that shipped behavior to
 * keep pre/post evidence comparable.
 *
 * The pool root is always an argument: resolution lives in goals-pool.ts, so this module
 * never invents a path and tests can point it at a temp directory.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { OpenGoal } from "./types.ts";

/**
 * Only an `active_goal_*.md` file is a candidate; anything else in the pool (ledgers,
 * snapshots, locks, metadata) is ignored without being read.
 */
export const ACTIVE_GOAL_FILE_RE = /^active_goal_.*\.md$/;

/**
 * The sparse goal header. `parseGoalFile` in pi-goal-x reads the JSON object at the top
 * of the file; the M3 adapter additionally ends the header at the first blank line, so
 * this schema tolerates the keys it needs and ignores the rest.
 */
export const GoalHeaderSchema = Type.Object(
  {
    id: Type.Optional(Type.String()),
    status: Type.Optional(Type.String()),
    objective: Type.Optional(Type.String()),
    activePath: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

type GoalHeader = Static<typeof GoalHeaderSchema>;

/**
 * Split the JSON header from the `# Goal Prompt` body. Returns null when nothing
 * parseable is at the top of the file.
 *
 * Two attempts, matching the shipped adapter: the prefix up to the first blank line
 * first (pi-goal-x ends its header there), then the whole prefix before the body marker
 * as a fallback.
 */
export function parseGoalHeader(text: string): GoalHeader | null {
  const marker = text.indexOf("# Goal Prompt");
  const head = marker >= 0 ? text.slice(0, marker) : text;

  const end = head.search(/\n\s*\n/);
  const attempts = end >= 0 ? [head.slice(0, end), head] : [head];

  for (const candidate of attempts) {
    let raw: unknown;
    try {
      raw = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!Value.Check(GoalHeaderSchema, raw)) continue;
    const header: GoalHeader = Value.Decode(GoalHeaderSchema, raw);
    if (header.id === undefined) continue;
    return header;
  }
  return null;
}

/**
 * Every open goal in the pool. A goal is open when it has an id and is not `complete`;
 * `archived/` is never scanned because an archived goal is retired regardless of its
 * recorded status.
 */
export function findOpenGoals(poolRoot: string): OpenGoal[] {
  let names: string[];
  try {
    names = readdirSync(poolRoot);
  } catch {
    return [];
  }

  const out: OpenGoal[] = [];
  for (const name of names) {
    if (!ACTIVE_GOAL_FILE_RE.test(name)) continue;
    const file = join(poolRoot, name);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const header = parseGoalHeader(text);
    if (header === null) continue;
    if (header.status === "complete") continue;
    out.push({
      id: header.id ?? "",
      status: header.status ?? "unknown",
      title: (header.objective ?? "").split("\n")[0]?.slice(0, 120) ?? "",
      activePath: header.activePath ?? null,
      file,
    });
  }
  return out;
}

/**
 * The message shown when handoff is refused because the pool already holds an open goal.
 * Unchanged from M3: the migrated probe asserts on these lines.
 */
export function buildExistingGoalReport(planPath: string, open: OpenGoal[]): string {
  const lines = open.map(
    (g) => `- ${g.id} · ${g.status} · ${g.title}${g.activePath ? `\n  ${g.activePath}` : ""}`,
  );
  return [
    "M3 adapter stopped before handoff: an existing open goal is present.",
    "",
    `Plan:   ${planPath}`,
    "Open goals:",
    ...lines,
    "",
    "Effect: No message was sent. No pi-goal goal was created.",
    "Action: choose one, then resubmit the plan through Plannotator:",
    "  /goal-focus <id>   work on that goal instead",
    "  /goal-unfocus      leave it open, unfocus it",
    "  /goal-clear        archive it and free the pool",
  ].join("\n");
}