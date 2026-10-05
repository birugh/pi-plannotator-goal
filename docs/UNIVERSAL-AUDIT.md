# Final Audit: Universal Goal Adapter

Date: goal muvg01pm-6q23we, final milestone. Scope: verify the adapter truly meets its
universal purpose after the Adapter Contract v1 refactor. Every claim below is backed by
code, tests, and docs in this repository.

## Dependency

**Question: does the adapter still need `validate.mjs`?**

No. `validatePath`, `defaultValidatePath`, `runValidator`, `defaultRunValidator`, and the
`validator-failed` reject reason were removed from `config.ts`, `index.ts`, and `types.ts`.
`docs/CONFIG.md` documents the key as removed; a stale `validatePath` in old settings is
tolerated as an unknown key and ignored (`test/config.test.ts` asserts `"validatePath" in
config === false`). A grep over all `.ts` sources finds `validate.mjs` only inside two test
strings that prove it is absent or ignored.

**Does the adapter depend on a specific project path or workflow prompt?**

No. `index.ts` resolves the plan path from the event payload, reads the goal pool through
pi-goal-x's documented precedence (`PI_GOAL_ROOT` > project > global > `cwd/.pi/goals`), and
never references `plans/`, the dotfiles repository, a milestone prompt, or a workflow-owned
file. `test/fixtures/wf-b-minimal.md` hands off a plan that has no validator, no custom
planner, and no workflow scaffolding at all.

## Interpretation

**Does the adapter ask an LLM to reinterpret the PLAN? Does an LLM decide tasks, hierarchy,
or task IDs?**

No. The parser (`plan-text.ts`) extracts structure with fixed regexes only; there is no
LLM call anywhere in the adapter. Task ids (`T-<nn>`), hierarchy (the dotted id root),
titles, the objective, and the mode come from the plan bytes, verbatim. The handoff message
(`handoff.ts`) states this contract to the model: "Do not reinterpret the plan. Do not invent
tasks. Do not skip tasks. Do not rename ids." `test/handoff-semantics.test.ts` pins those
strings and asserts the objective appears byte-for-byte in the message.

## Contract

- **Documented?** `docs/ADAPTER-CONTRACT.md` defines Adapter Contract v1: plan structure,
  what is a task (checkbox in a `## S-<nn>` section, outside code fences, valid `T-` id,
  non-empty title), what is not a task (Notes/Documentation/unknown sections, code fences,
  stranded lines), nesting by dotted id, id rules, unknown/malformed handling, execution
  mode, and the fail-closed principle. The parser exports `CONTRACT_VERSION = "v1"` so code
  and doc cannot drift silently.
- **Does the parser follow it?** Yes: `plan-text.ts` is section-aware and fence-aware.
  Checkboxes in prose sections are never tasks; stranded and malformed checkbox lines reject.
  Deterministic: identical input yields identical output.
- **Do tests follow it?** Yes. `test/plan-text.test.ts` covers the contract matrix
  (valid plan, tasks in the right section, Notes/fence/unknown-section checkboxes,
  stranded/malformed rejections, duplicate id, missing parent, invalid nesting, unknown
  section, CRLF/LF). `test/workflow-compat.test.ts` proves it end to end.
- **Does the README explain it?** Yes: the "Universal Adapter Contract" section states the
  principle (workflow planning Anda bebas; contract is the common language), links
  `docs/ADAPTER-CONTRACT.md`, and explains why a stable standard is needed: Plannotator +
  Goal Adapter + pi-goal only works with a shared format the adapter can translate without
  guessing.

## Safety

**When the adapter cannot understand the PLAN, does it STOP instead of guessing?**

Yes. Every failure path returns a typed `RejectReason`; `index.ts` sends no message and
creates no goal before returning. Cases: no `Goal:` line, no task sections, checkboxes only
outside task sections, stranded checkbox lines, malformed task lines, duplicate/invalid
ids, missing parents, unsupported nesting, missing requirements, oversize
objective/contract, bad execution order, plan file changed or unreadable, bad payload,
goal-pool misconfiguration, or an already-open goal. `test/workflow-compat.test.ts` fixtures
D and F assert the STOP with a clear logged error. No LLM is consulted for any of it.

## Integration

The actual pipeline, verified by `test/factory.test.ts` and `test/workflow-compat.test.ts`:

```text
Plannotator
    ↓
plan-approved
    ↓
Universal Adapter (payload + config + plan re-read)
    ↓
Contract validation (parser, deterministic; no external validator)
    ↓
IR (objective, tasks, mode, contract; pi-goal limits)
    ↓
goal pool check (open goal -> stop)
    ↓
pi-goal (create_goal -> set_goal_tasks -> pause, via public Pi API)
```

It is NOT:

```text
Plannotator
    ↓
custom validate.mjs wajib
    ↓
Universal Adapter
```

## Verdict

The adapter satisfies the universal goal: prone to no workflow-specific dependency, no LLM
interpretation, a versioned and documented contract, fail-closed safety, and a clean
integration into pi-goal through public APIs only. `npm run typecheck` exits 0 and
`node --test` reports all tests green.

> Workflow boleh berbeda. Contract harus stabil. Adapter tidak menebak.