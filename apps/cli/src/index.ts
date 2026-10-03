import { parseArgs } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { BoardEventKindSchema, ExecutorQuestionSchema, TaskCardSchema, type BoardEventKind } from "@agent-board/contracts";
import { answerQuestion, addProject, addTask, canStartTask, closeStore, createEpic, createQuestion, getEpic, getProject, getQuestion, getRun, getTask, IllegalTaskTransitionError, listEventsAfter, listEpics, listQuestions, listRecentBoardEvents, listRunsForTask, listSettings, listTaskLog, listTasks, listTasksByEpic, openStore, serveDispatcher, setSetting, setTaskPriority, transitionTask, waitForBoardEvents } from "@agent-board/core";
import { AcceptanceRefusedError, acceptTask, rejectTask, reviewSummary } from "@agent-board/core";
import { resumeTask, runInternal, startTask, stopTask } from "@agent-board/core";
import { ensureEpicWorktree, epicBranchName, getEpicWorktreePath } from "@agent-board/core";
import type { BoardStore } from "@agent-board/core";

const optionDefinitions = {
  json: { type: "boolean" },
  epic: { type: "string" },
  note: { type: "string" },
  "allow-extra": { type: "string" },
  decision: { type: "string" },
  kind: { type: "string" },
  text: { type: "string" },
  option: { type: "string", multiple: true },
  recommend: { type: "string" },
  follow: { type: "boolean" },
  raw: { type: "boolean" },
  help: { type: "boolean" },
  after: { type: "string" },
  timeout: { type: "string" },
  for: { type: "string" },
  set: { type: "string", multiple: true },
  open: { type: "boolean" },
  target: { type: "string" },
  reject: { type: "boolean" },
  once: { type: "boolean" },
} as const;

interface CliOptions {
  json: boolean;
  epic?: string;
  note?: string;
  allowExtra?: string;
  decision?: string;
  kind?: string;
  text?: string;
  option?: string[];
  recommend?: string;
  follow: boolean;
  raw: boolean;
  help: boolean;
  after?: string;
  timeout?: string;
  for?: string;
  set?: string[];
  open: boolean;
  target?: string;
  reject: boolean;
  once: boolean;
}

class CliRefusal extends Error {
  constructor(message: string, readonly code = "refused") {
    super(message);
    this.name = "CliRefusal";
  }
}

function parseCli(args: string[]): { positionals: string[]; options: CliOptions } {
  const parsed = parseArgs({ args, options: optionDefinitions, allowPositionals: true, strict: true });
  return {
    positionals: parsed.positionals,
    options: {
      json: parsed.values.json ?? false,
      epic: parsed.values.epic,
      note: parsed.values.note,
      allowExtra: parsed.values["allow-extra"],
      decision: parsed.values.decision,
      kind: parsed.values.kind,
      text: parsed.values.text,
      option: parsed.values.option,
      recommend: parsed.values.recommend,
      follow: parsed.values.follow ?? false,
      raw: parsed.values.raw ?? false,
      help: parsed.values.help ?? false,
      after: parsed.values.after,
      timeout: parsed.values.timeout,
      for: parsed.values.for,
      set: parsed.values.set,
      open: parsed.values.open ?? false,
      target: parsed.values.target,
      reject: parsed.values.reject ?? false,
      once: parsed.values.once ?? false,
    },
  };
}

function emit(value: unknown, json: boolean, human?: string): void {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else process.stdout.write(`${human ?? JSON.stringify(value, null, 2)}\n`);
}

function required(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) throw new TypeError(`Missing ${label}`);
  return value;
}

function humanTask(task: ReturnType<typeof getTask>): string {
  return `${task.id} [${task.status}] ${task.title} (priority ${task.prio}, round ${task.round})`;
}

