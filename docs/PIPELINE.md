# PIPELINE

What happens between the approval of a plan and the moment the agent is told to create the
goal.

## Trigger

The extension subscribes to `plannotator:plan-approved` on the pi event bus. The event
carries `cwd`, `planFilePath`, `planContent`, and optionally `feedback`. The payload is
validated with a typebox schema before any field is read; there is no blind type assertion.

## Stages

Each stage either advances or refuses. A refusal sends nothing and creates nothing.

1. Validate the payload. A payload that is not an object-shaped match, or one without `cwd`
   and `planFilePath`, is refused. The plan path is resolved against the event `cwd`.
2. Read config for the event `cwd`. When `enabled` is not literally `true`, the adapter logs
   a `skip` line and stops. This is the normal state of an unconfigured project.
3. Defer one macrotask with `setImmediate`. The event is emitted from inside the submit
   tool's execute, while the agent is still streaming, so `isIdle()` reads `false` at event
   time. Deferring past one macrotask is what makes the idle reading meaningful.
4. Re-read the plan from disk. An unreadable file is refused.
5. Compare the file with `planContent` when the payload carries it. A mismatch means the
   approved bytes are not the bytes on disk, so the handoff is refused rather than
   translated from either one.
6. Run the validator at `validatePath`. A non-zero exit refuses and quotes its output.
7. Parse the plan text: the `Goal:` line, task checkboxes with their implied depth, the
   requirement bullets, the optional `Execution order:` declaration, and the context
   sections.
8. Assemble the goal IR: apply the pi-goal limits, build the objective and the single-line
   verification contract, and compute the plan fingerprint.
9. Resolve the goal pool and read the open goals. Any open goal refuses the handoff and
   reports the pool.
10. Log the handoff and send one instruction message.

## Refusal codes

`RejectReason.code` is machine-readable; the message is the human sentence shown in the
session notification and written to the log.

| code | raised by | meaning |
| --- | --- | --- |
| `bad-payload` | config | the event payload did not match the schema, or had no cwd/planFilePath |
| `plan-unreadable` | index | the plan file could not be read from disk |
| `plan-changed` | index | the file differs from the approved payload |
| `validator-failed` | index | the external validator exited non-zero |
| `missing-goal-line` | plan-text | no `Goal: <outcome>` line |
| `milestone-or-story-id` | plan-text | an M- or S- id appeared in a task checkbox |
| `invalid-task-id` | plan-text | the id is not `T-<nn>` or `T-<nn>.<m>` |
| `duplicate-task-id` | plan-text | the same task id appears twice |
| `empty-task-title` | plan-text | a task checkbox has no title |
| `no-tasks` | ir | there is no task checkbox at all |
| `task-too-deep` | ir | a sub-task is nested deeper than `MAX_DEPTH` |
| `too-many-tasks` | ir | more tasks than `MAX_TASKS` |
| `missing-parent` | ir | a sub-task references an id that is not a task in the plan |
| `no-requirements` | ir | there is no `CR-<nn>: <text>` bullet |
| `objective-too-long` | ir | the objective exceeds `MAX_OBJECTIVE` characters |
| `contract-too-long` | ir | the contract line exceeds `MAX_CONTRACT` characters |
| `bad-execution-order` | ir | the declaration is not the supported `strict` |
| `sisyphus-needs-steps` | ir | `strict` was declared but the objective has no numbered steps |
| `goals-root-invalid` | goals-pool | the pool settings are malformed, or the value is not absolute, contains NUL, or is a symlink |

Refusals are values, not exceptions: every helper returns `Result<T, RejectReason>`.

## Limits

These are the pi-goal limits the adapter enforces. They are named constants in `ir.ts`
because they are the reason a creation payload is accepted or rejected.

| constant | value | applies to |
| --- | --- | --- |
| `MAX_TASKS` | 50 | task count |
| `MAX_DEPTH` | 1 | sub-task nesting, so only `T-<nn>.<m>` is allowed |
| `MAX_OBJECTIVE` | 1400 | characters in the objective |
| `MAX_CONTRACT` | 700 | characters in the single-line contract |

## The goal IR

`buildGoalIR` produces:

- `objective`: the `Goal:` line, the context sections (`Scope`, `Out of scope`,
  `Constraints`), and the contract line, separated by blank lines. The context is folded into
  the objective because pi-goal takes one objective string.
- `mode`: `regular`, or `sisyphus` when the plan declared `Execution order: strict`.
- `tasks`: roots and sub-tasks, with `parentId` resolved and validated.
- `verificationContract`: one line, `Verification contract: ` followed by the requirement
  bullets joined with `; `.
- `blockCompletion`: always `true`. The confirmation dialog stays with the user.
- `changeSummary`: the reviewer note, capped at 240 characters, never folded into the
  objective.
- `source`: the resolved plan path and a 16-character SHA-256 fingerprint of the exact text.

## The handoff message

The message is a contract with the model, not prose. It instructs, in order:

1. `create_goal` with the objective and mode only. This returns `terminate: true`, so the
   task list can only be applied on the continuation turn.
2. `set_goal_tasks` with the task list and `block_completion: true`. The confirmation dialog
   is the user's; the agent must not preselect it.
3. `update_goal({status: "paused"})` immediately after the list is applied, before any work.

It also forbids reinterpreting or renaming anything, forbids creating a second goal, and
requires the agent to stop and report if creation or task application fails, without trying
another creation path.

If another goal is already open, the message is not sent at all: the adapter stops earlier,
at stage 9, and asks the user to choose.

## Delivery

`deliverAs` is `followUp` when the cached session context reports idle at the deferred
moment, otherwise `steer`. The value is measured, not assumed, and it is recorded in the
handoff log line so the choice is auditable.