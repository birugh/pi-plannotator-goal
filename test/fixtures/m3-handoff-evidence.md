# M3.2 runtime handoff evidence

Session: one real TUI session in `tmux` session `m3probe`:
`pi --plan --extension /home/biru/.pi/agent/plans/probes/m3-handoff-probe.ts`
(`mode=tui`, `hasUI=true` — proven by the `session-start` line in `m3-handoff-evidence.jsonl`).

Session log: `sessions/--home-biru-.pi-agent--/2026-10-04T13-49-56-121Z_01a1072d-ac18-7636-a308-4c1780f00387.jsonl`
(line `L<n>` below refers to this file). Machine evidence: `plans/probes/m3-handoff-evidence.jsonl`.

Probe goal created: `mutvvtbc-z24zn2`
(`.pi/goals/active_goal_2026100420555172_mutvvtbc-z24zn2.md`).

---

## Test F — event handoff (`plan-approved` → deferred → `sendUserMessage`)

Raw payload `m3-handoff-evidence.jsonl`:

```json
{"kind":"plan-approved-sync","planFilePath":"plans/M-90-probe-gate-test.md","feedback":null,"sessionCtxCached":true,"isIdleAtSync":false}
{"kind":"handoff-deferred","isIdleAtDeferred":false,"deliverAs":"steer"}
{"kind":"sendUserMessage-sent","deliverAs":"steer"}
```

FACT:

1. Event arrived while agent was **busy**: `isIdleAtSync=false`. Matches M2 timing (emit inside
   `execute()` submit; `terminate: true` `@plannotator/pi-extension/index.ts:1356`, `:1415`).
2. `setImmediate` still `isIdleAtDeferred=false` (sync→deferred gap 4 ms) → **deferring one macrotask
   is not enough** to get `isIdle()===true` on this path.
3. `deliverAs` was chosen from measured value, not assumption → `"steer"`.
4. Message actually arrived: transcript `L19` (message arrives as user turn) → `L20` assistant
   answers `HANDOFF-RECEIVED`. No tool called on that turn.

U-2, U-3, U-9 **closed**:

- U-2: event handler does not call any UI; `setImmediate` is safe enough for
  `sendUserMessage` (no deadlock, message sent, agent continues).
- U-3: cached ctx from `session_start` (`pi.events.on` only receives `data`, see
  `plans/probes/m2-probe.ts:115`) has an `isIdle()` that works at event time.
- U-9: `steer` is the correct choice for the measured condition; `followUp` has **not** been proven
  necessary or harmful (not tested → still partial UNKNOWN, see below).

## Test A — `create_goal` → `set_goal_tasks` → human confirmation → tree persisted

| Step | Evidence |
|---|---|
| `create_goal` called | transcript `L24` (`toolCall create_goal`) |
| goal created + focused | `L25` custom entry `{"focusedGoalId":"mutvvtbc-z24zn2","reason":"created"}` |
| create report | `L26` `"Goal confirmed and created. Finalized goal: ..."` + line `other open goal remain in .pi/goals — this goal is now the session focus.` |
| `set_goal_tasks` called | `L29` |
| human confirmation dialog appears | capture pane: dialog `Task list confirmation`, list `T-01`/`T-01.1`/`T-02`, footer `Confirm task list` \| `Keep current tasks`, `blockCompletion enabled` |
| accept (Enter by user) | `L30` toolResult `"Task list set and confirmed. 3 tasks. (blockCompletion enabled)"` |
| tree persisted | goal file: `taskList.tasks = ["T-01","T-02"]` (T-01 has child `T-01.1`), `blockCompletion: true` |

FACT: the two-tool path works end-to-end in a real UI session, and gate 2 is genuinely human
(native pi-goal dialog, not auto-confirm; `PI_GOAL_AUTO_CONFIRM` was never set —
`env | grep PI_GOAL` empty).

## Test B — `terminate: true` (U-1) — **closed**

Transcript order:

```text
L22 user      instruction "SAME turn, two calls"
L24 assistant toolCall create_goal
L25 custom    focusedGoalId ... reason created
L26 toolResult "Goal confirmed and created..."
L27 system    (boundary)
L28 custom_message <pi_goal_continuation goal_id=mutvvtbc-z24zn2 kind=checkpoint v=2/>
L29 assistant toolCall set_goal_tasks
L30 toolResult "Task list set and confirmed. 3 tasks."
```

FACT: there is a `system` boundary + `pi_goal_continuation` checkpoint **between** the two tool calls.
So `terminate: true` (`goal-core-tools.ts:228`) ends the batch: `set_goal_tasks` only runs after the
checkpoint continuation, **not** in the same turn/step.

