/**
 * Boundary tests for config.ts: the enabled truth table from the M3 probe, scope
 * precedence, malformed files, and payload validation.
 *
 * Every case builds its own temp cwd and fake agent dir, so the real ~/.pi/agent is
 * never read or written.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ConfigSchema,
  CONFIG_FILE_NAME,
  PayloadSchema,
  parsePayload,
  projectConfigPath,
  resolveAgentDir,
  resolveConfig,
  resolvePlanPath,
} from "../config.ts";
import { Value } from "typebox/value";

function makeDirs(): { cwd: string; agentDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ppg-config-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { cwd, agentDir };
}

function writeConfig(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

describe("enabled truth table", () => {
  const cases: Array<[string, boolean]> = [
    ["absent file", false],
    ["malformed json", false],
    ["empty object", false],
    ['{"enabled":"true"}', false],
    ["{\"enabled\":false}", false],
    ["{\"enabled\":true}", true],
  ];

  for (const [text, expected] of cases) {
    it(`${JSON.stringify(text)} -> ${String(expected)}`, () => {
      const { cwd, agentDir } = makeDirs();
      if (text !== "absent file") writeConfig(join(agentDir, CONFIG_FILE_NAME), text);
      const config = resolveConfig(cwd, { PI_CODING_AGENT_DIR: agentDir }, "/nonexistent-home");
      assert.equal(config.enabled, expected);
    });
  }
});

describe("scope precedence", () => {
  it("project value wins over global", () => {
    const { cwd, agentDir } = makeDirs();
    writeConfig(join(agentDir, CONFIG_FILE_NAME), JSON.stringify({ enabled: false }));
    writeConfig(projectConfigPath(cwd), JSON.stringify({ enabled: true }));
    const config = resolveConfig(cwd, { PI_CODING_AGENT_DIR: agentDir }, "/nonexistent-home");
    assert.equal(config.enabled, true);
    assert.equal(config.sources.enabled, "project");
  });

  it("falls back to global when the project key is absent", () => {
    const { cwd, agentDir } = makeDirs();
    writeConfig(join(agentDir, CONFIG_FILE_NAME), JSON.stringify({ enabled: true }));
    writeConfig(projectConfigPath(cwd), JSON.stringify({ logPath: "/tmp/other.jsonl" }));
    const config = resolveConfig(cwd, { PI_CODING_AGENT_DIR: agentDir }, "/nonexistent-home");
    assert.equal(config.enabled, true);
    assert.equal(config.sources.enabled, "global");
    assert.equal(config.sources.logPath, "project");
  });

  it("a malformed project file falls back to global instead of disabling", () => {
    const { cwd, agentDir } = makeDirs();
    writeConfig(join(agentDir, CONFIG_FILE_NAME), JSON.stringify({ enabled: true }));
    writeConfig(projectConfigPath(cwd), "{ this is not json");
    const config = resolveConfig(cwd, { PI_CODING_AGENT_DIR: agentDir }, "/nonexistent-home");
    assert.equal(config.enabled, true);
    assert.equal(config.sources.enabled, "global");
    assert.equal(config.notes.length, 1, "the ignored file is reported");
    assert.match(config.notes[0] ?? "", /not valid JSON/);
  });

  it("a wrongly typed value is ignored, not coerced", () => {
    const { cwd, agentDir } = makeDirs();
    writeConfig(projectConfigPath(cwd), JSON.stringify({ enabled: "true" }));
    const config = resolveConfig(cwd, { PI_CODING_AGENT_DIR: agentDir }, "/nonexistent-home");
    assert.equal(config.enabled, false);
    assert.equal(config.sources.enabled, "default");
    assert.match(config.notes[0] ?? "", /unexpected types/);
  });

  it("defaults come from the agent dir when no file declares them", () => {
    const { cwd, agentDir } = makeDirs();
    const config = resolveConfig(cwd, { PI_CODING_AGENT_DIR: agentDir }, "/nonexistent-home");
    assert.equal(config.validatePath, join(agentDir, "plans", "validate.mjs"));
    assert.equal(config.logPath, join(agentDir, "plans", "plannotator-goal.jsonl"));
    assert.equal(config.sources.validatePath, "default");
  });

  it("a relative override resolves against cwd, an absolute one is kept", () => {
    const { cwd, agentDir } = makeDirs();
    writeConfig(
      projectConfigPath(cwd),
      JSON.stringify({ logPath: "logs/adapter.jsonl", validatePath: "/opt/validate.mjs" }),
    );
    const config = resolveConfig(cwd, { PI_CODING_AGENT_DIR: agentDir }, "/nonexistent-home");
    assert.equal(config.logPath, join(cwd, "logs", "adapter.jsonl"));
    assert.equal(config.validatePath, "/opt/validate.mjs");
  });

  it("honors PI_CODING_AGENT_DIR, absolute and home-relative", () => {
    assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "/tmp/agent" }, "/home/x"), "/tmp/agent");
    assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "cfg" }, "/home/x"), "/home/x/cfg");
    assert.equal(resolveAgentDir({}, "/home/x"), "/home/x/.pi/agent");
  });

  it("unknown extra keys are tolerated", () => {
    const { cwd, agentDir } = makeDirs();
    writeConfig(
      projectConfigPath(cwd),
      JSON.stringify({ enabled: true, _comment: "kill switch", futureKey: 1 }),
    );
    const config = resolveConfig(cwd, { PI_CODING_AGENT_DIR: agentDir }, "/nonexistent-home");
    assert.equal(config.enabled, true);
  });
});

describe("payload boundary", () => {
  it("accepts a well-formed payload without asserting", () => {
    const parsed = parsePayload({
      cwd: "/tmp/p",
      planFilePath: "plans/M-01.md",
      planContent: "x",
      feedback: "ok",
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.value.planFilePath, "plans/M-01.md");
  });

  it("accepts an empty payload and lets the caller reject it", () => {
    const parsed = parsePayload(undefined);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const path = resolvePlanPath(parsed.value);
    assert.equal(path.ok, false);
    if (!path.ok) assert.equal(path.error.code, "bad-payload");
  });

  it("rejects a wrongly typed field", () => {
    const parsed = parsePayload({ cwd: 42, planFilePath: "plans/M-01.md" });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.error.code, "bad-payload");
  });

  it("resolves the plan path against cwd", () => {
    const path = resolvePlanPath({ cwd: "/tmp/p", planFilePath: "plans/M-01.md" });
    assert.equal(path.ok, true);
    if (path.ok) assert.equal(path.value, "/tmp/p/plans/M-01.md");
  });

  it("schemas reject the values the old blind cast accepted", () => {
    assert.equal(Value.Check(ConfigSchema, { enabled: "true" }), false);
    assert.equal(Value.Check(PayloadSchema, { planFilePath: null }), false);
    assert.equal(Value.Check(PayloadSchema, { cwd: "/tmp" }), true);
  });
});