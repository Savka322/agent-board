import { Database } from "bun:sqlite";
import {
  EventKindSchema,
  ExecutorQuestionSchema,
  GateStatusSchema,
  NormalizedEventSchema,
  ProjectProfileSchema,
  QuestionKindSchema,
  QuestionTargetSchema,
  RunOutcomeSchema,
  TaskCardSchema,
  TaskStatusSchema,
  type ExecutorQuestion,
  type GateStatus,
  type NormalizedEvent,
  type ProjectProfile,
  type QuestionKind,
  type QuestionTarget,
  type RunOutcome,
  type TaskCard,
  type TaskStatus,
} from "@agent-board/contracts";
import { and, asc, eq, max, sql } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseCardFile } from "./cards";
import { resolveHome } from "./home";
import { applyTransition, canStart, type Actor, type CanStartContext, type TaskAction, type TransitionResult } from "./state-machine";
import {
  approvals,
  decisions,
  epics,
  events,
  gateRuns,
  gateStats,
  projects,
  questions,
  runs,
  schema,
  taskDecisions,
  taskDeps,
  tasks,
} from "./schema";

const stringArraySchema = z.array(z.string());
const decisionKeysSchema = TaskCardSchema.shape.decisions;
const jsonEncode = (value: unknown): string => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Value cannot be represented as JSON");
  return encoded;
};
const now = (): string => new Date().toISOString();

export interface BoardStore {
  home: string;
  sqlite: Database;
  db: BunSQLiteDatabase<typeof schema>;
}

export class StoreNotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = "StoreNotFoundError";
  }
}

export class IllegalTaskTransitionError extends Error {
  constructor(readonly transition: Exclude<TransitionResult, { ok: true }>) {
    super(`Illegal task transition: ${transition.error.code}`);
    this.name = "IllegalTaskTransitionError";
  }
}

/** Open the local SQLite store and apply packaged Drizzle migrations. */
export function openStore(home: string = resolveHome()): BoardStore {
  mkdirSync(home, { recursive: true });
  for (const directory of ["projects", "runs", "worktrees"]) {
    mkdirSync(join(home, directory), { recursive: true });
  }
  const sqlite = new Database(join(home, "board.db"));
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA busy_timeout = 5000");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
  migrate(db, { migrationsFolder });
  return { home, sqlite, db };
}

export function closeStore(store: BoardStore): void {
  store.sqlite.close(true);
}

function parseProfileFile(path: string): ProjectProfile {
  const parsed: unknown = Bun.TOML.parse(readFileSync(path, "utf8"));
  return ProjectProfileSchema.parse(parsed);
}

export interface StoredProject {
  name: string;
  profile_path: string;
  created_at: string;
  profile: ProjectProfile;
}

export function addProject(store: BoardStore, name: string): StoredProject {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new TypeError("Invalid project name");
  const profilePath = join(store.home, "projects", `${name}.toml`);
  const profile = parseProfileFile(profilePath);
  if (profile.name !== name) throw new TypeError(`Project profile name must match ${name}`);
  const createdAt = now();
  store.db.insert(projects).values({ name, profilePath, createdAt }).run();
  return { name, profile_path: profilePath, created_at: createdAt, profile };
}

export function getProject(store: BoardStore, name: string): StoredProject {
  const row = store.db.select().from(projects).where(eq(projects.name, name)).get();
  if (!row) throw new StoreNotFoundError("Project", name);
  return {
    name: row.name,
    profile_path: row.profilePath,
    created_at: row.createdAt,
    profile: parseProfileFile(row.profilePath),
  };
}

export interface CreateEpicInput {
  id: string;
  project: string;
  title: string;
  branch: string;
  status?: string;
}

export function createEpic(store: BoardStore, input: CreateEpicInput) {
  const row = {
    id: input.id,
    project: input.project,
    title: input.title,
    branch: input.branch,
    status: input.status ?? "open",
    mergeApprovedAt: null,
    createdAt: now(),
  };
  store.db.insert(epics).values(row).run();
  return row;
}

