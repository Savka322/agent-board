import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { addProject, addTask, appendEvents, closeStore, createEpic, createQuestion, createRun, emitBoardEvent, finishRun, openStore, renderCardFile, transitionTask, writeTaskLog, type BoardStore } from "@agent-board/core";
import type { TaskCard } from "@agent-board/contracts";
import { createApp } from "../src/index";

let home = "";
let store: BoardStore;
let epicId = "EPIC-1";

function addSampleProject() {
  const repoPath = join(home, "repo").replace(/\\/g, "\\\\");
  writeFileSync(join(home, "projects", "sample.toml"), [
    'name = "sample"',
    `repo = "${repoPath}"`,
    'base_branch = "main"',
    'epic_branch_pattern = "epic/{epic}"',
    "light_tests = []",
    "gates = []",
    "data_links = []",
    "forbidden = []",
    "rules = []",
    "[executor]",
    'kind = "codex"',
    'model = "codex-test"',
    'effort = "medium"',
    'sandbox = "workspace-write"',
    "extra_config = []",
    "",
  ].join("\n"), "utf8");
  addProject(store, "sample");
  createEpic(store, { id: epicId, project: "sample", title: "Web board", branch: "epic/web-board" });
}

function addSampleTask(id: string, options: Partial<TaskCard> = {}) {
  const card: TaskCard = {
    id,
    title: `Task ${id}`,
    epic: epicId,
    goal: "Make the board readable.\nKeep the live behavior stable.",
    allowed_files: [`src/${id.toLowerCase()}.ts`],
    deps: [],
    decisions: [],
    light_tests: [],
    gates: [],
    acceptance: ["The behavior is covered."],
    ...options,
  };
  const path = join(home, `${id}.md`);
  writeFileSync(path, renderCardFile(card), "utf8");
  return addTask(store, epicId, path);
}

function app() {
  return createApp(store, 8790);
}

const localHeaders = { Host: "127.0.0.1:8790" };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-board-server-test-"));
  store = openStore(home);
  addSampleProject();
});

afterEach(() => {
  try { closeStore(store); } finally {
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    home = "";
  }
});

