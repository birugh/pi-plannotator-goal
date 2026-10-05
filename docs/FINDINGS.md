# FINDINGS

Numbered findings that shaped this adapter. Each one states the claim, the evidence behind
it, the decision taken, the consequence, and the options that were rejected.

Findings F-01 through F-05 come from the M3 integration work; F-06 through F-14 come from
splitting the adapter out into this repository.

## F-01 A handoff must be two calls, not one

Claim: creating a goal and applying its task list cannot be made atomic, so the pause step
has to be an explicit third instruction.

Evidence: `create_goal` returns `terminate: true`, so the turn ends before any further tool
call can run. `set_goal_tasks` therefore only runs on the continuation turn, and until it
does, the goal exists without a task list. `block_completion` is stored with the task list at
apply time, so a goal created but not yet given tasks has no completion gate.

Decision: the handoff message mandates three ordered steps: `create_goal` with objective and
mode only, then `set_goal_tasks` with the task list and `block_completion: true`, then
`update_goal({status: "paused"})` before any work.

Consequence: a failure between calls is visible rather than silent, and the message requires
the agent to stop and report it. The confirmation dialog for the task list is the user's, so
the agent is told not to preselect it.

Rejected: a single combined instruction that leaves step ordering to the model. The
`terminate: true` return makes that ordering non-negotiable, and an instruction that omits it
fails on the first call.

## F-02 `block_completion` is always true

Claim: the adapter should always send `block_completion: true`.

Evidence: the pi-goal default is false, and the task gate is only active when it is true. The
gate is checked before the completion audit, so it is the cheapest existing mechanism that
enforces the milestone's own completion requirements.

Decision: `blockCompletion` is typed as the literal `true` in `GoalIR`, so no code path can
send anything else.

Consequence: a goal cannot reach `complete` while tasks are pending. That is the intent. If a
runtime experiment shows this blocking a legitimate continuation, that is a new architecture
decision to record, not something to change quietly.

Rejected: leaving the default, which would let a goal complete with its own tasks unfinished.

## F-03 Reviewer feedback belongs in `change_summary`

Claim: approval feedback must not be folded into the objective.

Evidence: the objective is passed to `create_goal` verbatim and becomes the goal's stored
objective, so mixing a reviewer note into it corrupts the record. pi-goal carries a separate
`change_summary` field for exactly this.

Decision: `withChangeSummary` attaches the note to `changeSummary`, capped at 240 characters,
and the objective is built without it.

Consequence: the goal's objective stays the plan's own wording, and the handoff message tells
the agent to pass the note as `change_summary`, not into the objective.

Rejected: appending the feedback to the objective, which would have made the stored objective
differ from the approved plan.

## F-04 An existing open goal stops the handoff

Claim: when any other goal is already open, the adapter must not create a second one.

Evidence: pi-goal has no "is there a goal for this plan" API, so matching a goal to a plan
cannot be automated. A new session does not auto-focus an existing goal, and resume with more
than one open goal asks the user. Without dedupe, a second handoff would leave the user with
two unattached goals and no way to tell which one the adapter meant.

Decision: before sending anything, read the open goals. If none, continue. If one or more,
send no message and report the pool with an explicit choice: `/goal-focus <id>`,
`/goal-unfocus`, `/goal-clear`, or proceed.

Consequence: the user keeps control of which goal is active, and the stop is recorded in the
log as `existing-goal-stop`.

Rejected: auto-merge, auto-adopt, auto-delete, silently auto-focusing an existing goal, and
building an id correlation scheme.

## F-05 The kill switch is read on every event and defaults off

Claim: the adapter needs its own kill switch, and an absent or non-`true` value must keep it
silent.

Evidence: pi 0.87.1 has no per-extension disable flag in settings or environment variables, so
nothing else can turn this extension off. The M3 switch was a single boolean file read on every
`plannotator:plan-approved` event.

Decision: `enabled` must be literally `true`. A missing file, malformed JSON, or any other
value keeps the adapter silent and writes one `skip` log line as checkable proof of no
reaction.

Consequence: fail-safe by default. Installing the extension changes nothing until a settings
file opts in, and the opt-in can be per project.

Rejected: coercing the string `"true"`, and treating a missing file as enabled.

## F-06 The adapter belongs in its own repository

Claim: the extension should live in a standalone repository rather than in the dotfiles
repository.

Evidence: the single file had grown to 349 lines mixing config loading, logging, plan parsing,
IR assembly, pool reading, message construction, and extension registration. Four of those
concerns are pure and testable without a host; only registration needs pi. The dotfiles
repository carries personal configuration, so it had no test harness, no type checking, and no
package manifest for the extension.

Decision: move the adapter to `pi-plannotator-goal` with a `package.json`, a strict
`tsconfig.json`, and a `node:test` suite, and load it from there.

