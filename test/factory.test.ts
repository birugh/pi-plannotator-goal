/**
 * End-to-end factory test: drive index.ts the way pi does, with a fake host.
 *
 * Every case runs against a temp cwd and a temp agent dir (PI_CODING_AGENT_DIR), so the
 * real ~/.pi/agent is never read or written. There is no external validator: the plan
 * parser enforces the Universal Adapter Contract, which is the only validation required.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import plannotatorGoalAdapter, { type AdapterDeps } from "../index.ts";
import { PLAN_APPROVED } from "../config.ts";

const VALID_PLAN = `# M-90 Factory probe plan

Goal: prove the factory hands off an approved plan.

## Scope

- In: the factory path.

## Completion Requirements

- CR-001: the handoff message names the task ids

## S-01 One story

- Scope: the only slice
- [ ] T-01 First task
- [ ] T-01.1 Sub task
`;

type Sent = { message: string; deliverAs?: string };
type Notify = { message: string; type?: string };
type Handler = (data: unknown) => void;
type StartHandler = (event: unknown, ctx: FakeCtx) => void;

type FakeCtx = { cwd: string; isIdle: () => boolean; ui: { notify: (m: string, t?: string) => void } };

function fakeHost(notifies: Notify[], cwd: string, idle: boolean) {
  const handlers: Handler[] = [];
  const starts: StartHandler[] = [];
  const sent: Sent[] = [];
  const pi = {
    on: (_event: string, handler: StartHandler) => {
      starts.push(handler);
      return () => {};
    },
    events: {
      on: (_channel: string, handler: Handler) => {
        handlers.push(handler);
        return () => {};
      },
    },
    sendUserMessage: (message: string, options?: { deliverAs?: string }) => {
      sent.push({ message, deliverAs: options?.deliverAs });
      return Promise.resolve();
    },
    getActiveTools: () => [],
  };
  const ctx: FakeCtx = {
    cwd,
    isIdle: () => idle,
    ui: { notify: (m, t) => notifies.push({ message: m, ...(t === undefined ? {} : { type: t }) }) },
  };
  return { pi, handlers, starts, sent, ctx };
}

type Env = {
  cwd: string;
  agentDir: string;
  logPath: string;
  planPath: string;
  /** Start a session (so session_start ctx is cached) before emitting the event. */
  emit: (payload: Record<string, unknown>, opts?: { startSession?: boolean; idle?: boolean }) => Promise<{ sent: Sent[]; notifies: Notify[] }>;
};

function setup(config: Record<string, unknown> | null = { enabled: true }, deps: AdapterDeps = {}): Env {
  const root = mkdtempSync(join(tmpdir(), "ppg-factory-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const plansDir = join(cwd, "plans");
  for (const dir of [cwd, agentDir, plansDir]) mkdirSync(dir, { recursive: true });

  const planPath = join(plansDir, "M-90.md");
  writeFileSync(planPath, VALID_PLAN);

  const logPath = join(root, "adapter-log.jsonl");
  if (config !== null) {
    writeFileSync(
      join(agentDir, "plannotator-goal.json"),
      JSON.stringify({ logPath, ...config }),
    );
  }

  const env = { PI_CODING_AGENT_DIR: agentDir };
  const fullDeps: AdapterDeps = { env, ...deps };

  return {
    cwd,
    agentDir,
    logPath,
    planPath,
    emit: async (payload, opts = {}) => {
      const notifies: Notify[] = [];
      const host = fakeHost(notifies, cwd, opts.idle ?? false);
      plannotatorGoalAdapter(host.pi as never, fullDeps);
      if (opts.startSession !== false) {
        for (const start of host.starts) start({ type: "session_start" }, host.ctx);
      }
      for (const handler of host.handlers) handler(payload);
      await new Promise((r) => setImmediate(r));
      return { sent: host.sent, notifies };
    },
  };
}

function logLines(logPath: string): Array<Record<string, unknown>> {
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(parseLogLine);
}

/** Parse one JSONL line, keeping the same no-assertion rule as the modules. */
function parseLogLine(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`log line is not a JSON object: ${line}`);
  }
  return Object.fromEntries(Object.entries(parsed));
}

