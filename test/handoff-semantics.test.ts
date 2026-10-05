/**
 * Milestone 4: pi-goal handoff semantics must be unchanged by the universal refactor.
 *
 * These tests pin the handoff contract the adapter ships to the agent:
 * - exactly one `plannotator:plan-approved` -> adapter -> public-Pi-API path
 * - the message mandates create_goal (objective+mode) then set_goal_tasks
 *   (block_completion: true) then update_goal paused, in that order
 * - it forbids Goal Drafting, private goal APIs, and direct .pi/goals mutation
 * - task ids, hierarchy, parent links and the objective are passed verbatim; the
 *   model is told not to reinterpret, invent, skip, or rename anything
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHandoffMessage } from "../handoff.ts";
import { buildGoalIR } from "../ir.ts";
import { parsePlanText } from "../plan-text.ts";
import type { GoalIR } from "../types.ts";
import { fixture } from "./helpers.ts";

const plan = fixture("m3-basic-plan.md");

function ir(): GoalIR {
  const parsed = parsePlanText(plan);
  if (!parsed.ok) throw new Error(`fixture must parse: ${parsed.error.message}`);
  const built = buildGoalIR(parsed.value, { planPath: "/plans/M-03.md" });
  if (!built.ok) throw new Error(`fixture must build: ${built.error.message}`);
  return built.value;
}

const msg = buildHandoffMessage(ir());

describe("handoff semantics are preserved", () => {
  it("mandates the three ordered steps: create_goal, set_goal_tasks, pause", () => {
    const c = msg.indexOf("  1. create_goal with objective and mode only.");
    const t = msg.indexOf("  2. set_goal_tasks with the task list and block_completion: true");
    const p = msg.indexOf("  3. update_goal({status: \"paused\"})");
    assert.ok(c >= 0, "step 1 must be create_goal");
    assert.ok(t > c, "step 2 must follow step 1");
    assert.ok(p > t, "step 3 must follow step 2");
    assert.match(msg, /create_goal returns terminate:true/);
    assert.match(msg, /BEFORE doing any[\s\S]*work\./);
    assert.match(msg, /pausing hands control back to the user/);
  });

  it("uses public Pi API tools only — no Goal Drafting, no private goal internals", () => {
    // Only public goal tools are named as actions anywhere in the message.
    for (const t of ["create_goal", "set_goal_tasks", "update_goal", "get_goal"]) {
      assert.ok(msg.includes(t), `message must name the public tool ${t}`);
    }
    // Goal Drafting appears only inside the prohibition list, never as a fallback path.
    assert.match(msg, /\(\/goal-direct, \/sisyphus-direct, \/goal drafting\)\./);
    assert.ok(!/_goalCore|goalCore|writeFileSync|writeFile\(|\.pi\/goals\/(?!.*belong)/.test(msg.replace(/goal drafting\)\..*/, "")));
  });

  it("translates tasks deterministically: ids, hierarchy and objective pass verbatim", () => {
    assert.match(msg, /- T-01 — Add borrow endpoint/);
    assert.match(msg, /- T-01\.1 — Validate stock \(parent_id: "T-01"\)/);
    assert.match(msg, /- T-01\.2 — Write ledger entry \(parent_id: "T-01"\)/);
    assert.match(msg, /- T-02 — Add borrow tests/);
    assert.match(msg, /Objective \(pass verbatim\):/);
    assert.ok(msg.includes(ir().objective), "the objective must appear byte-for-byte");
  });

  it("forbids the model from re-deciding tasks, ids, or the objective", () => {
    assert.match(msg, /Do not reinterpret the plan\./);
    assert.match(msg, /Do not invent tasks\./);
    assert.match(msg, /Do not skip tasks\./);
    assert.match(msg, /Do not rename ids\./);
    assert.match(msg, /Do not create another goal\./);
  });

  it("keeps block_completion: true and the single-line verification contract", () => {
    assert.match(msg, /block_completion: true/);
    assert.match(msg, /Verification contract:/);
    assert.match(msg, /Do not move\nthem into per-task verification_contract fields\./);
  });

  it("requires a stop-and-report instead of a fallback when creation fails", () => {
    assert.match(msg, /If creation or task application fails, STOP and report the exact tool output/);
    assert.match(msg, /Do not retry with/);
  });

  it("confirms after creation via get_goal, then replies with one line", () => {
    assert.match(msg, /verify with get_goal that objective, task ids, parent-child links/);
    assert.match(msg, /reply with a one-line summary\./);
  });
});