Consequence for adapter (D-12): the two-step handoff **cannot** be sent as one batch of tools;
the agent must continue via continuation, and the task dialog happens on the continuation step.
The "goal active without task tree" window (I-1) is therefore real and measured, not theoretical.

## Test C — depth (U-4) — **closed**

| Call | Result |
|---|---|
| `L39` `T-01`, `T-01.1`, `T-01.1.1` | `L40` toolResult `Task "T-01" has subtask nesting depth 2, exceeding the configured maximum of 1` — no dialog, no mutation |
| `L41` `T-01`, `T-01.1` | dialog appears (`L42` waits for human decision) |

FACT: `subtaskDepth=1` rejects `T-01.1.1` at runtime; the pi-goal error message matches exactly what
was predicted from source (`goal-task-tools.ts:135-137`). No setting was changed.

## Test D — dialog reject — **closed**

`L41` `set_goal_tasks` (2 tasks) → dialog shown → **Esc = `Keep current tasks`** by user.

- `L42` toolResult: `"Task list kept unchanged."`
- Goal file after reject: `taskList.tasks = ["T-01","T-02"]`, `blockCompletion: true`,
  `revision: 20`, `status: paused`.

FACT: reject = zero mutation (not partial). Matches `goal-task-tools.ts:336-340`.

Important note (not a bug, but UX fact): the agent **does not see** the reject dialog. The tool
result comes as `Task list kept unchanged.` without any marker that a human rejected the dialog,
so the agent concludes "no dialog appeared". The adapter must not depend on the agent to distinguish
"human rejected" vs "dialog unavailable" — the same message can mean either (compare
`goal-task-confirmation.ts:41` `ui.select` missing → `cancel`).

Timing: `L41` 14:02:07.551 → `L42` 14:03:33.448 = **86 seconds** waiting for human decision;
decision duration is unbounded (U-11 from M2 still holds: adapter must not timeout).

## Test E — existing goal detected (U-10) — **closed**

Three public paths, all observed:

1. `pi-goal-x` banner at session start: `1 open goal is available. Run /goal-focus to choose the
   goal for this session.` with status bar `goal: unfocused [1 open]`.
2. `create_goal` report (`L26`): `other open goal remain in .pi/goals — this goal is now the
   session focus.`, and probe goal status bar: `(+1 open)`.
3. Operator `/goal-list` (run in probe session):

```text
Open goals: 2
  mutt0yeo-txzlrv — running · goal · 45m45s · 933K
  Selesaikan M3 Goal Adapter (M3.1→M3.5, STOP+report ...)
  ...activePath
```

FACT: the condition "existing open goal that does not belong to this plan" can be detected without
private API: focus banner/prompt, create report, and `/goal-list` are all public surfaces. D-14
(STOP + REPORT + user chooses) can therefore be enforced using the above data, including the
`activePath` needed for the report.

INFERENCE (path boundary): the adapter **cannot** read the goal pool itself (without `_goalCore`).
So steps 1–2 of D-14 are executed by the **agent** on adapter instruction (the message contains the
command "report any other open goal before create"), or by the adapter only as text instruction — not
as adapter state reading. This is a boundary consequence, not a temporary limitation.

## U-5 — merge when structure changes: not tested

Not run (outside Tests A–E; session token cost high). Status: **UNKNOWN** carried to
M3.3/M4; source path still `mergeTasksWithExisting` (`goal-task-tools.ts:148-185`,
`tasks.ts` call `:350-351`) and D-10 is unaffected because plan approval is frozen.

## U-11 — `deliverAs: followUp` has not been tested

`steer` works for the measured condition. `followUp` untested → still UNKNOWN.
Temporary adapter rule: `ctx.isIdle() ? "followUp" : "steer"` (pattern from
`goal-drafting.ts:182`), with the note that on the `plan-approved` path the measured value is always
`false` (Test F).

---

## Reproduction commands

```bash
tmux new-session -d -s m3probe "pi --plan --extension /home/biru/.pi/agent/plans/probes/m3-handoff-probe.ts"
# Test F: submit plans/M-90-probe-gate-test.md, approve at http://127.0.0.1:<random port>/
#   port: ss -ltnp | grep "pid=$(tmux list-panes -t m3probe -F '#{pane_pid}'),"
#   (two ports: 73xx = pi-web-ui, 35xxx = review browser)
# Test A/B/C/D: tool instructions in the same pane; dialog answered by user (Enter / Esc)
# Test E: /goal-list in the same pane
```

Limitation: fragile if port/prompt changes; quoted numbers (revision, task id, timestamp) were taken
from the M3.2 file/session and are not hardcoded in the source.
