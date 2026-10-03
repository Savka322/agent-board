import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { addProject, addTask, canStartTask, createEpic, createRun, getRun, setRunPid, setSetting, transitionTask } from "../src/store";
import { cleanupDeadMemoryLeases, listMemoryLeases, memoryLimitBytes, releaseMemoryLease, setMemoryLeasePid, tryAcquireMemoryLease } from "../src/memory/ledger";
import { noopResourceLimiter } from "../src/memory/noop";
import { resourceLimiter } from "../src/memory";
import { dispatchTick } from "../src/dispatcher";
import { renderCardFile } from "../src/cards";
import type { TaskCard } from "@agent-board/contracts";
import { installFreshHome, writeProfile } from "./helpers";

const fresh = installFreshHome();

function addTaskFixture() {
  writeProfile(fresh.home);
  const project = addProject(fresh.store, "sample");
  createEpic(fresh.store, { id: "EPIC-1", project: project.name, title: "Memory work", branch: "epic/memory" });
  const card: TaskCard = {
    id: "MEM-1",
    title: "Memory test task",
    epic: "EPIC-1",
    goal: "Test memory lease admission.",
    allowed_files: ["src/**"],
    deps: [],
    decisions: [],
    light_tests: [],
    gates: [],
    acceptance: ["Memory is admitted safely."],
  };
  const cardPath = join(fresh.home, "MEM-1.md");
  writeFileSync(cardPath, renderCardFile(card), "utf8");
  return addTask(fresh.store, "EPIC-1", cardPath);
}

