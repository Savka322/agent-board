import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ExecutorReportSchema, executorReportJsonSchema, type ExecutorReport, type ProjectProfile } from "@agent-board/contracts";
import { normalizeCodexLine } from "./codex-normalizer";
import { buildPrompt, buildResumePrompt } from "./prompts";
import {
  appendEvents,
  closeStore,
  createQuestion,
  createRun,
  finishRun,
  getEpic,
  getProject,
  getRun,
  getTask,
  listAnsweredDecisionsForTask,
  listRunsForTask,
  openStore,
  setRunPid,
  setRunSessionId,
  transitionTask,
  writeTaskLog,
} from "./store";
import { ensureTaskWorktree, getTaskWorktreePath } from "./worktrees";

export interface StartResult {
  run_id: string;
  task: string;
  round: number;
  pid: number | undefined;
}

interface RunFiles {
  directory: string;
  prompt: string;
  schema: string;
  report: string;
  raw: string;
  stderr: string;
  note: string;
}

function runFiles(home: string, taskId: string, round: number): RunFiles {
  const directory = join(home, "runs", taskId, String(round));
  return {
    directory,
    prompt: join(directory, "prompt.md"),
    schema: join(directory, "report.schema.json"),
    report: join(directory, "report.json"),
    raw: join(directory, "events.jsonl"),
    stderr: join(directory, "stderr.log"),
    note: join(directory, "note.md"),
  };
}

function writePromptAndSchema(files: RunFiles, prompt: string): void {
  mkdirSync(files.directory, { recursive: true });
  writeFileSync(files.prompt, prompt, "utf8");
  writeFileSync(files.schema, `${JSON.stringify(executorReportJsonSchema(), null, 2)}\n`, "utf8");
}