const allCommandUsage = [
  "Usage: agentctl project add|show <name>",
  "Usage: agentctl epic new <project> <id> <title> | epic status <id>",
  "Usage: agentctl task add <epic> <card> | task show|promote|cancel <id> | task prio <id> <number>",
  "Usage: agentctl start <task-id>",
  "Usage: agentctl resume <task-id> --note <file>",
  "Usage: agentctl stop|review|accept|reject <task-id> [--allow-extra <reason>]",
  "Usage: agentctl ask <task-id> --kind stop|assume --decision <key> --text <text> --recommend <text> [--option <text>...]",
  "Usage: agentctl answer <question-id> <text> [--reject]",
  "Usage: agentctl questions [--open] [--target owner|claude] [--json]",
  "Usage: agentctl status [--epic <id>] [--json]",
  "Usage: agentctl wait --for <kind,...> [--after <seq>] [--timeout <seconds>] [--json]",
  "Usage: agentctl serve [--once]",
  "Usage: agentctl settings [--set key=value]...",
  "Usage: agentctl log <task-id> [--follow] [--raw] [--json]",
].filter(Boolean).join("\n");

function helpFor(positionals: string[]): string {
  if (positionals.length === 0 || positionals[0] === "help") return allCommandUsage;
  const usage = allCommandUsage.split("\n");
  const command = positionals[0];
  const subcommand = positionals[1];
  const matching = usage.filter((line) => line.startsWith(`Usage: agentctl ${command} `));
  if (matching.length === 0) return allCommandUsage;
  if (subcommand) {
    const specific = matching.find((line) => line.includes(`${command} ${subcommand} `));
    if (specific) return specific;
  }
  return matching.join("\n");
}

function compactStatus(store: BoardStore, tasks: ReturnType<typeof listTasks>) {
  const staleEvents = listRecentBoardEvents(store, "stale", 10_000);
  const failedEvents = listRecentBoardEvents(store, "failed", 10_000);
  return tasks.map((task) => {
    const labels: string[] = [];
    if (task.status === "next") {
      const availability = canStartTask(store, task.id);
      for (const reason of availability.reasons) {
        if ("ids" in reason) labels.push(`${reason.code}:${reason.ids.join(",")}`);
        else if (reason.code === "paused") labels.push(`paused:${reason.until}`);
        else labels.push(reason.code);
      }
    } else if (task.status === "running") {
      const run = listRunsForTask(store, task.id).at(-1);
      if (run) {
        const latestRunEvent = listEventsAfter(store, run.id, -1, 100_000).at(-1);
        const stale = staleEvents.find((event) => event.run === run.id);
        const staleSeq = typeof stale?.payload === "object" && stale.payload !== null
          ? (stale.payload as { last_event_seq?: unknown }).last_event_seq
          : undefined;
        if (stale && typeof staleSeq === "number" && staleSeq >= (latestRunEvent?.seq ?? -1)) labels.push("stale");
        if (failedEvents.some((event) => event.run === run.id)) labels.push("failed");
      }
    }
    return {
      id: task.id,
      epic: task.epic,
      title: task.title,
      status: task.status,
      prio: task.prio,
      round: task.round,
      labels,
    };
  });
}

function humanStatus(tasks: ReturnType<typeof compactStatus>): string {
  const groups = new Map<string, typeof tasks>();
  for (const task of tasks) groups.set(task.status, [...(groups.get(task.status) ?? []), task]);
  const statusOrder = ["running", "next", "needs_owner", "review", "todo", "done", "canceled"];
  return statusOrder.filter((status) => groups.has(status)).map((status) => {
    const rows = groups.get(status)!;
    return [`${status} (${rows.length})`, "ID       PRIO  ROUND  TITLE", ...rows.map((task) =>
      `${task.id.padEnd(8)} ${String(task.prio).padStart(4)}  ${String(task.round).padStart(5)}  ${task.title}${task.labels.length ? ` [${task.labels.join(", ")}]` : ""}`,
    )].join("\n");
  }).join("\n\n") || "No tasks.";
}

