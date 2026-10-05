/**
 * Tests for ir.ts: every reject reason, then the accepted shapes.
 *
 * The size guards are exercised by building text that just crosses each limit, so the
 * constants stay observable rather than assumed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGoalIR, MAX_CONTRACT, MAX_DEPTH, MAX_OBJECTIVE, MAX_TASKS, planSha256, withChangeSummary } from "../ir.ts";
import { parsePlanText, type ParsedPlan } from "../plan-text.ts";
import type { GoalIR } from "../types.ts";

const PLAN = `# M-90 Probe gate test

Goal: exercise the milestone shape end to end.

## Scope

- In: the adapter gate.

## Completion Requirements

- CR-001: the first thing works
- CR-002: the second thing works

## S-01 First story

- Scope: the first slice
- [ ] T-01 Do the first thing
- [ ] T-01.1 Do the sub thing
- [ ] T-02 Do the second thing
`;

const SOURCE = { planPath: "/tmp/plans/M-90.md" };

function parse(text: string): ParsedPlan {
  const result = parsePlanText(text);
  if (!result.ok) throw new Error(`fixture must parse: ${result.error.message}`);
  return result.value;
}

function build(text: string) {
  return buildGoalIR(parse(text), SOURCE);
}

function ir(text: string): GoalIR {
  const result = build(text);
  if (!result.ok) throw new Error(`fixture must build: ${result.error.message}`);
  return result.value;
}

function rejectReason(text: string): { code: string; message: string } {
  const result = build(text);
  if (result.ok) throw new Error("expected a rejection");
  return { code: result.error.code, message: result.error.message };
}

describe("buildGoalIR acceptance", () => {
  it("keeps the Goal line, the context and a single-line contract", () => {
    const goal = ir(PLAN);
    assert.ok(goal.objective.startsWith("Goal: exercise the milestone shape end to end."));
    assert.match(goal.objective, /Scope: In: the adapter gate\./);
    assert.ok(goal.objective.endsWith("Verification contract: CR-001 the first thing works; CR-002 the second thing works"));
  });

  it("maps roots and sub-tasks with explicit parent ids", () => {
    const goal = ir(PLAN);
    assert.deepEqual(goal.tasks, [
      { id: "T-01", title: "Do the first thing" },
      { id: "T-01.1", title: "Do the sub thing", parentId: "T-01" },
      { id: "T-02", title: "Do the second thing" },
    ]);
  });

  it("always blocks completion and defaults to regular mode", () => {
    const goal = ir(PLAN);
    assert.equal(goal.blockCompletion, true);
    assert.equal(goal.mode, "regular");
  });

  it("fingerprints the plan text", () => {
    assert.equal(ir(PLAN).source.planSha256, planSha256(PLAN));
    assert.equal(ir(PLAN).source.planPath, SOURCE.planPath);
  });

  it("switches to sisyphus for a numbered strict objective", () => {
    const text = PLAN.replace(
      "Goal: exercise the milestone shape end to end.",
      "Goal: complete two numbered steps. 1) first 2) second",
    ).concat("Execution order: strict\n");
    assert.equal(ir(text).mode, "sisyphus");
  });

  it("attaches a change summary, capped, without touching the objective", () => {
    const goal = ir(PLAN);
    const noted = withChangeSummary(goal, "x".repeat(400));
    assert.equal(noted.objective, goal.objective);
    assert.equal(noted.changeSummary?.length, 240);
    assert.equal(withChangeSummary(goal, undefined).changeSummary, undefined);
  });

  it("has no changeSummary key when there is no feedback", () => {
    assert.ok(!("changeSummary" in ir(PLAN)));
  });
});

describe("buildGoalIR rejections", () => {
  it("no-tasks", () => {
    const { code, message } = rejectReason(PLAN.replace(/^- \[ \] T-.*$/gm, ""));
    assert.equal(code, "no-tasks");
    assert.match(message, /no '- \[ \] T-<nn>' task checkbox/);
  });

  it("no-requirements", () => {
    const { code, message } = rejectReason(PLAN.replace(/^- CR-.*$/gm, ""));
    assert.equal(code, "no-requirements");
    assert.match(message, /no '- CR-<nn>: <text>' requirement/);
  });

  it("missing-parent", () => {
    const { code, message } = rejectReason(PLAN.replace("- [ ] T-01.1 ", "- [ ] T-77.1 "));
    assert.equal(code, "missing-parent");
    assert.match(message, /references missing parent 'T-77'/);
  });

  it("task-too-deep at MAX_DEPTH+1", () => {
    const { code, message } = rejectReason(`${PLAN}\n- [ ] T-01.1.9 too deep\n`);
    assert.equal(code, "task-too-deep");
    assert.match(message, new RegExp(`exceeds pi-goal supported subtask depth \\(${MAX_DEPTH}\\)`));
  });

  it("too-many-tasks above MAX_TASKS", () => {
    const extra = Array.from({ length: MAX_TASKS + 1 }, (_, i) => `- [ ] T-${200 + i} extra`).join("\n");
    const { code, message } = rejectReason(`${PLAN}\n${extra}\n`);
    assert.equal(code, "too-many-tasks");
    assert.match(message, new RegExp(`allows at most ${MAX_TASKS}`));
  });

  it("accepts exactly MAX_TASKS", () => {
    const filler = Array.from({ length: MAX_TASKS - 3 }, (_, i) => `- [ ] T-${200 + i} extra`).join("\n");
    const result = build(`${PLAN}\n${filler}\n`);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.tasks.length, MAX_TASKS);
  });

  it("bad-execution-order for a non-strict declaration", () => {
    const { code, message } = rejectReason(`${PLAN}\nExecution order: semi-strict\n`);
    assert.equal(code, "bad-execution-order");
    assert.match(message, /only 'strict'/);
  });

  it("sisyphus-needs-steps when strict has no numbered steps", () => {
    const { code, message } = rejectReason(`${PLAN}Execution order: strict\n`);
    assert.equal(code, "sisyphus-needs-steps");
    assert.match(message, /no numbered steps/);
  });

  it("objective-too-long above MAX_OBJECTIVE", () => {
    const padding = "y".repeat(MAX_OBJECTIVE);
    const { code, message } = rejectReason(PLAN.replace("Goal: exercise the milestone shape end to end.", `Goal: ${padding}`));
    assert.equal(code, "objective-too-long");
    assert.match(message, new RegExp(`safe adapter limit is ${MAX_OBJECTIVE}`));
  });

  it("contract-too-long above MAX_CONTRACT", () => {
    const long = `- CR-001: ${"z".repeat(MAX_CONTRACT)}`;
    const { code, message } = rejectReason(`${PLAN.replace(/^- CR-.*$/gm, "")}\n${long}\n`);
    assert.equal(code, "contract-too-long");
    assert.match(message, new RegExp(`safe adapter limit is ${MAX_CONTRACT}`));
  });
});