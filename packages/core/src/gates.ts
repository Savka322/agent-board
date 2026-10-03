import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeSync, createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Gate } from "@agent-board/contracts";
import {
  createGateRun,
  closeStore,
  getEpic,
  getGateRun,
  getProject,
  getTask,
  listGateRunsForTask,
  openStore,
  updateGateRun,
  updateGateStats,
  type BoardStore,
} from "./store";
import {
  BYTES_PER_GB,
  BYTES_PER_MB,
  getMemoryLeaseByRef,
  listMemoryLeases,
  memoryLimitBytes,
  releaseMemoryLease,
  setMemoryLeasePid,
  tryAcquireMemoryLease,
} from "./memory/ledger";
import { resourceLimiter } from "./memory";
import { isProcessAlive } from "./dispatcher";
import { getTaskWorktreePath, ensureTaskWorktree } from "./worktrees";

const now = (): string => new Date().toISOString();

function commandHash(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex");
}

function gateEstimateBytes(store: BoardStore, project: string, gate: Gate): number {
  const hashed = commandHash(gate.cmd);
  const stats = store.sqlite.query(
    "SELECT peak_commit_max_bytes AS peak FROM gate_stats WHERE project = ? AND cmd_hash = ?",
  ).get(project, hashed) as { peak: number } | null;
  if (stats) return Number(stats.peak);
  return Math.floor((gate.ram_est_gb ?? 2) * BYTES_PER_GB);
}

function gateLeaseBytes(estimateBytes: number, limitBytes: number): number {
  return Math.min(limitBytes, Math.max(Math.ceil(estimateBytes * 1.25), 512 * BYTES_PER_MB));
}

export function gateLogPath(store: BoardStore, taskId: string, gateRunId: string): string {
  return join(store.home, "runs", taskId, "gates", `${gateRunId}.log`);
}

export interface GateRunSummary {
  id: string;
  task: string;
  cmd: string;
  status: string;
  exit_code: number | null;
  peak_commit_bytes: number | null;
  started_at: string | null;
  ended_at: string | null;
  log_path: string;
}

interface PlannedGate {
  id: string;
  task: string;
  project: string;
  cmd: string;
  estimateBytes: number;
  leaseBytes: number;
  attempts: number;
  exclusiveRetry: boolean;
  lastWait?: string;
}

interface ActiveGate {
  gate: PlannedGate;
  pid: number | undefined;
}

function spawnGateLauncher(gateRunId: string, logPath: string): number | undefined {
  const entrypoint = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/cli/src/index.ts");
  mkdirSync(dirname(logPath), { recursive: true });
  const descriptor = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, [entrypoint, "_gate", gateRunId], {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      stdio: ["ignore", descriptor, descriptor],
      env: process.env,
    });
    child.unref();
    child.once("error", () => {});
    if (child.pid === undefined) throw new Error("Could not start the gate launcher process");
    return child.pid;
  } finally {
    closeSync(descriptor);
  }
}

function waitingReason(requested: number, free: number): string {
  const mb = (bytes: number) => (bytes / BYTES_PER_MB).toFixed(0);
  return `needs ${mb(requested)} MB; ${mb(free)} MB free`;
}

function summaries(store: BoardStore, taskId: string): GateRunSummary[] {
  return listGateRunsForTask(store, taskId).map((run) => ({
    id: run.id,
    task: run.task,
    cmd: run.cmd,
    status: run.status,
    exit_code: run.exitCode,
    peak_commit_bytes: run.peakCommitBytes,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    log_path: gateLogPath(store, run.task, run.id),
  }));
}

