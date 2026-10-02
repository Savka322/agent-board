import { parseArgs } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { ExecutorQuestionSchema, TaskCardSchema } from "@agent-board/contracts";
import { answerQuestion, addProject, addTask, closeStore, createEpic, createQuestion, getEpic, getProject, getQuestion, getRun, getTask, IllegalTaskTransitionError, listEventsAfter, listEpics, listOpenQuestionsForProject, listRunsForTask, listTaskLog, listTasks, listTasksByEpic, openStore, setTaskPriority, transitionTask } from "@agent-board/core";
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

async function dispatch(store: BoardStore, positionals: string[], options: CliOptions): Promise<void> {
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
    const task = transitionTask(store, taskId, "escalate", "claude");
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
    if (question.target === "owner" && getTask(store, question.task).status !== "needs_owner") {
      throw new CliRefusal(`Task ${question.task} is not waiting for an owner answer`);
    }
    const answered = answerQuestion(store, questionId, answer);
    const task = question.target === "owner" ? transitionTask(store, question.task, "owner_answered", "owner") : getTask(store, question.task);
    emit({ question: answered, task }, options.json, `Answered ${questionId}; ${task.id} is ${task.status}.`);
    return;
  }
  if (command === "status") {
    if (options.epic) {
      const epic = getEpic(store, options.epic);
      const result = { epic, tasks: listTasksByEpic(store, epic.id), open_questions: listOpenQuestionsForProject(store, epic.project) };
      emit(result, options.json, `${epic.id}: ${result.tasks.length} task(s), ${result.open_questions.length} open question(s).`);
    } else {
      const result = { epics: listEpics(store), tasks: listTasks(store) };
      emit(result, options.json, `${result.epics.length} epic(s), ${result.tasks.length} task(s).`);
    }
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
  let options: CliOptions = { json: false, follow: false, raw: false };
  try {
    const parsed = parseCli(args);
    options = parsed.options;
    if (parsed.positionals[0] === "--help" || parsed.positionals[0] === "help") {
      emit({ usage: "agentctl <project|epic|task|start|resume|stop|review|accept|reject|ask|answer|status|log> ..." }, options.json,
        "Usage: agentctl <project|epic|task|start|resume|stop|review|accept|reject|ask|answer|status|log> ...");
      return 0;
    }
    if (parsed.positionals[0] === "_run") {
      await runInternal(required(parsed.positionals[1], "run id"));
      return 0;
    }
    const store = openStore();
    try {
      await dispatch(store, parsed.positionals, options);
    } finally {
      closeStore(store);
    }
    return 0;
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
