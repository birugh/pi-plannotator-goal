# Adapter Contract v1

This document is the **source of truth for the plan format** the Universal Goal Adapter
accepts. A plan is the Markdown file a workflow produces after its planning phase, and the
file that `plannotator:plan-approved` carries into the adapter.

The Universal Adapter has a standard format. Any workflow may plan however it wants, but
the plan it hands to the adapter must satisfy this contract. The adapter reads the contract,
nothing else: it does not reinterpret the plan's intent, it does not ask an LLM to re-read
it, and it does not guess. When the contract is not met, the adapter STOPS and reports why.

## The principle

> Workflow planning Anda bebas. Universal Adapter tidak memaksa bagaimana Anda melakukan
> planning. Namun plan yang ingin diteruskan ke pi-goal harus mengikuti Universal Adapter
> Contract. Contract ini adalah bahasa bersama antara workflow dan adapter.

In one line: **the workflow may differ, the contract is stable, the adapter does not guess.**

## Versioning

The contract is versioned. This document defines **Adapter Contract v1**. The parser
exports the version it implements as `CONTRACT_VERSION` so the code and this document
cannot silently drift apart. A future change to the accepted format is a new contract
version, never a quiet parser tweak.

## Plan structure

A compliant plan is a Markdown file with exactly these responsibilities:

| Element | Syntax | Required | Becomes |
| --- | --- | --- | --- |
| Goal line | `Goal: <outcome>` | yes | the objective heading |
| Task sections | `## S-<nn> <title>` | at least one | task-bearing scope |
| Task lines | `- [ ] T-<nn> <title>` | at least one | pi-goal tasks |
| Sub-tasks | `- [ ] T-<nn>.<m> <title>` | optional | nested pi-goal tasks |
| Requirement bullets | `- CR-<nn>: <text>` | at least one | the verification contract |
| Execution mode | `Execution order: strict` | optional | sisyphus mode |
| Context sections | `## Scope`, `## Out of Scope`, `## Risks / Constraints` | optional | objective context |
| Everything else | headings, prose, notes | - | ignored, never tasks |

The adapter's job is to translate this structure deterministically. It never decides what
the tasks are; the plan's structure decides.

## What is a task

A line becomes a task **if and only if** all of these hold:

1. The line is a checkbox: `- [ ] `, `- [x] `, `- [X] `, or the same with `* `.
2. The checkbox sits **inside a task section** (see below).
3. The checkbox is **not inside a fenced code block**.
4. The id after the checkbox is a valid task id: `T-<nn>` or `T-<nn>.<m>`, where `<nn>` is
   two or three digits and `<m>` is one or more digits.
5. The title after the id is non-empty.

Checked boxes (`- [x]`) are tasks exactly like unchecked ones. The checkbox state carries no
meaning for the adapter.

## Task sections

A **task section** is a top-level heading matching

```
## S-<nn> <title>
```

case-insensitively on the `S-` marker, with `<nn>` one or more digits. These are the story
sections. The title is any text and is not interpreted.

No other heading shape is a task section. In particular `## Tasks`, `## Milestones`,
`## Plan`, and any heading the workflow invents are **not** task sections: their checkboxes
are never tasks. A workflow that wants its tasks translated must emit them inside
`## S-<nn>` sections. That is the shared language between workflow and adapter.

## What is NOT a task

The adapter never turns these into tasks:

- checkboxes inside any non-task section: `## Notes`, `## Documentation`, `## Context`,
  `## Scope`, `## Out of Scope`, `## Risks / Constraints`, `## Completion Requirements`,
  `## References`, `## Appendix`, or any other top-level heading that is not `## S-<nn>`;