Consequence: this repository detects pi through `pi.extensions`, and the dotfiles repository
keeps only a settings file and the validator it already owned.

Rejected: keeping one file and adding tests beside it in the dotfiles repository. The mixed
concerns were the actual problem; tests around the same function would not have separated them.

## F-07 Rejection is a value, not an exception

Claim: the internal `RejectError` class should be removed and replaced with a result type.

Evidence: `RejectError` was thrown from the IR builder and caught by the caller, and it was
asserted across a module boundary by two probes in 13 `instanceof` checks. A thrown error makes
every caller responsible for guessing which failure modes exist, and it makes the set of
reasons invisible in the function signature.

Decision: every helper returns `Result<T, RejectReason>`, where `RejectReason` carries a
machine-readable `RejectCode`, a human message, and the plan path.

Consequence: the caller decides explicitly whether to log, notify, or hand off, and the
`RejectCode` union is the complete, checkable list of failure modes. The class is gone.

Rejected: keeping the class and documenting the reasons. The probes' `instanceof` checks were
evidence of the coupling, not a reason to preserve it.

## F-08 Untrusted boundaries are validated, never asserted

Claim: the event payload and the config file must not be reached through a blind type
assertion.

Evidence: the original adapter read the event with `const event = (data ?? {}) as {...}` and
parsed config JSON then asserted `as { enabled?: unknown }`. A producer renaming a field would
turn into `undefined` at use time, with nothing to catch it, and a malformed file could only be
detected by a later field access being absent.

Decision: both boundaries have a typebox schema, and the TypeScript type is inferred from the
schema with `Static<typeof Schema>` so the runtime check and the compile-time type cannot drift
apart. Validation uses `Value.Check` and `Value.Decode`.

Consequence: a wrongly typed payload is a `bad-payload` refusal with no session side effects,
and no `as` appears at any boundary. `typebox` is declared as a peer dependency because pi
supplies it to extensions, and pinned to the host version `1.3.27` for development.

Rejected: hand-written type guards. They duplicate the type definition, and the two copies
drift.

## F-09 Open goals are read from the active pool only

Claim: `archived/` must not be scanned when deciding whether a goal is open.

Evidence: pi-goal-x reads open goals from the active pool only; `scanActiveGoalFiles` matches
`/^active_goal_.*\.md$/` inside the goals root and never descends into `archived/`. The earlier
adapter scanned both directories for `*.md`, which made it stop before handoff on goals the
user had already retired.

Decision: `findOpenGoals` matches `active_goal_*.md` in the resolved root and never reads
`archived/`. A goal is open when the header has an `id` and `status` is not `complete`.

Consequence: a retired goal no longer blocks a handoff, matching what pi-goal-x itself
considers open. Non-goal files in the pool (event log, ledger checkpoint, snapshot, locks) are
ignored without being read.

Rejected: scanning `archived/` and filtering by status. Status is not the criterion pi-goal-x
uses, and a paused goal in `archived/` is retired regardless of its recorded status.

## F-10 The goal pool is resolved, never assumed

Claim: the pool location must be resolved with pi-goal-x's precedence instead of a fixed path.

Evidence: pi-goal-x relocates its pool through a `goalsRoot` setting or `PI_GOAL_ROOT`, with
`~` expansion and validation (absolute, no NUL, not a symlink). The earlier adapter hardcoded
`join(cwd, ".pi", "goals")`, so after a relocation open-goal detection silently found nothing
and the handoff proceeded against a pool it could not see.

Decision: `goals-pool.ts` resolves `PI_GOAL_ROOT`, then the project settings, then the global
settings, then `<cwd>/.pi/goals`, honors both settings path overrides, and validates the value
the same way pi-goal-x does.

Consequence: the adapter and the real pool cannot disagree about where goals live, and the
resolved root and its source scope are recorded in the handoff log line.

Rejected: calling into pi-goal-x to ask for the root. The adapter must not depend on another
package's internals, and a re-implementation of the documented precedence is testable on its
own.

## F-11 A malformed pool settings file refuses the handoff

Claim: a settings file that cannot be parsed should refuse the handoff rather than fall back to
the default pool.

Evidence: pi-goal-x reports such a file as a diagnostic and keeps the valid keys, which is
right for settings that degrade gracefully. For this adapter the pool is not a preference: a
handoff made against a guessed pool would create a goal in a pool the user is not looking at,
which is worse than not handing off.

Decision: a settings file that is not valid JSON, is not a JSON object, or declares `goalsRoot`
with a non-string or empty value refuses the handoff with `goals-root-invalid`, naming the
offending file.

Consequence: the failure is loud and recoverable. Note that this deliberately differs from
pi-goal-x, and the difference is recorded here so the divergence is not mistaken for a bug.

