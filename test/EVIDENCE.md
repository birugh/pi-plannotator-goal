# EVIDENCE

Pairing of the recorded M3 baseline output with the post-refactor output for each ported
probe. The baseline was captured by running the three probes against the ORIGINAL
`~/.pi/agent/extensions/goal-adapter.ts` (commit `5861a76`, the corrected `findOpenGoals`)
before the module split; the post output is produced by the migrated `node:test` ports in
this repository.

Reproduce:

```text
node --test "test/m3-adapter-check.test.ts"    # helper + port; asserts, then prints the same summary
node --test "test/m3-adapter-skip-check.test.ts"
node --test "test/m3-failure-cases.test.ts"
```

Raw captured files live in `test/baseline/`:

| probe | baseline | post |
| --- | --- | --- |
| m3-adapter-check | `pre-adapter-check.txt` | `post-adapter-check.txt` |
| m3-adapter-skip-check | `pre-skip-check.txt` | `post-skip-check.txt` |
| m3-failure-cases | `pre-failure-cases.txt` | `post-failure-cases.txt` |

## 1. m3-adapter-check

Baseline command:

```text
cd ~/.pi/agent && node plans/probes/m3-adapter-check.ts
```

Baseline output:

```text
adapter pure checks: 33 assertions over 4 tasks
ALL ADAPTER CHECKS PASS
```

Post output (migrated port, `test/m3-adapter-check.test.ts`):

```text
adapter pure checks: 33 assertions over 4 tasks
ALL ADAPTER CHECKS PASS
```

Result: identical. Same assertion count, same task count, same summary lines.

## 2. m3-adapter-skip-check

Baseline command:

```text
cd ~/.pi/agent && node plans/probes/m3-adapter-skip-check.ts
```

Baseline output:

```text
adapter skip/reject checks: 5 assertions
ALL ADAPTER SKIP CHECKS PASS
```

Post output (`test/m3-adapter-skip-check.test.ts`):

```text
adapter skip/reject checks: 5 assertions
ALL ADAPTER SKIP CHECKS PASS
```

Result: identical.

## 3. m3-failure-cases

Baseline command:

```text
cd ~/.pi/agent && node plans/probes/m3-failure-cases.ts
```

Baseline output:

```text
1. duplicate task id -> reject — PASS
2. missing parent -> reject — PASS
3. depth > 1 -> reject (runtime also proves pi-goal rejects) — PASS
4. >50 tasks -> reject — PASS
5. invalid PLAN / changed file -> reject — PASS
6. invalid mode declaration -> reject — PASS
7. existing open goal -> adapter stops BEFORE sendUserMessage (runtime) — PASS
8. user rejects task confirmation -> no mutation (runtime) — PASS
9. create ok + set_goal_tasks fails -> mandated STOP+report, no retry — PASS
5b. live adapter run with a mismatched payload — rejected before any send
7b. live adapter run against a synthetic pool — stopped before sendUserMessage, no handoff
failure cases: 9/9 (+2 live runs)
ALL FAILURE CASES COVERED
```

Post output (`test/m3-failure-cases.test.ts`):

```text
1. duplicate task id -> reject — PASS
2. missing parent -> reject — PASS
3. depth > 1 -> reject (runtime also proves pi-goal rejects) — PASS
4. >50 tasks -> reject — PASS
5. invalid PLAN / changed file -> reject — PASS
6. invalid mode declaration -> reject — PASS
7. existing open goal -> adapter stops BEFORE sendUserMessage (runtime) — PASS
8. user rejects task confirmation -> no mutation (runtime) — PASS
9. create ok + set_goal_tasks fails -> mandated STOP+report, no retry — PASS
5b. live adapter run with a mismatched payload — rejected before any send
7b. live adapter run against a synthetic pool — stopped before sendUserMessage, no handoff
failure cases: 9/9 (+2 live runs)
ALL FAILURE CASES COVERED
```

Result: identical, all eleven results in the same order with the same summary lines.

## Intentional differences

These are the only places the ports diverge from the probes, and none of them changes an
assertion or its outcome:

- The ports run against a temp `cwd` and a temp agent dir (`PI_CODING_AGENT_DIR`), so the
  real `~/.pi/agent/goal-adapter.json` and the real probe log are never modified. The
  probes wrote both. The temp settings file always binds `logPath` to the temp sink.
- The ports read the plan fixtures from `test/fixtures/`; the probes read
  `~/.pi/agent/plans/...`. The copies are byte-identical.
- Reject cases assert through a stage-agnostic helper: a syntax problem is now reported by
  `parsePlanText` and a pi-goal-limit problem by `buildGoalIR`, where the single-function
  adapter could only throw one `RejectError`. The asserted reason strings are unchanged.
- `new RegExp` interpolation is replaced by a literal pattern plus an explicit
  `MAX_TASKS === 50` assertion, so the constant stays pinned without a dynamic regex.
- Runtime-only results (case 3, case 8) read the recorded wheel evidence
  `test/fixtures/m3-handoff-evidence.md`; they are not re-run, exactly as the probe read it.

## What is NOT covered here

- Suite totals for the nine root modules belong to the repository test run
  (`node --test "test/*.test.ts"`), not to this pairing, which is limited to the three
  migrated probes.
- A live pi-goal session is not started by any test; the handoff conversation itself was
  witnessed separately and is recorded in `test/fixtures/m3-handoff-evidence.jsonl`.