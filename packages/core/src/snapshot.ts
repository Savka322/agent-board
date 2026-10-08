import { ExecutorReportSchema } from "@agent-board/contracts";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { reviewSummary } from "./review";
import {
  canStartTask,
  getBoardEventCursor,
  getSetting,
  getTask,
  hasApproval,
  listEventsAfter,
  listEpics,
  listOpenQuestionsForTask,
  listRecentBoardEvents,
  listRunsForTask,
  listTaskLog,
  listTasks,
  listQuestions,
  type BoardStore,
} from "./store";

function canReadBoardFile(store: BoardStore, path: string | null): string | null {
  if (!path) return null;
  try {
    const home = realpathSync(store.home);
    const candidate = realpathSync(resolve(store.home, path));
    const fromHome = relative(home, candidate);
    if (fromHome === ".." || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) return null;
    if (!statSync(candidate).isFile()) return null;
    return candidate;
  } catch {
    return null;
  }
}

function reportForPath(store: BoardStore, path: string | null) {
  const confinedPath = canReadBoardFile(store, path);
  if (!confinedPath || !existsSync(confinedPath)) return null;
  try {
    return ExecutorReportSchema.parse(JSON.parse(readFileSync(confinedPath, "utf8")) as unknown);
  } catch {
    return null;
  }
}

function labelsForTask(store: BoardStore, task: ReturnType<typeof listTasks>[number], staleEvents: ReturnType<typeof listRecentBoardEvents>, failedRuns: Set<string>): string[] {
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
      const latestEvent = listEventsAfter(store, run.id, -1, 100_000).at(-1);
      const stale = staleEvents.find((event) => event.run === run.id);
      const staleSeq = typeof stale?.payload === "object" && stale.payload !== null
        ? (stale.payload as { last_event_seq?: unknown }).last_event_seq
        : undefined;
      if (stale && typeof staleSeq === "number" && staleSeq >= (latestEvent?.seq ?? -1)) labels.push("stale");
      if (failedRuns.has(run.id)) labels.push("failed");
    }
  }
  return labels;
}

export interface BoardSnapshotOptions {
  epic?: string;
}

/** Build a compact, read-only board view using the store's canonical queries and rules. */
export function boardSnapshot(store: BoardStore, options: BoardSnapshotOptions = {}) {
  const allEpics = listEpics(store);
  const epics = options.epic ? allEpics.filter((item) => item.id === options.epic) : allEpics;
  const epicById = new Map(allEpics.map((item) => [item.id, item]));
  const allTasks = listTasks(store);
  const tasks = options.epic ? allTasks.filter((item) => item.epic === options.epic) : allTasks;
  const staleEvents = listRecentBoardEvents(store, "stale", 10_000);
  const failedEvents = listRecentBoardEvents(store, "failed", 10_000);
  const failedRuns = new Set(failedEvents.flatMap((event) => event.run ? [event.run] : []));
  const compactTasks = tasks.map((task) => {
    const labels = labelsForTask(store, task, staleEvents, failedRuns);
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
  const ownerQuestions = listQuestions(store, { open: true, target: "owner" });
  const questions = ownerQuestions.flatMap((question) => {
    const questionTask = getTask(store, question.task);
    const questionEpic = questionTask.epic;
    const questionProject = epicById.get(questionEpic)?.project;
    const heldTaskIds = tasks.filter((task) => epicById.get(task.epic)?.project === questionProject
      && question.decision_key !== null
      && task.decisions.includes(question.decision_key)).map((task) => task.id);
    if (options.epic && questionEpic !== options.epic && heldTaskIds.length === 0) return [];
    return [{
      id: question.id,
      task: question.task,
      task_title: questionTask.title,
      decision_key: question.decision_key,
      kind: question.kind,
      text: question.text,
      options: question.options,
      recommendation: question.recommendation,
      created_at: question.createdAt,
      held_task_ids: heldTaskIds,
    }];
  });

  return {
    epics: epics.map((item) => {
      const epicTasks = allTasks.filter((task) => task.epic === item.id);
      return {
        id: item.id,
        project: item.project,
        title: item.title,
        status: item.status,
        merge_approved: hasApproval(store, item.id, "merge"),
        ready_for_merge: epicTasks.length > 0 && epicTasks.every((task) => task.status === "done" || task.status === "canceled"),
        progress: { done: epicTasks.filter((task) => task.status === "done").length, total: epicTasks.length },
      };
    }),
    selected_epic: options.epic ?? null,
    tasks: compactTasks,
    questions,
    settings: {
      max_slots: getSetting(store, "max_slots"),
      paused_until: getSetting(store, "paused_until"),
    },
    running_count: allTasks.filter((task) => task.status === "running").length,
    cursor: getBoardEventCursor(store),
  };
}

/** Return all data needed to inspect one task without changing board state. */
export function taskDetail(store: BoardStore, id: string) {
  const task = getTask(store, id);
  const runs = listRunsForTask(store, id);
  const lastRun = runs.at(-1);
  let summary: ReturnType<typeof reviewSummary> | null = null;
  let reviewError: string | null = null;
  if (task.status === "review") {
    try {
      summary = reviewSummary(store, id);
    } catch {
      reviewError = "Review summary is unavailable because the worktree is missing or unreadable.";
    }
  }

  return {
    card: {
      ...task.card,
      status: task.status,
      prio: task.prio,
      round: task.round,
      updated_at: task.updatedAt,
    },
    runs: runs.map((run) => ({
      id: run.id,
      round: run.round,
      outcome: run.outcome,
      started_at: run.startedAt,
      ended_at: run.endedAt,
      usage: run.usage,
      raw_available: canReadBoardFile(store, run.rawPath) !== null,
    })),
    task_log: listTaskLog(store, id),
    questions: listOpenQuestionsForTask(store, id),
    last_report: reportForPath(store, lastRun?.reportPath ?? null),
    review_summary: summary,
    review_error: reviewError,
  };
}
