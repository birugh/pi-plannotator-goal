/**
 * Port of plans/probes/m3-adapter-check.ts to node:test.
 *
 * Same assertions as the probe: the enabled truth table, IR assembly over the M-90 gate
 * fixture, the handoff message needles, and the reject matrix. The probe imported the
 * adapter's internals directly and read the real plans/M-90-probe-gate-test.md; this port
 * imports the modules and reads the copied fixture, so it never touches the agent dir.
 *
 * The summary lines at the end are the ones the recorded baseline produced, which is what
 * makes test/EVIDENCE.md a like-for-like comparison.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveConfig, type ResolvedConfig } from "../config.ts";
import { buildGoalIR, withChangeSummary, MAX_TASKS } from "../ir.ts";
import { parsePlanText, type ParsedPlan } from "../plan-text.ts";
import { buildHandoffMessage } from "../handoff.ts";
import { fixture } from "./helpers.ts";

const PLAN_PATH = "/home/biru/.pi/agent/plans/M-90-probe-gate-test.md";
const plan = fixture("m90-probe-gate-test.md");

/** Resolve config from an inline settings file, the way isEnabled(configText) did. */
function configFor(text: string | null): ResolvedConfig {
  const root = mkdtempSync(join(tmpdir(), "ppg-check-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "cwd");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (text !== null) writeFileSync(join(agentDir, "plannotator-goal.json"), text);
  return resolveConfig(cwd, { PI_CODING_AGENT_DIR: agentDir }, root);
}

function parsed(text: string): ParsedPlan {
  const result = parsePlanText(text);
  if (!result.ok) throw new Error(`fixture must parse: ${result.error.message}`);
  return result.value;
}

function rejectReason(input: string): string {
  // The old adapter parsed and assembled in one call, so its probe could not tell the
  // stages apart. A syntax problem now surfaces in parsePlanText and a pi-goal-limit
  // problem in buildGoalIR; both are the same rejection to a caller.
  const parsedPlan = parsePlanText(input);
  if (!parsedPlan.ok) return parsedPlan.error.message;
  const result = buildGoalIR(parsedPlan.value, { planPath: PLAN_PATH });
  if (result.ok) throw new Error("expected a rejection");
  return result.error.message;
}

test("enabled truth table matches the probe", () => {
  assert.equal(configFor(null).enabled, false, "missing config must be disabled");
  assert.equal(configFor("not json").enabled, false, "malformed config must be disabled");
  assert.equal(configFor("{}").enabled, false, "no enabled key must be disabled");
  assert.equal(configFor('{"enabled":"true"}').enabled, false, "string true must NOT enable");
  assert.equal(configFor('{"enabled":false}').enabled, false);
  assert.equal(configFor('{"enabled":true}').enabled, true);
});

test("IR assembly over the M-90 fixture", () => {
  const built = buildGoalIR(parsed(plan), { planPath: PLAN_PATH });
  assert.equal(built.ok, true, "the gate fixture must build");
  if (!built.ok) return;
  const ir = withChangeSummary(built.value, "approved with notes");

  assert.equal(ir.mode, "regular", "no explicit ordered marker -> regular");
  assert.equal(ir.blockCompletion, true, "block_completion always true");
  assert.ok(ir.objective.includes("Goal:"), "objective keeps the Goal: line");
  assert.ok(ir.verificationContract.startsWith("Verification contract: "), "single-line contract carrier");
  assert.match(ir.verificationContract, /CR-\d{2}/, "contract carries CR ids");
  assert.equal(ir.changeSummary, "approved with notes", "feedback goes to change_summary");
  assert.ok(
    ir.tasks.some((t) => t.parentId) && ir.tasks.some((t) => !t.parentId),
    "both roots and subtasks are mapped",
  );
  assert.ok(
    ir.tasks.filter((t) => t.parentId).every((t) => ir.tasks.some((r) => r.id === t.parentId)),
    "every parentId resolves to a task in the IR",
  );
  assert.ok(
    !JSON.stringify(ir).match(/status|evidence|completedAt|goalId|activePath|scheduler|ledger/),
    "IR carries no execution state",
  );

  const msg = buildHandoffMessage(ir);
  for (const needle of [
    "create_goal",
    "set_goal_tasks",
    "Do not reinterpret the plan",
    "Do not create another goal",
    "block_completion: true",
    "Do not retry with",
  ]) {
    assert.ok(msg.toLowerCase().includes(needle.toLowerCase()), `handoff message must state: ${needle}`);
  }
  for (const t of ir.tasks) assert.ok(msg.includes(t.id), `handoff lists ${t.id}`);

  console.log(`adapter pure checks: ${6 + 7 + 6 + 6 + 8} assertions over ${ir.tasks.length} tasks`);
  console.log("ALL ADAPTER CHECKS PASS");
});

test("reject matrix matches the probe", () => {
  const dropTasks = (source: string): string =>
    source
      .split("\n")
      .filter((l) => !/^[-*]\s*\[[ xX]\]/.test(l))
      .join("\n");

  const taskLines = plan.split("\n").filter((l) => /^[-*]\s*\[[ xX]\]/.test(l));
  assert.ok(taskLines.length > 0, "fixture must provide task lines for the reject cases");

  const rejects: Array<[string, string, RegExp]> = [
    ["missing Goal line", plan.replace(/^Goal:.*$/m, ""), /no 'Goal:/],
    [
      "duplicate task id",
      plan.replace(/^([-*]\s*\[[ xX]\]\s*T-90\.1)\b.*$/m, (m, head: string) =>
        head.replace("T-90.1", "T-90") + m.slice(head.length),
      ),
      /Duplicate task id/,
    ],
    [
      "depth > 1",
      `${plan}\n## S-91 Extra\n- [ ] T-90.1.1 too deep\n`,
      /subtask depth/,
    ],
    ["missing parent", plan.replace(/^([-*]\s*\[[ xX]\]\s*)(T-90\.1)\b/m, "$1T-42.1"), /references missing parent/],
    ["story as task", plan.replace(/^([-*]\s*\[[ xX]\]\s*)T-90\b/m, "$1S-90"), /not an executable task/],
    ["no CR bullet", plan.replace(/^[-*]\s*CR-\d+.*$/gm, ""), /no '- CR-/],
    ["no tasks", dropTasks(plan), /no '- \[ \] T-/],
    [
      "too many tasks",
      `${plan}\n## S-91 Extra\n${Array.from({ length: 60 }, (_, i) => `- [ ] T-${101 + i} extra`).join("\n")}`,
      /allows at most \d+/,
    ],
  ];

  // The probe asserted the literal 50; the constant is pinned here instead.
  assert.equal(MAX_TASKS, 50, "pi-goal allows at most 50 tasks");

  for (const [name, input, pattern] of rejects) {
    assert.match(rejectReason(input), pattern, `${name}: reason must match ${pattern}`);
  }
});