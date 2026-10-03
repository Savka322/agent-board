import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTCTL_PLACEHOLDER, defaultAgentctlCommand, installSkill, SkillInstallRefusalError } from "../src/install-skill";

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

  test("writes the agentctl command into Markdown files and treats it as part of the contents", () => {
    temporary = mkdtempSync(join(tmpdir(), "agent-board-skill-test-"));
    const target = join(temporary, "agent-board");
    const source = join(temporary, "source");
    mkdirSync(join(source, "references"), { recursive: true });
    writeFileSync(join(source, "SKILL.md"), `Run ${AGENTCTL_PLACEHOLDER} status\n`, "utf8");
    writeFileSync(join(source, "references", "notes.md"), `${AGENTCTL_PLACEHOLDER} wait\n`, "utf8");
    installSkill({ source, target, command: "bun \"C:/board/index.ts\"" });
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("Run bun \"C:/board/index.ts\" status\n");
    expect(readFileSync(join(target, "references", "notes.md"), "utf8")).toBe("bun \"C:/board/index.ts\" wait\n");
    expect(installSkill({ source, target, command: "bun \"C:/board/index.ts\"" }).alreadyCurrent).toBe(true);
    expect(() => installSkill({ source, target, command: "bun \"D:/moved/index.ts\"" })).toThrow(SkillInstallRefusalError);
  });

  test("the default command points at an existing CLI entry", () => {
    const command = defaultAgentctlCommand();
    expect(command.startsWith("bun \"")).toBe(true);
    expect(existsSync(command.slice("bun \"".length, -1))).toBe(true);
  });

  test("the repository skill calls agentctl through the placeholder", () => {
    const skill = readFileSync(join(import.meta.dir, "../../../skills/agent-board/SKILL.md"), "utf8");
    expect(skill).toContain(AGENTCTL_PLACEHOLDER);
  });
});