describe("factory handoff path", () => {
  it("sends the handoff message with ids, parent links and the contract", async () => {
    const e = setup();
    const { sent, notifies } = await e.emit({
      cwd: e.cwd,
      planFilePath: "plans/M-90.md",
      planContent: VALID_PLAN,
      feedback: "looks good",
    });
    assert.equal(sent.length, 1, "exactly one user message");
    const message = sent[0]?.message ?? "";
    assert.match(message, /A Plannotator plan has been approved/);
    assert.match(message, /- T-01 — First task/);
    assert.match(message, /- T-01\.1 — Sub task \(parent_id: "T-01"\)/);
    assert.match(message, /CR-001 the handoff message names the task ids/);
    assert.match(message, /Reviewer note \(pass as change_summary, not into the objective\): looks good/);
    assert.match(message, /Do not create another goal/);
    assert.equal(notifies.length, 0, "a successful handoff does not warn");
  });

  it("logs a handoff entry carrying the plan hash, task count and pool source", async () => {
    const e = setup();
    await e.emit({ cwd: e.cwd, planFilePath: "plans/M-90.md", planContent: VALID_PLAN });
    const entries = logLines(e.logPath);
    const handoff = entries.find((x) => x.kind === "handoff");
    assert.ok(handoff, "a handoff entry is written");
    assert.equal(handoff.tasks, 2);
    assert.equal(handoff.mode, "regular");
    assert.equal(typeof handoff.planSha256, "string");
    assert.equal(handoff.goalsRootSource, "default");
    assert.ok(typeof handoff.ts === "string", "the timestamp is present");
  });

  it("delivers as steer when the session is busy and followUp when idle", async () => {
    const busy = setup();
    const busyRun = await busy.emit(
      { cwd: busy.cwd, planFilePath: "plans/M-90.md", planContent: VALID_PLAN },
      { idle: false },
    );
    assert.equal(busyRun.sent[0]?.deliverAs, "steer");

    const idle = setup();
    const idleRun = await idle.emit(
      { cwd: idle.cwd, planFilePath: "plans/M-90.md", planContent: VALID_PLAN },
      { idle: true },
    );
    assert.equal(idleRun.sent[0]?.deliverAs, "followUp");
  });

  it("hands off with no validator at all — no validate.mjs anywhere", async () => {
    const e = setup();
    const { sent } = await e.emit({ cwd: e.cwd, planFilePath: "plans/M-90.md", planContent: VALID_PLAN });
    assert.equal(sent.length, 1, "the adapter needs no external validator to hand off");
  });

  it("returns 2 tasks for the fixture, proving ids are not renamed", async () => {
    const e = setup();
    await e.emit({ cwd: e.cwd, planFilePath: "plans/M-90.md", planContent: VALID_PLAN });
    const handoff = logLines(e.logPath).find((x) => x.kind === "handoff");
    assert.equal(handoff?.tasks, 2);
  });
});

