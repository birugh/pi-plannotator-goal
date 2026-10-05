/**
 * Tests for plan-text.ts. String inputs only: no disk, no temp dirs.
 *
 * The fixture text mirrors plans/fixtures/m3-basic-plan.md, which the migrated probe
 * uses, plus variants for each syntax rejection.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONTRACT_VERSION, parsePlanText, referencedParents, TASK_ID_RE } from "../plan-text.ts";

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

describe("Universal Adapter Contract v1 section-awareness", () => {
  it("exposes the contract version the parser implements", () => {
    assert.equal(CONTRACT_VERSION, "v1");
  });

  it("never turns a checkbox inside Notes into a task", () => {
    const text = PLAN.replace(
      "## Context\n\nProse the reviewer reads.",
      "## Context\n\nProse the reviewer reads.\n- [ ] T-99 This is a note, not a task",
    );
    const { tasks } = parse(text);
    assert.ok(!tasks.some((t) => t.id === "T-99"), "a Notes checkbox is not a task");
    assert.equal(tasks.length, 5, "only the S-section tasks survive");
  });

  it("never turns a checkbox inside a fenced code block into a task", () => {
    const text = `${PLAN}\n\n## Documentation\n\n\`\`\`markdown\n- [ ] T-98 Example checkbox in a fence\n\`\`\`\n`;
    const { tasks } = parse(text);
    assert.ok(!tasks.some((t) => t.id === "T-98"));
    assert.equal(tasks.length, 5);
  });

  it("ignores checkboxes in an unknown/unrelated section", () => {
    const text = `${PLAN}\n\n## References\n\n- [ ] T-97 Reference material\n`;
    const { tasks } = parse(text);
    assert.ok(!tasks.some((t) => t.id === "T-97"));
    assert.equal(tasks.length, 5);
  });

  it("treats a checkbox-style line inside a code fence as prose (no reject)", () => {
    const text = `${PLAN}\n\n\`\`\`text\n- [ ] shorthand example\n\`\`\`\n`;
    const result = parsePlanText(text);
    assert.equal(result.ok, true, "content inside a fence must not reject");
    if (result.ok) assert.equal(result.value.tasks.length, 5);
  });

  it("rejects a checkbox-shaped line stranded before any top-level section", () => {
    const text = `- [ ] T-96 orphaned\n\n${PLAN}`;
    const result = parsePlanText(text);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "stranded-checkbox");
  });

  it("malformed-task for a checkbox that does not match the task form inside a task section", () => {
    const text = PLAN.replace("- [ ] T-02 Do the second thing", "- [ ] T-02");
    const empty = parsePlanText(text);
    assert.equal(empty.ok, false);
    if (empty.ok) return;
    assert.equal(empty.error.code, "empty-task-title", "checkbox with an empty title is empty-task-title");

    // A checkbox whose closing bracket touches the id does not match the strict task
    // form at all; the parser rejects it rather than guessing (contract: no mending).
    const bad = PLAN.replace("- [ ] T-02 Do the second thing", "- [X]T-02 no space");
    const mal = parsePlanText(bad);
    assert.equal(mal.ok, false);
    if (mal.ok) return;
    assert.equal(mal.error.code, "malformed-task");
  });

  it("parses CRLF and LF identically", () => {
    const crlf = PLAN.replace(/\n/g, "\r\n");
    const parsed = parse(crlf);
    assert.equal(parsed.tasks.length, 5);
    assert.equal(parsed.goalLine, "Goal: exercise the milestone shape end to end.");
    assert.equal(parsed.requirements.length, 2);
  });

  it("ignores content inside tildes fences as prose", () => {
    const text = `${PLAN}\n\n~~~text\n- [ ] T-95 tilde example\n~~~\n`;
    const result = parsePlanText(text);
    assert.equal(result.ok, true);
    if (result.ok) assert.ok(!result.value.tasks.some((t) => t.id === "T-95"));
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