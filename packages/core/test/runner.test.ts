import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  closeStore,
  getEpic,
  getRun,
  getTask,
  canStartTask,
  listBoardEventsAfter,
  listEventsAfter,
  listQuestions,
  listRunsForTask,
  listTaskLog,
  openStore,
  setSetting,
  type BoardStore,
} from "../src/store";
import { changedFiles, ensureTaskWorktree, getEpicWorktreePath, getTaskWorktreePath, removeLeftoverWorktree, removeTaskWorktree } from "../src/worktrees";
import { dispatchTick } from "../src/dispatcher";

const root = resolve(import.meta.dir, "../../..");
const fakeCodex = resolve(import.meta.dir, "fake-codex.ts");
const fakeSession = "01a0fe6e-6396-7292-9b1d-f6fdf0916ef2";
const controlledVariables = [
  "AGENT_BOARD_HOME",
  "AGENT_BOARD_CODEX_CMD",
  "AGENT_BOARD_FAKE_EDIT",
  "AGENT_BOARD_FAKE_STATUS",
  "AGENT_BOARD_FAKE_SLEEP_MS",
  "AGENT_BOARD_FAKE_MISSING_REPORT",
  "AGENT_BOARD_FAKE_STDERR",
  "AGENT_BOARD_FAKE_SPLIT_UTF8",
  "AGENT_BOARD_FAKE_EXIT_CODE",
  "AGENT_BOARD_FAKE_SESSION_LOG",
  "AGENT_BOARD_FAKE_ASSUMPTIONS",
];

let tempRoot = "";
let home = "";
let repo = "";
let cardPath = "";
let sessionCapture = "";
let store: BoardStore | undefined;
let previousEnv: Record<string, string | undefined> = {};

function quotePrefixPart(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, windowsHide: true, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr ?? result.error?.message ?? result.status}`);
  return result.stdout;
}

function cli(args: string[], extraEnv: Record<string, string | undefined> = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return spawnSync(process.execPath, ["run", "agentctl", ...args], { cwd: root, windowsHide: true, encoding: "utf8", env });
}

function cliJson<T>(args: string[], extraEnv: Record<string, string | undefined> = {}): T {
  const result = cli([...args, "--json"], extraEnv);
  if (result.status !== 0) throw new Error(`agentctl ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  return JSON.parse(result.stdout) as T;
}

function toml(value: string): string {
  return JSON.stringify(value);
}

function writeProfile(dataLinks: Array<{ from: string; to: string; mode?: "copy" | "link" }> = []): void {
  const linkRows = dataLinks.map(({ from, to, mode }) => `{ from = ${toml(from)}, to = ${toml(to)}${mode ? `, mode = ${toml(mode)}` : ""} }`).join(", ");
  const contents = [
    `name = ${toml("sample")}`,
    `repo = ${toml(repo)}`,
    `base_branch = "main"`,
    `epic_branch_pattern = "epic/{epic}"`,
    `light_tests = []`,
    `gates = []`,
    `data_links = [${linkRows}]`,
    `forbidden = []`,
    `rules = ["Keep changes focused."]`,
    `[executor]`,
    `kind = "codex"`,
    `model = "codex-test-model"`,
    `effort = "medium"`,
    `sandbox = "workspace-write"`,
    `extra_config = []`,
    "",
  ].join("\n");
  writeFileSync(join(home, "projects", "sample.toml"), contents, "utf8");
}

function writeCard(): void {
  cardPath = join(tempRoot, "task.md");
  writeFileSync(cardPath, [
    "+++",
    `id = "AB-1"`,
    `title = "Add the test change"`,
    `epic = "EP-1"`,
    `allowed_files = ["src/**"]`,
    `deps = []`,
    `decisions = []`,
    `light_tests = []`,
    `gates = []`,
    `acceptance = ["The change is merged into the epic branch."]`,
    "+++",
    "Create a small change for the agent-board integration test.",
    "",
  ].join("\n"), "utf8");
}

function cliSetup(): void {
  const project = cliJson<{ name: string }>(["project", "add", "sample"]);
  expect(project.name).toBe("sample");
  const epic = cliJson<{ id: string }>(["epic", "new", "sample", "EP-1", "Test epic"]);
  expect(epic.id).toBe("EP-1");
  const task = cliJson<{ id: string }>(["task", "add", "EP-1", cardPath]);
  expect(task.id).toBe("AB-1");
}