describe("factory refusals", () => {
  it("stays silent when the adapter is disabled", async () => {
    const e = setup({ enabled: false });
    const { sent, notifies } = await e.emit({ cwd: e.cwd, planFilePath: "plans/M-90.md", planContent: VALID_PLAN });
    assert.equal(sent.length, 0);
    assert.equal(notifies.length, 0);
    assert.equal(logLines(e.logPath)[0]?.kind, "skip");
  });

  it("treats a missing config file as disabled", async () => {
    const e = setup(null);
    const { sent } = await e.emit({ cwd: e.cwd, planFilePath: "plans/M-90.md", planContent: VALID_PLAN });
    assert.equal(sent.length, 0, "no config means no handoff");
  });

  it("refuses when the plan on disk differs from the approved payload", async () => {
    const e = setup();
    const { sent, notifies } = await e.emit({
      cwd: e.cwd,
      planFilePath: "plans/M-90.md",
      planContent: `${VALID_PLAN}\n`,
    });
    assert.equal(sent.length, 0);
    assert.match(notifies[0]?.message ?? "", /M3 adapter rejected/);
    const entry = logLines(e.logPath).find((x) => x.kind === "reject");
    assert.match(String(entry?.text ?? ""), /differs from the approved payload/);
  });

  it("refuses when the plan cannot be read", async () => {
    const e = setup();
    const { sent } = await e.emit({ cwd: e.cwd, planFilePath: "plans/missing.md" });
    assert.equal(sent.length, 0);
    assert.match(String(logLines(e.logPath)[0]?.text ?? ""), /could not be read from disk/);
  });

  it("walks plan-content pitfalls only through the contract (no validator stage)", async () => {
    // A plan whose checkboxes sit in an unknown section must be rejected by the parser
    // and produce a typed log entry, not a handoff.
    const e = setup();
    const weird = `${VALID_PLAN.split("## S-01 One story")[0] ?? ""}## Notes\n\n- [ ] T-01 First task\n`;
    writeFileSync(e.planPath, weird);
    const { sent } = await e.emit({ cwd: e.cwd, planFilePath: "plans/M-90.md", planContent: weird });
    const entry = logLines(e.logPath).find((x) => x.kind === "reject");
    assert.equal(sent.length, 0, "a contract violation stops the handoff");
    assert.ok(entry, "the refusal is logged");
  });

  it("refuses a plan with no task checkboxes", async () => {
    const e = setup();
    const broken = VALID_PLAN.replace(/^- \[ \] T-.*$/gm, "");
    writeFileSync(e.planPath, broken);
    const { sent } = await e.emit({ cwd: e.cwd, planFilePath: "plans/M-90.md", planContent: broken });
    assert.equal(sent.length, 0);
    assert.match(String(logLines(e.logPath)[0]?.text ?? ""), /no '- \[ \] T-<nn>' task checkbox/);
  });

  it("stops before handoff when an open goal is already in the pool", async () => {
    const e = setup();
    const pool = join(e.cwd, ".pi", "goals");
    mkdirSync(join(pool, "archived"), { recursive: true });
    const header = JSON.stringify({ id: "probe-open", status: "paused", objective: "Synthetic open goal" });
    writeFileSync(join(pool, "active_goal_20260101000000_probe-open.md"), `${header}\n\n# Goal Prompt\n\nbody\n`);
    // Archived goals must not block.
    writeFileSync(
      join(pool, "archived", "goal_20260101000000_retired.md"),
      `${JSON.stringify({ id: "probe-retired", status: "paused", objective: "Retired" })}\n\n# Goal Prompt\n\nbody\n`,
    );

    const { sent, notifies } = await e.emit({ cwd: e.cwd, planFilePath: "plans/M-90.md", planContent: VALID_PLAN });
    assert.equal(sent.length, 0, "an open goal stops the handoff");
    const entry = logLines(e.logPath).find((x) => x.kind === "existing-goal-stop");
    const text = String(entry?.text ?? "");
    assert.match(text, /probe-open/);
    assert.ok(!text.includes("probe-retired"), "an archived goal is not reported as open");
    assert.ok(notifies[0]?.message.startsWith("M3 adapter stopped before handoff"), "the user is notified");
  });

  it("refuses when the goal pool settings are malformed", async () => {
    const e = setup();
    mkdirSync(join(e.cwd, ".pi"), { recursive: true });
    writeFileSync(join(e.cwd, ".pi", "pi-goal-x-settings.json"), "{ not json");
    const { sent } = await e.emit({ cwd: e.cwd, planFilePath: "plans/M-90.md", planContent: VALID_PLAN });
    assert.equal(sent.length, 0);
    assert.match(String(logLines(e.logPath)[0]?.text ?? ""), /refusing to guess the goal pool/);
  });

  it("refuses a payload with a wrongly typed field without touching the session", async () => {
    const e = setup();
    const { sent } = await e.emit({ cwd: 42, planFilePath: "plans/M-90.md" });
    assert.equal(sent.length, 0);
  });

  it("refuses a payload with no cwd or planFilePath", async () => {
    const e = setup();
    const { sent, notifies } = await e.emit({});
    assert.equal(sent.length, 0);
    // The notice is the first three lines of the report; the reason is the fourth.
    assert.match(notifies[0]?.message ?? "", /M3 adapter rejected PLAN\.md\.\s+Plan:\s+\(unresolved\)/);
    assert.match(String(logLines(e.logPath)[0]?.text ?? ""), /no cwd\/planFilePath/);
  });

  it("refuses a plan declaring an unsupported execution order", async () => {
    const e = setup();
    const text = `${VALID_PLAN}\nExecution order: semi-strict\n`;
    writeFileSync(e.planPath, text);
    const { sent } = await e.emit({ cwd: e.cwd, planFilePath: "plans/M-90.md", planContent: text });
    assert.equal(sent.length, 0);
    assert.match(String(logLines(e.logPath)[0]?.text ?? ""), /only 'strict'/);
  });

  it("falls back to the event cwd when no session_start was seen", async () => {
    const e = setup();
    const { sent } = await e.emit(
      { cwd: e.cwd, planFilePath: "plans/M-90.md", planContent: VALID_PLAN },
      { startSession: false },
    );
    assert.equal(sent.length, 1, "handoff still works without a cached ctx");
    assert.equal(sent[0]?.deliverAs, "steer", "without a ctx there is no idle reading");
  });
});