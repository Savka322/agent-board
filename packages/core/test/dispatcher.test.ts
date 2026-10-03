import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderCardFile } from "../src/cards";
import {
  addProject,
  addTask,
  answerQuestion,
  createEpic,
  createQuestion,
  createRun,
  emitBoardEvent,
  finishRun,
  getBoardEventCursor,
  getRun,
  getSetting,
  getTask,
  listBoardEventsAfter,
  setRunPid,
  setSetting,
  transitionTask,
  type BoardStore,
} from "../src/store";
import { acquireServeLock, dispatcherStatus, dispatchTick } from "../src/dispatcher";
import { waitForBoardEvents } from "../src/wait";
import type { TaskCard } from "@agent-board/contracts";
import { installFreshHome, writeProfile } from "./helpers";

const fresh = installFreshHome();

function setupTasks(cards: Array<{ id: string; deps?: string[]; decisions?: string[] }> = [{ id: "AB-1" }]): BoardStore {
  writeProfile(fresh.home);
  const project = addProject(fresh.store, "sample");
  createEpic(fresh.store, { id: "EPIC-1", project: project.name, title: "Dispatch tests", branch: "epic/dispatch" });
  for (const item of cards) {
    const card: TaskCard = {
      id: item.id,
      title: "Task " + item.id,
      epic: "EPIC-1",
      goal: "Exercise board orchestration.",
      allowed_files: ["src/" + item.id.toLowerCase() + ".ts"],
      deps: item.deps ?? [],
      decisions: item.decisions ?? [],
      light_tests: [],
      gates: [],
      acceptance: ["The test passes."],
    };
    const path = join(fresh.home, item.id + ".md");
    writeFileSync(path, renderCardFile(card), "utf8");
    addTask(fresh.store, "EPIC-1", path);
  }
  return fresh.store;
}

function finishActiveRun(store: BoardStore, taskId: string, outcome: "done" | "rate_limited" | "failed") {
  const running = transitionTask(store, taskId, "start", "claude");
  const run = createRun(store, { task: taskId, round: running.round, executor: "fake" });
  finishRun(store, run.id, { outcome, exitCode: outcome === "done" ? 0 : 1 });
  transitionTask(store, taskId, "run_finished", "runner");
  return run.id;
}