describe("read-only web app", () => {
  test("returns board progress, compact blocker labels, and owner questions", async () => {
    const base = addSampleTask("WEB-1");
    const pending = addSampleTask("WEB-2");
    const blocked = addSampleTask("WEB-3", { deps: [pending.id] });
    const questionTask = addSampleTask("WEB-4", { decisions: ["release_mode"] });
    transitionTask(store, base.id, "promote", "claude");
    transitionTask(store, base.id, "start", "claude");
    transitionTask(store, base.id, "run_finished", "runner");
    transitionTask(store, base.id, "accept", "claude");
    transitionTask(store, blocked.id, "promote", "claude");
    transitionTask(store, questionTask.id, "promote", "claude");
    const question = createQuestion(store, {
      task: questionTask.id,
      decision_key: "release_mode",
      kind: "stop",
      target: "owner",
      text: "Which release mode should this use?",
      options: ["Automatic", "Manual"],
      recommendation: "Automatic",
    });

    const response = await app().request("http://board/api/board", { headers: localHeaders });
    expect(response.status).toBe(200);
    const result = await response.json() as {
      epics: Array<{ id: string; progress: { done: number; total: number } }>;
      tasks: Array<{ id: string; labels: string[] }>;
      questions: Array<{ id: string; held_task_ids: string[] }>;
      settings: { max_slots: number; paused_until: string | null };
      running_count: number;
      cursor: number;
    };
    expect(result.epics).toEqual([{ id: epicId, project: "sample", title: "Web board", status: "open", progress: { done: 1, total: 4 } }]);
    expect(result.tasks.find((task) => task.id === blocked.id)?.labels).toEqual([`deps_pending:${pending.id}`]);
    expect(result.tasks.find((task) => task.id === questionTask.id)?.labels).toEqual([`waiting_answer:${question.id}`]);
    expect(result.questions[0]?.held_task_ids).toEqual([questionTask.id]);
    expect(result.settings.max_slots).toBe(5);
    expect(result.running_count).toBe(0);
    expect(result.cursor).toBeGreaterThanOrEqual(0);
    const questionsResponse = await app().request("http://board/api/questions?open=1", { headers: localHeaders });
    expect(await questionsResponse.json()).toMatchObject([{ id: question.id, status: "open", target: "owner" }]);
  });

  test("returns task card, run report, task history, and report details", async () => {
    const task = addSampleTask("WEB-4");
    const rawPath = join(home, "runs", "web-4", "events.jsonl");
    const reportPath = join(home, "runs", "web-4", "report.json");
    const report = {
      status: "DONE",
      summary: "Added the board view.",
      files_changed: ["src/board.ts"],
      tests_run: [{ cmd: "bun test", result: "pass", passed: 4, failed: 0 }],
      assumptions: [],
      question: null,
      notes: "",
    };
    mkdirSync(join(home, "runs", "web-4"), { recursive: true });
    writeFileSync(rawPath, "{\"type\":\"event\"}\n", "utf8");
    writeFileSync(reportPath, JSON.stringify(report), "utf8");
    transitionTask(store, task.id, "promote", "claude");
    transitionTask(store, task.id, "start", "claude");
    const run = createRun(store, { id: "run-web-4", task: task.id, executor: "codex-test", rawPath, reportPath });
    appendEvents(store, run.id, [{ ts: new Date().toISOString(), kind: "read", text: "Read the task card", raw_line: 1 }]);
    finishRun(store, run.id, { outcome: "done", exitCode: 0, rawPath, reportPath });
    transitionTask(store, task.id, "run_finished", "runner");
    writeTaskLog(store, { task: task.id, actor: "claude", action: "promote", note: "Ready to start" });

    const response = await app().request(`http://board/api/tasks/${task.id}`, { headers: localHeaders });
    expect(response.status).toBe(200);
    const result = await response.json() as {
      card: TaskCard & { status: string; round: number };
      runs: Array<{ round: number; outcome: string | null; started_at: string; usage: unknown; raw_available: boolean }>;
      task_log: Array<{ action: string; note: string | null }>;
      last_report: { status: string; summary: string } | null;
      review_summary: unknown;
      review_error: string | null;
    };
    expect(result.card).toMatchObject({ id: task.id, goal: task.card.goal, allowed_files: task.card.allowed_files, acceptance: task.card.acceptance, status: "review", round: 1 });
    expect(result.runs[0]).toMatchObject({ round: 1, outcome: "done", raw_available: true });
    expect(result.task_log.at(-1)).toMatchObject({ action: "promote", note: "Ready to start" });
    expect(result.last_report).toMatchObject({ status: "DONE", summary: "Added the board view." });
    expect(result.review_summary).toBeNull();
    expect(result.review_error).toContain("worktree is missing");
  });

  test("returns events strictly after a run cursor", async () => {
    const task = addSampleTask("WEB-5");
    const run = createRun(store, { id: "run-web-5", task: task.id, executor: "codex-test" });
    appendEvents(store, run.id, [
      { ts: new Date().toISOString(), kind: "read", text: "First", raw_line: 1 },
      { ts: new Date().toISOString(), kind: "exec", text: "Second", raw_line: 2 },
    ]);
    const response = await app().request(`http://board/api/tasks/${task.id}/events?after=0`, { headers: localHeaders });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject([{ seq: 1, kind: "exec", text: "Second" }]);
  });

  test("does not serve a raw log path outside the board home", async () => {
    const task = addSampleTask("WEB-6");
    const outsidePath = join(tmpdir(), `agent-board-escape-${crypto.randomUUID()}.jsonl`);
    writeFileSync(outsidePath, "private log\n", "utf8");
    try {
      createRun(store, { id: "run-web-6", task: task.id, executor: "codex-test", rawPath: join(home, "..", basename(outsidePath)) });
      const response = await app().request("http://board/api/runs/run-web-6/raw", { headers: localHeaders });
      expect(response.status).toBe(404);
    } finally {
      rmSync(outsidePath, { force: true });
    }
  });

  test("rejects unexpected hosts and accepts the local board host", async () => {
    const forbidden = await app().request("http://board/api/board", { headers: { Host: "evil.example:8790" } });
    const accepted = await app().request("http://board/api/board", { headers: localHeaders });
    expect(forbidden.status).toBe(403);
    expect(accepted.status).toBe(200);
  });

  test("serves the built SPA or the build instruction when dist is absent", async () => {
    const response = await app().request("http://board/", { headers: localHeaders });
    expect(response.status).toBe(200);
    const body = await response.text();
    if (existsSync(join(import.meta.dir, "../../web/dist/index.html"))) expect(body).toContain("<!doctype html>");
    else expect(body).toContain("bun run web:build");
  });

  test("streams new board events after the requested cursor", async () => {
    const cursor = 0;
    const response = await app().request(`http://board/api/stream?after=${cursor}`, { headers: localHeaders });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const chunkPromise = reader!.read();
    await Bun.sleep(20);
    const event = emitBoardEvent(store, { kind: "ready", task: null, payload: { task: "WEB-7" } });
    expect(event).not.toBeNull();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        chunkPromise,
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("SSE event timed out")), 2500); }),
      ]);
      expect(new TextDecoder().decode(result.value)).toContain('"task":"WEB-7"');
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      await reader!.cancel();
    }
  });
});
