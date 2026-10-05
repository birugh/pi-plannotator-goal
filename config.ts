/**
 * Every untrusted boundary of the adapter, validated with a runtime schema.
 *
 * Boundaries covered here:
 * - the kill-switch/settings file, project scope over global scope
 * - the `plannotator:plan-approved` event payload
 *
 * Types are inferred from the schemas (`Static<typeof Schema>`) so the runtime check
 * and the compile-time type cannot drift apart. Nothing is read from disk or from the
 * event without passing `Value.Check` first; a malformed value is a typed rejection or
 * a documented fallback, never an assertion.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { fail, ok, reject, type Result, type RejectReason } from "./types.ts";

export const PLAN_APPROVED = "plannotator:plan-approved";

export const CONFIG_FILE_NAME = "plannotator-goal.json";

/** Agent dir, honoring PI_CODING_AGENT_DIR the same way pi-goal-x does. */
export function resolveAgentDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): string {
  const override = env.PI_CODING_AGENT_DIR;
  if (override !== undefined && override !== "") {
    return isAbsolute(override) ? normalize(override) : resolve(homeDir, override);
  }
  return join(homeDir, ".pi", "agent");
}


/**
 * The historical M3 sink was <agent dir>/plans/probes/m3-adapter-log.jsonl. That directory
 * was removed with the adapter's own probe directory, and the old default would recreate it
 * on the first handoff, so the default is the same file one level up. An explicit logPath,
 * including the historical one, is still honored.
 */
export function defaultLogPath(agentDir: string): string {
  return join(agentDir, "plans", "plannotator-goal.jsonl");
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", CONFIG_FILE_NAME);
}

export function globalConfigPath(agentDir: string): string {
  return join(agentDir, CONFIG_FILE_NAME);
}

/**
 * Settings file schema. Unknown keys are tolerated so the file can carry comments or
 * keys owned by a later version; only the three known keys are read.
 */
export const ConfigSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    logPath: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export type AdapterConfig = Static<typeof ConfigSchema>;

/**
 * `plannotator:plan-approved` payload schema. The old adapter asserted this shape with
 * a blind `as`, which let a renamed producer field turn into `undefined` at use time.
 */
export const PayloadSchema = Type.Object(
  {
    cwd: Type.Optional(Type.String()),
    planFilePath: Type.Optional(Type.String()),
    planContent: Type.Optional(Type.String()),
    feedback: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export type PlanApprovedPayload = Static<typeof PayloadSchema>;

export type ConfigSource = "project" | "global" | "default";

export type ResolvedConfig = {
  enabled: boolean;
  logPath: string;
  sources: { enabled: ConfigSource; logPath: ConfigSource };
  /** Human-readable notes about files that were ignored, surfaced in the log. */
  notes: string[];
};

type RawLayer = { config: AdapterConfig | null; note: string | null };

export function parsePayload(data: unknown): Result<PlanApprovedPayload, RejectReason> {
  const candidate = data ?? {};
  if (!Value.Check(PayloadSchema, candidate)) {
    return fail(reject("bad-payload", "plan-approved event payload did not match the expected shape."));
  }
  // Decode is typed as Static<typeof PayloadSchema>: no assertion at this boundary.
  return ok(Value.Decode(PayloadSchema, candidate));
}

/**
 * Read one config file. A missing file is "absent and silent"; a file that exists but
 * cannot be read or parsed produces a note so the fallback is observable in the log.
 */
function readLayer(path: string, label: string): RawLayer {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { config: null, note: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { config: null, note: `${label} config at ${path} is not valid JSON; ignored.` };
  }
  if (!Value.Check(ConfigSchema, raw)) {
    return { config: null, note: `${label} config at ${path} has unexpected types; ignored.` };
  }
  return { config: Value.Decode(ConfigSchema, raw), note: null };
}

/**
 * Resolve the effective configuration, per key, project scope over global scope.
 *
 * - A key that is present and valid in the project file wins.
 * - A key that is missing or invalid at one scope falls through to the next scope, so a
 *   malformed project file can never silently disable the adapter.
 * - A key absent everywhere falls back to the compiled default.
 */
export function resolveConfig(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): ResolvedConfig {
  const agentDir = resolveAgentDir(env, homeDir);
  const project = readLayer(projectConfigPath(cwd), "project");
  const global = readLayer(globalConfigPath(agentDir), "global");

  const notes = [project.note, global.note].filter((n): n is string => n !== null);

  const pick = <K extends "enabled" | "logPath">(
    key: K,
  ): { value: AdapterConfig[K] | undefined; source: ConfigSource } => {
    const fromProject = project.config?.[key];
    if (fromProject !== undefined) return { value: fromProject, source: "project" };
    const fromGlobal = global.config?.[key];
    if (fromGlobal !== undefined) return { value: fromGlobal, source: "global" };
    return { value: undefined, source: "default" };
  };

  const enabled = pick("enabled");
  const log = pick("logPath");

  const logPath =
    log.value === undefined
      ? defaultLogPath(agentDir)
      : isAbsolute(log.value)
        ? normalize(log.value)
        : resolve(cwd, log.value);

  return {
    enabled: enabled.value === true,
    logPath,
    sources: {
      enabled: enabled.source,
      logPath: log.source,
    },
    notes,
  };
}

/**
 * Resolve the approved plan path against the event cwd. Both fields are required: a
 * payload without them is unroutable and is reported as a rejection by the caller.
 */
export function resolvePlanPath(payload: PlanApprovedPayload): Result<string, RejectReason> {
  if (payload.cwd === undefined || payload.planFilePath === undefined) {
    return fail(reject("bad-payload", "plan-approved event had no cwd/planFilePath."));
  }
  return ok(resolve(payload.cwd, payload.planFilePath));
}