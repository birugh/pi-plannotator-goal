/**
 * Append-only JSONL logging for the adapter.
 *
 * The sink path is not a module constant any more: it comes from the resolved config
 * (`logPath`), so a test can point it at a temp directory and the agent dir stays
 * untouched. The timestamp is read at call time, which is what makes a handoff entry a
 * usable witness.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogEntry = Record<string, unknown>;

export type Logger = (entry: LogEntry) => void;

/** True when the entry is worth printing to stderr as well (warnings and rejections). */
const NOTIFY_KINDS = new Set(["reject", "existing-goal-stop", "config-error"]);

export function shouldNotify(entry: LogEntry): boolean {
  return typeof entry.kind === "string" && NOTIFY_KINDS.has(entry.kind);
}

/**
 * Build a logger bound to one path. Logging never throws: a broken sink must not break
 * the handoff, so every write is best-effort and failures are reported to stderr only
 * when the environment asks for it.
 */
export function createLogger(logPath: string, now: () => Date = () => new Date()): Logger {
  return (entry: LogEntry): void => {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${JSON.stringify({ ts: now().toISOString(), ...entry })}\n`);
    } catch (error) {
      if (process.env.PLANNOTATOR_GOAL_DEBUG === "1") {
        console.error("[plannotator-goal] log write failed:", error);
      }
    }
  };
}

/** A logger that discards everything; used when a caller only needs the shape. */
export const nullLogger: Logger = () => {};