/** Start task gates whenever the cross-process ledger has room, retrying one OOM with the full limit. */
export async function runGates(
  store: BoardStore,
  taskId: string,
  onWait: (gate: { cmd: string; reason: string }) => void = () => {},
): Promise<GateRunSummary[]> {
  const task = getTask(store, taskId);
  const projectName = getEpic(store, task.epic).project;
  const profile = getProject(store, projectName).profile;
  const gates = task.card.gates.length > 0 ? task.card.gates : profile.gates;
  const limit = memoryLimitBytes(store);
  const planned: PlannedGate[] = gates.map((gate) => {
    const estimateBytes = gateEstimateBytes(store, projectName, gate);
    const run = createGateRun(store, { task: taskId, cmd: gate.cmd, ram_est_bytes: estimateBytes });
    return {
      id: run.id,
      task: taskId,
      project: projectName,
      cmd: gate.cmd,
      estimateBytes,
      leaseBytes: gateLeaseBytes(estimateBytes, limit),
      attempts: 0,
      exclusiveRetry: false,
    };
  });
  if (planned.length === 0) return [];

  ensureTaskWorktree(store, taskId);
  const queued = [...planned];
  const active = new Map<string, ActiveGate>();
  const completed = new Set<string>();

  while (completed.size < planned.length) {
    for (const gate of [...queued]) {
      const requestedBytes = gate.exclusiveRetry ? limit : gate.leaseBytes;
      const acquisition = tryAcquireMemoryLease(store, {
        id: gate.id,
        kind: "gate",
        ref: gate.id,
        bytes: requestedBytes,
      });
      if (!acquisition.acquired) {
        const reason = waitingReason(acquisition.requestedBytes, acquisition.freeBytes);
        if (gate.lastWait !== reason) {
          gate.lastWait = reason;
          onWait({ cmd: gate.cmd, reason });
        }
        continue;
      }

      queued.splice(queued.indexOf(gate), 1);
      gate.attempts += 1;
      gate.lastWait = undefined;
      const startedAt = getGateRun(store, gate.id).startedAt ?? now();
      updateGateRun(store, gate.id, { status: "running", started_at: startedAt, ended_at: null });
      try {
        const pid = spawnGateLauncher(gate.id, gateLogPath(store, gate.task, gate.id));
        if (pid !== undefined) setMemoryLeasePid(store, gate.id, pid);
        active.set(gate.id, { gate, pid });
      } catch (error) {
        releaseMemoryLease(store, gate.id);
        updateGateRun(store, gate.id, { status: "fail", exit_code: 1, ended_at: now() });
        writeGateLauncherError(store, gate.id, error);
        completed.add(gate.id);
      }
    }

    for (const [id, entry] of [...active]) {
      const run = getGateRun(store, id);
      if (run.status === "pass" || run.status === "fail" || run.status === "oom") {
        if (entry.pid !== undefined && isProcessAlive(entry.pid)) continue;
        active.delete(id);
        releaseMemoryLease(store, id);
        if (run.status === "oom" && entry.gate.attempts === 1) {
          entry.gate.exclusiveRetry = true;
          entry.gate.lastWait = undefined;
          queued.push(entry.gate);
          updateGateRun(store, id, { status: "queued", ended_at: null });
        } else {
          completed.add(id);
        }
        continue;
      }

      if (entry.pid !== undefined && !isProcessAlive(entry.pid)) {
        active.delete(id);
        releaseMemoryLease(store, id);
        updateGateRun(store, id, { status: "fail", exit_code: 1, ended_at: now() });
        writeGateLauncherError(store, id, new Error("Gate launcher exited without recording a result"));
        completed.add(id);
      }
    }

    if (completed.size < planned.length) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }

  return summaries(store, taskId).filter((run) => planned.some((gate) => gate.id === run.id));
}

function writeGateLauncherError(store: BoardStore, gateRunId: string, error: unknown): void {
  const run = getGateRun(store, gateRunId);
  const path = gateLogPath(store, run.task, run.id);
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, "a");
  try {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    writeSync(descriptor, `\n[agent-board gate launcher error] ${message}\n`);
  } finally {
    closeSync(descriptor);
  }
}

function cmdArguments(command: string): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${command}"`], windowsVerbatimArguments: true };
  }
  return { command: process.env.SHELL ?? "/bin/sh", args: ["-c", command] };
}

