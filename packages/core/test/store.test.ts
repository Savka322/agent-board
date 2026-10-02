import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCardFile, renderCardFile } from "../src/cards";
import { resolveHome } from "../src/home";
import {
  addApproval,
  addProject,
  addTask,
  answerDecision,
  answerQuestion,
  appendEvents,
  closeStore,
  createDecision,
  createEpic,
  createGateRun,
  createQuestion,
  createRun,
  finishRun,
  getEpic,
  getGateStats,
  getProject,
  getRun,
  getTask,
  hasApproval,
  listApprovals,
  listEpics,
  listEventsAfter,
  listOpenDecisions,
  listOpenQuestionsForProject,
  listOpenQuestionsForTask,
  listTasksByEpic,
  listTasksByStatus,
  openStore,
  setRunPid,
  setRunSessionId,
  transitionTask,
  updateGateRun,
  updateGateStats,
} from "../src/store";
import type { TaskCard } from "@agent-board/contracts";
import { installFreshHome, writeProfile } from "./helpers";

const fresh = installFreshHome();

function addSampleProjectAndEpic() {
  writeProfile(fresh.home);
  const project = addProject(fresh.store, "sample");
  const epic = createEpic(fresh.store, { id: "EPIC-1", project: project.name, title: "Build core", branch: "epic/core" });
  return { project, epic };
}

function writeCard(card: TaskCard): string {
  const path = join(fresh.home, `${card.id}.md`);
  writeFileSync(path, renderCardFile(card), "utf8");
  return path;
}

function card(id: string, allowedFiles = [`src/${id.toLowerCase()}.ts`], extra: Partial<TaskCard> = {}): TaskCard {
  return {
    id,
    title: `Task ${id}`,
    epic: "EPIC-1",
    goal: "Implement the requested change.\n\nKeep the behavior stable.",
    allowed_files: allowedFiles,
    deps: [],
    decisions: [],
    light_tests: [],
    gates: [{ cmd: "bun test", ram_est_gb: 1 }],
    acceptance: ["Behavior is covered"],
    ...extra,
  };
}

describe("card files", () => {
  test("round trips all TaskCard fields through TOML front matter", () => {
    const original = card("DEMO-1", ["src/**", "docs/overview.md"], {
      deps: ["DEMO-2"],
      decisions: ["api_shape"],
      light_tests: ["bun test packages/core"],
      gates: [{ cmd: "bun test", ram_est_gb: 1.5 }, { cmd: "bunx tsc --noEmit" }],
      acceptance: ["First condition", "Second condition"],
      notes: "Preserve the markdown body as content.",
    });
    expect(parseCardFile(renderCardFile(original))).toEqual(original);
  });
});

