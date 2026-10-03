import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { RunOutcome } from "@agent-board/contracts";
import {
  canStartTask,
  emitBoardEvent,
  getGateRun,
  getInternalSetting,
  getLatestRunEvent,
  getTask,
  getEpic,
  getSetting,
  listRunsForTask,
  listTasks,
  listTasksByStatus,
  listEpics,
  listTasksByEpic,
  listQuestions,
  hasApproval,
  setInternalSetting,
  setSetting,
  finishRun,
  transitionTask,
  type BoardStore,
  updateGateRun,
} from "./store";
import { cleanupDeadMemoryLeases } from "./memory/ledger";
import { notifyCause, type Notifier, type RegistryWriter } from "./notify";

export interface NotificationDraft {
  kind: "owner_question" | "epic_ready";
  ref: string;
  title: string;
  text: string;
  launch: string;
}

export interface DispatcherTickResult {
  ready: string[];
  stale: string[];
  failed: string[];
  paused: string[];
  resumed: boolean;
  notifications: NotificationDraft[];
}

export interface DispatcherOptions {
  now?: Date;
  isAlive?: (pid: number) => boolean;
  onNotification?: (draft: NotificationDraft) => void;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM" || code === "EACCES";
  }
}

function recordReadiness(store: BoardStore, task: string, ready: boolean, now: string): boolean {
  const key = `dispatcher.ready:${task}`;
  store.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const wasReady = getInternalSetting(store, key, false);
    if (ready && !wasReady) {
      store.sqlite.query("INSERT INTO board_events (ts, kind, task, question, run, payload) VALUES (?, ?, ?, ?, ?, ?)")
        .run(now, "ready", task, null, null, "{}");
    }
    setInternalSetting(store, key, ready);
    store.sqlite.exec("COMMIT");
    return ready && !wasReady;
  } catch (error) {
    try { store.sqlite.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

function recordStale(store: BoardStore, task: string, run: string, lastEventSeq: number, lastEventAt: string, now: Date): boolean {
  const key = `dispatcher.stale:${run}`;
  store.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const priorSeq = getInternalSetting(store, key, -2);
    if (lastEventSeq <= priorSeq) {
      store.sqlite.exec("COMMIT");
      return false;
    }
    store.sqlite.query("INSERT INTO board_events (ts, kind, task, question, run, payload) VALUES (?, ?, ?, ?, ?, ?)")
      .run(now.toISOString(), "stale", task, null, run, JSON.stringify({ last_event_seq: lastEventSeq, last_event_at: lastEventAt }));
    setInternalSetting(store, key, lastEventSeq);
    store.sqlite.exec("COMMIT");
    return true;
  } catch (error) {
    try { store.sqlite.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

function handledKey(outcome: RunOutcome, runId: string): string {
  return `dispatcher.handled:${outcome}:${runId}`;
}

function handleCompletedRuns(store: BoardStore, now: Date): string[] {
  const completed = listTasks(store).flatMap((task) => listRunsForTask(store, task.id)
    .filter((run) => run.endedAt !== null && run.outcome !== null)
    .map((run) => ({ task, run })))
    .sort((first, second) => first.run.endedAt!.localeCompare(second.run.endedAt!));
  const paused: string[] = [];
  for (const { task, run } of completed) {
    if (run.outcome === "rate_limited" && !getInternalSetting(store, handledKey("rate_limited", run.id), false)) {
      const latestRun = listRunsForTask(store, task.id).at(-1);
      if (task.status === "running" && latestRun?.id === run.id) continue;
      if (task.status === "review" && latestRun?.id === run.id) transitionTask(store, task.id, "requeue", "dispatcher");
      const delayMinutes = Math.min(getSetting(store, "pause_backoff_minutes"), 120);
      const pausedUntil = new Date(now.getTime() + delayMinutes * 60_000).toISOString();
      setSetting(store, "paused_until", pausedUntil);
      setSetting(store, "pause_backoff_minutes", Math.min(delayMinutes * 2, 120));
      emitBoardEvent(store, {
        kind: "paused",
        task: task.id,
        run: run.id,
        payload: { until: pausedUntil, minutes: delayMinutes },
      }, { run: run.id });
      setInternalSetting(store, handledKey("rate_limited", run.id), true);
      paused.push(run.id);
    } else if (run.outcome === "done" && !getInternalSetting(store, handledKey("done", run.id), false)) {
      setSetting(store, "pause_backoff_minutes", 15);
      setInternalSetting(store, handledKey("done", run.id), true);
    }
  }
  return paused;
}

function recordResumeIfDue(store: BoardStore, now: Date): boolean {
  store.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const pausedUntil = getSetting(store, "paused_until");
    if (pausedUntil === null || Date.parse(pausedUntil) > now.getTime()) {
      store.sqlite.exec("COMMIT");
      return false;
    }
    setSetting(store, "paused_until", null);
    store.sqlite.query("INSERT INTO board_events (ts, kind, task, question, run, payload) VALUES (?, ?, ?, ?, ?, ?)")
      .run(now.toISOString(), "resumed", null, null, null, JSON.stringify({ at: now.toISOString() }));
    store.sqlite.exec("COMMIT");
    return true;
  } catch (error) {
    try { store.sqlite.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

export function dispatchTick(store: BoardStore, options: DispatcherOptions = {}): DispatcherTickResult {
  const now = options.now ?? new Date();
  const isAlive = options.isAlive ?? isProcessAlive;
  const staleLimitMs = getSetting(store, "stale_minutes") * 60_000;
  const result: DispatcherTickResult = { ready: [], stale: [], failed: [], paused: [], resumed: false, notifications: [] };

  for (const lease of cleanupDeadMemoryLeases(store, isAlive)) {
    if (lease.kind === "gate") {
      const gateRun = getGateRun(store, lease.ref);
      if (gateRun.status === "running") updateGateRun(store, lease.ref, { status: "fail", exit_code: 1, ended_at: now.toISOString() });
    }
  }

  for (const task of listTasksByStatus(store, "running")) {
    const run = listRunsForTask(store, task.id).at(-1);
    if (!run) continue;
    if (run.endedAt !== null) {
      if (getTask(store, task.id).status === "running") {
        transitionTask(store, task.id, "run_finished", "runner");
        emitBoardEvent(store, {
          kind: "review",
          task: task.id,
          run: run.id,
          payload: run.outcome ?? "failed",
        }, { run: run.id });
      }
      continue;
    }
    if (run.pid !== null && !isAlive(run.pid)) {
      finishRun(store, run.id, { outcome: "failed", exitCode: 1 });
      transitionTask(store, task.id, "run_finished", "runner");
      emitBoardEvent(store, { kind: "review", task: task.id, run: run.id, payload: "failed" }, { run: run.id });
      emitBoardEvent(store, {
        kind: "failed",
        task: task.id,
        run: run.id,
        payload: { outcome: "failed", reason: "runner_exited_without_finishing" },
      }, { run: run.id });
      result.failed.push(run.id);
      continue;
    }

    const lastEvent = getLatestRunEvent(store, run.id);
    const lastEventAt = lastEvent?.ts ?? run.startedAt;
    const silenceMs = now.getTime() - Date.parse(lastEventAt);
    if (silenceMs >= staleLimitMs && recordStale(store, task.id, run.id, lastEvent?.seq ?? -1, lastEventAt, now)) {
      result.stale.push(run.id);
    }
  }

  result.paused = handleCompletedRuns(store, now);
  result.resumed = recordResumeIfDue(store, now);

  const webPort = getSetting(store, "web_port");
  for (const question of listQuestions(store, { open: true, target: "owner" })) {
    const task = getTask(store, question.task);
    const event = emitBoardEvent(store, {
      kind: "owner_question",
      task: task.id,
      question: question.id,
      payload: { kind: question.kind },
    }, { question: question.id });
    if (!event) continue;
    const epic = getEpic(store, task.epic);
    const heldCount = question.decisionKey === null ? 0 : listTasks(store)
      .filter((candidate) => getEpic(store, candidate.epic).project === epic.project && candidate.decisions.includes(question.decisionKey!)).length;
    const draft: NotificationDraft = {
      kind: "owner_question",
      ref: question.id,
      title: `Question for you · holds ${heldCount} ${heldCount === 1 ? "task" : "tasks"}`,
      text: question.text,
      launch: `http://127.0.0.1:${webPort}/#q=${encodeURIComponent(question.id)}`,
    };
    result.notifications.push(draft);
    options.onNotification?.(draft);
  }

  for (const epic of listEpics(store)) {
    const epicTasks = listTasksByEpic(store, epic.id);
    if (epicTasks.length === 0 || epicTasks.some((task) => task.status !== "done" && task.status !== "canceled")
      || hasApproval(store, epic.id, "merge")) continue;
    const event = emitBoardEvent(store, {
      kind: "epic_ready",
      epic: epic.id,
      payload: { epic: epic.id },
    }, { epic: epic.id });
    if (!event) continue;
    const draft: NotificationDraft = {
      kind: "epic_ready",
      ref: epic.id,
      title: "Epic ready for merge approval",
      text: epic.title,
      launch: `http://127.0.0.1:${webPort}/#epic=${encodeURIComponent(epic.id)}`,
    };
    result.notifications.push(draft);
    options.onNotification?.(draft);
  }

  const nextTasks = new Set(listTasksByStatus(store, "next").map((task) => task.id));
  for (const task of listTasks(store)) {
    const key = `dispatcher.ready:${task.id}`;
    if (!nextTasks.has(task.id)) {
      if (getInternalSetting(store, key, false)) setInternalSetting(store, key, false);
      continue;
    }
    const availability = canStartTask(store, task.id);
    if (recordReadiness(store, task.id, availability.ok, now.toISOString())) result.ready.push(task.id);
  }
  return result;
}

/** Whether an `agentctl serve` process holds this home's lock. */
export function dispatcherStatus(store: BoardStore, isAlive: (pid: number) => boolean = isProcessAlive): { running: boolean; pid: number | null } {
  let contents = "";
  try { contents = readFileSync(join(store.home, "serve.lock"), "utf8").trim(); } catch { return { running: false, pid: null }; }
  const pid = /^\d+$/.test(contents) ? Number(contents) : null;
  return pid !== null && isAlive(pid) ? { running: true, pid } : { running: false, pid: null };
}

export function acquireServeLock(store: BoardStore): () => void {
  const lockPath = join(store.home, "serve.lock");
  const ownPid = process.pid;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx");
      try { writeSync(descriptor, `${ownPid}\n`); } finally { closeSync(descriptor); }
      return () => {
        try {
          if (existsSync(lockPath) && Number(readFileSync(lockPath, "utf8").trim()) === ownPid) unlinkSync(lockPath);
        } catch { /* A removed or replaced lock needs no cleanup. */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let lockPid: number | undefined;
      try {
        const contents = readFileSync(lockPath, "utf8").trim();
        if (/^\d+$/.test(contents)) lockPid = Number(contents);
      } catch {
        // Another instance may still be writing the just-created lock file.
      }
      if (lockPid !== undefined && isProcessAlive(lockPid)) throw new Error(`Dispatcher is already running (pid ${lockPid}).`);
      if (lockPid === undefined && existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs < 1000) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        continue;
      }
      try { unlinkSync(lockPath); } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new Error("Could not acquire the dispatcher lock after removing a stale lock.");
}

export async function serveDispatcher(store: BoardStore, options: { once?: boolean; notifier?: Notifier; registry?: RegistryWriter } = {}): Promise<void> {
  const release = acquireServeLock(store);
  let stop = false;
  const requestStop = () => { stop = true; };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  try {
    do {
      const tick = dispatchTick(store);
      for (const draft of tick.notifications) {
        try { await notifyCause(store, draft, { notifier: options.notifier, registry: options.registry }); } catch { /* Notification failures are logged where possible and do not stop dispatch. */ }
      }
      if (options.once || stop) break;
      await new Promise((resolve) => setTimeout(resolve, getSetting(store, "tick_seconds") * 1000));
    } while (!stop);
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    release();
  }
}
