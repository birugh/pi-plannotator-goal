# pi-plannotator-goal

A pi extension that turns an approved Plannotator milestone plan into a pi-goal handoff.

It listens on the `plannotator:plan-approved` event. When a plan is approved it re-reads the
plan from disk, re-validates it, translates it into a goal IR, checks that no other goal is
already open in the pool, and then sends one message that instructs the agent to create the
goal, apply the task list, and immediately pause. It never executes the plan itself.

The point of the adapter is the refusal paths: a plan that failed validation, a plan whose
file changed after approval, a payload that does not match the plan on disk, a plan that
breaks a pi-goal limit, or an already-open goal all stop the handoff and report why. No
message is sent and no goal is created in any of those cases.

## Install

The extension is loaded from a directory that pi discovers, either the agent dir or a
project extension directory. It declares its entry point in `package.json`:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

To load it from an arbitrary path without installing:

```bash
pi -e /path/to/pi-plannotator-goal
```

It is enabled per project by a settings file, and it is disabled unless that file says
`{"enabled": true}` explicitly. See `docs/CONFIG.md`.

## Configuration

Two keys and one kill switch, resolved per key with the project file winning over the global
agent dir file:

- `enabled` (boolean, default false) - only an explicit `true` allows a handoff.
- `validatePath` (string, default `<agent dir>/plans/validate.mjs`) - the plan validator.
- `logPath` (string, default `<agent dir>/plans/probes/m3-adapter-log.jsonl`) - the JSONL sink.

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
  -> run the validator (validatePath)
  -> parse the plan text, then assemble the goal IR
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

- `docs/CONFIG.md` - scopes, precedence, defaults, environment overrides.
- `docs/PIPELINE.md` - the stages, the reject reasons, and the handoff contract.
- `docs/GOALS-POOL.md` - pool resolution and open-goal detection.
- `docs/DEVELOPMENT.md` - module map, tests, and how to verify.
- `docs/FINDINGS.md` - numbered findings with evidence, decisions, and rejected options.

## License

Private. Not published.