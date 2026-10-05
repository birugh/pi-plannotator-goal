/**
 * Goal pool resolution: where pi-goal-x keeps its goals.
 *
 * The old adapter hardcoded `join(cwd, ".pi", "goals")` and therefore missed a pool
 * relocated through `goalsRoot` or `PI_GOAL_ROOT`: it would happily hand off while
 * looking for open goals in the wrong directory.
 *
 * Precedence is copied from pi-goal-x (`extensions/goal-settings.ts:777-779`,
 * `extensions/storage/goal-root.ts:30-62`) so this adapter and the real pool cannot
 * disagree:
 *
 *     PI_GOAL_ROOT > project layer > global layer > <cwd>/.pi/goals
 *
 * Values are validated like pi-goal-x validates them: `~` expands, and a result that is
 * not absolute, contains NUL, or resolves through a symlink is refused. Unlike
 * pi-goal-x, a settings file that cannot be parsed is ALSO refused here: a handoff made
 * against a guessed pool is worse than a refusal, and the refusal is a typed value.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { fail, ok, reject, type Result, type RejectReason } from "./types.ts";
import { resolveAgentDir } from "./config.ts";

export const PI_GOAL_ROOT_ENV = "PI_GOAL_ROOT";
export const PI_GOAL_SETTINGS_FILE_ENV = "PI_GOAL_SETTINGS_FILE";
export const PI_GOAL_GLOBAL_SETTINGS_FILE_ENV = "PI_GOAL_GLOBAL_SETTINGS_FILE";

export const PI_GOAL_SETTINGS_FILE_NAME = "pi-goal-x-settings.json";

export type GoalsRootSource = "environment" | "project" | "global" | "default";

export type ResolvedGoalsRoot = {
  /** Absolute, symlink-resolved pool root. */
  root: string;
  source: GoalsRootSource;
  /** The path the value came from when a file supplied it. */
  settingsFile?: string;
};

export type GoalsRootContext = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

/**
 * The only key this adapter reads from pi-goal-x settings. Validated with typebox like
 * every other untrusted boundary, so an environment override and a file value are
 * checked by the same code.
 */
const GoalsRootLayerSchema = Type.Object(
  { goalsRoot: Type.Optional(Type.String()) },
  { additionalProperties: true },
);

type GoalsRootLayer = Static<typeof GoalsRootLayerSchema>;

/** A non-empty trimmed string, or undefined. Shared by env and file values. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Global settings path: PI_GOAL_GLOBAL_SETTINGS_FILE (abs or ~-relative) else agent dir. */
export function globalSettingsPath(env: NodeJS.ProcessEnv = process.env, homeDir: string = homedir()): string {
  const override = nonEmptyString(env[PI_GOAL_GLOBAL_SETTINGS_FILE_ENV]);
  if (override !== undefined) {
    return isAbsolute(override) ? normalize(override) : resolve(homeDir, override);
  }
  return join(resolveAgentDir(env, homeDir), PI_GOAL_SETTINGS_FILE_NAME);
}

/** Project settings path: PI_GOAL_SETTINGS_FILE (abs or cwd-relative) else <cwd>/.pi. */
export function projectSettingsPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = nonEmptyString(env[PI_GOAL_SETTINGS_FILE_ENV]);
  if (override !== undefined) {
    return isAbsolute(override) ? normalize(override) : resolve(cwd, override);
  }
  return join(cwd, ".pi", PI_GOAL_SETTINGS_FILE_NAME);
}

/** The compiled-in default pool, relative to the session cwd. */
export function defaultGoalsRoot(cwd: string): string {
  return join(cwd, ".pi", "goals");
}

type LayerRead = { value: string | undefined; note: string | null; path: string };

/**
 * Read only the `goalsRoot` key from one settings file.
 *
 * A missing file is silent. A file that exists but is not a JSON object, or is not JSON
 * at all, produces a note that the caller turns into a refusal: the goal pool must not
 * be guessed.
 */
function readGoalsRootLayer(path: string, label: string): LayerRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { value: undefined, note: null, path };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { value: undefined, note: `${label} settings at ${path} is not valid JSON`, path };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { value: undefined, note: `${label} settings at ${path} is not a JSON object`, path };
  }
  if (!Value.Check(GoalsRootLayerSchema, raw)) {
    return { value: undefined, note: `${label} settings at ${path} has an unexpected goalsRoot type`, path };
  }
  const layer: GoalsRootLayer = Value.Decode(GoalsRootLayerSchema, raw);
  const parsed = nonEmptyString(layer.goalsRoot);
  if (layer.goalsRoot === undefined) return { value: undefined, note: null, path };
  if (parsed === undefined) {
    return { value: undefined, note: `${label} settings goalsRoot at ${path} must be a non-empty string`, path };
  }
  return { value: parsed, note: null, path };
}

/** Expand a leading `~` or `~/` the way pi-goal-x does. */
export function expandHome(value: string, homeDir: string = homedir()): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return value;
}

/**
 * Validate a candidate root exactly as pi-goal-x does, then resolve it.
 *
 * Refusals: not absolute after expansion, contains NUL, exists but is a symlink.
 */
export function validateGoalsRoot(
  candidate: string,
  homeDir: string = homedir(),
): Result<string, RejectReason> {
  const expanded = expandHome(candidate, homeDir);
  if (!isAbsolute(expanded) || expanded.includes("\0")) {
    return fail(
      reject(
        "goals-root-invalid",
        "goalsRoot / PI_GOAL_ROOT must be an absolute path or ~/path; reload after correcting it.",
      ),
    );
  }
  const normalized = normalize(expanded);
  if (existsSync(normalized)) {
    if (lstatSync(normalized).isSymbolicLink()) {
      return fail(reject("goals-root-invalid", `Goal root is a symlink: ${normalized}`));
    }
    return ok(realpathSync(normalized));
  }
  return ok(normalized);
}

/**
 * Resolve the goal pool for one session.
 *
 * Returns a typed refusal rather than falling back when a layer is malformed or a value
 * is invalid: handoff must never proceed against a guessed pool.
 */
export function resolveGoalsRoot(ctx: GoalsRootContext): Result<ResolvedGoalsRoot, RejectReason> {
  const cwd = ctx.cwd;
  const env = ctx.env ?? process.env;
  const homeDir = ctx.homeDir ?? homedir();

  const envValue = nonEmptyString(env[PI_GOAL_ROOT_ENV]);
  const project = readGoalsRootLayer(projectSettingsPath(cwd, env), "project");
  const global = readGoalsRootLayer(globalSettingsPath(env, homeDir), "global");

  const malformed = [project.note, global.note].find((n): n is string => n !== null);
  if (malformed !== undefined) {
    return fail(reject("goals-root-invalid", `${malformed}; refusing to guess the goal pool.`));
  }

  if (envValue !== undefined) {
    const resolved = validateGoalsRoot(envValue, homeDir);
    if (!resolved.ok) return resolved;
    return ok({ root: resolved.value, source: "environment" });
  }

  if (project.value !== undefined) {
    const resolved = validateGoalsRoot(project.value, homeDir);
    if (!resolved.ok) return resolved;
    return ok({ root: resolved.value, source: "project", settingsFile: project.path });
  }

  if (global.value !== undefined) {
    const resolved = validateGoalsRoot(global.value, homeDir);
    if (!resolved.ok) return resolved;
    return ok({ root: resolved.value, source: "global", settingsFile: global.path });
  }

  const fallback = validateGoalsRoot(defaultGoalsRoot(cwd), homeDir);
  if (!fallback.ok) return fallback;
  return ok({ root: fallback.value, source: "default" });
}