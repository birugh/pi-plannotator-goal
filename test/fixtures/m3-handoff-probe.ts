/**
 * M3.2 handoff probe — witness for the plan-approved → deferred → sendUserMessage
 * path (Test F / U-2 / U-3 / U-9 of plans/M3-DECISIONS.md §10).
 *
 * Load explicitly (file, not a package dir — avoids the M2 double-load hazard):
 *
 *   pi --plan --extension ~/.pi/agent/plans/probes/m3-handoff-probe.ts ...
 *
 * It observes and (optionally) sends ONE short test message. It does NOT create
 * goals, does not call goal tools, does not write .pi/goals, does not import any
 * package internals: the channel is a plain string (README of @plannotator,
 * pi-extension:270) and sendUserMessage is public host surface
 * (dist/core/extensions/types.d.ts:1055-1057).
 *
 * Evidence sink: plans/probes/m3-handoff-evidence.jsonl (override M3_HANDOFF_EVIDENCE).
 * Set M3_HANDOFF_SEND=0 to record the event without sending the test message.
 *
 * Notes (verified in M2):
 * - pi.events.on handlers receive only `data`, no ExtensionContext
 *   (see m2-probe.ts:115 which uses the same shape) → the session_start ctx is
 *   cached; whether that cached ctx.isIdle() is trustworthy at event time is
 *   exactly what this probe measures (U-3).
 * - The event is emitted while the submit tool result is still in flight
 *   (M2: plan-approved ts .566 < submit-result .567) → sync isIdle() is
 *   expected false; setImmediate defers one macrotask past the handler (U-2).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PLAN_APPROVED = "plannotator:plan-approved";
const EVIDENCE_FILE =
  process.env.M3_HANDOFF_EVIDENCE ??
  "/home/biru/.pi/agent/plans/probes/m3-handoff-evidence.jsonl";

function record(obj: Record<string, unknown>): void {
  mkdirSync(dirname(EVIDENCE_FILE), { recursive: true });
  appendFileSync(EVIDENCE_FILE, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
}

export default function (pi: ExtensionAPI): void {
  let sessionCtx: ExtensionContext | undefined;

  pi.on("session_start", (_event, startCtx) => {
    sessionCtx = startCtx;
    record({
      kind: "session-start",
      mode: startCtx.mode,
      hasUI: startCtx.hasUI,
      cwd: startCtx.cwd,
    });
  });

  pi.events.on(PLAN_APPROVED, (data) => {
    const event = (data ?? {}) as {
      cwd?: string;
      planFilePath?: string;
      planContent?: string;
      feedback?: string;
    };

    // Sync measurement: emitted inside the submit tool's execute() while the
    // agent is still busy (M2 timing evidence) — expect false.
    const syncIdle = sessionCtx ? sessionCtx.isIdle() : null;

    record({
      kind: "plan-approved-sync",
      planFilePath: event.planFilePath ?? null,
      feedback: event.feedback ?? null,
      sessionCtxCached: sessionCtx !== undefined,
      isIdleAtSync: syncIdle,
    });

    // Deferred: one macrotask past the event handler. deliverAs is chosen from
    // the measured value, not from an assumption (M3.2 Test F).
    setImmediate(() => {
      const deferredIdle = sessionCtx ? sessionCtx.isIdle() : null;
      const deliverAs = deferredIdle ? "followUp" : "steer";
      record({ kind: "handoff-deferred", isIdleAtDeferred: deferredIdle, deliverAs });

      if (process.env.M3_HANDOFF_SEND === "0") {
        record({ kind: "send-skipped", reason: "M3_HANDOFF_SEND=0" });
        return;
      }
      pi.sendUserMessage(
        "M3.2 probe handoff test: reply with exactly HANDOFF-RECEIVED. " +
          "Do not call any tools. Do not create a goal. Do not plan anything.",
        { deliverAs },
      );
      record({ kind: "sendUserMessage-sent", deliverAs });
    });
  });
}
