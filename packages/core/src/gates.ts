import { createHash } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeSync, createWriteStream } from "node:fs";
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
const ACTIVE_PROCESS_ZERO = 4;

const stderrOomPatterns = [
  { label: "RangeError: Out of memory", pattern: /RangeError:\s*Out of memory/i },
  { label: "MemoryError", pattern: /MemoryError/i },
  { label: "std::bad_alloc", pattern: /std::bad_alloc/i },
  { label: "Out of memory", pattern: /Out of memory/i },
  { label: "Bun crash banner", pattern: /oh no: Bun has crashed\. This indicates a bug in Bun, not your code\./i },
];

function matchStderrOomPattern(stderr: string): string | undefined {
  return stderrOomPatterns.find(({ pattern }) => pattern.test(stderr))?.label;
}

function readGateLogTail(path: string): string {
  const descriptor = openSync(path, "r");
  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, 8192);
    const tail = Buffer.alloc(length);
    readSync(descriptor, tail, 0, length, size - length);
    return tail.toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

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
  lease_bytes: number | null;
  peak_commit_bytes: number | null;
  started_at: string | null;
  ended_at: string | null;
  log_path: string;
  attempts: GateAttemptSummary[];
}

export interface GateAttemptSummary {
  id: string;
  attempt: number;
  retry_of: string | null;
  status: string;
  exit_code: number | null;
  lease_bytes: number | null;
  peak_commit_bytes: number | null;
  started_at: string | null;
  ended_at: string | null;
  log_path: string;
}

