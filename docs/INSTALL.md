# INSTALL

This document is written for the AI agent running the install prompt, not for a human
following a shell script. The README points here; the prompt tells you to read this file
first and to execute it step by step.

The one rule: **this package is an adapter, not a bundle.** Installing it never installs
Plannotator and never installs a goal extension. You must check the user's pi environment
for both, ask before installing anything the user does not have, and configure what needs
configuring. A silent handoff is the failure mode this whole design exists to prevent, so
verify at the end instead of assuming.

## What the adapter needs

| dependency | why | required |
| --- | --- | --- |
| pi (coding agent) | host for extensions | yes |
| Plannotator (`@plannotator/pi-extension`) | emits `plannotator:plan-approved` | yes |
| a pi-goal extension (`pi-goal-x` or compatible) | receives the handoff (`create_goal` -> `set_goal_tasks` -> `update_goal paused`) | yes |
| `{"enabled": true}` settings file | kill switch; without it the adapter stays silent | yes |
| `goalsRoot` / `PI_GOAL_ROOT` | only if the user relocated the goal pool | no |

## Step 1 - detect the environment

Confirm pi is available, then list what the user already has installed:

```bash
pi --version
pi list
```

`pi list` prints the user packages from the settings file. Read it; do not guess.

Two shortcuts for reading the settings directly, if needed:

- user-global: `~/.pi/agent/settings.json`, key `packages`
- project-local: `<cwd>/.pi/settings.json`, key `packages`

## Step 2 - check Plannotator

Look for `@plannotator/pi-extension` in the Step 1 output.

- Present: nothing to do, go to Step 3.
- Missing: **ask the user first**, then install:

```bash
pi install npm:@plannotator/pi-extension
```

Do not touch Plannotator's own configuration (`<agent dir>/plannotator.json` or
`<cwd>/.pi/plannotator.json`). Those files configure phases, models, and planning tools.
The adapter requires none of them: it only reacts to the `plannotator:plan-approved`
event, which Plannotator emits by default when a plan is approved.

## Step 3 - check the goal extension

Look for `pi-goal-x` (or another goal extension that stores its pool in `<cwd>/.pi/goals`
and exposes `create_goal`, `set_goal_tasks`, and `update_goal`).

- Present: nothing to do, go to Step 4.
- Missing: **ask the user first**, then install:

```bash
pi install npm:pi-goal-x
```

The goal pool needs no configuration by default: pi-goal creates `<cwd>/.pi/goals` on
demand. Only if the user says the pool lives somewhere else, the adapter reads the same
sources pi-goal-x reads, in this precedence:

1. `PI_GOAL_ROOT` environment variable
2. `goalsRoot` in `<cwd>/.pi/pi-goal-x-settings.json`
3. `goalsRoot` in `<agent dir>/pi-goal-x-settings.json`
4. default `<cwd>/.pi/goals`

If the user relocated the pool, verify one of the first three is in place. The adapter
does not write these; it only reads them. A malformed settings file refuses the handoff
rather than guessing, by design.

## Step 4 - install the adapter

```bash
# user-global (default)
pi install npm:pi-plannotator-goal

# per project instead
pi install npm:pi-plannotator-goal --local
```

Offer the `--local` choice only if the user has a project context; do not install both
scopes. For a local checkout or git source, see the alternatives in the README's Install
section.

## Step 5 - enable the adapter (the step people forget)

The adapter refuses every handoff unless a settings file says `{"enabled": true}`. It
reads two scopes, project winning over global:

| scope | path |
| --- | --- |
| project | `<cwd>/.pi/plannotator-goal.json` |
| global | `<agent dir>/plannotator-goal.json` (`~/.pi/agent/plannotator-goal.json` normally) |

Decide the scope with the user (global = every project, project = this repo only), check
whether the file already exists, and write or merge:

```json
{
  "enabled": true
}
```

Rules:

- If the file exists, merge the key; never clobber other keys such as `logPath`.
- `enabled` must be the literal boolean `true`. The string `"true"` is deliberately not
  coerced and keeps the adapter silent.
- Unknown keys are tolerated, so a `_comment` field is fine.

Optional, only when the user asks: `logPath` (string) moves the JSONL handoff log, which
defaults to `<agent dir>/plans/plannotator-goal.jsonl`.

## Step 6 - verify

1. Re-run `pi list` and confirm `pi-plannotator-goal` appears.
2. Show the resolved settings file path and its `enabled` value.
3. Tell the user: extensions load at startup, so a **new pi session** (or a restart) is
   needed before the adapter is live.
4. End state to confirm: approve a plan in Plannotator, and one line lands in the JSONL
   log plus a goal appears in the pool. A refusal (contract violation, changed plan file,
   open goal) logs a `Reason:` and creates nothing - that is the adapter working, not
   failing.

## Refusal paths - do not "fix" these by loosening the config

The adapter stops, logs, and notifies on purpose when: the plan violates the Universal
Adapter Contract (`docs/ADAPTER-CONTRACT.md`), the plan file changed after approval, the
payload does not match the file on disk, a pi-goal limit breaks, or a goal is already open
in the pool. Never edit the settings file, the plan, or the pool to force a handoff
through. Report the `Reason:` to the user and let them decide.

## Security note

Pi loads extensions with full process permissions. If the user hesitates, point them at
the source of this package before installing, and never install an extension they did not
ask for.
