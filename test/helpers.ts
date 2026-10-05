/**
 * Shared helpers for the migrated probes.
 *
 * These exist so every probe runs against a temp cwd and a temp agent dir
 * (PI_CODING_AGENT_DIR): the real ~/.pi/agent is never read or written, and a crashed
 * run cannot leave a real kill switch disabled.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotatorGoalAdapter, { type AdapterDeps } from "../index.ts";

export type FakeEnv = {
  root: string;
  cwd: string;
  agentDir: string;
  logPath: string;
  configPath: string;
  planPath: string;
};

export function makeEnv(): FakeEnv {
  const root = mkdtempSync(join(tmpdir(), "ppg-probe-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const plansDir = join(cwd, "plans");
  for (const dir of [cwd, agentDir, plansDir]) mkdirSync(dir, { recursive: true });
  return {
    root,
    cwd,
    agentDir,
    logPath: join(root, "adapter-log.jsonl"),
    configPath: join(agentDir, "plannotator-goal.json"),
    planPath: join(plansDir, "plan.md"),
  };
}

export function writeConfig(
  env: FakeEnv,
  value: unknown,
  extra: Record<string, unknown> = {},
): void {
  // logPath defaults to the temp sink so a probe never appends to the agent dir log.
  const body =
    typeof value === "string"
      ? value
      : JSON.stringify({ logPath: env.logPath, ...(value as object), ...extra });
  writeFileSync(env.configPath, body);
}

export type Sent = { message: string; deliverAs?: string };
export type Notified = { message: string; type?: string };

export type EmitOptions = {
  /** Set false to emit without a prior session_start. */
  startSession?: boolean;
  /** Value the cached session context reports for isIdle(). */
  idle?: boolean;
  deps?: AdapterDeps;
};

export type EmitResult = { sent: Sent[]; notifies: Notified[] };

/**
 * Drive the factory exactly like pi does: register, start a session, emit the event,
 * then settle one macrotask so the deferred handler runs.
 */
export async function emitPlanApproved(
  env: FakeEnv,
  payload: Record<string, unknown>,
  options: EmitOptions = {},
): Promise<EmitResult> {
  const notifies: Notified[] = [];
  const sent: Sent[] = [];
  const handlers: Array<(data: unknown) => void> = [];

  const ctx = {
    cwd: env.cwd,
    isIdle: () => options.idle ?? false,
    ui: { notify: (message: string, type?: string) => notifies.push({ message, ...(type === undefined ? {} : { type }) }) },
  };

  const pi = {
    on: (_event: string, handler: (event: unknown, context: unknown) => void) => {
      if (options.startSession !== false) handler({ type: "session_start" }, ctx);
      return () => {};
    },
    events: {
      on: (_channel: string, handler: (data: unknown) => void) => {
        handlers.push(handler);
        return () => {};
      },
    },
    sendUserMessage: (message: string, opts?: { deliverAs?: string }) => {
      sent.push({ message, ...(opts?.deliverAs === undefined ? {} : { deliverAs: opts.deliverAs }) });
      return Promise.resolve();
    },
    getActiveTools: () => [],
  };

  const deps: AdapterDeps = { env: { PI_CODING_AGENT_DIR: env.agentDir }, runValidator: () => null, ...options.deps };
  plannotatorGoalAdapter(pi as never, deps);
  for (const handler of handlers) handler(payload);
  await settle();
  return { sent, notifies };
}

export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export type LogLine = { kind?: string; text?: string; [key: string]: unknown };

export function readLog(logPath: string): LogLine[] {
  let body: string;
  try {
    body = readFileSync(logPath, "utf8").trim();
  } catch {
    return [];
  }
  if (body === "") return [];
  return body.split("\n").map((line) => JSON.parse(line) as LogLine);
}

export function findLog(logPath: string, kind: string): LogLine | undefined {
  return readLog(logPath).find((entry) => entry.kind === kind);
}

export function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
}

/**
 * A pi-goal-x shaped goal file: JSON header, blank line, body below `# Goal Prompt`.
 */
export function goalFile(id: string, status: string, objective: string): string {
  const record = {
    id,
    objective,
    status,
    autoContinue: false,
    usage: { activeSeconds: 0, tokensUsed: 0 },
    sisyphus: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return `${JSON.stringify(record, null, 2)}\n\n# Goal Prompt\n\n${objective}\n\n## Progress\n\n- Status: ${status}\n`;
}