interface PlannedGate {
  id: string;
  currentAttemptId: string;
  attemptIds: string[];
  attempt: number;
  task: string;
  project: string;
  cmd: string;
  estimateBytes: number;
  leaseBytes: number;
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

function summaries(store: BoardStore, planned: PlannedGate[]): GateRunSummary[] {
  return planned.map((gate) => {
    const attempts = gate.attemptIds
      .map((id) => getGateRun(store, id))
      .sort((left, right) => left.attempt - right.attempt)
      .map((run) => ({
        id: run.id,
        attempt: run.attempt,
        retry_of: run.retryOf,
        status: run.status,
        exit_code: run.exitCode,
        lease_bytes: run.leaseBytes,
        peak_commit_bytes: run.peakCommitBytes,
        started_at: run.startedAt,
        ended_at: run.endedAt,
        log_path: gateLogPath(store, run.task, run.id),
      }));
    const finalAttempt = attempts[attempts.length - 1]!;
    const firstAttempt = attempts[0]!;
    return {
      id: gate.id,
      task: gate.task,
      cmd: gate.cmd,
      status: finalAttempt.status,
      exit_code: finalAttempt.exit_code,
      lease_bytes: finalAttempt.lease_bytes,
      peak_commit_bytes: finalAttempt.peak_commit_bytes,
      started_at: firstAttempt.started_at,
      ended_at: finalAttempt.ended_at,
      log_path: finalAttempt.log_path,
      attempts,
    };
  });
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
    const run = createGateRun(store, { task: taskId, cmd: gate.cmd, ram_est_bytes: estimateBytes, attempt: 1 });
    return {
      id: run.id,
      currentAttemptId: run.id,
      attemptIds: [run.id],
      attempt: 1,
      task: taskId,
      project: projectName,
      cmd: gate.cmd,
      estimateBytes,
      leaseBytes: gateLeaseBytes(estimateBytes, limit),
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
      const attemptId = gate.currentAttemptId;
      const acquisition = tryAcquireMemoryLease(store, {
        id: attemptId,
        kind: "gate",
        ref: attemptId,
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
      gate.lastWait = undefined;
      const startedAt = getGateRun(store, attemptId).startedAt ?? now();
      updateGateRun(store, attemptId, { status: "running", lease_bytes: requestedBytes, started_at: startedAt, ended_at: null });
      try {
        const pid = spawnGateLauncher(attemptId, gateLogPath(store, gate.task, attemptId));
        if (pid !== undefined) setMemoryLeasePid(store, attemptId, pid);
        active.set(attemptId, { gate, pid });
      } catch (error) {
        releaseMemoryLease(store, attemptId);
        updateGateRun(store, attemptId, { status: "fail", exit_code: 1, ended_at: now() });
        writeGateLauncherError(store, attemptId, error);
        completed.add(gate.id);
      }
    }

    for (const [id, entry] of [...active]) {
      const run = getGateRun(store, id);
      if (run.status === "pass" || run.status === "fail" || run.status === "oom") {
        if (entry.pid !== undefined && isProcessAlive(entry.pid)) continue;
        active.delete(id);
        releaseMemoryLease(store, id);
        if (run.status === "oom" && run.endedAt === null) {
          const endedAt = now();
          updateGateRun(store, id, { status: "oom", exit_code: run.exitCode, peak_commit_bytes: run.peakCommitBytes, ended_at: endedAt });
          if (run.peakCommitBytes !== null) updateGateStats(store, entry.gate.project, commandHash(run.cmd), run.peakCommitBytes);
        }
        if (run.status === "oom" && entry.gate.attempt === 1) {
          entry.gate.exclusiveRetry = true;
          entry.gate.lastWait = undefined;
          const retry = createGateRun(store, {
            task: entry.gate.task,
            cmd: entry.gate.cmd,
            ram_est_bytes: entry.gate.estimateBytes,
            attempt: 2,
            retry_of: entry.gate.id,
          });
          entry.gate.currentAttemptId = retry.id;
          entry.gate.attemptIds.push(retry.id);
          entry.gate.attempt = 2;
          queued.push(entry.gate);
        } else {
          completed.add(entry.gate.id);
        }
        continue;
      }

      if (entry.pid !== undefined && !isProcessAlive(entry.pid)) {
        const logPath = gateLogPath(store, entry.gate.task, id);
        const pattern = matchStderrOomPattern(readGateLogTail(logPath));
        if (pattern !== undefined) {
          updateGateRun(store, id, { status: "oom", exit_code: 1, ended_at: now() });
          const descriptor = openSync(logPath, "a");
          try { writeSync(descriptor, `[agent-board gate classification signal=stderr:${pattern} status=oom]\n`); }
          finally { closeSync(descriptor); }
        } else {
          active.delete(id);
          releaseMemoryLease(store, id);
          updateGateRun(store, id, { status: "fail", exit_code: 1, ended_at: now() });
          writeGateLauncherError(store, id, new Error("Gate launcher exited without recording a result"));
          completed.add(entry.gate.id);
        }
      }
    }

    if (completed.size < planned.length) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }

  return summaries(store, planned);
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
  let memoryLimitObserved = false;
  let classificationLogged = false;
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
    let stderrOomPattern: string | undefined;
    child.stdout.pipe(logOutput, { end: false });
    child.stderr.pipe(logOutput, { end: false });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-8192);
      if (stderrOomPattern === undefined) {
        stderrOomPattern = matchStderrOomPattern(stderrTail);
      }
    });
    const completionMessages = new Set<number>();
    const drainCompletionPort = () => {
      for (const message of resourceSession?.pollMessages() ?? []) {
        completionMessages.add(message);
        if (message === 10 && !memoryLimitObserved) {
          memoryLimitObserved = true;
          updateGateRun(store, gateRunId, { status: "oom", started_at: startedAt });
          writeSync(descriptor!, "[agent-board gate classification signal=port:10 status=oom observed]\n");
          classificationLogged = true;
        }
      }
    };
    const watcher = setInterval(drainCompletionPort, 100);
    try {
      exitCode = await new Promise<number>((resolvePromise) => {
        child.once("error", (error) => {
          if (descriptor !== undefined) writeSync(descriptor, `\n[spawn error] ${error.message}\n`);
          resolvePromise(1);
        });
        child.once("close", (code) => resolvePromise(code ?? 1));
      });
      drainCompletionPort();
      if (process.platform === "win32") {
        // Completion notifications are ordered; wait for the final process-zero
        // packet, or bound the wait in case the launcher itself keeps the job active.
        const deadline = Date.now() + 2000;
        while (!completionMessages.has(ACTIVE_PROCESS_ZERO) && Date.now() < deadline) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
          drainCompletionPort();
        }
      }
    } finally {
      clearInterval(watcher);
    }

    logOutput.end();
    await new Promise<void>((resolvePromise) => logOutput.once("finish", resolvePromise));

    peak = resourceSession.peakMemoryBytes();
    const signal = completionMessages.has(10)
      ? "port:10"
      : exitCode !== 0 && stderrOomPattern !== undefined
        ? `stderr:${stderrOomPattern}`
        : "none";
    status = signal !== "none" ? "oom" : exitCode === 0 ? "pass" : "fail";
    if (!classificationLogged) writeSync(descriptor, `[agent-board gate classification signal=${signal} status=${status}]\n`);
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
        status: memoryLimitObserved ? "oom" : "fail",
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
