# pi-plannotator-goal

A pi extension that turns an approved Plannotator plan into a pi-goal handoff, for any
planning workflow that follows the **Universal Adapter Contract**.

It listens on the `plannotator:plan-approved` event. When a plan is approved it re-reads the
plan from disk, validates it against the contract, translates it deterministically into a
goal IR, checks that no other goal is already open in the pool, and then sends one message
that instructs the agent to create the goal, apply the task list, and immediately pause. It
never executes the plan itself, and it never asks an LLM to reinterpret the plan.

This adapter is designed for the combination **Plannotator + Goal Adapter + pi-goal**: you
plan and get approval with Plannotator, the adapter translates the approved plan into a
pi-goal handoff, and pi-goal owns execution.

The point of the adapter is the refusal paths: a plan that violates the contract, a plan
whose file changed after approval, a payload that does not match the plan on disk, a plan
that breaks a pi-goal limit, or an already-open goal all stop the handoff and report why. No
message is sent and no goal is created in any of those cases.

## Universal Adapter Contract

**Your planning workflow is free. The Universal Adapter does not force how you plan.
However, any plan handed to pi-goal must follow the Universal Adapter Contract.
This contract is the shared language between workflow and adapter.**

In one line: *the workflow may differ, the contract is stable, the adapter does not guess.*

- You are free to invent your own planning workflow. The adapter does not force a planning
  process, and it does not read or interpret your custom instructions to decide what the
  tasks are.
- The plan you hand to the adapter must satisfy the Universal Adapter Contract: a `Goal:`
  line, tasks inside `## S-<nn>` story sections (outside code fences), `CR-<nn>` completion
  requirements, and an optional `Execution order:` declaration. The exact format is the
  source of truth in **`docs/ADAPTER-CONTRACT.md`**.
- The adapter does not depend on `plans/validate.mjs` or on any workflow-specific file. Your
  workflow may keep its own validator as an optional planning-time check; it is never
  required for a handoff.
- If you change the plan format beyond the contract, the adapter **rejects** the plan with a
  clear error rather than guessing.

## Requirements

The adapter reacts to the `plannotator:plan-approved` event, so it needs three things to
be useful:

1. **Plannotator** installed, to plan and approve a plan that emits the event.
2. **pi-goal** installed, to receive the handoff (`create_goal` -> `set_goal_tasks` ->
   `update_goal paused`).
3. A settings file declaring `{"enabled": true}` (project or global scope). Without it the
   adapter stays silent by design.

## Install

Install as a pi package from npm, git, or a local path:

```bash
# from npm (published)
pi install npm:pi-plannotator-goal

# per project instead of user-global
pi install npm:pi-plannotator-goal --local

# from git
pi install git:github.com/birugh/pi-plannator-goal

# from a local checkout
pi install ./pi-plannotator-goal
```

Try it for one invocation without installing:

```bash
pi -e npm:pi-plannotator-goal
pi -e /path/to/pi-plannotator-goal
```

The package declares its extension in `package.json`:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

## Security

Decide for yourself:

> Pi loads extensions with full process permissions. Review the source before
> installing; load only from sources you trust.

This adapter is gated by a settings file, but the same trust rule applies as to any
extension.

## Configuration

Two keys and one kill switch, resolved per key with the project file winning over the global
agent dir file:

- `enabled` (boolean, default false) - only an explicit `true` allows a handoff.
- `logPath` (string, default `<agent dir>/plans/plannotator-goal.jsonl`) - the JSONL sink.

There is no validator key: the adapter does not run an external validator. It validates
the plan against the **Universal Adapter Contract** (`docs/ADAPTER-CONTRACT.md`) and rejects
non-conforming plans with a clear error instead of guessing. Your workflow may keep its own
planning-time validator; that is optional and never required for a handoff.

Project scope is `<cwd>/.pi/plannotator-goal.json`; global scope is
`<agent dir>/plannotator-goal.json`. Full precedence, fallback behavior, and the environment
overrides are in `docs/CONFIG.md`.

## Pipeline

```text
plannotator:plan-approved
  -> validate the event payload
  -> read config (enabled? else stop silently)
  -> defer one macrotask (the event fires while the submit tool is in flight)
  -> resolve the plan path against the event cwd
  -> re-read the plan; refuse if it differs from the approved payload
  -> parse the plan text against the Universal Adapter Contract, then assemble the goal IR
  -> resolve the goal pool and stop if any goal is already open
  -> log the handoff and send the instruction message
```

Each step and its failure modes are described in `docs/PIPELINE.md`.

## The goal pool

Open-goal detection reads the same pool pi-goal-x reads, resolved with the same precedence:
`PI_GOAL_ROOT`, then the project settings, then the global settings, then `<cwd>/.pi/goals`.
Only `active_goal_*.md` files are open; an archived goal is retired and does not block a
handoff. A malformed settings file refuses the handoff rather than guessing the pool. See
`docs/GOALS-POOL.md`.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test "test/*.test.ts"
```

No test touches the real agent dir: each one builds a temp `cwd` and a temp
`PI_CODING_AGENT_DIR`. The module layout, the test layout, and the evidence pairing are in
`docs/DEVELOPMENT.md`.

## Documentation

- `docs/ADAPTER-CONTRACT.md` - the Universal Adapter Contract v1: the source of truth for
  the plan format, what is a task and what is not, and the fail-closed principle.
- `docs/CONFIG.md` - scopes, precedence, defaults, environment overrides.
- `docs/PIPELINE.md` - the stages, the reject reasons, and the handoff contract.
- `docs/GOALS-POOL.md` - pool resolution and open-goal detection.
- `docs/DEVELOPMENT.md` - module map, tests, and how to verify.
- `docs/FINDINGS.md` - numbered findings with evidence, decisions, and rejected options.

## License

MIT — see [`LICENSE`](LICENSE).