describe("SQLite store", () => {
  test("resolves the explicit home override and the default suffix", () => {
    expect(resolveHome()).toBe(fresh.home);
    const previous = process.env.AGENT_BOARD_HOME;
    delete process.env.AGENT_BOARD_HOME;
    try {
      expect(resolveHome().endsWith(".agent-board")).toBe(true);
    } finally {
      if (previous !== undefined) process.env.AGENT_BOARD_HOME = previous;
    }
  });

  test("applies migrations on a new home and is idempotent when reopened", () => {
    const first = fresh.store.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(first.map(({ name }) => name)).toContain("tasks");
    fresh.close();
    const reopened = fresh.reopen();
    const second = reopened.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(second.filter(({ name }) => name === "tasks")).toHaveLength(1);
  });

  test("loads valid TOML profiles and rejects invalid profile data", () => {
    writeProfile(fresh.home);
    const project = addProject(fresh.store, "sample");
    expect(project.profile.name).toBe("sample");
    expect(project.profile.base_branch).toBe("main");
    expect(getProject(fresh.store, "sample").profile.executor.kind).toBe("codex");

    const invalidHome = mkdtempSync(join(tmpdir(), "agent-board-invalid-profile-"));
    let invalidStore: ReturnType<typeof openStore> | undefined;
    try {
      process.env.AGENT_BOARD_HOME = invalidHome;
      invalidStore = openStore();
      mkdirSync(join(invalidHome, "projects"), { recursive: true });
      writeFileSync(join(invalidHome, "projects", "bad.toml"), "name = \"bad\"\nrepo = \"relative/repo\"\n[executor]\nkind=\"codex\"\nmodel=\"m\"\neffort=\"low\"\nsandbox=\"read-only\"\nextra_config=[]\n", "utf8");
      expect(() => addProject(invalidStore!, "bad")).toThrow();
    } finally {
      if (invalidStore) closeStore(invalidStore);
      process.env.AGENT_BOARD_HOME = fresh.home;
      rmSync(invalidHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test("removes a written home after closing its store", () => {
    const cleanupHome = mkdtempSync(join(tmpdir(), "agent-board-cleanup-check-"));
    const previous = process.env.AGENT_BOARD_HOME;
    let cleanupStore: ReturnType<typeof openStore> | undefined;
    try {
      process.env.AGENT_BOARD_HOME = cleanupHome;
      cleanupStore = openStore();
      writeProfile(cleanupHome);
      addProject(cleanupStore, "sample");
      closeStore(cleanupStore);
      cleanupStore = undefined;
      rmSync(cleanupHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      expect(existsSync(cleanupHome)).toBe(false);
    } finally {
      if (cleanupStore) closeStore(cleanupStore);
      if (previous === undefined) delete process.env.AGENT_BOARD_HOME;
      else process.env.AGENT_BOARD_HOME = previous;
      if (existsSync(cleanupHome)) rmSync(cleanupHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test("supports project, epic, task, decision, and question CRUD", () => {
    const { project, epic } = addSampleProjectAndEpic();
    expect(getEpic(fresh.store, epic.id).title).toBe("Build core");
    expect(listEpics(fresh.store, project.name)).toHaveLength(1);

    const prerequisite = addTask(fresh.store, epic.id, writeCard(card("DEMO-1")));
    const main = addTask(fresh.store, epic.id, writeCard(card("DEMO-2", ["src/main.ts"], {
      deps: ["DEMO-1"],
      decisions: ["api_shape"],
    })));
    expect(prerequisite.status).toBe("todo");
    expect(getTask(fresh.store, main.id).deps).toEqual(["DEMO-1"]);
    expect(getTask(fresh.store, main.id).decisions).toEqual(["api_shape"]);
    expect(listTasksByEpic(fresh.store, epic.id)).toHaveLength(2);
    expect(listTasksByStatus(fresh.store, "todo")).toHaveLength(2);

    createDecision(fresh.store, { project: project.name, key: "release_mode", title: "Release mode" });
    expect(listOpenDecisions(fresh.store, project.name).map(({ key }) => key)).toContain("api_shape");
    const question = createQuestion(fresh.store, {
      task: main.id,
      decision_key: "api_shape",
      kind: "stop",
      target: "owner",
      text: "Which API shape should this use?",
      options: ["A", "B"],
      recommendation: "A",
    });
    expect(listOpenQuestionsForTask(fresh.store, main.id)).toHaveLength(1);
    expect(listOpenQuestionsForProject(fresh.store, project.name)).toHaveLength(1);
    expect(answerQuestion(fresh.store, question.id, "A").status).toBe("answered");
    expect(listOpenQuestionsForTask(fresh.store, main.id)).toHaveLength(0);
    expect(listOpenDecisions(fresh.store, project.name).some(({ key }) => key === "api_shape")).toBe(false);
    answerDecision(fresh.store, project.name, "release_mode", "stable");
    expect(listOpenDecisions(fresh.store, project.name).some(({ key }) => key === "release_mode")).toBe(false);
  });

  test("supports run, event, gate, gate-stat, and approval CRUD", () => {
    const { project, epic } = addSampleProjectAndEpic();
    const task = addTask(fresh.store, epic.id, writeCard(card("DEMO-1")));

    const run = createRun(fresh.store, { id: "run-1", task: task.id, executor: "codex" });
    setRunSessionId(fresh.store, run.id, "session-1");
    setRunPid(fresh.store, run.id, 1234);
    const ended = finishRun(fresh.store, run.id, {
      outcome: "partial",
      exitCode: 1,
      usage: { input_tokens: 10, output_tokens: 4 },
      reportPath: "runs/run-1-report.json",
      rawPath: "runs/run-1.jsonl",
    });
    expect(ended.sessionId).toBe("session-1");
    expect(getRun(fresh.store, run.id).pid).toBe(1234);
    expect(ended.usage).toEqual({ input_tokens: 10, output_tokens: 4 });

    const appended = appendEvents(fresh.store, run.id, [
      { ts: "2026-01-01T00:00:00.000Z", kind: "message", text: "started", raw_line: 1 },
      { ts: "2026-01-01T00:00:01.000Z", kind: "edit", text: "add src/main.ts", raw_line: 2 },
    ]);
    expect(appended.map(({ seq }) => seq)).toEqual([0, 1]);
    expect(listEventsAfter(fresh.store, run.id, 0).map(({ text }) => text)).toEqual(["add src/main.ts"]);

    const gate = createGateRun(fresh.store, { id: "gate-1", task: task.id, cmd: "bun test", ram_est_bytes: 1024 });
    expect(updateGateRun(fresh.store, gate.id, { status: "pass", peak_commit_bytes: 2048, started_at: "2026-01-01T00:00:00.000Z", ended_at: "2026-01-01T00:00:01.000Z" }).status).toBe("pass");
    updateGateStats(fresh.store, project.name, "hash-a", 800);
    updateGateStats(fresh.store, project.name, "hash-a", 600);
    expect(getGateStats(fresh.store, project.name, "hash-a")).toMatchObject({ peakCommitMaxBytes: 800, runs: 2 });

    addApproval(fresh.store, { id: "approval-1", epic: epic.id, kind: "merge", source: "web" });
    expect(hasApproval(fresh.store, epic.id, "merge")).toBe(true);
    expect(listApprovals(fresh.store, epic.id)).toHaveLength(1);
  });

  test("routes persisted status changes through the state machine and puts answered owner work first", () => {
    const { epic } = addSampleProjectAndEpic();
    addTask(fresh.store, epic.id, writeCard(card("DEMO-1", ["src/one.ts"])));
    addTask(fresh.store, epic.id, writeCard(card("DEMO-2", ["src/two.ts"])));
    transitionTask(fresh.store, "DEMO-1", "promote", "claude");
    transitionTask(fresh.store, "DEMO-2", "promote", "claude");
    const started = transitionTask(fresh.store, "DEMO-1", "start", "claude");
    expect(started.round).toBe(1);
    transitionTask(fresh.store, "DEMO-1", "run_finished", "runner");
    transitionTask(fresh.store, "DEMO-1", "escalate", "claude");
    const updated = transitionTask(fresh.store, "DEMO-1", "owner_answered", "owner");
    expect(updated.status).toBe("next");
    expect(listTasksByStatus(fresh.store, "next")[0]?.id).toBe("DEMO-1");
  });

  test("blocks a start when another task has an open stop question for a shared decision", () => {
    const { epic } = addSampleProjectAndEpic();
    addTask(fresh.store, epic.id, writeCard(card("DEMO-1", ["src/one.ts"], { decisions: ["api_shape"] })));
    addTask(fresh.store, epic.id, writeCard(card("DEMO-2", ["src/two.ts"], { decisions: ["api_shape"] })));
    createQuestion(fresh.store, {
      task: "DEMO-1",
      decision_key: "api_shape",
      kind: "stop",
      target: "owner",
      text: "Choose an API shape.",
      options: ["A", "B"],
      recommendation: "A",
    });
    transitionTask(fresh.store, "DEMO-2", "promote", "claude");
    expect(() => transitionTask(fresh.store, "DEMO-2", "start", "claude")).toThrow("start_blocked");
  });

  test("passes a per-transition slot limit to canStart", () => {
    const { epic } = addSampleProjectAndEpic();
    addTask(fresh.store, epic.id, writeCard(card("DEMO-1", ["src/one.ts"])));
    addTask(fresh.store, epic.id, writeCard(card("DEMO-2", ["src/two.ts"])));
    transitionTask(fresh.store, "DEMO-1", "promote", "claude");
    transitionTask(fresh.store, "DEMO-1", "start", "claude");
    transitionTask(fresh.store, "DEMO-2", "promote", "claude");
    expect(() => transitionTask(fresh.store, "DEMO-2", "start", "claude", 1)).toThrow("start_blocked");
  });
});
