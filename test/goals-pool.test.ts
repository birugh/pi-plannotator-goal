/**
 * Decision table for goals-pool.ts and goals.ts.
 *
 * Every case builds its own temp cwd, fake agent dir and settings files, so the real
 * ~/.pi/agent is never read. The expected precedence is copied from pi-goal-x:
 * PI_GOAL_ROOT > project > global > <cwd>/.pi/goals.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  defaultGoalsRoot,
  expandHome,
  globalSettingsPath,
  projectSettingsPath,
  resolveGoalsRoot,
  validateGoalsRoot,
} from "../goals-pool.ts";
import { ACTIVE_GOAL_FILE_RE, buildExistingGoalReport, findOpenGoals, parseGoalHeader } from "../goals.ts";

function makeEnv(): { cwd: string; agentDir: string; homeDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ppg-pool-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");
  for (const dir of [cwd, agentDir, homeDir]) mkdirSync(dir, { recursive: true });
  return { cwd, agentDir, homeDir };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function writeText(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

/** A pi-goal-x shaped goal file: JSON header, blank line, body with the prompt. */
export function goalFile(id: string, status: string, objective: string, activePath?: string): string {
  const record = {
    id,
    objective,
    status,
    ...(activePath === undefined ? {} : { activePath }),
    autoContinue: false,
    usage: { activeSeconds: 0, tokensUsed: 0 },
    sisyphus: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return `${JSON.stringify(record, null, 2)}\n\n# Goal Prompt\n\n${objective}\n\n## Progress\n\n- Status: ${status}\n`;
}

describe("goalsRoot precedence decision table", () => {
  it("default when nothing is configured", () => {
    const { cwd, agentDir, homeDir } = makeEnv();
    const result = resolveGoalsRoot({ cwd, env: { PI_CODING_AGENT_DIR: agentDir }, homeDir });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.root, defaultGoalsRoot(cwd));
      assert.equal(result.value.source, "default");
    }
  });

  it("global layer when only the agent dir file declares it", () => {
    const { cwd, agentDir, homeDir } = makeEnv();
    const pool = join(homeDir, "global-pool");
    mkdirSync(pool, { recursive: true });
    writeJson(join(agentDir, "pi-goal-x-settings.json"), { goalsRoot: pool });
    const result = resolveGoalsRoot({ cwd, env: { PI_CODING_AGENT_DIR: agentDir }, homeDir });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.root, pool);
      assert.equal(result.value.source, "global");
    }
  });

  it("project layer overrides global", () => {
    const { cwd, agentDir, homeDir } = makeEnv();
    const projectPool = join(homeDir, "project-pool");
    const globalPool = join(homeDir, "global-pool");
    mkdirSync(projectPool, { recursive: true });
    mkdirSync(globalPool, { recursive: true });
    writeJson(join(agentDir, "pi-goal-x-settings.json"), { goalsRoot: globalPool });
    writeJson(join(cwd, ".pi", "pi-goal-x-settings.json"), { goalsRoot: projectPool });
    const result = resolveGoalsRoot({ cwd, env: { PI_CODING_AGENT_DIR: agentDir }, homeDir });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.root, projectPool);
      assert.equal(result.value.source, "project");
    }
  });

  it("PI_GOAL_ROOT overrides every file layer", () => {
    const { cwd, agentDir, homeDir } = makeEnv();
    const envPool = join(homeDir, "env-pool");
    mkdirSync(envPool, { recursive: true });
    writeJson(join(agentDir, "pi-goal-x-settings.json"), { goalsRoot: join(homeDir, "global-pool") });
    writeJson(join(cwd, ".pi", "pi-goal-x-settings.json"), { goalsRoot: join(homeDir, "project-pool") });
    const result = resolveGoalsRoot({
      cwd,
      env: { PI_CODING_AGENT_DIR: agentDir, PI_GOAL_ROOT: envPool },
      homeDir,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.root, envPool);
      assert.equal(result.value.source, "environment");
    }
  });

  it("expands ~ in an environment override", () => {
    const { cwd, agentDir, homeDir } = makeEnv();
    mkdirSync(join(homeDir, "pool"), { recursive: true });
    const result = resolveGoalsRoot({
      cwd,
      env: { PI_CODING_AGENT_DIR: agentDir, PI_GOAL_ROOT: "~/pool" },
      homeDir,
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.root, join(homeDir, "pool"));
  });

  it("honors PI_GOAL_SETTINGS_FILE for the project layer", () => {
    const { cwd, agentDir, homeDir } = makeEnv();
    const pool = join(homeDir, "override-pool");
    const overrideFile = join(homeDir, "other-settings.json");
    mkdirSync(pool, { recursive: true });
    writeJson(overrideFile, { goalsRoot: pool });
    // The default project path declares a different pool that must lose.
    writeJson(join(cwd, ".pi", "pi-goal-x-settings.json"), { goalsRoot: join(homeDir, "decoy") });
    const env = { PI_CODING_AGENT_DIR: agentDir, PI_GOAL_SETTINGS_FILE: overrideFile };
    assert.equal(projectSettingsPath(cwd, env), overrideFile);
    const result = resolveGoalsRoot({ cwd, env, homeDir });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.root, pool);
      assert.equal(result.value.source, "project");
    }
  });

  it("honors PI_GOAL_GLOBAL_SETTINGS_FILE for the global layer", () => {
    const { cwd, agentDir, homeDir } = makeEnv();
    const pool = join(homeDir, "override-pool");
    const overrideFile = join(homeDir, "other-global.json");
    mkdirSync(pool, { recursive: true });
    writeJson(overrideFile, { goalsRoot: pool });
    writeJson(join(agentDir, "pi-goal-x-settings.json"), { goalsRoot: join(homeDir, "decoy") });
    const env = { PI_CODING_AGENT_DIR: agentDir, PI_GOAL_GLOBAL_SETTINGS_FILE: overrideFile };
    assert.equal(globalSettingsPath(env, homeDir), overrideFile);
    const result = resolveGoalsRoot({ cwd, env, homeDir });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.root, pool);
      assert.equal(result.value.source, "global");
    }
  });

  it("a relative settings override resolves against cwd or home", () => {
    const { cwd, homeDir } = makeEnv();
    assert.equal(projectSettingsPath(cwd, { PI_GOAL_SETTINGS_FILE: "cfg.json" }), join(cwd, "cfg.json"));
    assert.equal(globalSettingsPath({ PI_GOAL_GLOBAL_SETTINGS_FILE: "g.json" }, homeDir), join(homeDir, "g.json"));
  });
});