describe("board events and dispatcher", () => {
  test("emits ready once when the last dependency becomes done", () => {
    const store = setupTasks([{ id: "AB-1" }, { id: "AB-2", deps: ["AB-1"] }]);
    transitionTask(store, "AB-1", "promote", "claude");
    transitionTask(store, "AB-2", "promote", "claude");

    expect(dispatchTick(store).ready).toEqual(["AB-1"]);
    expect(dispatchTick(store).ready).toEqual([]);
    finishActiveRun(store, "AB-1", "done");
    transitionTask(store, "AB-1", "accept", "claude");
    expect(dispatchTick(store).ready).toEqual(["AB-2"]);
    expect(dispatchTick(store).ready).toEqual([]);
    expect(listBoardEventsAfter(store, 0, ["ready"]).map((event) => event.task)).toEqual(["AB-1", "AB-2"]);
  });

  test("answers stop questions, releases needs_owner, and wakes decision tasks", () => {
    const store = setupTasks([
      { id: "AB-1", decisions: ["api_shape"] },
      { id: "AB-2", decisions: ["api_shape"] },
      { id: "AB-3", decisions: ["api_shape"] },
    ]);
    transitionTask(store, "AB-1", "promote", "claude");
    transitionTask(store, "AB-1", "start", "claude");
    const run = createRun(store, { task: "AB-1", executor: "fake" });
    finishRun(store, run.id, { outcome: "done", exitCode: 0 });
    transitionTask(store, "AB-1", "run_finished", "runner");
    const question = createQuestion(store, {
      task: "AB-1",
      kind: "stop",
      target: "owner",
      decision_key: "api_shape",
      text: "Which API shape should be used?",
      options: ["A", "B"],
      recommendation: "A",
    });
    transitionTask(store, "AB-1", "escalate", "claude");
    transitionTask(store, "AB-2", "promote", "claude");
    transitionTask(store, "AB-3", "promote", "claude");
    expect(dispatchTick(store).ready).toEqual([]);
    expect(getTask(store, "AB-2").prio).toBe(0);
    expect(getTask(store, "AB-3").prio).toBe(0);

    const answered = answerQuestion(store, question.id, "Use A");
    expect(answered.status).toBe("answered");
    const ownerTask = transitionTask(store, "AB-1", "owner_answered", "owner");
    expect(ownerTask.status).toBe("next");
    expect(ownerTask.prio).toBe(-1);
    expect(dispatchTick(store).ready).toEqual(["AB-1", "AB-2", "AB-3"]);
    expect(listBoardEventsAfter(store, 0, ["answer"]).map((event) => event.question)).toEqual([question.id]);
  });

  test("wait returns matching events after the cursor without skipping events between calls", async () => {
    const store = setupTasks();
    emitBoardEvent(store, { kind: "ready", task: "AB-1", payload: {} });
    const after = getBoardEventCursor(store);
    const pending = waitForBoardEvents(store, { kinds: ["review", "answer"], after, timeoutSeconds: 1, pollMs: 5 });
    emitBoardEvent(store, { kind: "review", task: "AB-1", payload: "done" });
    emitBoardEvent(store, { kind: "answer", task: "AB-1", question: "Q-1", payload: { answer: "ok" } });
    const result = await pending;
    expect(result.events.map((event) => event.kind)).toEqual(["review", "answer"]);
    const next = await waitForBoardEvents(store, { kinds: ["review", "answer"], after: result.cursor, timeoutSeconds: 0 });
    expect(next).toEqual({ events: [], cursor: result.cursor, timed_out: true });
    const freshResult = await waitForBoardEvents(store, { kinds: ["ready"], timeoutSeconds: 0 });
    expect(freshResult.cursor).toBe(getBoardEventCursor(store));
  });

  test("records stale once for unchanged silence", () => {
    const store = setupTasks();
    transitionTask(store, "AB-1", "promote", "claude");
    const running = transitionTask(store, "AB-1", "start", "claude");
    const run = createRun(store, { task: "AB-1", round: running.round, executor: "fake" });
    setRunPid(store, run.id, 88888888);
    setSetting(store, "stale_minutes", 0.0001);
    const now = new Date(Date.parse(run.startedAt) + 1000);

    expect(dispatchTick(store, { now, isAlive: () => true }).stale).toEqual([run.id]);
    expect(dispatchTick(store, { now, isAlive: () => true }).stale).toEqual([]);
    expect(listBoardEventsAfter(store, 0, ["stale"]).filter((event) => event.run === run.id)).toHaveLength(1);
  });

  test("finishes a dead runner as failed and moves the task to review", () => {
    const store = setupTasks();
    transitionTask(store, "AB-1", "promote", "claude");
    const running = transitionTask(store, "AB-1", "start", "claude");
    const run = createRun(store, { task: "AB-1", round: running.round, executor: "fake" });
    setRunPid(store, run.id, 88888889);

    expect(dispatchTick(store, { isAlive: () => false }).failed).toEqual([run.id]);
    expect(getRun(store, run.id)).toMatchObject({ endedAt: expect.any(String), outcome: "failed" });
    expect(getTask(store, "AB-1").status).toBe("review");
    expect(listBoardEventsAfter(store, 0, ["failed", "review"]).map((event) => event.kind)).toEqual(["review", "failed"]);
  });

  test("reconciles a run that ended just before its task transition", () => {
    const store = setupTasks();
    transitionTask(store, "AB-1", "promote", "claude");
    const running = transitionTask(store, "AB-1", "start", "claude");
    const run = createRun(store, { task: "AB-1", round: running.round, executor: "fake" });
    finishRun(store, run.id, { outcome: "rate_limited", exitCode: 1 });

    expect(dispatchTick(store).paused).toEqual([run.id]);
    expect(getTask(store, "AB-1").status).toBe("next");
    expect(listBoardEventsAfter(store, 0, ["review"]).map((event) => event.payload)).toEqual(["rate_limited"]);
  });

  test("rate-limit pauses requeue work, double backoff, and resume once", () => {
    const store = setupTasks();
    transitionTask(store, "AB-1", "promote", "claude");
    const firstRunId = finishActiveRun(store, "AB-1", "rate_limited");
    expect(dispatchTick(store).paused).toEqual([firstRunId]);
    expect(getTask(store, "AB-1").status).toBe("next");
    expect(getSetting(store, "pause_backoff_minutes")).toBe(30);
    expect(dispatchTick(store).paused).toEqual([]);
    expect(listBoardEventsAfter(store, 0, ["paused"])).toHaveLength(1);

    setSetting(store, "paused_until", new Date(Date.now() - 1000).toISOString());
    expect(dispatchTick(store).resumed).toBe(true);
    expect(dispatchTick(store).resumed).toBe(false);
    expect(listBoardEventsAfter(store, 0, ["resumed"])).toHaveLength(1);

    const secondRunId = finishActiveRun(store, "AB-1", "rate_limited");
    expect(getRun(store, secondRunId).round).toBe(2);
    expect(dispatchTick(store).paused).toEqual([secondRunId]);
    expect(getSetting(store, "pause_backoff_minutes")).toBe(60);
    expect(getTask(store, "AB-1").status).toBe("next");
  });

  test("serve uses one live lock and takes over a lock with a dead pid", () => {
    const store = setupTasks();
    const release = acquireServeLock(store);
    expect(() => acquireServeLock(store)).toThrow("already running");
    release();

    const lockPath = join(store.home, "serve.lock");
    writeFileSync(lockPath, "2147483647\n", "utf8");
    const releaseStale = acquireServeLock(store);
    expect(existsSync(lockPath)).toBe(true);
    releaseStale();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("dispatcher status reports the live lock holder only", () => {
    const store = setupTasks();
    expect(dispatcherStatus(store)).toEqual({ running: false, pid: null });
    const release = acquireServeLock(store);
    expect(dispatcherStatus(store)).toEqual({ running: true, pid: process.pid });
    release();
    writeFileSync(join(store.home, "serve.lock"), "2147483647\n", "utf8");
    expect(dispatcherStatus(store)).toEqual({ running: false, pid: null });
  });
});
