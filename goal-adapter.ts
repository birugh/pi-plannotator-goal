import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PLAN_APPROVED = "plannotator:plan-approved";
const AGENT_DIR = "/home/biru/.pi/agent";
const CONFIG_PATH = join(AGENT_DIR, "goal-adapter.json");
const VALIDATOR = join(AGENT_DIR, "plans", "validate.mjs");
const LOG_PATH = join(AGENT_DIR, "plans", "probes", "m3-adapter-log.jsonl");

const MAX_TASKS = 50;
const MAX_DEPTH = 1;
const MAX_OBJECTIVE = 1400;
const MAX_CONTRACT = 700;

export type TaskIR = { id: string; title: string; parentId?: string };
export type GoalIR = {
  objective: string;
  mode: "regular" | "sisyphus";
  tasks: TaskIR[];
  verificationContract: string;
  blockCompletion: true;
  changeSummary?: string;
  source: { planPath: string; planSha256: string };
};

export class RejectError extends Error {}

export function log(obj: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
  } catch {
    return;
  }
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function isEnabled(configText: string | null): boolean {
  if (configText === null) return false;
  try {
    return (JSON.parse(configText) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

export type OpenGoal = {
  id: string;
  status: string;
  title: string;
  activePath: string | null;
  file: string;
};

export function findOpenGoals(cwd: string): OpenGoal[] {
  const out: OpenGoal[] = [];
  for (const dir of [join(cwd, ".pi", "goals"), join(cwd, ".pi", "goals", "archived")]) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const file = join(dir, name);
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const marker = text.indexOf("# Goal Prompt");
      const head = marker >= 0 ? text.slice(0, marker) : text;
      let rec: { id?: string; status?: string; objective?: string; activePath?: string };
      try {
        rec = JSON.parse(head) as typeof rec;
      } catch {
        continue;
      }
      if (!rec.id || rec.status === "complete") continue;
      out.push({
        id: rec.id,
        status: rec.status ?? "unknown",
        title: (rec.objective ?? "").split("\n")[0].slice(0, 120),
        activePath: rec.activePath ?? null,
        file,
      });
    }
  }
  return out;
}

export function buildExistingGoalReport(planPath: string, open: OpenGoal[]): string {
  const lines = open.map(
    (g) => `- ${g.id} · ${g.status} · ${g.title}${g.activePath ? `\n  ${g.activePath}` : ""}`,
  );
  return [
    "M3 adapter stopped before handoff: an existing open goal is present.",
    "",
    `Plan:   ${planPath}`,
    "Open goals:",
    ...lines,
    "",
    "Effect: No message was sent. No pi-goal goal was created.",
    "Action: choose one, then resubmit the plan through Plannotator:",
    "  /goal-focus <id>   work on that goal instead",
    "  /goal-unfocus      leave it open, unfocus it",
    "  /goal-clear        archive it and free the pool",
  ].join("\n");
}

function contextText(lines: string[]): string {
  const keep: Array<[string, string]> = [
    ["## scope", "Scope"],
    ["## out of scope", "Out of scope"],
    ["## risks / constraints", "Constraints"],
  ];
  const out: string[] = [];
  for (const [heading, label] of keep) {
    const start = lines.findIndex((l) => l.trim().toLowerCase() === heading);
    if (start < 0) continue;
    const end = lines.findIndex((l, j) => j > start && /^##\s+/.test(l));
    const body = lines
      .slice(start + 1, end < 0 ? undefined : end)
      .map((l) => l.trim().replace(/^[-*]\s+/, ""))
      .filter((l) => l && !/^(Scope:|\[)/.test(l));
    if (body.length) out.push(`${label}: ${body.join(" ")}`);
  }
  return out.join(" | ");
}

export function buildIR(planPath: string, text: string, feedback?: string): GoalIR {
  const lines = text.split("\n");
  const goal = lines.find((l) => /^Goal:\s*\S/.test(l));
  if (!goal) throw new RejectError("PLAN.md has no 'Goal: <outcome>' line.");

  const tasks: TaskIR[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const box = /^[-*]\s*\[[ xX]\]\s+(\S+)\s*(.*)$/.exec(line);
    if (!box) continue;
    const id = box[1];
    const title = box[2].trim();
    if (/^(M|S)-/.test(id))
      throw new RejectError(`'${id}' is a milestone/story id, not an executable task.`);
    if (!/^T-\d{2,3}(\.\d+)*$/.test(id))
      throw new RejectError(`'${id}' is not a valid task id (T-<nn> or T-<nn>.<m>).`);
    if (seen.has(id)) throw new RejectError(`Duplicate task id '${id}'.`);
    seen.add(id);
    if (!title) throw new RejectError(`Task '${id}' has no title.`);
    const dots = id.split(".").length - 1;
    if (dots > MAX_DEPTH)
      throw new RejectError(
        `Task ${id} exceeds pi-goal supported subtask depth (${MAX_DEPTH}). Flatten it or split the parent.`,
      );
    tasks.push(dots === 0 ? { id, title } : { id, title, parentId: id.split(".")[0] });
  }
  if (tasks.length === 0) throw new RejectError("PLAN.md has no '- [ ] T-<nn>' task checkbox.");
  if (tasks.length > MAX_TASKS)
    throw new RejectError(`PLAN.md has ${tasks.length} tasks; pi-goal allows at most ${MAX_TASKS}.`);
  for (const t of tasks)
    if (t.parentId && !seen.has(t.parentId))
      throw new RejectError(`Task '${t.id}' references missing parent '${t.parentId}'.`);

  const crs: string[] = [];
  for (const line of lines) {
    const cr = /^[-*]\s*(CR-\d{2,3})\s*:\s*(.+)$/.exec(line);
    if (cr) crs.push(`${cr[1]} ${cr[2].trim()}`);
  }
  if (crs.length === 0) throw new RejectError("PLAN.md has no '- CR-<nn>: <text>' requirement.");

  const contract = `Verification contract: ${crs.join("; ")}`;
  const ctx = contextText(lines);
  const objective = [goal.trim(), ctx, contract].filter(Boolean).join("\n\n");
  if (objective.length > MAX_OBJECTIVE)
    throw new RejectError(
      `Objective would be ${objective.length} chars; the safe adapter limit is ${MAX_OBJECTIVE}. Shorten Scope/Risks prose in PLAN.md.`,
    );
  if (contract.length > MAX_CONTRACT)
    throw new RejectError(
      `Verification contract line is ${contract.length} chars; the safe adapter limit is ${MAX_CONTRACT}. Shorten the CR texts.`,
    );

  const modeMarker = /^Execution order:\s*(\S.*)$/im.exec(text);
  const mode: GoalIR["mode"] = modeMarker && /^strict\b/i.test(modeMarker[1].trim()) ? "sisyphus" : "regular";
  if (modeMarker && !/^strict\b/i.test(modeMarker[1].trim()))
    throw new RejectError(
      `PLAN.md declares 'Execution order: ${modeMarker[1].trim()}' but only 'strict' (sisyphus) is supported; omit the line for regular mode.`,
    );
  if (mode === "sisyphus" && !/\b\d{1,2}\s*[).:]|\bstep\s*\d+/i.test(objective))
    throw new RejectError(
      "PLAN.md declares 'Execution order: strict' but the objective has no numbered steps; pi-goal rejects that sisyphus objective.",
    );

  return {
    objective,
    mode,
    tasks,
    verificationContract: contract,
    blockCompletion: true,
    ...(feedback ? { changeSummary: feedback.slice(0, 240) } : {}),
    source: { planPath, planSha256: sha(text) },
  };
}

export function buildHandoffMessage(ir: GoalIR): string {
  const taskLines = ir.tasks
    .map((t) => `- ${t.id} — ${t.title}${t.parentId ? ` (parent_id: "${t.parentId}")` : ""}`)
    .join("\n");
  return [
    "A Plannotator plan has been approved. Create the pi-goal for it exactly as translated below.",
    "",
    "This is an approved user request. Use two steps, in order (create_goal returns terminate:true,",
    "so set_goal_tasks only runs on the continuation turn):",
    "  1. create_goal with objective and mode only.",
    "  2. set_goal_tasks with the task list and block_completion: true — a confirmation dialog appears;",
    "     the user must confirm it. Do not preselect for them.",
    "  3. update_goal({status: \"paused\"}) immediately after the task list is applied, BEFORE doing any",
    "     work. pi-goal auto-continues; pausing hands control back to the user. This is a handoff, not",
    "     an execution: do not run any task, test, or audit for this goal.",
    "",
    "Before step 1, if another goal is open in .pi/goals that does not belong to this plan, STOP:",
    "report that goal (id, status, mode, objective title, activePath) and ask the user to choose",
    "/goal-focus, /goal-unfocus, /goal-clear, or to proceed. Do not create a second goal until they answer.",
    "",
    "Do not reinterpret the plan. Do not invent tasks. Do not skip tasks. Do not rename ids.",
    "Do not create another goal. Do not execute any task now — this step only creates the goal.",
    "If creation or task application fails, STOP and report the exact tool output. Do not retry with",
    "another creation path (/goal-direct, /sisyphus-direct, /goal drafting).",
    "",
    "Objective (pass verbatim):",
    ir.objective,
    "",
    "Mode: " + ir.mode,
    "block_completion: true",
    "",
    "Tasks (ids, titles, parent_id are explicit):",
    taskLines,
    "",
    ir.changeSummary ? `Reviewer note (pass as change_summary, not into the objective): ${ir.changeSummary}` : "",
    "",
    "Completion requirements live in the objective's single-line 'Verification contract:'. Do not move",
    "them into per-task verification_contract fields.",
    "",
    "After creation, verify with get_goal that objective, task ids, parent-child links, verification",
    "contract and block_completion match this message, then reply with a one-line summary.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function reject(planPath: string | null, reason: string): string {
  return [
    "M3 adapter rejected PLAN.md.",
    "",
    `Plan:   ${planPath ?? "(unresolved)"}`,
    `Reason: ${reason}`,
    "Effect: No message was sent. No pi-goal goal was created.",
    "Fix:    Correct the plan file, re-validate, and resubmit through Plannotator.",
  ].join("\n");
}

export default function (pi: ExtensionAPI): void {
  let sessionCtx: ExtensionContext | undefined;

  pi.on("session_start", (_event, startCtx) => {
    sessionCtx = startCtx;
  });

  pi.events.on(PLAN_APPROVED, (data) => {
    const event = (data ?? {}) as {
      cwd?: string;
      planFilePath?: string;
      planContent?: string;
      feedback?: string;
    };

    let configText: string | null = null;
    try {
      configText = readFileSync(CONFIG_PATH, "utf8");
    } catch {
      configText = null;
    }
    if (!isEnabled(configText)) {
      log({ kind: "skip", reason: "adapter disabled or no config", planFilePath: event.planFilePath });
      return;
    }

    setImmediate(() => {
      const report = (text: string, kind: string): void => {
        log({ kind, text });
        sessionCtx?.ui?.notify?.(text.split("\n").slice(0, 3).join(" "), "warning");
      };
      const resolved =
        typeof event.planFilePath === "string" && typeof event.cwd === "string"
          ? resolve(event.cwd, event.planFilePath)
          : null;
      if (!resolved) return report("M3 adapter: plan-approved event had no cwd/planFilePath.", "reject");

      let text = "";
      try {
        text = readFileSync(resolved, "utf8");
      } catch {
        return report(reject(resolved, "Plan file could not be read from disk."), "reject");
      }

      if (typeof event.planContent === "string" && event.planContent !== text)
        return report(reject(resolved, "Plan file on disk differs from the approved payload."), "reject");

      try {
        execFileSync("node", [VALIDATOR, resolved], { stdio: "pipe" });
      } catch (err) {
        const out = String((err as { stdout?: Buffer }).stdout ?? "").trim();
        return report(reject(resolved, `plans/validate.mjs failed:\n${out || String(err)}`), "reject");
      }

      let ir: GoalIR;
      try {
        ir = buildIR(resolved, text, event.feedback);
      } catch (err) {
        const reason = err instanceof RejectError ? err.message : String(err);
        return report(reject(resolved, reason), "reject");
      }

      const openGoals = findOpenGoals(event.cwd as string);
      if (openGoals.length > 0) {
        return report(buildExistingGoalReport(resolved, openGoals), "existing-goal-stop");
      }

      const message = buildHandoffMessage(ir);
      const deliverAs = sessionCtx?.isIdle?.() ? "followUp" : "steer";
      log({
        kind: "handoff",
        planPath: resolved,
        planSha256: ir.source.planSha256,
        tasks: ir.tasks.length,
        mode: ir.mode,
        deliverAs,
      });
      pi.sendUserMessage(message, { deliverAs: deliverAs as "steer" | "followUp" });
    });
  });
}