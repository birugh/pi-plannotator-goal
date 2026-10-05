# GOALS-POOL

How the adapter finds the pi-goal pool, and which goals in it count as open.

## Why this module exists

The original M3 adapter hardcoded `join(cwd, ".pi", "goals")`. pi-goal-x can relocate its
pool through a `goalsRoot` setting or the `PI_GOAL_ROOT` environment variable. When the pool
was relocated, the adapter looked in the wrong directory: open-goal detection silently found
nothing and the handoff proceeded against a pool it could not see.

`goals-pool.ts` resolves the pool the same way pi-goal-x resolves it, and refuses the handoff
when it cannot be resolved confidently.

## Precedence

Copied from pi-goal-x (`extensions/goal-settings.ts`, `extensions/storage/goal-root.ts`):

| order | source | value |
| --- | --- | --- |
| 1 | environment | `PI_GOAL_ROOT` |
| 2 | project settings | `<cwd>/.pi/pi-goal-x-settings.json`, key `goalsRoot` |
| 3 | global settings | `<agent dir>/pi-goal-x-settings.json`, key `goalsRoot` |
| 4 | default | `<cwd>/.pi/goals` |

Each layer is read per key, so a project file that does not mention `goalsRoot` falls through
to the global file, exactly as pi-goal-x resolves a leaf setting.

## Settings file path overrides

The two file paths themselves can be redirected, and both overrides are honored:

| variable | effect |
| --- | --- |
| `PI_GOAL_SETTINGS_FILE` | replaces the project settings path; relative resolves against `cwd` |
| `PI_GOAL_GLOBAL_SETTINGS_FILE` | replaces the global settings path; relative resolves against the home directory |

These exist because pi-goal-x supports them, and an adapter that ignored them would read a
different settings file than the pool actually uses.

## Value validation

A candidate root is validated the way pi-goal-x validates it:

- a leading `~` or `~/` is expanded against the home directory
- the result must be an absolute path
- the value must not contain a NUL byte
- if the path exists, it must not be a symlink; an existing directory is canonicalized with
  `realpath`
- a path that does not exist yet is accepted, because pi-goal-x creates the pool on demand

A value that fails any of these refuses the handoff with `goals-root-invalid`.

## Malformed settings refuse

When a settings file exists but is not valid JSON, or is not a JSON object, or declares
`goalsRoot` with a non-string or empty value, the adapter refuses the handoff instead of
falling back to the default pool.

This is stricter than pi-goal-x, which reports such a file as a diagnostic and keeps the
valid keys. The difference is deliberate: a diagnostic is right for settings that degrade
gracefully, but a handoff made against a guessed pool would create a goal in a pool the user
is not looking at. Refusing is the recoverable outcome.

The refusal message names the offending file and says the pool will not be guessed.

## Which goals are open

Only `active_goal_*.md` files in the resolved root are candidates. The name pattern is
`ACTIVE_GOAL_FILE_RE` in `goals.ts`.

Everything else in the pool is ignored without being read: `goal_events.jsonl`, the ledger
checkpoint, the pool snapshot, the lock directory, and any metadata directory.

An archived goal is retired. `archived/` is not scanned at all, because pi-goal-x reads open
goals from the active pool only (`extensions/storage/goal-files.ts`, where
`scanActiveGoalFiles` matches the active filename pattern inside the goals root and never
descends into `archived/`). Scanning `archived/*.md` made the earlier adapter stop before
handoff on goals the user had already retired.

A candidate is open when its header has an `id` and its `status` is not `complete`.

## Header parsing

A goal file is a JSON header, a blank line, then a body that begins with `# Goal Prompt`. The
header is validated with a typebox schema; a file whose header cannot be parsed is skipped
rather than reported, because a stray file in the pool must not block a handoff.

Two attempts are made, matching the shipped behavior: the prefix up to the first blank line
first, then the whole prefix before the body marker as a fallback.

## The stop report

When at least one goal is open, the adapter sends no message and reports instead. The report
names the plan path and every open goal with its id, status, title, and active path, then
offers the three user actions:

```text
/goal-focus <id>   work on that goal instead
/goal-unfocus      leave it open, unfocus it
/goal-clear        archive it and free the pool
```

## Verification

`test/goals-pool.test.ts` is a decision table over environment, project, global, and default
sources; both settings path overrides; and every refusal: malformed JSON, a non-object
document, a non-string value, an empty string, a relative path, a NUL byte, and a symlink. It
also covers pool scanning, the archived-goal rule, header parsing, and the stop report.

Each case builds its own temp `cwd` and temp agent dir. The real `~/.pi/agent` is never read.