describe("goalsRoot refusals", () => {
  it("malformed project settings JSON refuses instead of guessing", () => {
    const { cwd, agentDir, homeDir } = makeEnv();
    writeText(join(cwd, ".pi", "pi-goal-x-settings.json"), "{ not json");
    const result = resolveGoalsRoot({ cwd, env: { PI_CODING_AGENT_DIR: agentDir }, homeDir });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "goals-root-invalid");
      assert.match(result.error.message, /not valid JSON/);
    }
  });

  it("malformed global settings JSON refuses", () => {
    const { cwd, agentDir, homeDir } = makeEnv();
    writeText(join(agentDir, "pi-goal-x-settings.json"), "[]");
    const result = resolveGoalsRoot({ cwd, env: { PI_CODING_AGENT_DIR: agentDir }, homeDir });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /not a JSON object/);
  });

  it("a non-string goalsRoot refuses", () => {
    const { cwd, agentDir, homeDir } = makeEnv();
    writeJson(join(cwd, ".pi", "pi-goal-x-settings.json"), { goalsRoot: 42 });
    const result = resolveGoalsRoot({ cwd, env: { PI_CODING_AGENT_DIR: agentDir }, homeDir });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /unexpected goalsRoot type/);
  });

  it("an empty string goalsRoot refuses", () => {
    const { cwd, agentDir, homeDir } = makeEnv();
    writeJson(join(cwd, ".pi", "pi-goal-x-settings.json"), { goalsRoot: "   " });
    const result = resolveGoalsRoot({ cwd, env: { PI_CODING_AGENT_DIR: agentDir }, homeDir });
    assert.equal(result.ok, false);
  });

  it("a relative path refuses", () => {
    const { cwd, agentDir, homeDir } = makeEnv();
    const result = resolveGoalsRoot({
      cwd,
      env: { PI_CODING_AGENT_DIR: agentDir, PI_GOAL_ROOT: "relative/pool" },
      homeDir,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /must be an absolute path or ~\/path/);
  });

  it("a path containing NUL refuses", () => {
    const { cwd, agentDir, homeDir } = makeEnv();
    const result = resolveGoalsRoot({
      cwd,
      env: { PI_CODING_AGENT_DIR: agentDir, PI_GOAL_ROOT: "/tmp/pool\0evil" },
      homeDir,
    });
    assert.equal(result.ok, false);
  });

  it("a symlinked pool refuses", () => {
    const { cwd, agentDir, homeDir } = makeEnv();
    const real = join(homeDir, "real-pool");
    const link = join(homeDir, "link-pool");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    const result = resolveGoalsRoot({
      cwd,
      env: { PI_CODING_AGENT_DIR: agentDir, PI_GOAL_ROOT: link },
      homeDir,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /is a symlink/);
  });

  it("a pool that does not exist yet is accepted, not refused", () => {
    const { homeDir } = makeEnv();
    const result = validateGoalsRoot(join(homeDir, "not-created-yet"), homeDir);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, join(homeDir, "not-created-yet"));
  });

  it("expandHome handles ~, ~/x and plain paths", () => {
    assert.equal(expandHome("~", "/home/x"), "/home/x");
    assert.equal(expandHome("~/p", "/home/x"), "/home/x/p");
    assert.equal(expandHome("/abs/p", "/home/x"), "/abs/p");
  });
});