Rejected: silently falling back to the default pool, and treating a malformed project file as
"this project has no pool preference".

## F-12 The validator stays in the dotfiles repository

Claim: the plan validator must not be copied into this repository, and must be reached through
a config key.

Evidence: `plans/validate.mjs` is invoked by the Plannotator planning phase and by this
adapter before a handoff. It defines the milestone file format, which is a property of the
planning workflow rather than of the handoff. It is also already owned and versioned in the
dotfiles repository.

Decision: the validator is not copied. The adapter runs the path given by the `validatePath`
config key, defaulting to `<agent dir>/plans/validate.mjs`.

Consequence: one validator, one owner, and the adapter cannot drift into accepting a format the
planner rejects. A test points `validatePath` at the real validator, which proves the key is
the wiring rather than a decoration.

Rejected: vendoring a copy, which would have created two validators to keep in sync.

## F-13 `deliverAs` is measured, not assumed

Claim: the choice between `steer` and `followUp` must come from an observed idle state at the
right moment.

Evidence: the `plan-approved` event is emitted from inside the submit tool's execute, while the
agent is still streaming, so a synchronous `isIdle()` reads false even when the agent is about
to become idle. Deferring one macrotask with `setImmediate` moves the reading past that window.

Decision: the handler defers with `setImmediate` and reads the cached session context there,
choosing `followUp` when idle and `steer` otherwise, and records the measured value in the
handoff log line.

Consequence: the delivery mode is auditable after the fact, and the timing assumption is
documented rather than implicit.

Rejected: reading `isIdle()` synchronously, and hardcoding `steer`.

## F-14 Nine flat modules, not a nested tree

Claim: the adapter should stay nine files at the repository root, without subdirectories for
config, plan, or goal concerns.

Evidence: the whole adapter was 349 lines. Splitting it further would have created directories
with one or two files each and import paths longer than the modules themselves, and pi
discovers an extension from `index.ts` at the package root regardless.

Decision: `index.ts` plus eight sibling modules, each with one responsibility: `types`,
`config`, `log`, `plan-text`, `ir`, `goals-pool`, `goals`, `handoff`.

Consequence: the dependency order is visible in one directory listing, and each module has a
matching test file. `index.ts` is the only module with I/O side effects beyond reading a file
or writing a log line.

Rejected: a `src/` layout with nested concern directories. It would have implied a size this
adapter does not have, and it would have put an extra path segment between every import and its
target.

## F-15 Tests never touch the real agent dir

Claim: every test, including the migrated probes, must run against a temp agent dir.

Evidence: the M3 probes wrote the real `goal-adapter.json` and appended to the real probe log,
restoring the settings file on the success path only. An interrupted or failing run could
leave the real adapter disabled, and a failing assertion left the config in a test state with
no cleanup.

Decision: every test creates a temp `cwd` and a temp agent dir, passes it as
`PI_CODING_AGENT_DIR`, and the shared probe helper binds `logPath` to a temp sink by default.

Consequence: an interrupted run cannot change real settings or real logs, and the suite is safe
to run at any time. The one test that touches the real validator does so read-only, through
`validatePath`.

Rejected: saving and restoring the real settings file in a `finally` block. Restoring is still
a write to the real file, and a crash between the write and the restore is exactly the case the
probes needed to survive.

## F-16 A key that is invalid falls through, a file that is malformed is ignored

Claim: config resolution should be per key, and an unreadable file should not disable the
adapter.

Evidence: the M3 switch was a single file, so a typo anywhere in it silently turned the adapter
off with no signal. With a project file layered over a global file, a single bad edit in the
project file could disable a working installation.

Decision: resolution is per key. A key that is missing or wrongly typed at the project scope
falls through to the global scope and then to the compiled default, and the ignored file is
reported in the resolved config's `notes` and written to the log.

Consequence: one bad value cannot silently turn off a handoff that the other scope still
enables, and the fallback is observable rather than invisible.

Rejected: treating any malformed project file as "this project opts out", which would have made
a typo indistinguishable from an intentional disable.

## F-17 The handoff strings are frozen

Claim: the handoff and rejection message text should be treated as a contract and not
reworded.

Evidence: the three migrated probes and the recorded handoff evidence assert on those exact
strings, including the handoff message's numbered steps and its prohibition list. The message
is also the interface the model follows, so a rewording is a behavior change, not a copy edit.

Decision: `handoff.ts` holds the strings unchanged, and the probes assert on them so a
rewording fails the suite.

Consequence: `test/EVIDENCE.md` can pair pre-refactor and post-refactor output byte for byte,
and the evidence keeps its value as a witness.

Rejected: tidying the wording during the split. It would have invalidated the recorded evidence
and made the refactor indistinguishable from a behavior change.

## F-18 The milestone's archived-directory wording was superseded

