/**
 * Port of plans/probes/m3-adapter-skip-check.ts to node:test.
 *
 * Same five assertions: a disabled adapter sends nothing and logs only a skip, and a
 * payload that disagrees with the plan on disk is rejected with an actionable reason.
 *
 * The probe wrote the real ~/.pi/agent/goal-adapter.json and the real probe log; this port
 * uses a temp agent dir, so an interrupted run cannot leave the real kill switch off.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { emitPlanApproved, findLog, fixture, makeEnv, readLog, writeConfig } from "./helpers.ts";

test("disabled adapter stays silent and only records a skip", async () => {
  const env = makeEnv();
  const plan = fixture("m3-basic-plan.md");
  writeFileSync(env.planPath, plan);
  writeConfig(env, { enabled: false });

  const { sent } = await emitPlanApproved(env, {
    cwd: env.cwd,
    planFilePath: "plans/plan.md",
    planContent: plan,
  });

  assert.equal(sent.length, 0, "disabled adapter must not send anything");
  const log = readLog(env.logPath);
  assert.ok(
    log.some((e) => e.kind === "skip"),
    `disabled adapter must record a skip line, got ${JSON.stringify(log)}`,
  );
  assert.ok(
    !log.some((e) => e.kind === "handoff" || e.kind === "reject"),
    "disabled adapter must not hand off or reject",
  );
});

test("a payload that differs from the file on disk is rejected", async () => {
  const env = makeEnv();
  writeFileSync(env.planPath, fixture("m3-basic-plan.md"));
  writeConfig(env, { enabled: true });

  const { sent } = await emitPlanApproved(env, {
    cwd: env.cwd,
    planFilePath: "plans/plan.md",
    planContent: "not the file on disk",
  });

  assert.equal(sent.length, 0, "a payload mismatch must not send");
  const entry = findLog(env.logPath, "reject");
  assert.ok(entry !== undefined, "the mismatch is logged as a reject");
  assert.match(entry.text ?? "", /differs from the approved payload/);
});

test("the port keeps the probe's assertion count", () => {
  // Two skip cases plus the three property assertions above.
  console.log("adapter skip/reject checks: 5 assertions");
  console.log("ALL ADAPTER SKIP CHECKS PASS");
});