export function getEpic(store: BoardStore, id: string) {
  const row = store.db.select().from(epics).where(eq(epics.id, id)).get();
  if (!row) throw new StoreNotFoundError("Epic", id);
  return row;
}

export function listEpics(store: BoardStore, project?: string) {
  const query = store.db.select().from(epics);
  return (project ? query.where(eq(epics.project, project)) : query).orderBy(asc(epics.createdAt)).all();
}

export interface StoredTask {
  id: string;
  epic: string;
  title: string;
  status: TaskStatus;
  prio: number;
  cardPath: string;
  allowedFiles: TaskCard["allowed_files"];
  gates: TaskCard["gates"];
  lightTests: TaskCard["light_tests"];
  round: number;
  createdAt: string;
  updatedAt: string;
  deps: string[];
  decisions: string[];
  card: TaskCard;
}

function parseJson<T>(value: string, validator: z.ZodType<T>, label: string): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new TypeError(`Invalid stored JSON for ${label}`);
  }
  return validator.parse(decoded);
}

function taskFromRow(store: BoardStore, row: typeof tasks.$inferSelect): StoredTask {
  const deps = store.db.select({ id: taskDeps.dependsOn }).from(taskDeps).where(eq(taskDeps.task, row.id)).orderBy(asc(taskDeps.dependsOn)).all().map((item) => item.id);
  const linkedDecisions = store.db.select({ key: taskDecisions.decisionKey }).from(taskDecisions).where(eq(taskDecisions.task, row.id)).orderBy(asc(taskDecisions.decisionKey)).all().map((item) => item.key);
  const sourceCard = parseCardFile(readFileSync(row.cardPath, "utf8"));
  const card = TaskCardSchema.parse({
    ...sourceCard,
    id: row.id,
    title: row.title,
    epic: row.epic,
    allowed_files: parseJson(row.allowedFiles, TaskCardSchema.shape.allowed_files, "tasks.allowed_files"),
    deps: parseJson(jsonEncode(deps), TaskCardSchema.shape.deps, "task_deps"),
    decisions: parseJson(jsonEncode(linkedDecisions), decisionKeysSchema, "task_decisions"),
    gates: parseJson(row.gates, TaskCardSchema.shape.gates, "tasks.gates"),
    light_tests: parseJson(row.lightTests, TaskCardSchema.shape.light_tests, "tasks.light_tests"),
  });
  return {
    ...row,
    status: TaskStatusSchema.parse(row.status),
    allowedFiles: card.allowed_files,
    gates: card.gates,
    lightTests: card.light_tests,
    deps,
    decisions: linkedDecisions,
    card,
  };
}

