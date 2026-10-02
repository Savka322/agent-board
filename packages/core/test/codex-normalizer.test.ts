import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeCodexLine } from "../src/codex-normalizer";
import { installFreshHome } from "./helpers";

installFreshHome(false);

const repoRoot = "C:\\work\\repo";
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function normalizeFixture(name: string) {
  let seq = 0;
  let lineNumber = 1;
  let sessionId: string | undefined;
  const events = [] as ReturnType<typeof normalizeCodexLine>["events"];
  for (const line of readFileSync(fixture(name), "utf8").trim().split(/\r?\n/)) {
    const output = normalizeCodexLine(line, {
      run_id: "test-run",
      seq,
      line: lineNumber++,
      repoRoot,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    if (output.sessionId) sessionId = output.sessionId;
    events.push(...output.events);
    seq += output.events.length;
  }
  return { sessionId, events };
}

describe("Codex event normalizer", () => {
  test("normalizes the initial sanitized Codex fixture with stable event counts", () => {
    const result = normalizeFixture("codex-run-initial.jsonl");
    const counts = Object.fromEntries([...new Set(result.events.map(({ kind }) => kind))]
      .map((kind) => [kind, result.events.filter((event) => event.kind === kind).length]));
    expect(counts).toEqual({ message: 2, exec: 4, edit: 2, test_fail: 1 });
    expect(result.sessionId).toBe("01a0fe6e-6396-7292-9b1d-f6fdf0916ef2");
    expect(result.events.every((event) => event.run_id === "test-run")).toBe(true);
    expect(result.events.every((event, index) => event.seq === index)).toBe(true);
    expect(result.events.every((event) => event.text.length <= 2000)).toBe(true);
    expect(result.events.filter(({ kind }) => kind === "edit").every(({ text }) => !text.includes("C:/work/repo"))).toBe(true);
    expect(result.events.some(({ kind, text }) => kind === "test_fail" && text.includes("bun test"))).toBe(true);
  });

  test("normalizes the resume fixture with stable event counts", () => {
    const result = normalizeFixture("codex-run-resume.jsonl");
    const counts = Object.fromEntries([...new Set(result.events.map(({ kind }) => kind))]
      .map((kind) => [kind, result.events.filter((event) => event.kind === kind).length]));
    expect(counts).toEqual({ think: 4, message: 2, exec: 3, edit: 2 });
    expect(result.sessionId).toBe("01a0fe6e-6396-7292-9b1d-f6fdf0916ef2");
    expect(result.events.every((event, index) => event.seq === index)).toBe(true);
  });

  test("extracts reasoning, command, changes, usage, and malformed lines", () => {
    const ctx = { run_id: "run", seq: 4, line: 42, repoRoot, now: () => "2026-01-01T00:00:00.000Z" };
    expect(normalizeCodexLine('{"type":"item.completed","item":{"type":"reasoning","text":"Use **small steps** now"}}', ctx).events[0]?.text).toBe("Use small steps now");
    const wrappedCommand = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'bun test'`;
    const startedCommand = JSON.stringify({ type: "item.started", item: { type: "command_execution", command: wrappedCommand } });
    expect(normalizeCodexLine(startedCommand, ctx).events[0]).toMatchObject({ kind: "exec", text: "bun test" });

    const failing = normalizeCodexLine('{"type":"item.completed","item":{"type":"command_execution","command":"bun test packages/core","exit_code":1}}', ctx);
    expect(failing.events[0]).toMatchObject({ kind: "test_fail", text: "exit 1: bun test packages/core" });
    expect(failing.events[0]?.raw_line).toBe(42);
    const editLine = JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ kind: "update", path: "c:\\WORK\\REPO\\src\\main.ts" }] } });
    const edit = normalizeCodexLine(editLine, ctx);
    expect(edit.events[0]).toMatchObject({ kind: "edit", text: "update src/main.ts" });
    expect(normalizeCodexLine("not-json", ctx).events[0]).toMatchObject({ kind: "unknown", text: "not-json" });
    expect(normalizeCodexLine('{"type":"new.event"}', ctx).events[0]?.kind).toBe("unknown");
    expect(normalizeCodexLine('{"type":"item.completed","item":{"type":"new_item"}}', ctx).events[0]?.kind).toBe("unknown");
    expect(normalizeCodexLine('{"type":"turn.completed","usage":{"input_tokens":8}}', ctx).usage).toEqual({ input_tokens: 8 });
    expect(normalizeCodexLine('{"type":"item.started","item":{"type":"file_change"}}', ctx).events).toEqual([]);
    expect(normalizeCodexLine('{"type":"item.completed","item":{"type":"command_execution","command":"bun run build","exit_code":2}}', ctx).events[0]).toMatchObject({ kind: "exec", text: "exit 2: bun run build" });
    const longUnknown = normalizeCodexLine("x".repeat(2500), ctx).events[0];
    expect(longUnknown?.kind).toBe("unknown");
    expect(longUnknown?.text).toHaveLength(2000);
    expect(normalizeCodexLine("bad", { ...ctx, now: () => { throw new Error("clock unavailable"); } }).events[0]?.ts).toBe("1970-01-01T00:00:00.000Z");
  });

  test("recognizes test commands in shell command segments", () => {
    const commands = [
      "Set-Location packages/core; bun test",
      "cd packages/core && bun test --timeout 5000",
      "bun test 2>&1 | Select-Object -Last 5",
    ];
    for (const command of commands) {
      const line = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command, exit_code: 0 } });
      expect(normalizeCodexLine(line, { run_id: "run", seq: 0, line: 1, repoRoot, now: () => "2026-01-01T00:00:00.000Z" }).events[0]?.kind).toBe("test_pass");
    }
    const negative = JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "bun run test-data-gen", exit_code: 1 } });
    expect(normalizeCodexLine(negative, { run_id: "run", seq: 0, line: 1, repoRoot, now: () => "2026-01-01T00:00:00.000Z" }).events[0]?.kind).toBe("exec");
  });
});
