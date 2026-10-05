# DEVELOPMENT

## Module map

Nine TypeScript modules at the repository root. `package.json` points pi at `index.ts`.

| module | responsibility |
| --- | --- |
| `types.ts` | shared types: `GoalIR`, `TaskIR`, `OpenGoal`, `Result`, `RejectReason`, the `RejectCode` union, and the `ok`/`fail`/`reject` constructors |
| `config.ts` | untrusted boundaries: the settings schema, the event payload schema, config resolution, agent dir and default path resolution |
| `log.ts` | JSONL logger bound to a path, with a call-time timestamp |
| `plan-text.ts` | pure plan parsing: `Goal:` line, task checkboxes, requirement bullets, execution order, context sections |
| `ir.ts` | pi-goal limits and IR assembly: `buildGoalIR` returning `Result<GoalIR, RejectReason>` |
| `goals-pool.ts` | pool resolution: `goalsRoot` precedence, settings path overrides, value validation |
| `goals.ts` | pool reading: which files are open goals, header parsing, the existing-goal report |
| `handoff.ts` | the two messages: the handoff instruction and the rejection notice |
| `index.ts` | the factory: wiring, ordering, and the only place with I/O side effects |

## Design rules

Two rules hold across every module, and both come out of M3 findings.

Rejection is a value, not an exception. The original adapter threw `RejectError` across
module boundaries and caught it in the caller. Helpers now return
`Result<T, RejectReason>`, so a refusal is data the caller logs, not control flow it has to
guess at. There is no `RejectError` class any more.

Untrusted input is validated, never asserted. The original adapter cast the event payload
with `as {...}` and parsed config JSON and then asserted its shape. Both boundaries now have a
typebox schema, and the TypeScript type is inferred from the schema with
`Static<typeof Schema>`, so the runtime check and the compile-time type cannot drift. There is
no blind `as` at any boundary.

## Tests

```bash
npm test            # node --test "test/*.test.ts"
npm run typecheck   # tsc --noEmit
```

The glob matters: `node --test` with no glob also collects `test/helpers.ts` and the fixtures
under `test/fixtures/`, which are not tests.

| file | covers |
| --- | --- |
| `test/config.test.ts` | enabled truth table, scope precedence, malformed and wrongly typed files, overrides, payload validation |
| `test/plan-text.test.ts` | parsing structure, the context-section rule, task id shape, syntax rejections |
| `test/ir.test.ts` | IR acceptance, every reject reason, exact-limit boundaries |
| `test/goals-pool.test.ts` | the pool decision table and every refusal, pool scanning, the stop report |
| `test/factory.test.ts` | the factory end to end through a fake host, including steer vs followUp |
| `test/m3-adapter-check.test.ts` | port of the M3 pure-check probe |
| `test/m3-adapter-skip-check.test.ts` | port of the M3 skip/reject probe |
| `test/m3-failure-cases.test.ts` | port of the M3 failure-case probe, nine cases plus two live runs |
| `test/helpers.ts` | the fake host and temp-scope helpers the probes share |

No test touches the real agent dir. Each one creates a temp `cwd` and a temp agent dir, and
passes the temp agent dir as `PI_CODING_AGENT_DIR`. `test/helpers.ts` also binds `logPath` to
the temp sink by default, so a probe cannot append to the real log. This matters: the original
probes wrote the real kill switch and the real probe log, so an interrupted run could leave
the real adapter disabled.

The factory takes optional `deps`, so a test can stub an environment without module
mocking. No test stubs an external validator, because the adapter has no validator stage:
`test/workflow-compat.test.ts` hands off fixtures with no `validate.mjs` anywhere,
proving the config key is gone and the contract parser is the only validation.

## Repository layout

```text
index.ts, types.ts, config.ts, log.ts, plan-text.ts, ir.ts,
  goals-pool.ts, goals.ts, handoff.ts     the nine modules
docs/                                     the contract, config, pipeline, findings, and audit
test/*.test.ts                            the suite
test/fixtures/                            example plans, goal headers, and probe evidence
```

The `plans/` and `test/baseline/` directories that existed during the original migration were
historical artifacts only; they are not part of the universal adapter and have been removed.

## Verifying by hand

Load the extension from the repository root in a throwaway session:

```bash
pi -p --no-session --no-extensions -e /path/to/pi-plannotator-goal -nt "Reply with exactly: LOADED"
```

Pi discovers `index.ts` through the `pi.extensions` manifest entry, so no install step is
needed. A failure to load surfaces as a startup error, not as a silently missing extension.

The full check before a change is:

```bash
npm run typecheck && npm test
```