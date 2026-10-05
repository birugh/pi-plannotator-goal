/**
 * Milestone 5: universal workflow compatibility.
 *
 * The adapter is universal: any workflow may plan however it wants, but the plan it
 * hands to the adapter must satisfy the Universal Adapter Contract v1. These e2e cases
 * prove that claim with six fixture workflows:
 *
 *   A. the current workflow            -> handoff succeeds
 *   B. a minimal workflow, no validator, no custom planner -> handoff succeeds
 *   C. a different planning workflow, contract-compliant  -> handoff succeeds
 *   D. a custom format outside the contract (tasks outside S-sections) -> STOP, clear error
 *   E. misleading task-like content in Notes / code fences -> never pi-goal tasks
 *   F. missing required structure (no S-section, no tasks) -> reject
 *
 * Each case drives the real adapter factory (index.ts) end to end: temp cwd + temp
 * agent dir, no external validator anywhere, no real ~/.pi/agent.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { emitPlanApproved, fixture, findLog, makeEnv, writeConfig } from "./helpers.ts";

function run(env: ReturnType<typeof makeEnv>, planName: string) {
  const text = fixture(planName);
  writeFileSync(env.planPath, text);
  writeConfig(env, { enabled: true });
  return emitPlanApproved(
    env,
    { cwd: env.cwd, planFilePath: "plans/plan.md", planContent: text },
    { idle: true },
  );
}

test("Fixture A — current workflow hands off", async () => {
  const env = makeEnv();
  const { sent, notifies } = await run(env, "wf-a-current.md");
  assert.equal(sent.length, 1, "the current workflow must hand off");
  assert.equal(notifies.length, 0, "a success must not warn");
  const message = sent[0]?.message ?? "";
  assert.match(message, /- T-01 — Add borrow endpoint/);
  assert.match(message, /- T-03 — Rollback on stock failure/);
  assert.match(message, /- T-01\.1 — Validate stock \(parent_id: "T-01"\)/);
  assert.match(message, /Verification contract: CR-01 POST \/borrow/);
  const handoff = findLog(env.logPath, "handoff");
  assert.ok(handoff, "the handoff is logged");
});

test("Fixture B — minimal workflow hands off with no validator and no custom planner", async () => {
  const env = makeEnv();
  const { sent, notifies } = await run(env, "wf-b-minimal.md");
  assert.equal(sent.length, 1, "a minimal contract-compliant plan must hand off");
  assert.equal(notifies.length, 0);
  assert.match(sent[0]?.message ?? "", /- T-01 — Do the one thing/);
  assert.match(sent[0]?.message ?? "", /Verification contract: CR-001 the one thing is done/);
});

test("Fixture C — a different planning workflow (kanban vocabulary) hands off", async () => {
  const env = makeEnv();
  const { sent, notifies } = await run(env, "wf-c-kanban.md");
  assert.equal(sent.length, 1, "workflow may differ, the contract is what counts");
  assert.equal(notifies.length, 0);
  const message = sent[0]?.message ?? "";
  assert.match(message, /- T-01 — Serialize the board/);
  assert.ok(!/- \(a planning note/.test(message), "a planning note in prose must never become a task");
});

test("Fixture D — a custom format outside the contract stops with a clear error", async () => {
  const env = makeEnv();
  const { sent, notifies } = await run(env, "wf-d-custom-invalid.md");
  assert.equal(sent.length, 0, "no handoff for a non-compliant format");
  assert.match(notifies[0]?.message ?? "", /M3 adapter rejected PLAN\.md/);
  const entry = findLog(env.logPath, "reject");
  assert.ok(entry, "the refusal is logged");
  assert.match(String(entry?.text ?? ""), /outside '## S-/);
});

test("Fixture E — misleading task-like content never becomes a pi-goal task", async () => {
  // A Notes section with a checkbox, an unknown section with a checkbox, and a fenced
  // code block with a checkbox: none may become tasks, and none may reject either.
  const env = makeEnv();
  const text = fixture("wf-a-current.md") + `

## Notes

- [ ] T-99 This note must never become a task

## Appendix

- [ ] T-98 Appendix checkbox

\`\`\`bash
- [ ] T-97 Fenced example
\`\`\`
`;
  writeFileSync(env.planPath, text);
  writeConfig(env, { enabled: true });
  const { sent, notifies } = await emitPlanApproved(
    env,
    { cwd: env.cwd, planFilePath: "plans/plan.md", planContent: text },
    { idle: true },
  );
  assert.equal(sent.length, 1, "the plan with prose checkboxes still hands off");
  const message = sent[0]?.message ?? "";
  assert.ok(!message.includes("T-99"), "a Notes checkbox must not be a task");
  assert.ok(!message.includes("T-98"), "an Appendix checkbox must not be a task");
  assert.ok(!message.includes("T-97"), "a fenced code checkbox must not be a task");
  assert.match(message, /- T-01 — Add borrow endpoint/);
});

test("Fixture F — missing required structure is rejected", async () => {
  const env = makeEnv();
  const text = "# No structure\n\nGoal: nothing here.\n\n## Completion Requirements\n\n- CR-001: nothing\n";
  writeFileSync(env.planPath, text);
  writeConfig(env, { enabled: true });
  const { sent, notifies } = await emitPlanApproved(
    env,
    { cwd: env.cwd, planFilePath: "plans/plan.md", planContent: text },
    { idle: true },
  );
  assert.equal(sent.length, 0, "a plan with no task structure must be rejected");
  assert.match(notifies[0]?.message ?? "", /M3 adapter rejected PLAN\.md/);
  const entry = findLog(env.logPath, "reject");
  assert.ok(entry, "the refusal is logged");
  assert.match(String(entry?.text ?? ""), /no '- \[ \] T-<nn>' task checkbox/);
});