function spawnDetachedRunner(runId: string): StartResult["pid"] {
  const cliEntrypoint = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/cli/src/index.ts");
  const child = spawn(process.execPath, [cliEntrypoint, "_run", runId], {
    cwd: process.cwd(),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  return child.pid;
}

export function startTask(store: ReturnType<typeof openStore>, taskId: string): StartResult {
  const currentTask = getTask(store, taskId);
  const epic = getEpic(store, currentTask.epic);
  const profile = getProject(store, epic.project).profile;
  const task = transitionTask(store, taskId, "start", "claude");
  let files: RunFiles;
  let prompt: string;
  try {
    ensureTaskWorktree(store, taskId);
    files = runFiles(store.home, taskId, task.round);
    if (existsSync(files.directory)) throw new Error(`Run directory already exists for ${taskId} round ${task.round}`);
    prompt = buildPrompt({ profile, card: task.card, decisions: listAnsweredDecisionsForTask(store, taskId) });
  } catch (error) {
    transitionTask(store, taskId, "run_finished", "runner");
    throw error;
  }
  const run = createRun(store, { task: taskId, round: task.round, executor: profile.executor.model, reportPath: files.report, rawPath: files.raw });
  try {
    writePromptAndSchema(files, prompt);
    const pid = spawnDetachedRunner(run.id);
    return { run_id: run.id, task: taskId, round: run.round, pid };
  } catch (error) {
    finishRun(store, run.id, { outcome: "failed", exitCode: 1 });
    transitionTask(store, taskId, "run_finished", "runner");
    throw error;
  }
}

export function resumeTask(store: ReturnType<typeof openStore>, taskId: string, notePath: string): StartResult {
  const note = readFileSync(notePath, "utf8");
  const task = getTask(store, taskId);
  const priorRuns = listRunsForTask(store, taskId);
  const prior = priorRuns.at(-1);
  if (!prior?.sessionId) throw new Error(`Task ${taskId} has no previous Codex session to resume`);
  const epic = getEpic(store, task.epic);
  const profile = getProject(store, epic.project).profile;
  const runningTask = transitionTask(store, taskId, "resume", "claude", 5, notePath);
  let files: RunFiles;
  let prompt: string;
  try {
    ensureTaskWorktree(store, taskId);
    files = runFiles(store.home, taskId, runningTask.round);
    if (existsSync(files.directory)) throw new Error(`Run directory already exists for ${taskId} round ${runningTask.round}`);
    prompt = buildResumePrompt(note, listAnsweredDecisionsForTask(store, taskId));
  } catch (error) {
    transitionTask(store, taskId, "run_finished", "runner");
    throw error;
  }
  const run = createRun(store, { task: taskId, round: runningTask.round, executor: profile.executor.model, reportPath: files.report, rawPath: files.raw });
  try {
    writePromptAndSchema(files, prompt);
    writeFileSync(files.note, note, "utf8");
    const pid = spawnDetachedRunner(run.id);
    return { run_id: run.id, task: taskId, round: run.round, pid };
  } catch (error) {
    finishRun(store, run.id, { outcome: "failed", exitCode: 1 });
    transitionTask(store, taskId, "run_finished", "runner");
    throw error;
  }
}

export function stopTask(store: ReturnType<typeof openStore>, taskId: string) {
  const active = listRunsForTask(store, taskId).at(-1);
  if (!active || active.endedAt !== null || active.pid === null) throw new Error(`Task ${taskId} has no active runner process`);
  const result = spawnSync("taskkill", ["/T", "/F", "/PID", String(active.pid)], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not stop runner process ${active.pid}: ${`${result.stdout ?? ""}${result.stderr ?? result.error?.message ?? "taskkill failed"}`.trim()}`);
  }
  finishRun(store, active.id, { outcome: "canceled", exitCode: 1 });
  writeTaskLog(store, { task: taskId, actor: "claude", action: "stop" });
  transitionTask(store, taskId, "run_finished", "runner");
  return { task: taskId, run_id: active.id, outcome: "canceled" as const };
}

function parseCommandPrefix(value: string | undefined): string[] {
  if (!value?.trim()) return ["codex"];
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | "\"" | null = null;
  for (const character of value.trim()) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else token += character;
    } else if (character === "'" || character === "\"") quote = character;
    else if (/\s/.test(character)) {
      if (token.length > 0) tokens.push(token), token = "";
    } else token += character;
  }
  if (quote !== null) throw new Error("Unclosed quote in AGENT_BOARD_CODEX_CMD");
  if (token.length > 0) tokens.push(token);
  if (tokens.length === 0) throw new Error("AGENT_BOARD_CODEX_CMD must contain a command");
  return tokens;
}

function codexArguments(profile: ProjectProfile, files: RunFiles, sessionId?: string): { command: string; args: string[] } {
  const prefix = parseCommandPrefix(process.env.AGENT_BOARD_CODEX_CMD);
  const [command, ...prefixArgs] = prefix;
  const config = (key: string, value: string) => ["-c", `${key}=${value}`];
  const args = sessionId === undefined
    ? ["exec", "--json", "-s", profile.executor.sandbox, "-m", profile.executor.model,
      ...config("model_reasoning_effort", profile.executor.effort)]
    : ["exec", "resume", sessionId, "--json", "-m", profile.executor.model,
      ...config("model_reasoning_effort", profile.executor.effort),
      ...config("sandbox_mode", profile.executor.sandbox)];
  for (const item of profile.executor.extra_config) args.push(...config(...splitConfig(item)));
  args.push(...config("model_reasoning_summary", "concise"));
  args.push("--output-schema", files.schema, "-o", files.report, "-");
  return { command: command!, args: [...prefixArgs, ...args] };
}

function splitConfig(value: string): [string, string] {
  const separator = value.indexOf("=");
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function readReport(path: string): ExecutorReport | null {
  try {
    return ExecutorReportSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

async function runExecutor(store: ReturnType<typeof openStore>, runId: string): Promise<void> {
  const run = getRun(store, runId);
  const task = getTask(store, run.task);
  const epic = getEpic(store, task.epic);
  const profile = getProject(store, epic.project).profile;
  const worktree = getTaskWorktreePath(store, task.id);
  const files = runFiles(store.home, task.id, run.round);
  setRunPid(store, runId, process.pid);
  const previous = run.round > 1 ? listRunsForTask(store, task.id).find((item) => item.round === run.round - 1) : undefined;
  const codex = codexArguments(profile, files, previous?.sessionId ?? undefined);
  const child = spawn(codex.command, codex.args, { cwd: worktree, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const rawOutput = createWriteStream(files.raw, { flags: "w" });
  const stderrOutput = createWriteStream(files.stderr, { flags: "w" });
  let stderrTail = "";
  let pendingStdout = "";
  let rawLine = 0;
  let seq = 0;
  let usage: unknown | null = null;
  let rateLimitSignatureDetected = false;
  let eventBatch: Array<{ ts: string; kind: "think" | "read" | "exec" | "edit" | "test_pass" | "test_fail" | "message" | "question" | "error" | "unknown"; text: string; raw_line: number }> = [];
  let consumerError: Error | null = null;

  const flushEvents = () => {
    if (eventBatch.length === 0) return;
    appendEvents(store, runId, eventBatch);
    eventBatch = [];
  };
  const normalizeLine = (line: string) => {
    rawLine += 1;
    const normalized = normalizeCodexLine(line, {
      run_id: runId,
      seq,
      line: rawLine,
      repoRoot: worktree,
      now: () => new Date(),
      testCommands: task.card.light_tests,
    });
    if (normalized.sessionId) setRunSessionId(store, runId, normalized.sessionId);
    if (normalized.usage !== undefined) usage = normalized.usage;
    for (const event of normalized.events) {
      eventBatch.push({ ts: event.ts, kind: event.kind, text: event.text, raw_line: event.raw_line });
    }
    seq += normalized.events.length;
    if (eventBatch.length >= 100) flushEvents();
  };
  const interval = setInterval(() => {
    try { flushEvents(); } catch (error) {
      consumerError = error instanceof Error ? error : new Error(String(error));
      child.kill();
    }
  }, 250);

  child.stdout.on("data", (chunk: string) => {
    try {
      rawOutput.write(chunk);
      pendingStdout += chunk;
      const lines = pendingStdout.split(/\r?\n/);
      pendingStdout = lines.pop() ?? "";
      for (const line of lines) normalizeLine(line);
    } catch (error) {
      consumerError = error instanceof Error ? error : new Error(String(error));
      child.kill();
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderrOutput.write(chunk);
    // This deliberately requires a rate-limit phrase or a contextual 429 to avoid tool output false positives.
    if (/rate[ _-]?limit|usage limit|too many requests|\b429\b[^\n]*(too many|rate)|status(?: code)?[: ]+429/i.test(`${stderrTail}${chunk}`)) {
      rateLimitSignatureDetected = true;
    }
    stderrTail = `${stderrTail}${chunk}`.slice(-8192);
  });
  child.stdin.end(readFileSync(files.prompt));

  let exitCode = 1;
  try {
    exitCode = await new Promise<number>((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", (code) => resolvePromise(code ?? 1));
    });
    if (pendingStdout.length > 0) normalizeLine(pendingStdout);
  } catch (error) {
    consumerError = error instanceof Error ? error : new Error(String(error));
  } finally {
    clearInterval(interval);
    try { flushEvents(); } catch (error) { consumerError ??= error instanceof Error ? error : new Error(String(error)); }
    rawOutput.end();
    stderrOutput.end();
    await Promise.all([new Promise<void>((resolvePromise) => rawOutput.once("finish", resolvePromise)), new Promise<void>((resolvePromise) => stderrOutput.once("finish", resolvePromise))]);
  }

  const report = consumerError ? null : readReport(files.report);
  let outcome: "done" | "partial" | "blocked" | "failed" | "rate_limited";
  if (exitCode !== 0 || !report) {
    // This stderr signature is a best-effort Codex usage-limit heuristic.
    outcome = exitCode !== 0 && rateLimitSignatureDetected ? "rate_limited" : "failed";
  } else if (report.status === "DONE") outcome = "done";
  else if (report.status === "PARTIAL") outcome = "partial";
  else outcome = "blocked";

  finishRun(store, runId, { outcome, exitCode, usage, reportPath: files.report, rawPath: files.raw });
  try {
    if (outcome === "blocked" && report?.question) {
      createQuestion(store, {
        task: task.id,
        kind: "stop",
        target: "claude",
        decision_key: report.question.decision_key,
        text: report.question.text,
        options: report.question.options,
        recommendation: report.question.recommendation,
      });
    }
  } finally {
    transitionTask(store, task.id, "run_finished", "runner");
  }
  if (consumerError) throw consumerError;
}

/** Entry point for the hidden CLI worker process. */
export async function runInternal(runId: string): Promise<void> {
  const store = openStore();
  try {
    await runExecutor(store, runId);
  } catch (error) {
    try {
      const run = getRun(store, runId);
      if (run.endedAt === null) {
        finishRun(store, runId, { outcome: "failed", exitCode: 1, reportPath: run.reportPath, rawPath: run.rawPath });
        transitionTask(store, run.task, "run_finished", "runner");
      }
    } catch {
      // Keep the worker's original failure as its exit reason.
    }
    throw error;
  } finally {
    closeStore(store);
  }
}