async function followLog(store: BoardStore, taskId: string, json: boolean, raw: boolean): Promise<void> {
  let run = listRunsForTask(store, taskId).at(-1);
  if (!run) throw new CliRefusal(`Task ${taskId} has no runs`);
  let cursor = -1;
  let rawOffset = 0;
  while (true) {
    const events = listEventsAfter(store, run.id, cursor, 1000);
    for (const event of events) {
      cursor = event.seq;
      if (raw) continue;
      if (json) process.stdout.write(`${JSON.stringify(event)}\n`);
      else process.stdout.write(`[${event.kind}] ${event.text}\n`);
    }
    if (raw && run.rawPath && existsSync(run.rawPath)) {
      const contents = readFileSync(run.rawPath);
      if (contents.length > rawOffset) process.stdout.write(contents.subarray(rawOffset).toString("utf8"));
      rawOffset = contents.length;
    }
    run = getRun(store, run.id);
    if (run.endedAt !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (json && !raw) process.stdout.write(`${JSON.stringify({ run_id: run.id, finished: true })}\n`);
}

async function dispatch(store: BoardStore, positionals: string[], options: CliOptions): Promise<number | void> {
  const [command, subcommand, ...rest] = positionals;
  if (!command) throw new TypeError("Missing command. Run `bun run agentctl --help` for usage.");

  if (command === "_run") {
    if (options.json) throw new TypeError("The hidden _run command does not support --json");
    await runInternal(required(subcommand, "run id"));
    return;
  }

  if (command === "project") {
    const name = required(subcommand, "project name");
    if (name === "add") {
      const projectName = required(rest[0], "project name");
      const project = addProject(store, projectName);
      emit(project, options.json, `Added project ${project.name}. Profile: ${project.profile_path}`);
      return;
    }
    if (name === "show") {
      const project = getProject(store, required(rest[0], "project name"));
      emit(project, options.json, `${project.name}: ${project.profile.repo} (base ${project.profile.base_branch})`);
      return;
    }
    throw new TypeError("Usage: agentctl project add|show <name>");
  }

  if (command === "epic") {
    const action = required(subcommand, "epic action");
    if (action === "new") {
      const [projectName, epicId, ...titleParts] = rest;
      const project = getProject(store, required(projectName, "project name"));
      const id = required(epicId, "epic id");
      const title = required(titleParts.join(" "), "epic title");
      const branch = epicBranchName(project.profile, id);
      const epic = createEpic(store, { id, project: project.name, title, branch });
      ensureEpicWorktree(store, id);
      emit(epic, options.json, `Created epic ${id} on ${branch}.`);
      return;
    }
    if (action === "status") {
      const epic = getEpic(store, required(rest[0], "epic id"));
      const tasks = listTasksByEpic(store, epic.id);
      const worktree = getEpicWorktreePath(store, epic.project, epic.id);
      const result = { ...epic, worktree, tasks };
      emit(result, options.json, `${epic.id} [${epic.status}] ${epic.title}: ${tasks.length} task(s)`);
      return;
    }
    throw new TypeError("Usage: agentctl epic new|status ...");
  }

  if (command === "task") {
    const action = required(subcommand, "task action");
    if (action === "add") {
      const epicId = required(rest[0], "epic id");
      const cardPath = required(rest[1], "card path");
      const task = addTask(store, epicId, cardPath);
      emit(task, options.json, `Added ${humanTask(task)}.`);
      return;
    }
    if (action === "show") {
      const task = getTask(store, required(rest[0], "task id"));
      emit(task, options.json, humanTask(task));
      return;
    }
    if (action === "promote") {
      const task = transitionTask(store, required(rest[0], "task id"), "promote", "claude");
      emit(task, options.json, `Promoted ${task.id} to ${task.status}.`);
      return;
    }
    if (action === "prio") {
      const taskId = required(rest[0], "task id");
      const priority = Number(required(rest[1], "priority"));
      if (!Number.isInteger(priority)) throw new TypeError("Priority must be an integer");
      const task = setTaskPriority(store, taskId, priority);
      emit(task, options.json, `Set ${task.id} priority to ${task.prio}.`);
      return;
    }
    if (action === "cancel") {
      const task = transitionTask(store, required(rest[0], "task id"), "cancel", "claude");
      emit(task, options.json, `Canceled ${task.id}.`);
      return;
    }
    throw new TypeError("Usage: agentctl task add|show|promote|prio|cancel ...");
  }

  if (command === "start") {
    const result = startTask(store, required(subcommand, "task id"));
    emit(result, options.json, `Started ${result.task}; run ${result.run_id} is running in the background.`);
    return;
  }
  if (command === "resume") {
    const result = resumeTask(store, required(subcommand, "task id"), required(options.note, "--note <file>"));
    emit(result, options.json, `Resumed ${result.task}; run ${result.run_id} is running in the background.`);
    return;
  }
  if (command === "stop") {
    const result = stopTask(store, required(subcommand, "task id"));
    emit(result, options.json, `Stopped ${result.task}; it is ready for review.`);
    return;
  }
  if (command === "review") {
    const summary = reviewSummary(store, required(subcommand, "task id"));
    emit(summary, options.json, `${summary.task}: ${summary.changed_files.length} changed file(s), ${summary.new_files.length} new file(s).`);
    return;
  }
  if (command === "accept") {
    const result = acceptTask(store, required(subcommand, "task id"), { allowExtraReason: options.allowExtra });
    emit(result, options.json, `Accepted ${result.task} and merged commit ${result.commit.slice(0, 12)} into ${result.merged_into}.`);
    return;
  }
  if (command === "reject") {
    const task = rejectTask(store, required(subcommand, "task id"));
    emit(task, options.json, `Rejected ${task.id}; its worktree was kept.`);
    return;
  }
  if (command === "ask") {
    const taskId = required(subcommand, "task id");
    const decisionKey = required(options.decision, "--decision <key>");
    const kind = required(options.kind, "--kind stop|assume");
    if (kind !== "stop" && kind !== "assume") throw new TypeError("--kind must be stop or assume");
    const text = required(options.text, "--text <text>");
    const recommendation = required(options.recommend, "--recommend <text>");
    TaskCardSchema.shape.decisions.parse([decisionKey]);
    ExecutorQuestionSchema.parse({ decision_key: decisionKey, text, options: options.option ?? [], recommendation });
    if (getTask(store, taskId).status !== "review") throw new CliRefusal(`Task ${taskId} must be in review before asking the owner`);
    const task = kind === "stop" ? transitionTask(store, taskId, "escalate", "claude") : getTask(store, taskId);
    const question = createQuestion(store, {
      task: taskId,
      kind,
      target: "owner",
      decision_key: decisionKey,
      text,
      options: options.option ?? [],
      recommendation,
    });
    emit({ question, task }, options.json, `Asked the owner ${question.id}; ${task.id} is waiting for an answer.`);
    return;
  }
  if (command === "answer") {
    const questionId = required(subcommand, "question id");
    const answer = required(rest.join(" "), "answer text");
    const question = getQuestion(store, questionId);
    if (question.target === "owner" && question.kind === "stop" && getTask(store, question.task).status !== "needs_owner") {
      throw new CliRefusal(`Task ${question.task} is not waiting for an owner answer`);
    }
    const answered = answerQuestion(store, questionId, answer, options.reject);
    const task = question.target === "owner" && question.kind === "stop"
      ? transitionTask(store, question.task, "owner_answered", "owner")
      : getTask(store, question.task);
    emit({ question: answered, task }, options.json, `Answered ${questionId}; ${task.id} is ${task.status}.`);
    return;
  }
  if (command === "questions") {
    const target = options.target === undefined ? undefined : options.target;
    if (target !== undefined && target !== "owner" && target !== "claude") throw new TypeError("--target must be owner or claude");
    const questions = listQuestions(store, { open: options.open, target });
    emit(questions, options.json, questions.length ? questions.map((question) => `${question.id} [${question.status}] ${question.target}/${question.kind}: ${question.text}`).join("\n") : "No questions.");
    return;
  }
  if (command === "status") {
    if (options.epic) {
      const epic = getEpic(store, options.epic);
      const tasks = compactStatus(store, listTasksByEpic(store, epic.id));
      const result = { epic: { id: epic.id, title: epic.title, status: epic.status }, tasks };
      emit(result, options.json, `${epic.id}: ${tasks.length} task(s)\n${humanStatus(tasks)}`);
    } else {
      const tasks = compactStatus(store, listTasks(store));
      const result = { epics: listEpics(store).map(({ id, title, status }) => ({ id, title, status })), tasks };
      emit(result, options.json, `${result.epics.length} epic(s), ${tasks.length} task(s)\n${humanStatus(tasks)}`);
    }
    return;
  }
  if (command === "wait") {
    const kinds = required(options.for, "--for <kind,...>").split(",").map((kind) => kind.trim());
    const parsedKinds: BoardEventKind[] = kinds.map((kind) => {
      const parsed = BoardEventKindSchema.safeParse(kind);
      if (!parsed.success) throw new TypeError(`Unknown board event kind: ${kind}`);
      return parsed.data;
    });
    const after = options.after === undefined ? undefined : Number(options.after);
    if (after !== undefined && (!Number.isInteger(after) || after < 0)) throw new TypeError("--after must be a non-negative integer");
    const timeoutSeconds = options.timeout === undefined ? undefined : Number(options.timeout);
    if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0)) throw new TypeError("--timeout must be a non-negative number of seconds");
    const result = await waitForBoardEvents(store, { kinds: parsedKinds, after, timeoutSeconds });
    emit({ events: result.events, cursor: result.cursor }, options.json,
      result.timed_out ? `Timed out; cursor ${result.cursor}.` : `${result.events.map((event) => `[${event.seq}] ${event.kind} ${event.task ?? ""} ${JSON.stringify(event.payload)}`).join("\n")}\nCursor ${result.cursor}.`);
    if (result.timed_out) return 3;
    return;
  }
  if (command === "serve") {
    await serveDispatcher(store, { once: options.once });
    emit({ running: !options.once }, options.json, options.once ? "Dispatcher tick completed." : "Dispatcher stopped.");
    return;
  }
  if (command === "settings") {
    for (const assignment of options.set ?? []) {
      const separator = assignment.indexOf("=");
      if (separator < 1) throw new TypeError("Settings use --set key=value");
      const key = assignment.slice(0, separator);
      const rawValue = assignment.slice(separator + 1);
      if (!Object.hasOwn({ max_slots: 1, stale_minutes: 1, tick_seconds: 1, paused_until: 1, pause_backoff_minutes: 1 }, key)) {
        throw new TypeError(`Unknown setting: ${key}`);
      }
      let value: unknown;
      try { value = JSON.parse(rawValue) as unknown; } catch { value = rawValue; }
      setSetting(store, key as Parameters<typeof setSetting>[1], value as never);
    }
    const settings = listSettings(store);
    emit(settings, options.json, settings.map(({ key, value }) => `${key}=${JSON.stringify(value)}`).join("\n"));
    return;
  }
  if (command === "log") {
    const taskId = required(subcommand, "task id");
    if (options.follow) await followLog(store, taskId, options.json, options.raw);
    else {
      const run = listRunsForTask(store, taskId).at(-1);
      if (!run) throw new CliRefusal(`Task ${taskId} has no runs`);
      if (options.raw) {
        const raw = run.rawPath && existsSync(run.rawPath) ? readFileSync(run.rawPath, "utf8") : "";
        emit({ run_id: run.id, raw }, options.json, raw);
      } else {
        const events = listEventsAfter(store, run.id, -1, 100_000);
        emit({ run_id: run.id, events, task_log: listTaskLog(store, taskId) }, options.json, events.map((event) => `[${event.kind}] ${event.text}`).join("\n"));
      }
    }
    return;
  }

  throw new TypeError(`Unknown command: ${command}`);
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  let options: CliOptions = { json: false, follow: false, raw: false, help: false, open: false, reject: false, once: false };
  try {
    const parsed = parseCli(args);
    options = parsed.options;
    if (options.help || parsed.positionals[0] === "help") {
      const usage = helpFor(parsed.positionals);
      emit({ usage }, options.json, usage);
      return 0;
    }
    if (parsed.positionals[0] === "_run") {
      await runInternal(required(parsed.positionals[1], "run id"));
      return 0;
    }
    const store = openStore();
    try {
      const result = await dispatch(store, parsed.positionals, options);
      return typeof result === "number" ? result : 0;
    } finally {
      closeStore(store);
    }
  } catch (error) {
    const refused = error instanceof CliRefusal || error instanceof AcceptanceRefusedError || error instanceof IllegalTaskTransitionError;
    const code = refused ? 2 : 1;
    const transitionDetails = error instanceof IllegalTaskTransitionError ? error.transition.error : undefined;
    const message = error instanceof Error ? error.message : String(error);
    const payload = {
      error: message,
      code: refused ? "refused" : "error",
      ...(transitionDetails ? { details: transitionDetails } : {}),
    };
    if (options.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
    else process.stderr.write(`${refused ? "Refused" : "Error"}: ${message}${transitionDetails?.reasons ? `; reasons: ${JSON.stringify(transitionDetails.reasons)}` : ""}\n`);
    return code;
  }
}

if (import.meta.main) process.exitCode = await main();