describe("findOpenGoals over a pool", () => {
  it("reads active goals and never the archived directory", () => {
    const { cwd } = makeEnv();
    const pool = join(cwd, ".pi", "goals");
    mkdirSync(join(pool, "archived"), { recursive: true });
    writeText(join(pool, "active_goal_20260101000000_probe-open.md"), goalFile("probe-open", "paused", "Open goal", ".pi/goals/active_goal_20260101000000_probe-open.md"));
    writeText(join(pool, "archived", "goal_20260101000000_probe-retired.md"), goalFile("probe-retired", "paused", "Retired goal"));
    const open = findOpenGoals(pool);
    assert.equal(open.length, 1);
    assert.equal(open[0]?.id, "probe-open");
    assert.equal(open[0]?.status, "paused");
    assert.equal(open[0]?.title, "Open goal");
    assert.match(open[0]?.activePath ?? "", /active_goal_/);
  });

  it("ignores non-goal files without reading them as goals", () => {
    const { cwd } = makeEnv();
    const pool = join(cwd, ".pi", "goals");
    mkdirSync(pool, { recursive: true });
    writeText(join(pool, "goal_events.jsonl"), "{}\n");
    writeText(join(pool, ".goal-ledger-checkpoint.json"), "{}");
    writeText(join(pool, "active_goal_notes.txt"), "not a goal");
    assert.deepEqual(findOpenGoals(pool), []);
  });

  it("skips a complete goal", () => {
    const { cwd } = makeEnv();
    const pool = join(cwd, ".pi", "goals");
    mkdirSync(pool, { recursive: true });
    writeText(join(pool, "active_goal_20260101000000_done.md"), goalFile("done", "complete", "Finished"));
    assert.deepEqual(findOpenGoals(pool), []);
  });

  it("a missing pool is empty, not an error", () => {
    assert.deepEqual(findOpenGoals(join(tmpdir(), "ppg-pool-that-does-not-exist")), []);
  });

  it("a headerless or unparsable file is skipped", () => {
    const { cwd } = makeEnv();
    const pool = join(cwd, ".pi", "goals");
    mkdirSync(pool, { recursive: true });
    writeText(join(pool, "active_goal_20260101000000_bad.md"), "# Goal Prompt\n\nno header\n");
    writeText(join(pool, "active_goal_20260101000000_wrong.md"), `${JSON.stringify({ status: "paused" })}\n\n# Goal Prompt\n`);
    assert.deepEqual(findOpenGoals(pool), []);
  });

  it("falls back to the full prefix when the header has no blank line", () => {
    const header = JSON.stringify({ id: "no-blank", status: "active", objective: "Single line header" });
    assert.equal(parseGoalHeader(`${header}\n# Goal Prompt\n\nbody\n`)?.id, "no-blank");
  });

  it("matches only active_goal_*.md names", () => {
    for (const name of ["active_goal_a.md", "active_goal_20260101000000_x.md"]) {
      assert.equal(ACTIVE_GOAL_FILE_RE.test(name), true, name);
    }
    for (const name of ["goal_a.md", "active_goal_a.txt", "archived.md", "active_goal_"]) {
      assert.equal(ACTIVE_GOAL_FILE_RE.test(name), false, name);
    }
  });
});

describe("buildExistingGoalReport", () => {
  it("names the stop, the plan and every open goal", () => {
    const report = buildExistingGoalReport("/tmp/plans/M-01.md", [
      { id: "g1", status: "paused", title: "First", activePath: ".pi/goals/a.md", file: "/tmp/a.md" },
      { id: "g2", status: "unknown", title: "Second", activePath: null, file: "/tmp/b.md" },
    ]);
    assert.match(report, /stopped before handoff: an existing open goal is present/);
    assert.match(report, /Plan:   \/tmp\/plans\/M-01\.md/);
    assert.match(report, /- g1 · paused · First/);
    assert.match(report, /- g2 · unknown · Second/);
    assert.match(report, /No message was sent\. No pi-goal goal was created\./);
    for (const cmd of ["/goal-focus", "/goal-unfocus", "/goal-clear"]) {
      assert.ok(report.includes(cmd), cmd);
    }
  });
});