async function waitForRun(runId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runRow = getRun(store!, runId);
    if (runRow.endedAt !== null) return runRow;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Run ${runId} did not finish within ${timeoutMs} ms`);
}

async function waitForRunnerPid(runId: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runRow = getRun(store!, runId);
    if (runRow.pid !== null) return runRow;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Run ${runId} did not report its runner pid`);
}

function killStubbornTestProcesses(): void {
  if (!store) return;
  for (const task of ["AB-1"]) {
    try {
      const active = listRunsForTask(store, task).find((runRow) => runRow.endedAt === null && runRow.pid !== null);
      if (active?.pid) spawnSync("taskkill", ["/T", "/F", "/PID", String(active.pid)], { windowsHide: true, encoding: "utf8" });
    } catch { /* Cleanup below still removes the isolated temporary workspace. */ }
  }
}

function removeTemp(path: string): void {
  if (!path || !existsSync(path)) return;
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

describe("runner, worktrees, review, and agentctl", () => {
  beforeEach(() => {
    previousEnv = Object.fromEntries(controlledVariables.map((key) => [key, process.env[key]]));
    tempRoot = mkdtempSync(join(tmpdir(), "agent-board-runner-test-"));
    home = join(tempRoot, "home with space");
    mkdirSync(join(home, "projects"), { recursive: true });
    mkdirSync(join(home, "runs"), { recursive: true });
    repo = join(tempRoot, "repo");
    mkdirSync(repo, { recursive: true });
    run("git", ["init", "-b", "main", repo], tempRoot);
    writeFileSync(join(repo, "README.md"), "temporary integration repo\n", "utf8");
    run("git", ["add", "README.md"], repo);
    run("git", ["-c", "user.name=Agent Board Test", "-c", "user.email=agent-board-test@example.invalid", "commit", "-m", "initial"], repo);
    process.env.AGENT_BOARD_HOME = home;
    process.env.AGENT_BOARD_CODEX_CMD = `${quotePrefixPart(process.execPath)} ${quotePrefixPart(fakeCodex)}`;
    process.env.AGENT_BOARD_FAKE_EDIT = "src/allowed.txt";
    process.env.AGENT_BOARD_FAKE_STATUS = "DONE";
    delete process.env.AGENT_BOARD_FAKE_SLEEP_MS;
    delete process.env.AGENT_BOARD_FAKE_MISSING_REPORT;
    delete process.env.AGENT_BOARD_FAKE_STDERR;
    delete process.env.AGENT_BOARD_FAKE_SPLIT_UTF8;
    delete process.env.AGENT_BOARD_FAKE_EXIT_CODE;
    sessionCapture = join(tempRoot, "fake-sessions.log");
    process.env.AGENT_BOARD_FAKE_SESSION_LOG = sessionCapture;
    delete process.env.AGENT_BOARD_FAKE_ASSUMPTIONS;
    writeProfile();
    writeCard();
    store = openStore(home);
  });

  afterEach(async () => {
    if (store) {
      try {
        for (const runRow of listRunsForTask(store, "AB-1")) {
          if (runRow.endedAt === null) {
            try { await waitForRun(runRow.id, 10_000); } catch { killStubbornTestProcesses(); }
          }
        }
        const taskRow = store.sqlite.query("select id from tasks where id = ?").get("AB-1");
        if (taskRow) removeTaskWorktree(store, "AB-1");
        const taskPath = join(home, "worktrees", "sample", "AB-1");
        if (existsSync(taskPath)) throw new Error(`Task worktree was not removed during test cleanup: ${taskPath}`);
        const epicPath = join(home, "worktrees", "sample", "_epic-EP-1");
        if (existsSync(epicPath)) {
          const result = spawnSync("git", ["worktree", "remove", "--force", epicPath], { cwd: repo, encoding: "utf8", windowsHide: true });
          if (result.status !== 0 && existsSync(epicPath)) removeTemp(epicPath);
          spawnSync("git", ["worktree", "prune"], { cwd: repo, windowsHide: true });
        }
      } finally {
        closeStore(store);
        store = undefined;
      }
    }
    removeTemp(tempRoot);
    for (const key of controlledVariables) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("runs, resumes, reviews, and accepts a task through agentctl", async () => {
    cliSetup();
    const promoted = cliJson<{ status: string }>(["task", "promote", "AB-1"]);
    expect(promoted.status).toBe("next");
    const first = cliJson<{ run_id: string; round: number }>(["start", "AB-1"]);
    expect(first.round).toBe(1);
    const prompt = await Bun.file(join(home, "runs", "AB-1", "1", "prompt.md")).text();
    expect(prompt).toContain("You are the executor for one task card on an agent-board. Rules:");
    expect(prompt).toContain("Keep changes focused.");
    expect(prompt).toContain("allowed_files:\n- src/**");
    expect(JSON.parse(await Bun.file(join(home, "runs", "AB-1", "1", "report.schema.json")).text())).toHaveProperty("properties");
    const firstRun = await waitForRun(first.run_id);
    expect(firstRun.outcome).toBe("done");
    expect(getTask(store!, "AB-1").status).toBe("review");
    expect(listEventsAfter(store!, first.run_id, -1).length).toBeGreaterThan(0);
    const firstReview = cliJson<{ changed_files: Array<{ path: string }> }>(["review", "AB-1"]);
    expect(firstReview.changed_files.map(({ path }) => path)).toContain("src/allowed.txt");

    const notePath = join(tempRoot, "review-note.md");
    writeFileSync(notePath, "Please keep the implementation as-is and confirm the checks.", "utf8");
    const second = cliJson<{ run_id: string; round: number }>(["resume", "AB-1", "--note", notePath]);
    expect(second.round).toBe(2);
    expect((await waitForRun(second.run_id)).outcome).toBe("done");
    expect(listEventsAfter(store!, second.run_id, -1).length).toBeGreaterThan(0);
    const captured = await Bun.file(sessionCapture).text();
    expect(captured).toContain(`resume:${fakeSession}`);
    expect(captured).toContain("sandbox_mode=workspace-write");
    expect(captured).not.toContain('sandbox_mode="workspace-write"');
    expect(await Bun.file(join(home, "runs", "AB-1", "2", "note.md")).text()).toContain("Please keep the implementation");
    const secondReview = cliJson<{ report: { status: string } }>(["review", "AB-1"]);
    expect(secondReview.report.status).toBe("DONE");

    const accepted = cliJson<{ task: string; commit: string }>(["accept", "AB-1"]);
    expect(accepted.task).toBe("AB-1");
    expect(accepted.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(existsSync(getTaskWorktreePath(store!, "AB-1"))).toBe(false);
    const epicPath = getEpicWorktreePath(store!, "sample", "EP-1");
    expect(existsSync(join(epicPath, "src", "allowed.txt"))).toBe(true);
    expect(run("git", ["log", "--merges", "--oneline", "-1"], epicPath).trim().length).toBeGreaterThan(0);
    expect(getEpic(store!, "EP-1").branch).toBe("epic/EP-1");
    expect(listTaskLog(store!, "AB-1").map(({ action }) => action)).toEqual([
      "promote", "start", "run_finished", "resume", "run_finished", "accept",
    ]);
  });

  test("refuses outside-allowed changes unless the reason is recorded on accept", async () => {
    cliSetup();
    cliJson(["task", "promote", "AB-1"]);
    process.env.AGENT_BOARD_FAKE_EDIT = "private.txt";
    const started = cliJson<{ run_id: string }>(["start", "AB-1"]);
    await waitForRun(started.run_id);
    const refused = cli(["accept", "AB-1", "--json"]);
    expect(refused.status).toBe(2);
    expect(JSON.parse(refused.stdout).error).toContain("outside allowed_files");
    const accepted = cliJson<{ task: string }>(["accept", "AB-1", "--allow-extra", "Approved the generated metadata file."]);
    expect(accepted.task).toBe("AB-1");
    expect(listTaskLog(store!, "AB-1").at(-1)?.note).toBe("Approved the generated metadata file.");
  });

  test("records a BLOCKED report and opens a question for Claude", async () => {
    cliSetup();
    cliJson(["task", "promote", "AB-1"]);
    process.env.AGENT_BOARD_FAKE_EDIT = "nothing";
    process.env.AGENT_BOARD_FAKE_STATUS = "BLOCKED";
    const started = cliJson<{ run_id: string }>(["start", "AB-1"]);
    const runRow = await waitForRun(started.run_id);
    expect(runRow.outcome).toBe("blocked");
    const questions = store!.sqlite.query("select target, kind, status from questions where task = ?").all("AB-1") as Array<{ target: string; kind: string; status: string }>;
    expect(questions).toEqual([{ target: "claude", kind: "stop", status: "open" }]);
  });

  test("marks a missing report as failed", async () => {
    cliSetup();
    cliJson(["task", "promote", "AB-1"]);
    process.env.AGENT_BOARD_FAKE_EDIT = "nothing";
    process.env.AGENT_BOARD_FAKE_MISSING_REPORT = "1";
    const started = cliJson<{ run_id: string }>(["start", "AB-1"]);
    expect((await waitForRun(started.run_id)).outcome).toBe("failed");
    expect(getTask(store!, "AB-1").status).toBe("review");
  });

  test("preserves multi-byte event text split across stdout chunks", async () => {
    cliSetup();
    cliJson(["task", "promote", "AB-1"]);
    process.env.AGENT_BOARD_FAKE_EDIT = "nothing";
    process.env.AGENT_BOARD_FAKE_SPLIT_UTF8 = "1";
    const started = cliJson<{ run_id: string }>(["start", "AB-1"]);
    await waitForRun(started.run_id);
    const event = listEventsAfter(store!, started.run_id, -1).find(({ text }) => text.includes("Cyrillic:"));
    expect(event?.text).toBe("Cyrillic: Привет, emoji: 😀");
    const raw = await Bun.file(join(home, "runs", "AB-1", "1", "events.jsonl")).text();
    expect(raw).toContain("Привет, emoji: 😀");
  });

  test("classifies explicit rate-limit failures", async () => {
    cliSetup();
    cliJson(["task", "promote", "AB-1"]);
    process.env.AGENT_BOARD_FAKE_EDIT = "nothing";
    process.env.AGENT_BOARD_FAKE_STDERR = "HTTP 429 Too Many Requests\n";
    process.env.AGENT_BOARD_FAKE_EXIT_CODE = "1";
    const started = cliJson<{ run_id: string }>(["start", "AB-1"]);
    expect((await waitForRun(started.run_id)).outcome).toBe("rate_limited");
  });

  test("classifies usage-limit failures", async () => {
    cliSetup();
    cliJson(["task", "promote", "AB-1"]);
    process.env.AGENT_BOARD_FAKE_EDIT = "nothing";
    process.env.AGENT_BOARD_FAKE_STDERR = "usage limit reached\n";
    process.env.AGENT_BOARD_FAKE_EXIT_CODE = "1";
    const started = cliJson<{ run_id: string }>(["start", "AB-1"]);
    expect((await waitForRun(started.run_id)).outcome).toBe("rate_limited");
  });

  test("does not classify an unrelated line number as a rate-limit failure", async () => {
    cliSetup();
    cliJson(["task", "promote", "AB-1"]);
    process.env.AGENT_BOARD_FAKE_EDIT = "nothing";
    process.env.AGENT_BOARD_FAKE_STDERR = "apply_patch verification failed\nline 429\n";
    process.env.AGENT_BOARD_FAKE_EXIT_CODE = "1";
    const started = cliJson<{ run_id: string }>(["start", "AB-1"]);
    expect((await waitForRun(started.run_id)).outcome).toBe("failed");
  });

  test("asks the owner and releases a task after the answer is recorded", async () => {
    cliSetup();
    expect(cliJson<{ prio: number }>(["task", "prio", "AB-1", "3"]).prio).toBe(3);
    cliJson(["task", "promote", "AB-1"]);
    process.env.AGENT_BOARD_FAKE_EDIT = "nothing";
    const started = cliJson<{ run_id: string }>(["start", "AB-1"]);
    await waitForRun(started.run_id);
    const asked = cliJson<{ question: { id: string; target: string; options: string[] }; task: { status: string } }>([
      "ask", "AB-1", "--decision", "implementation", "--kind", "stop",
      "--text", "Which implementation should be used?", "--option", "Option A", "--option", "Option B",
      "--recommend", "Option A",
    ]);
    expect(asked.question.target).toBe("owner");
    expect(asked.question.options).toEqual(["Option A", "Option B"]);
    expect(asked.task.status).toBe("needs_owner");
    const answer = cliJson<{ question: { answer: string }; task: { status: string } }>(["answer", asked.question.id, "Choose Option A"]);
    expect(answer.question.answer).toBe("Choose Option A");
    expect(answer.task.status).toBe("next");
  });

  test("continues the prior Codex session after an owner answer with a short decision note", async () => {
    cliSetup();
    cliJson(["task", "promote", "AB-1"]);
    process.env.AGENT_BOARD_FAKE_EDIT = "nothing";
    const first = cliJson<{ run_id: string }>(["start", "AB-1"]);
    await waitForRun(first.run_id);
    const asked = cliJson<{ question: { id: string } }>([
      "ask", "AB-1", "--decision", "implementation", "--kind", "stop",
      "--text", "Which implementation should be used?", "--option", "Option A", "--option", "Option B",
      "--recommend", "Option A",
    ]);
    cliJson(["answer", asked.question.id, "Choose Option A"]);

    const notePath = join(tempRoot, "owner-note.md");
    writeFileSync(notePath, "Keep the selected approach narrow.", "utf8");
    const continued = cliJson<{ run_id: string; round: number }>(["start", "AB-1", "--note", notePath]);
    expect(continued.round).toBe(2);
    await waitForRun(continued.run_id);
    const prompt = await Bun.file(join(home, "runs", "AB-1", "2", "prompt.md")).text();
    expect(prompt).toContain("implementation: Choose Option A");
    expect(prompt).toContain("Keep the selected approach narrow.");
    expect(prompt).not.toContain("## Task card");
    const captured = await Bun.file(sessionCapture).text();
    expect(captured).toContain(`resume:${fakeSession} exec resume ${fakeSession}`);
    expect(getRun(store!, continued.run_id).resumeSessionId).toBe(fakeSession);
    expect(listTaskLog(store!, "AB-1").filter(({ action }) => action === "start").at(-1)?.note)
      .toBe(`continued session ${fakeSession}`);
  });

  test("--fresh starts a new Codex session and includes the card and all answered decisions", async () => {
    cliSetup();
    cliJson(["task", "promote", "AB-1"]);
    process.env.AGENT_BOARD_FAKE_EDIT = "nothing";
    const first = cliJson<{ run_id: string }>(["start", "AB-1"]);
    await waitForRun(first.run_id);
    const asked = cliJson<{ question: { id: string } }>([
      "ask", "AB-1", "--decision", "implementation", "--kind", "stop",
      "--text", "Which implementation should be used?", "--recommend", "Option A",
    ]);
    cliJson(["answer", asked.question.id, "Choose Option B"]);

    const fresh = cliJson<{ run_id: string; round: number }>(["start", "AB-1", "--fresh"]);
    expect(fresh.round).toBe(2);
    await waitForRun(fresh.run_id);
    const prompt = await Bun.file(join(home, "runs", "AB-1", "2", "prompt.md")).text();
    expect(prompt).toContain("## Task card");
    expect(prompt).toContain("implementation: Choose Option B");
    expect(getRun(store!, fresh.run_id).resumeSessionId).toBeNull();
    const captured = await Bun.file(sessionCapture).text();
    expect(captured.match(/^exec /gm)).toHaveLength(2);
    expect(captured).not.toContain("resume:");
    expect(listTaskLog(store!, "AB-1").filter(({ action }) => action === "start").at(-1)?.note).toBe("started fresh");
  });

  test("continues the session after a rate-limit requeue with the interruption note", async () => {
    cliSetup();
    cliJson(["task", "promote", "AB-1"]);
    process.env.AGENT_BOARD_FAKE_EDIT = "nothing";
    process.env.AGENT_BOARD_FAKE_STDERR = "Rate limit exceeded";
    process.env.AGENT_BOARD_FAKE_EXIT_CODE = "1";
    const first = cliJson<{ run_id: string }>(["start", "AB-1"]);
    expect((await waitForRun(first.run_id)).outcome).toBe("rate_limited");
    expect(dispatchTick(store!).paused).toEqual([first.run_id]);
    setSetting(store!, "paused_until", null);
    delete process.env.AGENT_BOARD_FAKE_STDERR;
    delete process.env.AGENT_BOARD_FAKE_EXIT_CODE;

    const continued = cliJson<{ run_id: string; round: number }>(["start", "AB-1"]);
    expect(continued.round).toBe(2);
    await waitForRun(continued.run_id);
    const prompt = await Bun.file(join(home, "runs", "AB-1", "2", "prompt.md")).text();
    expect(prompt).toContain("the previous run was interrupted by a rate limit");
    expect(prompt).not.toContain("## Task card");
    expect((await Bun.file(sessionCapture).text())).toContain(`resume:${fakeSession} exec resume ${fakeSession}`);
  });

  test("refuses to start a fourth run", async () => {
    cliSetup();
    cliJson(["task", "promote", "AB-1"]);
    process.env.AGENT_BOARD_FAKE_EDIT = "nothing";
    for (let round = 1; round <= 3; round += 1) {
      const started = cliJson<{ run_id: string; round: number }>(["start", "AB-1"]);
      expect(started.round).toBe(round);
      await waitForRun(started.run_id);
      const asked = cliJson<{ question: { id: string } }>([
        "ask", "AB-1", "--decision", "implementation", "--kind", "stop",
        "--text", `Confirm implementation for run ${round}?`, "--recommend", "Continue",
      ]);
      cliJson(["answer", asked.question.id, `Continue after run ${round}`]);
    }

    const refused = cli(["start", "AB-1", "--json"]);
    expect(refused.status).toBe(2);
    expect(JSON.parse(refused.stdout)).toMatchObject({ details: { code: "max_rounds" } });
    expect(getTask(store!, "AB-1")).toMatchObject({ status: "next", round: 3 });
    expect(listRunsForTask(store!, "AB-1")).toHaveLength(3);
  });

  test("stores report assumptions as open non-blocking owner questions and records rejection", async () => {
    cliSetup();
    cliJson(["task", "promote", "AB-1"]);
    process.env.AGENT_BOARD_FAKE_EDIT = "nothing";
    process.env.AGENT_BOARD_FAKE_ASSUMPTIONS = JSON.stringify([
      { decision_key: "api_shape", text: "The API follows the existing client convention." },
      { decision_key: null, text: "The generated file remains checked in." },
    ]);
    const started = cliJson<{ run_id: string }>(["start", "AB-1"]);
    await waitForRun(started.run_id);
    const assumptions = listQuestions(store!, { open: true, target: "owner" });
    expect(assumptions).toHaveLength(2);
    expect(assumptions.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "assume", text: "The API follows the existing client convention." },
      { kind: "assume", text: "The generated file remains checked in." },
    ]);
    expect(getTask(store!, "AB-1").status).toBe("review");
    expect(listBoardEventsAfter(store!, 0, ["review"]).filter((event) => event.run === started.run_id).map((event) => event.payload)).toEqual(["done"]);

    const rejected = cliJson<{ question: { status: string }; task: { status: string } }>([
      "answer", assumptions[0]!.id, "Use the other convention", "--reject",
    ]);
    expect(rejected.question.status).toBe("rejected");
    expect(rejected.task.status).toBe("review");
    expect(listBoardEventsAfter(store!, 0, ["answer", "assumption_rejected"]).map(({ kind, question }) => ({ kind, question }))).toEqual([
      { kind: "answer", question: assumptions[0]!.id },
      { kind: "assumption_rejected", question: assumptions[0]!.id },
    ]);
  });

  test("answers a BLOCKED report question addressed to the orchestrator without changing status", async () => {
    cliSetup();
    cliJson(["task", "promote", "AB-1"]);
    process.env.AGENT_BOARD_FAKE_EDIT = "nothing";
    process.env.AGENT_BOARD_FAKE_STATUS = "BLOCKED";
    const started = cliJson<{ run_id: string }>(["start", "AB-1"]);
    await waitForRun(started.run_id);
    const question = listQuestions(store!, { open: true, target: "claude" })[0]!;
    expect(question.kind).toBe("stop");
    expect(getTask(store!, "AB-1").status).toBe("review");

    const answer = cliJson<{ question: { status: string }; task: { status: string } }>(["answer", question.id, "Proceed with option A"]);
    expect(answer.question.status).toBe("answered");
    expect(answer.task.status).toBe("review");
  });

  test("copies default data links so executor writes do not reach their source", () => {
    const sourceFile = join(tempRoot, "copied-data.json");
    writeFileSync(sourceFile, "source data\n", "utf8");
    writeProfile([{ from: sourceFile, to: "data/source.json" }]);
    cliSetup();
    const taskPath = ensureTaskWorktree(store!, "AB-1").path;
    writeFileSync(join(taskPath, "data", "source.json"), "executor data\n", "utf8");
    expect(readFileSync(sourceFile, "utf8")).toBe("source data\n");
    expect(changedFiles(store!, "AB-1")).toEqual([]);
  });

  test("preserves shared writes for an explicit link-mode data link", () => {
    const sourceFile = join(tempRoot, "linked-data.json");
    writeFileSync(sourceFile, "source data\n", "utf8");
    writeProfile([{ from: sourceFile, to: "data/source.json", mode: "link" }]);
    cliSetup();
    const taskPath = ensureTaskWorktree(store!, "AB-1").path;
    writeFileSync(join(taskPath, "data", "source.json"), "executor data\n", "utf8");
    expect(readFileSync(sourceFile, "utf8")).toBe("executor data\n");
    expect(changedFiles(store!, "AB-1")).toEqual([]);
  });

  test("emits a compact status payload", () => {
    cliSetup();
    const status = cliJson<{ tasks: Array<Record<string, unknown>> }>(["status"]);
    expect(Object.keys(status.tasks[0]!).sort()).toEqual(["epic", "id", "labels", "prio", "round", "status", "title"]);
  });

  test("reads and updates dispatcher settings", () => {
    cliSetup();
    const settings = cliJson<Array<{ key: string; value: unknown }>>(["settings", "--set", "stale_minutes=0.01"]);
    expect(settings.find(({ key }) => key === "stale_minutes")?.value).toBe(0.01);
  });

  test("prints help for every command and reports a wait timeout with exit code 3", () => {
    const helpCommands = [
      [], ["project"], ["project", "add"], ["project", "show"], ["epic"], ["epic", "new"], ["epic", "status"],
      ["task"], ["task", "add"], ["task", "show"], ["task", "promote"], ["task", "prio"], ["task", "cancel"],
      ["start"], ["resume"], ["stop"], ["review"], ["accept"], ["reject"], ["ask"], ["answer"], ["questions"],
      ["status"], ["wait"], ["serve"], ["settings"], ["log"],
    ];
    for (const command of helpCommands) {
      const help = cli([...command, "--help"]);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("Usage: agentctl");
    }

    const timeout = cli(["wait", "--for", "ready", "--timeout", "0", "--json"]);
    expect(timeout.status).toBe(3);
    expect(JSON.parse(timeout.stdout)).toEqual({ events: [], cursor: 0 });
  });

  test("rate-limited runs are requeued and pause starts are exposed to canStart", async () => {
    cliSetup();
    cliJson(["task", "promote", "AB-1"]);
    process.env.AGENT_BOARD_FAKE_EDIT = "nothing";
    process.env.AGENT_BOARD_FAKE_STDERR = "Rate limit exceeded";
    process.env.AGENT_BOARD_FAKE_EXIT_CODE = "1";
    const started = cliJson<{ run_id: string }>(["start", "AB-1"]);
    expect((await waitForRun(started.run_id)).outcome).toBe("rate_limited");
    const tick = dispatchTick(store!);
    expect(tick.paused).toEqual([started.run_id]);
    expect(getTask(store!, "AB-1").status).toBe("next");
    expect(canStartTask(store!, "AB-1").reasons).toContainEqual({ code: "paused", until: expect.any(String) });
  });

  test("creates directory junctions and file hard links without including them as changes", async () => {
    const dataDirectory = join(tempRoot, "linked-directory");
    const sourceFile = join(tempRoot, "linked-file.json");
    mkdirSync(dataDirectory, { recursive: true });
    writeFileSync(join(dataDirectory, "source.txt"), "directory data\n", "utf8");
    writeFileSync(sourceFile, "file data\n", "utf8");
    writeProfile([{ from: dataDirectory, to: "shared", mode: "link" }, { from: sourceFile, to: "config/local.json", mode: "link" }]);
    cliSetup();
    cliJson(["task", "promote", "AB-1"]);
    process.env.AGENT_BOARD_FAKE_EDIT = "nothing";
    const started = cliJson<{ run_id: string }>(["start", "AB-1"]);
    await waitForRun(started.run_id);
    expect(ensureTaskWorktree(store!, "AB-1").dataLinkPaths).toEqual(["shared", "config/local.json"]);
    const taskPath = getTaskWorktreePath(store!, "AB-1");
    expect(lstatSync(join(taskPath, "shared")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(taskPath, "config", "local.json")).isFile()).toBe(true);
    expect(statSync(join(taskPath, "config", "local.json")).ino).toBe(statSync(sourceFile).ino);
    expect(await Bun.file(join(taskPath, "shared", "source.txt")).text()).toBe("directory data\n");
    expect(await Bun.file(join(taskPath, "config", "local.json")).text()).toBe("file data\n");
    expect((await import("../src/worktrees")).changedFiles(store!, "AB-1")).toEqual([]);
    removeTaskWorktree(store!, "AB-1");
    expect(existsSync(taskPath)).toBe(false);
    expect(await Bun.file(join(dataDirectory, "source.txt")).text()).toBe("directory data\n");
  });

  test("removes a spaced leftover worktree without following a junction", () => {
    cliSetup();
    cliJson(["task", "promote", "AB-1"]);
    const taskPath = ensureTaskWorktree(store!, "AB-1").path;
    const target = join(tempRoot, "junction-target");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "keep.txt"), "keep this file\n", "utf8");
    const junction = join(taskPath, "node_modules");
    symlinkSync(target, junction, "junction");

    removeLeftoverWorktree(taskPath);
    expect(existsSync(taskPath)).toBe(false);
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep this file\n");
    removeTaskWorktree(store!, "AB-1");
  });

  test("retries accept after resolving a merge conflict on the task branch", async () => {
    cliSetup();
    cliJson(["task", "promote", "AB-1"]);
    const started = cliJson<{ run_id: string }>(["start", "AB-1"]);
    await waitForRun(started.run_id);
    const epicPath = getEpicWorktreePath(store!, "sample", "EP-1");
    const taskPath = getTaskWorktreePath(store!, "AB-1");
    mkdirSync(join(epicPath, "src"), { recursive: true });
    writeFileSync(join(epicPath, "src", "allowed.txt"), "epic version\n", "utf8");
    run("git", ["add", "--", "src/allowed.txt"], epicPath);
    run("git", ["-c", "user.name=Agent Board Test", "-c", "user.email=agent-board-test@example.invalid", "commit", "-m", "epic change"], epicPath);

    const firstAccept = cli(["accept", "AB-1", "--json"]);
    expect(firstAccept.status).toBe(2);
    expect(JSON.parse(firstAccept.stdout).error).toContain("Merge conflict");
    expect(JSON.parse(firstAccept.stdout).error).toContain("src/allowed.txt");
    expect(getTask(store!, "AB-1").status).toBe("review");

    const merge = spawnSync("git", ["merge", "epic/EP-1"], { cwd: taskPath, windowsHide: true, encoding: "utf8" });
    expect(merge.status).not.toBe(0);
    writeFileSync(join(taskPath, "src", "allowed.txt"), "resolved after epic update\n", "utf8");
    run("git", ["add", "--", "src/allowed.txt"], taskPath);
    run("git", ["-c", "user.name=Agent Board Test", "-c", "user.email=agent-board-test@example.invalid", "commit", "-m", "resolve epic conflict"], taskPath);
    expect(await Bun.file(join(taskPath, "src", "allowed.txt")).text()).toBe("resolved after epic update\n");
    expect(run("git", ["show", "agent/AB-1:src/allowed.txt"], repo)).toBe("resolved after epic update\n");

    const accepted = cliJson<{ task: string; merged_into: string }>(["accept", "AB-1"]);
    expect(accepted.task).toBe("AB-1");
    expect(accepted.merged_into).toBe("epic/EP-1");
    expect(existsSync(getTaskWorktreePath(store!, "AB-1"))).toBe(false);
    expect(run("git", ["show", "epic/EP-1:src/allowed.txt"], repo)).toBe("resolved after epic update\n");
    expect(run("git", ["status", "--short"], epicPath)).toBe("");
    expect((await Bun.file(join(epicPath, "src", "allowed.txt")).text()).replace(/\r\n/g, "\n"))
      .toBe("resolved after epic update\n");
    expect(run("git", ["log", "--merges", "--oneline", "-1"], epicPath).trim().length).toBeGreaterThan(0);
  });

  test("kills a sleeping fake executor and moves the task to review", async () => {
    cliSetup();
    cliJson(["task", "promote", "AB-1"]);
    process.env.AGENT_BOARD_FAKE_EDIT = "nothing";
    process.env.AGENT_BOARD_FAKE_SLEEP_MS = "3000";
    const started = cliJson<{ run_id: string }>(["start", "AB-1"]);
    await waitForRunnerPid(started.run_id);
    const stopped = cli(["stop", "AB-1", "--json"]);
    if (stopped.status !== 0) throw new Error(`stop command failed with exit ${stopped.status}: ${stopped.stdout.trim()}`);
    expect(stopped.status).toBe(0);
    expect(JSON.parse(stopped.stdout).outcome).toBe("canceled");
    expect(getRun(store!, started.run_id).outcome).toBe("canceled");
    expect(getTask(store!, "AB-1").status).toBe("review");
  });

  test("supports JSON output and the documented refusal and error exit codes", () => {
    cliSetup();
    const task = cliJson<{ status: string }>(["task", "promote", "AB-1"]);
    expect(task.status).toBe("next");
    const refused = cli(["task", "promote", "AB-1", "--json"]);
    expect(refused.status).toBe(2);
    expect(JSON.parse(refused.stdout).code).toBe("refused");
    const unexpected = cli(["not-a-command", "--json"]);
    expect(unexpected.status).toBe(1);
    expect(JSON.parse(unexpected.stdout).code).toBe("error");
  });
});