Claim: the task list item that described scanning the pool "and its archived directory" was
already out of date when the plan was written, and the shipped behavior should win.

Evidence: the dotfiles working copy carried an uncommitted correction to `findOpenGoals`
adding the active-pool-only rule and a comment citing `pi-goal-x/extensions/storage/goal-files.ts`.
That correction postdates the last commit of the adapter, and the corresponding probe update
asserts that an archived goal must not block a handoff.

Decision: adopt the corrected behavior as the baseline (F-09), and record the deviation from
the milestone wording in `goals.ts` and in this document rather than following the literal
instruction.

Consequence: pre-refactor and post-refactor evidence compare like for like. Following the
literal wording would have shipped the retired-goal bug and made CR-004 fail.

Rejected: following the task wording literally, and porting the fix later. Either would have
made the baseline reflect behavior the adapter had already stopped having.
## F-19 The cutover supersedes the pending M-04 LSP milestone

Claim: moving the adapter out of `~/.pi/agent` makes the unexecuted M-04 milestone
unreachable, and that should be recorded rather than silently absorbed.

Evidence: M-04's goal is "`lens_diagnostics` on `extensions/goal-adapter.ts` reports 0
typescript findings", and its CR-001 requires creating `extensions/tsconfig.json` with
`extends: "../tsconfig.json"`. All seven of its tasks were still pending. The cutover deletes
`extensions/goal-adapter.ts` and the root `tsconfig.json` that the child config would have
extended, so both the file under measurement and the chosen fix stop existing.

Decision: do not execute M-04 and do not delete it. Its file stays in `plans/` with its tasks
untouched, and this finding records why it no longer applies.

Consequence: the intent behind M-04, which was that a TypeScript file in the agent dir should
not fall back to an inferred LSP project, is now carried by two better-scoped things: the
extension has its own strict `tsconfig.json` and a real test suite in this repository, and the
only remaining `.ts` file in the agent dir is `extensions/herdr-agent-state.ts`, which imports
`node:net` and `node:path` only and therefore does not need the host package `paths` mapping
that M-04 existed to restore.

Rejected: executing M-04 first, which would have added a config file whose only purpose was to
serve a file the plan deletes next; and deleting the M-04 plan file, which would have hidden
an unexecuted commitment instead of explaining it.

## F-20 The root tsconfig was load-bearing only for the probes

Claim: deleting the agent dir root `tsconfig.json` is safe once the probes move.

Evidence: commit `78f7631` added that file with the comment "add noEmit tsconfig so pi host
types resolve for probes". Its `include` was `extensions/**/*.ts` and `plans/probes/**/*.ts`,
and its `paths` mapping existed so tsserver could resolve
`@earendil-works/pi-coding-agent` from the global install. Both consumers went away: the
adapter moved to a repository with its own tsconfig, and `plans/probes` was removed as part of
the same cutover.

Decision: delete it, as the plan's T-23 requires.

Consequence: the agent dir no longer carries a TypeScript project for a directory whose
remaining TypeScript file imports only Node built-ins. Pi loads extensions through jiti, so the
file was never consulted at runtime anyway, only by the language server.

Rejected: keeping it and narrowing `include` to `extensions/**`. That would have preserved a
file whose stated reason for existing had already moved elsewhere, and M-04 is where its
remaining intent belongs.

## F-21 The validator is no longer an adapter dependency

Claim: after the universal contract work, the external validator must not gate the handoff
at all, superseding F-12.

Evidence: F-12 recorded that the adapter ran the path from the `validatePath` config key,
defaulting to `<agent dir>/plans/validate.mjs`, before every handoff. That made the handoff
depend on a workflow-owned file: a workflow without that file (or with a different one)
could not be handed off at all. The Universal Adapter Contract work removes that dependency
by making the adapter's own contract validation the only required validation.

Decision: delete the `validatePath` config key, the `runValidator` stage in `index.ts`, the
`validator-failed` reject reason, and the default validator path. The adapter now validates
the plan entirely through the contract parser (`docs/ADAPTER-CONTRACT.md`) and refuses
non-conforming plans with a typed reason. A workflow MAY keep its own validator as an
optional planning-time check; a `validatePath` key left in old settings files is tolerated
as an unknown key and ignored. The six fixture workflows in `test/workflow-compat.test.ts`
prove the adapter hands off with no validator, no custom planner, and no workflow-owned
file.

Consequence: the adapter is universal: any workflow whose plan satisfies the contract can
hand off, and the contract is the single shared language. The divergence from F-12 is
intentional and recorded so the two findings do not look contradictory.

Rejected: keeping the validator as an optional-but-wired key. An optional external
validator is a planning concern, not an adapter concern, and carrying the key would keep a
`plans/validate.mjs` presence subtly load-bearing for old setups.
