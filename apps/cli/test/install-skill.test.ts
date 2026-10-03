import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill, SkillInstallRefusalError } from "../src/install-skill";

let temporary = "";

afterEach(() => {
  if (temporary) rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  temporary = "";
});

describe("agentctl install-skill", () => {
  test("copies SKILL.md and reference files to an explicit temp target", () => {
    temporary = mkdtempSync(join(tmpdir(), "agent-board-skill-test-"));
    const target = join(temporary, "skills", "agent-board");
    const result = installSkill({ target });
    expect(result.alreadyCurrent).toBe(false);
    expect(result.files).toContain("SKILL.md");
    expect(result.files.some((file) => file.startsWith("references/"))).toBe(true);
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toContain("agent-board");
  });

  test("refuses differing existing contents unless --force, then replaces them", () => {
    temporary = mkdtempSync(join(tmpdir(), "agent-board-skill-test-"));
    const target = join(temporary, "agent-board");
    const source = join(temporary, "source");
    mkdirSync(source);
    writeFileSync(join(source, "SKILL.md"), "repository skill\n", "utf8");
    mkdirSync(target);
    writeFileSync(join(target, "SKILL.md"), "different skill\n", "utf8");
    expect(() => installSkill({ source, target })).toThrow(SkillInstallRefusalError);
    const result = installSkill({ source, target, force: true });
    expect(result.alreadyCurrent).toBe(false);
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("repository skill\n");
  });
});
