/**
 * The extension entry point: a thin factory that wires the host to the modules.
 *
 * All logic lives in the sibling modules; this file only orchestrates. The order below
 * is the contract with the M3 evidence:
 *
 *   1. validate the event payload (no blind cast)
 *   2. read config; an explicit `true` is required to proceed
 *   3. defer one macrotask, because the event fires while the submit tool is still in
 *      flight and `isIdle()` is false at that instant
 *   4. resolve the plan path against the event cwd
 *   5. re-read the plan and refuse if it differs from the approved payload
 *   6. run the external validator
 *   7. build the IR (rejection is a value)
 *   8. resolve the real goal pool and stop if an open goal is present
 *   9. log and hand off, choosing `steer` or `followUp` from the measured idle state
 *
 * Every refusal leaves the session untouched: no message is sent and no goal is created.
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  parsePayload,
  PLAN_APPROVED,
  resolveConfig,
  resolvePlanPath,
  type PlanApprovedPayload,
  type ResolvedConfig,
} from "./config.ts";
import { createLogger, type Logger } from "./log.ts";
import { parsePlanText } from "./plan-text.ts";
import { buildGoalIR, withChangeSummary } from "./ir.ts";
import { resolveGoalsRoot } from "./goals-pool.ts";
import { buildExistingGoalReport, findOpenGoals } from "./goals.ts";
import { buildHandoffMessage, buildRejectionMessage, summarizeForNotice } from "./handoff.ts";
import { reject, type RejectReason } from "./types.ts";

export type AdapterDeps = {
  env?: NodeJS.ProcessEnv;
  runValidator?: (validatePath: string, planPath: string) => string | null;
};

/**
 * Run the external validator; returns stdout when it fails, null on success.
 *
 * The thrown value is a child-process error whose `stdout` is a Buffer. It is read through
 * a schema check rather than a cast, so the only remaining `unknown` in this module is
 * narrowed the same way every other boundary is.
 */
function defaultRunValidator(validatePath: string, planPath: string): string | null {
  try {
    execFileSync("node", [validatePath, planPath], { stdio: "pipe" });
    return null;
  } catch (error) {
    const stdout = readErrorStdout(error).trim();
    return stdout !== "" ? stdout : describeError(error);
  }
}

/** The child process stdout of a failed exec, when the thrown value carries it. */
function readErrorStdout(error: unknown): string {
  // execFileSync throws an Error whose captured pipes are non-enumerable properties. They
  // are read through a descriptor lookup, so no assertion is needed on the thrown value.
  if (!(error instanceof Error)) return "";
  const stdout = Object.getOwnPropertyDescriptor(error, "stdout")?.value;
  if (typeof stdout === "string") return stdout;
  if (Buffer.isBuffer(stdout)) return stdout.toString("utf8");
  return "";
}

/** A printable form of an unknown thrown value. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function plannotatorGoalAdapter(pi: ExtensionAPI, deps: AdapterDeps = {}): void {
  const env = deps.env ?? process.env;
  const runValidator = deps.runValidator ?? defaultRunValidator;
  let sessionCtx: ExtensionContext | undefined;

  pi.on("session_start", (_event, startCtx) => {
    sessionCtx = startCtx;
  });

  pi.events.on(PLAN_APPROVED, (data) => {
    const parsed = parsePayload(data);
    if (!parsed.ok) {
      // Without a trustworthy payload there is nowhere to write a log line to, so the
      // refusal goes to the console and the session stays untouched.
      console.error(`[plannotator-goal] ${parsed.error.message}`);
      return;
    }
    const payload: PlanApprovedPayload = parsed.value;
    const cwd = payload.cwd ?? sessionCtx?.cwd ?? process.cwd();
    const config: ResolvedConfig = resolveConfig(cwd, env);
    const log: Logger = createLogger(config.logPath);

    if (!config.enabled) {
      log({ kind: "skip", reason: "adapter disabled or no config", planFilePath: payload.planFilePath ?? null });
      return;
    }

    // One macrotask past the event handler: the event is emitted inside the submit
    // tool's execute() while the agent is still busy (M2 timing evidence).
    setImmediate(() => {
      const report = (text: string, kind: string): void => {
        log({ kind, text });
        sessionCtx?.ui.notify(summarizeForNotice(text), "warning");
      };

      const rejectWith = (reason: RejectReason, planPath: string | null): void => {
        report(buildRejectionMessage(planPath, reason.message), "reject");
      };

      const resolved = resolvePlanPath(payload);
      if (!resolved.ok) return rejectWith(resolved.error, null);
      const planPath = resolved.value;

      let text: string;
      try {
        text = readFileSync(planPath, "utf8");
      } catch {
        return rejectWith(reject("plan-unreadable", "Plan file could not be read from disk.", planPath), planPath);
      }

      if (payload.planContent !== undefined && payload.planContent !== text) {
        return rejectWith(
          reject("plan-changed", "Plan file on disk differs from the approved payload.", planPath),
          planPath,
        );
      }

      const validationFailure = runValidator(config.validatePath, planPath);
      if (validationFailure !== null) {
        return rejectWith(
          reject("validator-failed", `plans/validate.mjs failed:\n${validationFailure}`, planPath),
          planPath,
        );
      }

      const parsedPlan = parsePlanText(text);
      if (!parsedPlan.ok) return rejectWith(parsedPlan.error, planPath);

      const built = buildGoalIR(parsedPlan.value, { planPath });
      if (!built.ok) return rejectWith(built.error, planPath);
      const ir = withChangeSummary(built.value, payload.feedback);

      const pool = resolveGoalsRoot({ cwd, env });
      if (!pool.ok) return rejectWith(pool.error, planPath);

      const openGoals = findOpenGoals(pool.value.root);
      if (openGoals.length > 0) {
        return report(buildExistingGoalReport(planPath, openGoals), "existing-goal-stop");
      }

      const message = buildHandoffMessage(ir);
      const deliverAs = sessionCtx !== undefined && sessionCtx.isIdle() ? "followUp" : "steer";
      log({
        kind: "handoff",
        planPath,
        planSha256: ir.source.planSha256,
        tasks: ir.tasks.length,
        mode: ir.mode,
        deliverAs,
        goalsRoot: pool.value.root,
        goalsRootSource: pool.value.source,
      });
      pi.sendUserMessage(message, { deliverAs });
    });
  });
}

export { PLAN_APPROVED } from "./config.ts";