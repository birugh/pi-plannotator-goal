/**
 * Port of plans/probes/m3-failure-cases.ts to node:test.
 *
 * Same eleven results: the nine failure cases plus the two live runs (a mismatched
 * payload rejected before any send, and a synthetic pool that stops the handoff). The
 * runtime cases read the recorded wheel evidence rather than re-running a real pi-goal
 * session; those files are copied into test/fixtures and referenced by name below.
 *
 * The probe wrote the real kill switch and the real probe log. This port uses a temp agent
 * dir and a temp pool, so the real ~/.pi/agent is untouched.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildExistingGoalReport, findOpenGoals } from "../goals.ts";
import { buildGoalIR } from "../ir.ts";
import { parsePlanText } from "../plan-text.ts";
import { buildHandoffMessage } from "../handoff.ts";
import { emitPlanApproved, findLog, fixture, goalFile, makeEnv, readLog, writeConfig } from "./helpers.ts";

const PLAN_PATH = "/home/biru/.pi/agent/plans/fixtures/m3-basic-plan.md";
const plan = fixture("m3-basic-plan.md");
const evidence = fixture("m3-handoff-evidence.md");

function parsed(text: string) {
  const result = parsePlanText(text);
  if (!result.ok) throw new Error(`fixture must parse: ${result.error.message}`);
  return result.value;
}

function rejectReason(input: string): string {
  const parsedPlan = parsePlanText(input);
  if (!parsedPlan.ok) return parsedPlan.error.message;
  const result = buildGoalIR(parsedPlan.value, { planPath: PLAN_PATH });
  if (result.ok) throw new Error("expected a rejection");
  return result.error.message;
}

const results: string[] = [];

test("1. duplicate task id -> reject", () => {
  assert.match(
    rejectReason(plan.replace(/^([-*]\s*\[[ xX]\]\s*)T-02\b/m, "$1T-01")),
    /Duplicate task id/,
  );
  results.push("1. duplicate task id -> reject — PASS");
});

test("2. missing parent -> reject", () => {
  assert.match(
    rejectReason(plan.replace(/^([-*]\s*\[[ xX]\]\s*)T-01\.1\b/m, "$1T-77.1")),
    /references missing parent/,
  );
  results.push("2. missing parent -> reject — PASS");
});

test("3. depth > 1 -> reject, with the runtime rejection captured", () => {
  assert.match(rejectReason(`${plan}\n## S-99 Extra\n- [ ] T-01.1.9 too deep\n`), /subtask depth/);
  assert.match(
    evidence,
    /subtask nesting depth 2, exceeding the configured maximum of 1/,
    "runtime depth rejection must be captured",
  );
  results.push("3. depth > 1 -> reject (runtime also proves pi-goal rejects) — PASS");
});

test("4. more than 50 tasks -> reject", () => {
  assert.match(
    rejectReason(`${plan}\n## S-99 Extra\n${Array.from({ length: 60 }, (_, i) => `- [ ] T-${201 + i} extra`).join("\n")}`),
    /allows at most 50/,
  );
  results.push("4. >50 tasks -> reject — PASS");
});

test("5. invalid plan or changed file -> reject", () => {
  assert.match(rejectReason(plan.replace(/^Goal:.*$/m, "")), /no 'Goal:/);
  assert.match(rejectReason(plan.replace(/^[-*]\s*CR-\d+.*$/gm, "")), /no '- CR-/);
  assert.match(rejectReason(plan.replace(/^([-*]\s*\[[ xX]\]\s*)T-01\b/m, "$1S-01")), /not an executable task/);
  results.push("5. invalid PLAN / changed file -> reject — PASS");
});

test("6. invalid mode declaration -> reject", () => {
  assert.match(rejectReason(`${plan}\nExecution order: semi-strict\n`), /only 'strict'/);
  results.push("6. invalid mode declaration -> reject — PASS");
});

test("7. existing open goal -> adapter stops before sendUserMessage", () => {
  const env = makeEnv();
  const pool = join(env.cwd, ".pi", "goals");
  mkdirSync(join(pool, "archived"), { recursive: true });
  writeFileSync(
    join(pool, "active_goal_20260101000000_probe-open.md"),
    goalFile("probe-open", "paused", "Synthetic open goal for the adapter gate"),
  );
  writeFileSync(
    join(pool, "archived", "goal_20260101000000_probe-retired.md"),
    goalFile("probe-retired", "paused", "Retired goal that must not block handoff"),
  );

  const open = findOpenGoals(pool);
  assert.equal(open.length, 1, "exactly the synthetic active goal is open");
  assert.equal(open[0]?.id, "probe-open", "the active pool file is reported");
  assert.ok(
    !open.some((g) => g.id === "probe-retired"),
    "an archived goal is retired even when its status is not complete",
  );
  const report = buildExistingGoalReport(PLAN_PATH, open);
  assert.match(report, /No message was sent\. No pi-goal goal was created\./);
  assert.match(report, /\/goal-focus|\/goal-unfocus|\/goal-clear/);
  for (const g of open) assert.ok(report.includes(g.id), `report lists ${g.id}`);
  results.push("7. existing open goal -> adapter stops BEFORE sendUserMessage (runtime) — PASS");
});

test("8. user rejects task confirmation -> no mutation", () => {
  assert.match(evidence, /Task list kept unchanged\./, "runtime human-reject result must be captured");
  assert.match(evidence, /revision: 20/, "goal revision must be unchanged after reject");
  results.push("8. user rejects task confirmation -> no mutation (runtime) — PASS");
});

test("9. create ok + set_goal_tasks fails -> mandated stop and report, no retry", () => {
  const built = buildGoalIR(parsed(plan), { planPath: PLAN_PATH });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const msg = buildHandoffMessage(built.value);
  assert.match(msg, /If creation or task application fails, STOP and report the exact tool output/);
  assert.match(msg, /Do not retry with/);
  assert.ok(
    !/goal-direct|sisyphus-direct/.test(msg.replace(/another creation path \([^)]*\)/, "")),
    "no fallback path may be offered as an action",
  );
  results.push("9. create ok + set_goal_tasks fails -> mandated STOP+report, no retry — PASS");
});

test("5b. live run with a mismatched payload is rejected before any send", async () => {
  const env = makeEnv();
  writeFileSync(env.planPath, plan);
  writeConfig(env, { enabled: true });

  const { sent } = await emitPlanApproved(env, {
    cwd: env.cwd,
    planFilePath: "plans/plan.md",
    planContent: `${plan}\n`,
  });

  assert.equal(sent.length, 0, "a payload mismatch must not send a message");
  assert.ok(findLog(env.logPath, "reject") !== undefined, "the live mismatch run must log a reject");
  results.push("5b. live adapter run with a mismatched payload — rejected before any send");
});

test("7b. live run against a synthetic pool stops before sendUserMessage", async () => {
  const env = makeEnv();
  writeFileSync(env.planPath, plan);
  writeConfig(env, { enabled: true });
  const pool = join(env.cwd, ".pi", "goals");
  mkdirSync(join(pool, "archived"), { recursive: true });
  writeFileSync(
    join(pool, "active_goal_20260101000000_probe-open.md"),
    goalFile("probe-open", "paused", "Synthetic open goal for the adapter gate"),
  );
  writeFileSync(
    join(pool, "archived", "goal_20260101000000_probe-retired.md"),
    goalFile("probe-retired", "paused", "Retired goal that must not block handoff"),
  );

  const { sent } = await emitPlanApproved(env, {
    cwd: env.cwd,
    planFilePath: "plans/plan.md",
    planContent: plan,
  });

  assert.equal(sent.length, 0, "existing-goal stop must not send a message to the agent");
  const log = readLog(env.logPath);
  assert.ok(log.some((e) => e.kind === "existing-goal-stop"), "live run must record the stop");
  assert.ok(!log.some((e) => e.kind === "handoff"), "live run must not hand off");
  results.push("7b. live adapter run against a synthetic pool — stopped before sendUserMessage, no handoff");
});

test("the port reports the same eleven results as the probe", () => {
  assert.equal(results.length, 11, "nine failure cases plus two live runs");
  console.log(results.join("\n"));
  console.log("failure cases: 9/9 (+2 live runs)");
  console.log("ALL FAILURE CASES COVERED");
});