function childOutput(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

describe("global memory leases", () => {
  test("refuses a start with exit code 2 when executor memory does not fit", async () => {
    const task = addTaskFixture();
    const mb = 1024 ** 2;
    setSetting(fresh.store, "memory_limit_gb", 1024 * mb / (1024 ** 3));
    setSetting(fresh.store, "executor_memory_gb", 0.75);
    expect(tryAcquireMemoryLease(fresh.store, { kind: "gate", ref: "gate-x", bytes: 512 * mb }).acquired).toBe(true);
    const availability = canStartTask(fresh.store, task.id);
    expect(availability.ok).toBe(false);
    expect(availability.reasons).toContainEqual({ code: "no_memory", requested_bytes: 0.75 * 1024 ** 3, free_bytes: 512 * mb });
    transitionTask(fresh.store, task.id, "promote", "claude");
    const entrypoint = join(import.meta.dir, "../../../apps/cli/src/index.ts");
    const cli = await childOutput(process.execPath, [entrypoint, "start", task.id, "--json"], {
      ...process.env,
      AGENT_BOARD_HOME: fresh.home,
    });
    expect(cli.code).toBe(2);
    expect(JSON.parse(cli.stdout).details.reasons).toContainEqual({ code: "no_memory", requested_bytes: 0.75 * 1024 ** 3, free_bytes: 512 * mb });
    expect(listMemoryLeases(fresh.store).every(({ kind }) => kind !== "executor")).toBe(true);
  });

  test("acquires the executor lease with the start transition", () => {
    const task = addTaskFixture();
    transitionTask(fresh.store, task.id, "promote", "claude");
    const runId = "atomic-executor-run";
    const started = transitionTask(fresh.store, task.id, "start", "claude", undefined, undefined, {
      id: runId,
      kind: "executor",
      ref: runId,
      bytes: 10,
    });
    expect(started.status).toBe("running");
    expect(listMemoryLeases(fresh.store)).toContainEqual(expect.objectContaining({ id: runId, kind: "executor", bytes: 2 * 1024 ** 3 }));
    transitionTask(fresh.store, task.id, "run_finished", "runner");
    releaseMemoryLease(fresh.store, runId);
  });

  test("never over-admits concurrent acquires from separate processes", async () => {
    setSetting(fresh.store, "memory_limit_gb", 600 * 1024 ** 2 / (1024 ** 3));
    const worker = join(import.meta.dir, "memory-acquire-worker.ts");
    const env = { ...process.env, AGENT_BOARD_HOME: fresh.home };
    const [first, second] = await Promise.all([
      childOutput(process.execPath, [worker, "one", String(400 * 1024 ** 2)], env),
      childOutput(process.execPath, [worker, "two", String(400 * 1024 ** 2)], env),
    ]);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    const outcomes = [JSON.parse(first.stdout) as { acquired: boolean }, JSON.parse(second.stdout) as { acquired: boolean }];
    expect(outcomes.filter(({ acquired }) => acquired)).toHaveLength(1);
    const total = listMemoryLeases(fresh.store).reduce((sum, lease) => sum + lease.bytes, 0);
    expect(total).toBeLessThanOrEqual(memoryLimitBytes(fresh.store));
    for (const lease of listMemoryLeases(fresh.store)) releaseMemoryLease(fresh.store, lease.id);
  });

  test("does not lower the configured limit below outstanding reservations", () => {
    const lease = tryAcquireMemoryLease(fresh.store, { kind: "gate", ref: "active", bytes: 1024 ** 3 });
    expect(lease.acquired).toBe(true);
    expect(() => setSetting(fresh.store, "memory_limit_gb", 0.5)).toThrow("active memory leases");
    if (lease.acquired) releaseMemoryLease(fresh.store, lease.lease.id);
  });

  test("agentctl memory reports the limit, leases, and free capacity", async () => {
    const lease = tryAcquireMemoryLease(fresh.store, { id: "visible-memory", kind: "gate", ref: "visible", bytes: 1024 ** 2 });
    expect(lease.acquired).toBe(true);
    const entrypoint = join(import.meta.dir, "../../../apps/cli/src/index.ts");
    const result = await childOutput(process.execPath, [entrypoint, "memory", "--json"], {
      ...process.env,
      AGENT_BOARD_HOME: fresh.home,
    });
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as { limit_bytes: number; free_bytes: number; leases: Array<{ id: string }> };
    expect(output.limit_bytes).toBe(16 * 1024 ** 3);
    expect(output.free_bytes).toBe(output.limit_bytes - 1024 ** 2);
    expect(output.leases.map(({ id }) => id)).toContain("visible-memory");
    releaseMemoryLease(fresh.store, "visible-memory");
  });

  test("dispatcher removes dead pid leases and keeps the non-Windows limiter as a no-op", () => {
    const dead = tryAcquireMemoryLease(fresh.store, { kind: "executor", ref: "dead", bytes: 1_000, pid: 43210 });
    const starting = tryAcquireMemoryLease(fresh.store, { kind: "gate", ref: "starting", bytes: 1_000 });
    expect(dead.acquired && starting.acquired).toBe(true);
    expect(dispatchTick(fresh.store, { isAlive: () => false })).toBeDefined();
    expect(listMemoryLeases(fresh.store).map(({ ref }) => ref)).toEqual(["starting"]);
    expect(cleanupDeadMemoryLeases(fresh.store, () => false)).toEqual([]);
    const noOp = noopResourceLimiter.create(1024 ** 2);
    expect(noOp.pollMemoryLimit()).toBe(false);
    expect(noOp.peakMemoryBytes()).toBeNull();
    noOp.dispose();
  });

  test("dispatcher releases the executor lease after its runner process is killed", () => {
    const task = addTaskFixture();
    transitionTask(fresh.store, task.id, "promote", "claude");
    const runId = "killed-executor-run";
    const running = transitionTask(fresh.store, task.id, "start", "claude", undefined, undefined, {
      id: runId,
      kind: "executor",
      ref: runId,
      bytes: 1,
    });
    createRun(fresh.store, { id: runId, task: task.id, round: running.round, executor: "codex" });
    setRunPid(fresh.store, runId, 987654);
    setMemoryLeasePid(fresh.store, runId, 987654);
    expect(listMemoryLeases(fresh.store)).toHaveLength(1);
    dispatchTick(fresh.store, { isAlive: () => false });
    expect(listMemoryLeases(fresh.store)).toHaveLength(0);
    expect(getRun(fresh.store, runId).endedAt).not.toBeNull();
  });

  test("no-op limiter is the selected implementation off Windows", () => {
    if (process.platform === "win32") return;
    const session = resourceLimiter.create(1024 ** 2);
    expect(session.peakMemoryBytes()).toBeNull();
    expect(session.pollMemoryLimit()).toBe(false);
    session.dispose();
  });
});
