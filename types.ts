/**
 * Shared types for the Plannotator -> pi-goal adapter.
 *
 * Two rules hold across the whole module split:
 * - Untrusted input (config files, event payloads) is validated at runtime with a
 *   typebox schema in config.ts or goals-pool.ts, and the TypeScript type is inferred
 *   from that schema. Nothing is asserted with a blind `as`.
 * - Rejection is a value, not a throw: helpers return `Result<T, RejectReason>` and
 *   the caller decides whether to log, notify, or hand off.
 */

export type TaskIR = { id: string; title: string; parentId?: string };

export type PlanSource = { planPath: string; planSha256: string };

export type GoalIR = {
  objective: string;
  mode: "regular" | "sisyphus";
  tasks: TaskIR[];
  verificationContract: string;
  blockCompletion: true;
  changeSummary?: string;
  source: PlanSource;
};

/**
 * Machine-readable rejection codes. Every reason the adapter can surface is one of
 * these; the message is the human sentence shown in the session notification.
 */
export type RejectCode =
  | "plan-unreadable"
  | "plan-changed"
  | "bad-payload"
  | "missing-goal-line"
  | "milestone-or-story-id"
  | "invalid-task-id"
  | "duplicate-task-id"
  | "empty-task-title"
  | "stranded-checkbox"
  | "malformed-task"
  | "task-too-deep"
  | "no-tasks"
  | "too-many-tasks"
  | "missing-parent"
  | "no-requirements"
  | "objective-too-long"
  | "contract-too-long"
  | "bad-execution-order"
  | "sisyphus-needs-steps"
  | "goals-root-invalid";

export type RejectReason = {
  code: RejectCode;
  message: string;
  planPath: string | null;
};

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function fail<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function reject(code: RejectCode, message: string, planPath: string | null = null): RejectReason {
  return { code, message, planPath };
}

export type OpenGoal = {
  id: string;
  status: string;
  title: string;
  activePath: string | null;
  file: string;
};