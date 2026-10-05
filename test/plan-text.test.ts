/**
 * Tests for plan-text.ts. String inputs only: no disk, no temp dirs.
 *
 * The fixture text mirrors plans/fixtures/m3-basic-plan.md, which the migrated probe
 * uses, plus variants for each syntax rejection.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePlanText, referencedParents, TASK_ID_RE } from "../plan-text.ts";

const PLAN = `# M-90 Probe gate test

Goal: exercise the milestone shape end to end.

## Context

Prose the reviewer reads.

## Scope

- In: the adapter gate.
- Out: anything else.

## Out of Scope

- Touching other repos.

## Risks / Constraints

- Fixture drift.

## S-01 First story

- Scope: the first slice
- [ ] T-01 Do the first thing
- [ ] T-01.1 Do the sub thing
- [ ] T-02 Do the second thing

## S-02 Second story

- Scope: the second slice
- [ ] T-03 Do the third thing
- [ ] T-04 Do the fourth thing

## Completion Requirements

- CR-001: the first thing works
- CR-002: the second thing works
`;

function parse(text: string) {
  const result = parsePlanText(text);
  if (!result.ok) throw new Error(`fixture must parse: ${result.error.message}`);
  return result.value;
}

describe("parsePlanText structure", () => {
  it("reads the Goal line", () => {
    assert.equal(parse(PLAN).goalLine, "Goal: exercise the milestone shape end to end.");
  });

  it("reads every task checkbox with id, title and depth", () => {
    const { tasks } = parse(PLAN);
    assert.deepEqual(
      tasks.map((t) => [t.id, t.title, t.depth]),
      [
        ["T-01", "Do the first thing", 0],
        ["T-01.1", "Do the sub thing", 1],
        ["T-02", "Do the second thing", 0],
        ["T-03", "Do the third thing", 0],
        ["T-04", "Do the fourth thing", 0],
      ],
    );
  });

  it("accepts checked boxes and alternative bullets", () => {
    const text = PLAN.replace("- [ ] T-01 ", "- [x] T-01 ").replace("Task", "Task");
    const starred = text.replace("- [ ] T-02 ", "* [ ] T-02 ");
    const { tasks } = parse(starred);
    assert.equal(tasks.length, 5);
    assert.ok(tasks.some((t) => t.id === "T-01"));
  });

  it("reads requirement bullets normalized to CR-id plus text", () => {
    assert.deepEqual(parse(PLAN).requirements, [
      "CR-001 the first thing works",
      "CR-002 the second thing works",
    ]);
  });

  it("reads the context sections in Scope, Out of scope, Constraints order", () => {
    const context = parse(PLAN).context;
    assert.match(context, /^Scope: In: the adapter gate\. Out: anything else\./);
    assert.match(context, /\| Out of scope: Touching other repos\./);
    assert.match(context, /\| Constraints: Fixture drift\.$/);
  });

  it("omits context sections that are absent", () => {
    const text = PLAN.replace(/^## Out of Scope$\n\n- Touching other repos\.\n/m, "").replace(
      /^## Risks \/ Constraints$\n\n- Fixture drift\.\n/m,
      "",
    );
    assert.equal(parse(text).context, "Scope: In: the adapter gate. Out: anything else.");
  });

  it("absorbs a stray bullet from a removed heading into the previous section", () => {
    // Preserved M3 quirk: a section slice runs to the next '## ' heading, so removing a
    // heading without its body folds those bullets into the preceding section.
    const text = PLAN.replace(/^## Risks \/ Constraints$\n/m, "");
    assert.match(parse(text).context, /Out of scope: Touching other repos\. Fixture drift\./);
    assert.ok(!parse(text).context.includes("Constraints:"));
  });

  it("has no execution order when the line is absent", () => {
    assert.equal(parse(PLAN).executionOrder, null);
  });

  it("reads the execution order value", () => {
    assert.equal(parse(`${PLAN}\nExecution order: strict\n`).executionOrder, "strict");
  });

  it("keeps the raw text for hashing", () => {
    assert.equal(parse(PLAN).text, PLAN);
  });
});

describe("parsePlanText rejections", () => {
  const cases: Array<[code: string, text: string, pattern: RegExp]> = [
    [
      "missing-goal-line",
      PLAN.replace(/^Goal:.*$/m, ""),
      /no 'Goal:/,
    ],
    [
      "milestone-or-story-id",
      PLAN.replace("- [ ] T-01 ", "- [ ] S-01 "),
      /not an executable task/,
    ],
    [
      "invalid-task-id",
      PLAN.replace("- [ ] T-02 ", "- [ ] TASK-2 "),
      /not a valid task id/,
    ],
    [
      "duplicate-task-id",
      PLAN.replace("- [ ] T-02 ", "- [ ] T-01 "),
      /Duplicate task id 'T-01'/,
    ],
    [
      "empty-task-title",
      PLAN.replace("- [ ] T-02 Do the second thing", "- [ ] T-02"),
      /Task 'T-02' has no title/,
    ],
  ];

  for (const [code, text, pattern] of cases) {
    it(`${code}`, () => {
      const result = parsePlanText(text);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error.code, code);
      assert.match(result.error.message, pattern);
    });
  }

  it("an empty requirement list is not a parse error", () => {
    const text = PLAN.replace(/^[-*]\s*CR-.*$/gm, "");
    const result = parsePlanText(text);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value.requirements, []);
  });
});

describe("task id shape", () => {
  it("accepts T-<nn>, T-<nnn> and sub-steps", () => {
    for (const id of ["T-01", "T-001", "T-99", "T-001.1", "T-12.3.4"]) {
      assert.equal(TASK_ID_RE.test(id), true, id);
    }
  });

  it("rejects M-, S-, lowercase and unpadded ids", () => {
    for (const id of ["M-01", "S-01", "T-1", "t-01", "T-01a"]) {
      assert.equal(TASK_ID_RE.test(id), false, id);
    }
  });

  it("referencedParents lists only ids used as parents", () => {
    assert.deepEqual([...referencedParents(parse(PLAN).tasks)], ["T-01"]);
  });
});