/** Hidden worker used by `agentctl _gate <gate-run-id>`. */
export async function gateInternal(gateRunId: string): Promise<void> {
  const store = openStore();
  let resourceSession: ReturnType<typeof resourceLimiter.create> | undefined;
  let descriptor: number | undefined;
  const startedAt = now();
  let exitCode = 1;
  let status: "pass" | "fail" | "oom" = "fail";
  let peak: number | null = null;
  try {
    const run = getGateRun(store, gateRunId);
    const lease = getMemoryLeaseByRef(store, "gate", gateRunId);
    if (!lease) throw new Error(`Gate memory lease not found for run ${gateRunId}`);
    const task = getTask(store, run.task);
    const worktree = getTaskWorktreePath(store, task.id);
    const logPath = gateLogPath(store, task.id, run.id);
    mkdirSync(dirname(logPath), { recursive: true });
    descriptor = openSync(logPath, "a");
    writeSync(descriptor, `\n[agent-board gate attempt ${new Date().toISOString()} lease=${lease.bytes}]\n`);
    resourceSession = resourceLimiter.create(lease.bytes);

    const invocation = cmdArguments(run.cmd);
    const logOutput = createWriteStream(logPath, { flags: "a" });
    const child = spawn(invocation.command, invocation.args, {
      cwd: worktree,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(invocation.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: invocation.windowsVerbatimArguments }),
    });
    let stderrTail = "";
    child.stdout.pipe(logOutput, { end: false });
    child.stderr.pipe(logOutput, { end: false });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-8192);
    });
    let memoryLimitMessage = false;
    const watcher = setInterval(() => {
      if (resourceSession && !memoryLimitMessage && resourceSession.pollMemoryLimit()) memoryLimitMessage = true;
    }, 100);
    try {
      exitCode = await new Promise<number>((resolvePromise) => {
        child.once("error", (error) => {
          if (descriptor !== undefined) writeSync(descriptor, `\n[spawn error] ${error.message}\n`);
          resolvePromise(1);
        });
        child.once("close", (code) => resolvePromise(code ?? 1));
      });
      if (!memoryLimitMessage && resourceSession.pollMemoryLimit()) memoryLimitMessage = true;
    } finally {
      clearInterval(watcher);
    }

    logOutput.end();
    await new Promise<void>((resolvePromise) => logOutput.once("finish", resolvePromise));

    peak = resourceSession.peakMemoryBytes();
    const stderrLooksLikeOom = exitCode !== 0 && /out of memory|memoryerror|std::bad_alloc/i.test(stderrTail);
    status = memoryLimitMessage || stderrLooksLikeOom ? "oom" : exitCode === 0 ? "pass" : "fail";
    const previousPeak = getGateRun(store, run.id).peakCommitBytes;
    const peakMax = peak === null ? previousPeak : Math.max(previousPeak ?? 0, peak);
    updateGateRun(store, run.id, {
      status,
      exit_code: exitCode,
      peak_commit_bytes: peakMax,
      ended_at: now(),
    });
    if (peakMax !== null) {
      const project = getEpic(store, task.epic).project;
      updateGateStats(store, project, commandHash(run.cmd), peakMax);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        writeSync(descriptor, `\n[agent-board gate error] ${message}\n`);
      } catch { /* Keep the original launcher error. */ }
    }
    try {
      const run = getGateRun(store, gateRunId);
      peak = resourceSession?.peakMemoryBytes() ?? run.peakCommitBytes;
      updateGateRun(store, gateRunId, {
        status: "fail",
        exit_code: exitCode,
        ...(peak === null ? {} : { peak_commit_bytes: peak }),
        started_at: run.startedAt ?? startedAt,
        ended_at: now(),
      });
    } catch { /* The parent detects a worker that could not update its row. */ }
  } finally {
    resourceSession?.dispose();
    if (descriptor !== undefined) closeSync(descriptor);
    closeStore(store);
  }
}

/** Human-readable helper data for the `memory` command. */
export function memoryStatus(store: BoardStore) {
  const limit = memoryLimitBytes(store);
  const leases = listMemoryLeases(store);
  const used = leases.reduce((total, lease) => total + lease.bytes, 0);
  return { limit_bytes: limit, used_bytes: used, free_bytes: Math.max(0, limit - used), leases };
}