- checkboxes inside fenced code blocks (```` ``` ```` or `~~~`), regardless of the section;
- checkboxes inside blockquotes or indented code;
- checkbox-like text outside any top-level section (see "Malformed content");
- prose, tables, inline code, or any non-checkbox line anywhere.

A non-task section may hold checkbox-like examples for documentation purposes; the adapter
ignores them by definition and does not reject the plan for them.

## Nested tasks

A sub-task id `T-<nn>.<m>` is a child of the root task `T-<nn>`, regardless of which task
section it appears in. Parentage is by id only.

- The parent root `T-<nn>` must itself exist as a task line. A sub-task whose root is absent
  is a missing-parent rejection.
- pi-goal supports one level of nesting (`MAX_DEPTH` = 1). A id with two or more dots,
  `T-<nn>.<m>.<k>`, exceeds the depth and is rejected.
- Nesting is expressed only through the dotted id. Indentation of the checkbox line is not
  significant and is not read.

## Id rules

- A task id is case-sensitive, zero-padded, two or three digits: `T-01`, `T-001`, `T-99`.
  `T-1` (unpadded), `t-01` (lowercase), and `T-01a` (suffix) are invalid.
- **Duplicate id**: the same id appearing on more than one task line rejects the plan.
- **Missing id**: a checkbox with no id at all (`- [ ] Do the thing`) rejects the plan. The
  adapter does not mint ids.
- **Misplaced ids**: a checkbox whose id is `M-<nn>` or `S-<nn>` inside a task section is a
  milestone/story id, not an executable task, and rejects the plan.

## Unknown and malformed content

The parser is fail-closed. Any of these rejects the plan, sends no message, and creates no
goal:

- no `Goal: <outcome>` line;
- no task section at all;
- a checkbox-shaped line **outside** any top-level section (before the first `## ` heading,
  or in a trailing region). The parser cannot say whether such a line is a task, so it stops
  rather than guesses;
- inside a task section: a checkbox with an invalid id, a duplicate id, an empty title, or a
  `T-<nn>.<m>` sub-task whose root task is missing;
- a task section with a checkbox line that does not match the task shape at all (for example
  a checkbox with a long dash id or a leading space that breaks the form). The parser does
  not repair, normalize, or reinterpret such lines.

An unknown top-level section that is not `## S-<nn>` is prose by definition: never a task
source, never a rejection on its own.

## Requirements and the verification contract

Requirement bullets are `- CR-<nn>: <text>` anywhere in the plan, with `<nn>` two or three
digits. They are collected in file order and joined into one line:

```
Verification contract: CR-001 <text>; CR-002 <text>; ...
```

At least one requirement is required. The contract line is capped (see `MAX_CONTRACT`).
Requirements are part of this contract version.

## Execution mode

- No `Execution order:` line, or an `Execution order: regular` line, means **regular** mode.
- `Execution order: strict` means **sisyphus** mode, and the objective must then contain
  numbered steps (pi-goal rejects a sisyphus objective without them).
- Any other value on the `Execution order:` line rejects the plan.

## Context sections

`## Scope`, `## Out of Scope`, and `## Risks / Constraints` (case-insensitive headings) are
folded into the objective as `Scope: ...`, `Out of scope: ...`, `Constraints: ...`. They are
prose for the objective; their checkboxes are never tasks.

## Objective assembly

The goal objective is built deterministically:

```
<Goal line>

<context sections>

Verification contract: <requirements joined with '; '>
```

The task list, task ids, parent links, mode, and objective are all taken from the plan
structure. Nothing in this assembly is decided by an LLM.

## Fail-closed behavior

> If the adapter cannot understand an essential part of the plan, it STOPS. It never
> guesses, and it never asks an LLM to reinterpret the plan.

"Essential part" means the goal line, the task sections, the task lines, the ids, or the
requirements. A plan that fails the contract produces a typed refusal with a message naming
the failing element, and the session stays untouched: no message is sent, no goal is
created.

## Workflow validators

A workflow MAY run its own validator (for example `plans/validate.mjs`) as an additional
check during its planning phase. That is workflow-level validation and is never a
dependency of the adapter. The adapter's own contract validation above is the only
validation the handoff requires. Workflow-specific rules live in the workflow; they are not
moved into this contract, and this contract is not extended to encode them.

## Contract checklist

A plan satisfies Adapter Contract v1 when:

- [ ] it has a `Goal: <outcome>` line;
- [ ] every task checkbox sits inside a `## S-<nn>` section and outside code fences;
- [ ] every task id is `T-<nn>` or `T-<nn>.<m>`, unique, and its parent exists;
- [ ] at least one `CR-<nn>: <text>` requirement exists;
- [ ] no checkbox-shaped line is stranded outside a top-level section;
- [ ] `Execution order:` is absent, `regular`, or `strict`;
- [ ] the author accepts that the adapter will STOP instead of guessing on anything else.