export function addTask(store: BoardStore, epicId: string, cardPath: string): StoredTask {
  const card = TaskCardSchema.parse(parseCardFile(readFileSync(cardPath, "utf8")));
  if (card.epic !== epicId) throw new TypeError("Task card epic must match the requested epic");
  const epic = getEpic(store, epicId);
  const timestamp = now();
  store.db.transaction((tx) => {
    tx.insert(tasks).values({
      id: card.id,
      epic: epicId,
      title: card.title,
      status: "todo",
      prio: 0,
      cardPath,
      allowedFiles: jsonEncode(card.allowed_files),
      gates: jsonEncode(card.gates),
      lightTests: jsonEncode(card.light_tests),
      round: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
    if (card.deps.length > 0) {
      tx.insert(taskDeps).values(card.deps.map((dependsOn) => ({ task: card.id, dependsOn }))).run();
    }
    if (card.decisions.length > 0) {
      tx.insert(taskDecisions).values(card.decisions.map((decisionKey) => ({ task: card.id, decisionKey }))).run();
      for (const decisionKey of card.decisions) {
        tx.insert(decisions).values({ project: epic.project, key: decisionKey, title: decisionKey, status: "open", answer: null, answeredAt: null }).onConflictDoNothing().run();
      }
    }
  });
  return getTask(store, card.id);
}

export function getTask(store: BoardStore, id: string): StoredTask {
  const row = store.db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!row) throw new StoreNotFoundError("Task", id);
  return taskFromRow(store, row);
}

export function listTasksByEpic(store: BoardStore, epicId: string): StoredTask[] {
  return store.db.select().from(tasks).where(eq(tasks.epic, epicId)).orderBy(asc(tasks.prio), asc(tasks.createdAt)).all().map((row) => taskFromRow(store, row));
}

export function listTasksByStatus(store: BoardStore, status: TaskStatus): StoredTask[] {
  const parsedStatus = TaskStatusSchema.parse(status);
  return store.db.select().from(tasks).where(eq(tasks.status, parsedStatus)).orderBy(asc(tasks.prio), asc(tasks.createdAt)).all().map((row) => taskFromRow(store, row));
}

export interface CreateDecisionInput {
  project: string;
  key: string;
  title: string;
}

export function createDecision(store: BoardStore, input: CreateDecisionInput) {
  decisionKeysSchema.parse([input.key]);
  const row = { ...input, status: "open", answer: null, answeredAt: null };
  store.db.insert(decisions).values(row).run();
  return row;
}

export function answerDecision(store: BoardStore, project: string, key: string, answer: string) {
  const current = store.db.select().from(decisions).where(and(eq(decisions.project, project), eq(decisions.key, key))).get();
  if (!current) throw new StoreNotFoundError("Decision", `${project}/${key}`);
  const answeredAt = now();
  store.db.update(decisions).set({ status: "answered", answer, answeredAt }).where(and(eq(decisions.project, project), eq(decisions.key, key))).run();
  return { ...current, status: "answered", answer, answeredAt };
}

export function listOpenDecisions(store: BoardStore, project: string) {
  return store.db.select().from(decisions).where(and(eq(decisions.project, project), eq(decisions.status, "open"))).orderBy(asc(decisions.key)).all();
}

export interface CreateQuestionInput extends ExecutorQuestion {
  id?: string;
  task: string;
  kind: QuestionKind;
  target: QuestionTarget;
}

export function createQuestion(store: BoardStore, input: CreateQuestionInput) {
  const kind = QuestionKindSchema.parse(input.kind);
  const target = QuestionTargetSchema.parse(input.target);
  const questionFields = ExecutorQuestionSchema.parse({
    decision_key: input.decision_key,
    text: input.text,
    options: input.options,
    recommendation: input.recommendation,
  });
  const options = questionFields.options;
  if (input.decision_key !== null) decisionKeysSchema.parse([input.decision_key]);
  const task = getTask(store, input.task);
  const epic = getEpic(store, task.epic);
  const id = input.id ?? crypto.randomUUID();
  const createdAt = now();
  const row = {
    id,
    task: input.task,
    decisionKey: input.decision_key,
    kind,
    target,
    text: input.text,
    options: jsonEncode(options),
    recommendation: input.recommendation,
    status: "open",
    answer: null,
    answeredAt: null,
    createdAt,
  };
  store.db.transaction((tx) => {
    tx.insert(questions).values(row).run();
    if (input.decision_key !== null) {
      tx.insert(decisions).values({ project: epic.project, key: input.decision_key, title: input.decision_key, status: "open", answer: null, answeredAt: null }).onConflictDoNothing().run();
    }
  });
  return { ...row, options };
}

function questionFromRow(row: typeof questions.$inferSelect) {
  return {
    ...row,
    kind: QuestionKindSchema.parse(row.kind),
    target: QuestionTargetSchema.parse(row.target),
    ...ExecutorQuestionSchema.parse({
      decision_key: row.decisionKey,
      text: row.text,
      options: parseJson(row.options, stringArraySchema, "questions.options"),
      recommendation: row.recommendation,
    }),
  };
}

export function answerQuestion(store: BoardStore, id: string, answer: string) {
  const current = store.db.select().from(questions).where(eq(questions.id, id)).get();
  if (!current) throw new StoreNotFoundError("Question", id);
  const answeredAt = now();
  store.db.transaction((tx) => {
    tx.update(questions).set({ status: "answered", answer, answeredAt }).where(eq(questions.id, id)).run();
    if (current.decisionKey !== null) {
      const task = tx.select({ epic: tasks.epic }).from(tasks).where(eq(tasks.id, current.task)).get();
      if (task) {
        const epic = tx.select({ project: epics.project }).from(epics).where(eq(epics.id, task.epic)).get();
        if (epic) {
          tx.update(decisions).set({ status: "answered", answer, answeredAt })
            .where(and(eq(decisions.project, epic.project), eq(decisions.key, current.decisionKey))).run();
        }
      }
    }
  });
  return questionFromRow({ ...current, status: "answered", answer, answeredAt });
}

export function listOpenQuestionsForTask(store: BoardStore, taskId: string) {
  return store.db.select().from(questions).where(and(eq(questions.task, taskId), eq(questions.status, "open"))).orderBy(asc(questions.createdAt)).all().map(questionFromRow);
}

export function listOpenQuestionsForProject(store: BoardStore, project: string) {
  return store.db.select({ question: questions })
    .from(questions)
    .innerJoin(tasks, eq(questions.task, tasks.id))
    .innerJoin(epics, eq(tasks.epic, epics.id))
    .where(and(eq(epics.project, project), eq(questions.status, "open")))
    .orderBy(asc(questions.createdAt))
    .all()
    .map(({ question }) => questionFromRow(question));
}

export interface CreateRunInput {
  id?: string;
  task: string;
  round?: number;
  executor: string;
  reportPath?: string | null;
  rawPath?: string | null;
}

export function createRun(store: BoardStore, input: CreateRunInput) {
  const task = getTask(store, input.task);
  const round = input.round ?? task.round;
  if (!Number.isInteger(round) || round < 0) throw new TypeError("round must be a non-negative integer");
  const row = {
    id: input.id ?? crypto.randomUUID(),
    task: input.task,
    round,
    executor: input.executor,
    sessionId: null,
    pid: null,
    startedAt: now(),
    endedAt: null,
    exitCode: null,
    outcome: null,
    reportPath: input.reportPath ?? null,
    rawPath: input.rawPath ?? null,
    usage: null,
  };
  store.db.insert(runs).values(row).run();
  return row;
}

export function getRun(store: BoardStore, id: string) {
  const row = store.db.select().from(runs).where(eq(runs.id, id)).get();
  if (!row) throw new StoreNotFoundError("Run", id);
  return {
    ...row,
    outcome: row.outcome === null ? null : RunOutcomeSchema.parse(row.outcome),
    usage: row.usage === null ? null : JSON.parse(row.usage) as unknown,
  };
}

export function setRunSessionId(store: BoardStore, id: string, sessionId: string) {
  store.db.update(runs).set({ sessionId }).where(eq(runs.id, id)).run();
  return getRun(store, id);
}

export function setRunPid(store: BoardStore, id: string, pid: number) {
  if (!Number.isInteger(pid) || pid < 0) throw new TypeError("pid must be a non-negative integer");
  store.db.update(runs).set({ pid }).where(eq(runs.id, id)).run();
  return getRun(store, id);
}

export interface FinishRunInput {
  outcome: RunOutcome;
  exitCode: number;
  usage?: unknown | null;
  reportPath?: string | null;
  rawPath?: string | null;
}

export function finishRun(store: BoardStore, id: string, input: FinishRunInput) {
  const outcome = RunOutcomeSchema.parse(input.outcome);
  if (!Number.isInteger(input.exitCode)) throw new TypeError("exitCode must be an integer");
  const usage = input.usage === undefined || input.usage === null ? null : jsonEncode(input.usage);
  const current = store.db.select({ id: runs.id }).from(runs).where(eq(runs.id, id)).get();
  if (!current) throw new StoreNotFoundError("Run", id);
  store.db.update(runs).set({
    endedAt: now(),
    exitCode: input.exitCode,
    outcome,
    usage,
    ...(input.reportPath !== undefined ? { reportPath: input.reportPath } : {}),
    ...(input.rawPath !== undefined ? { rawPath: input.rawPath } : {}),
  }).where(eq(runs.id, id)).run();
  return getRun(store, id);
}

export type EventDraft = Omit<NormalizedEvent, "run_id" | "seq">;

/** Append events while holding a SQLite immediate write lock so concurrent processes serialize sequence allocation. */
export function appendEvents(store: BoardStore, runId: string, batch: EventDraft[]): NormalizedEvent[] {
  if (batch.length === 0) return [];
  let result: NormalizedEvent[] = [];
  store.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const current = store.db.select({ seq: max(events.seq) }).from(events).where(eq(events.runId, runId)).get();
    let nextSeq = (current?.seq ?? -1) + 1;
    result = batch.map((event) => {
      const parsed = NormalizedEventSchema.parse({
        run_id: runId,
        seq: nextSeq++,
        ts: event.ts,
        kind: EventKindSchema.parse(event.kind),
        text: event.text,
        raw_line: event.raw_line,
      });
      return parsed;
    });
    store.db.insert(events).values(result.map((event) => ({
      runId: event.run_id,
      seq: event.seq,
      ts: event.ts,
      kind: event.kind,
      text: event.text,
      rawLine: event.raw_line,
    }))).run();
    store.sqlite.exec("COMMIT");
  } catch (error) {
    try { store.sqlite.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
    throw error;
  }
  return result;
}

export function listEventsAfter(store: BoardStore, runId: string, cursor: number, limit = 100): NormalizedEvent[] {
  if (!Number.isInteger(cursor) || cursor < -1) throw new TypeError("Event cursor must be an integer >= -1");
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError("Event limit must be a positive integer");
  return store.db.select().from(events)
    .where(and(eq(events.runId, runId), sql`${events.seq} > ${cursor}`))
    .orderBy(asc(events.seq))
    .limit(limit)
    .all()
    .map((row) => NormalizedEventSchema.parse({
      run_id: row.runId,
      seq: row.seq,
      ts: row.ts,
      kind: EventKindSchema.parse(row.kind),
      text: row.text,
      raw_line: row.rawLine,
    }));
}

export interface CreateGateRunInput {
  id?: string;
  task: string;
  cmd: string;
  ram_est_bytes: number;
}

export function createGateRun(store: BoardStore, input: CreateGateRunInput) {
  if (!Number.isInteger(input.ram_est_bytes) || input.ram_est_bytes < 0) throw new TypeError("ram_est_bytes must be a non-negative integer");
  const row = {
    id: input.id ?? crypto.randomUUID(),
    task: input.task,
    cmd: input.cmd,
    status: "queued",
    ramEstBytes: input.ram_est_bytes,
    peakCommitBytes: null,
    startedAt: null,
    endedAt: null,
  };
  store.db.insert(gateRuns).values(row).run();
  return row;
}

export interface UpdateGateRunInput {
  status: GateStatus;
  peak_commit_bytes?: number | null;
  started_at?: string | null;
  ended_at?: string | null;
}

export function updateGateRun(store: BoardStore, id: string, input: UpdateGateRunInput) {
  const status = GateStatusSchema.parse(input.status);
  if (input.peak_commit_bytes !== undefined && input.peak_commit_bytes !== null
    && (!Number.isInteger(input.peak_commit_bytes) || input.peak_commit_bytes < 0)) {
    throw new TypeError("peak_commit_bytes must be a non-negative integer");
  }
  const current = store.db.select().from(gateRuns).where(eq(gateRuns.id, id)).get();
  if (!current) throw new StoreNotFoundError("Gate run", id);
  const update = {
    status,
    ...(input.peak_commit_bytes !== undefined ? { peakCommitBytes: input.peak_commit_bytes } : {}),
    ...(input.started_at !== undefined ? { startedAt: input.started_at } : {}),
    ...(input.ended_at !== undefined ? { endedAt: input.ended_at } : {}),
  };
  store.db.update(gateRuns).set(update).where(eq(gateRuns.id, id)).run();
  return { ...current, ...update };
}

export function updateGateStats(store: BoardStore, project: string, cmdHash: string, peakCommitBytes: number) {
  if (!Number.isInteger(peakCommitBytes) || peakCommitBytes < 0) throw new TypeError("peakCommitBytes must be a non-negative integer");
  store.sqlite.query(`
    INSERT INTO gate_stats (project, cmd_hash, peak_commit_max_bytes, runs)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(project, cmd_hash) DO UPDATE SET
      peak_commit_max_bytes = MAX(gate_stats.peak_commit_max_bytes, excluded.peak_commit_max_bytes),
      runs = gate_stats.runs + 1
  `).run(project, cmdHash, peakCommitBytes);
  return getGateStats(store, project, cmdHash);
}

export function getGateStats(store: BoardStore, project: string, cmdHash: string) {
  const row = store.db.select().from(gateStats).where(and(eq(gateStats.project, project), eq(gateStats.cmdHash, cmdHash))).get();
  if (!row) throw new StoreNotFoundError("Gate stats", `${project}/${cmdHash}`);
  return row;
}

export interface AddApprovalInput {
  id?: string;
  epic: string;
  kind: string;
  source: "web" | "telegram";
}

export function addApproval(store: BoardStore, input: AddApprovalInput) {
  if (input.source !== "web" && input.source !== "telegram") throw new TypeError("Invalid approval source");
  const row = { id: input.id ?? crypto.randomUUID(), epic: input.epic, kind: input.kind, source: input.source, createdAt: now() };
  store.db.insert(approvals).values(row).run();
  return row;
}

export function hasApproval(store: BoardStore, epic: string, kind: string): boolean {
  return store.db.select({ id: approvals.id }).from(approvals).where(and(eq(approvals.epic, epic), eq(approvals.kind, kind))).get() !== undefined;
}

export function listApprovals(store: BoardStore, epic: string) {
  return store.db.select().from(approvals).where(eq(approvals.epic, epic)).orderBy(asc(approvals.createdAt)).all();
}

export function transitionTask(store: BoardStore, id: string, action: TaskAction, actor: Actor, maxSlots = 5): StoredTask {
  store.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const task = getTask(store, id);
    let transitionContext: { canStart?: ReturnType<typeof canStart> } = {};
    if (action === "start") {
      const dependencyStatuses: Record<string, TaskStatus | undefined> = {};
      for (const dependencyId of task.deps) {
        const dependency = store.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, dependencyId)).get();
        dependencyStatuses[dependencyId] = dependency ? TaskStatusSchema.parse(dependency.status) : undefined;
      }
      const project = getEpic(store, task.epic).project;
      const openQuestionRows = listOpenQuestionsForProject(store, project).map((question) => ({
        id: question.id,
        decision_key: question.decisionKey,
        kind: question.kind,
        status: "open" as const,
      }));
      const runningRows = store.db.select().from(tasks).where(eq(tasks.status, "running")).all().map((row) => ({
        id: row.id,
        allowed_files: parseJson(row.allowedFiles, TaskCardSchema.shape.allowed_files, "tasks.allowed_files"),
      }));
      const ctx: CanStartContext = {
        dependencyStatuses,
        questions: openQuestionRows,
        runningTasks: runningRows,
        maxSlots,
      };
      transitionContext = { canStart: canStart(task.card, ctx) };
    }
    const result = applyTransition(task, action, actor, transitionContext);
    if (!result.ok) throw new IllegalTaskTransitionError(result);

    let prio = task.prio;
    if (action === "owner_answered") {
      const lowest = store.db.select({ value: minSql(tasks.prio) }).from(tasks).where(eq(tasks.status, "next")).get()?.value;
      prio = (lowest ?? 0) - 1;
    }
    store.db.update(tasks).set({ status: result.status, round: result.round, prio, updatedAt: now() }).where(eq(tasks.id, id)).run();
    store.sqlite.exec("COMMIT");
  } catch (error) {
    try { store.sqlite.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
    throw error;
  }
  return getTask(store, id);
}

function minSql(column: typeof tasks.prio) {
  return sql<number>`min(${column})`;
}
