import {
  check,
  integer,
  index,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const projects = sqliteTable("projects", {
  name: text("name").primaryKey(),
  profilePath: text("profile_path").notNull(),
  createdAt: text("created_at").notNull(),
});

export const epics = sqliteTable("epics", {
  id: text("id").primaryKey(),
  project: text("project").notNull().references(() => projects.name),
  title: text("title").notNull(),
  branch: text("branch").notNull(),
  status: text("status").notNull(),
  mergeApprovedAt: text("merge_approved_at"),
  createdAt: text("created_at").notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  epic: text("epic").notNull().references(() => epics.id),
  title: text("title").notNull(),
  status: text("status").notNull(),
  prio: integer("prio").notNull(),
  cardPath: text("card_path").notNull(),
  allowedFiles: text("allowed_files").notNull(),
  gates: text("gates").notNull(),
  lightTests: text("light_tests").notNull(),
  round: integer("round").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const taskLog = sqliteTable("task_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  task: text("task").notNull().references(() => tasks.id),
  ts: text("ts").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  note: text("note"),
});

export const taskDeps = sqliteTable("task_deps", {
  task: text("task").notNull().references(() => tasks.id),
  dependsOn: text("depends_on").notNull().references(() => tasks.id),
}, (table) => [primaryKey({ columns: [table.task, table.dependsOn] })]);

export const taskDecisions = sqliteTable("task_decisions", {
  task: text("task").notNull().references(() => tasks.id),
  decisionKey: text("decision_key").notNull(),
}, (table) => [primaryKey({ columns: [table.task, table.decisionKey] })]);

export const decisions = sqliteTable("decisions", {
  project: text("project").notNull().references(() => projects.name),
  key: text("key").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  answer: text("answer"),
  answeredAt: text("answered_at"),
}, (table) => [primaryKey({ columns: [table.project, table.key] })]);

export const questions = sqliteTable("questions", {
  id: text("id").primaryKey(),
  task: text("task").notNull().references(() => tasks.id),
  decisionKey: text("decision_key"),
  kind: text("kind").notNull(),
  target: text("target").notNull(),
  text: text("text").notNull(),
  options: text("options").notNull(),
  recommendation: text("recommendation").notNull(),
  status: text("status").notNull(),
  answer: text("answer"),
  answeredAt: text("answered_at"),
  createdAt: text("created_at").notNull(),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  task: text("task").notNull().references(() => tasks.id),
  round: integer("round").notNull(),
  executor: text("executor").notNull(),
  sessionId: text("session_id"),
  resumeSessionId: text("resume_session_id"),
  pid: integer("pid"),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  exitCode: integer("exit_code"),
  outcome: text("outcome"),
  reportPath: text("report_path"),
  rawPath: text("raw_path"),
  usage: text("usage"),
});

export const events = sqliteTable("events", {
  runId: text("run_id").notNull().references(() => runs.id),
  seq: integer("seq").notNull(),
  ts: text("ts").notNull(),
  kind: text("kind").notNull(),
  text: text("text").notNull(),
  rawLine: integer("raw_line").notNull(),
}, (table) => [primaryKey({ columns: [table.runId, table.seq] })]);

export const gateRuns = sqliteTable("gate_runs", {
  id: text("id").primaryKey(),
  task: text("task").notNull().references(() => tasks.id),
  cmd: text("cmd").notNull(),
  status: text("status").notNull(),
  exitCode: integer("exit_code"),
  ramEstBytes: integer("ram_est_bytes").notNull(),
  attempt: integer("attempt").notNull().default(1),
  retryOf: text("retry_of").references((): AnySQLiteColumn => gateRuns.id),
  leaseBytes: integer("lease_bytes"),
  peakCommitBytes: integer("peak_commit_bytes"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
});

export const gateStats = sqliteTable("gate_stats", {
  project: text("project").notNull().references(() => projects.name),
  cmdHash: text("cmd_hash").notNull(),
  peakCommitMaxBytes: integer("peak_commit_max_bytes").notNull(),
  runs: integer("runs").notNull(),
}, (table) => [primaryKey({ columns: [table.project, table.cmdHash] })]);

export const memoryLeases = sqliteTable("memory_leases", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  ref: text("ref").notNull(),
  bytes: integer("bytes").notNull(),
  pid: integer("pid"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("memory_leases_pid_idx").on(table.pid),
  check("memory_leases_kind_check", sql`${table.kind} IN ('gate', 'executor')`),
  check("memory_leases_bytes_check", sql`${table.bytes} > 0`),
]);

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  epic: text("epic").notNull().references(() => epics.id),
  kind: text("kind").notNull(),
  source: text("source").notNull(),
  createdAt: text("created_at").notNull(),
});

export const epicLog = sqliteTable("epic_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  epic: text("epic").notNull().references(() => epics.id),
  ts: text("ts").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  note: text("note"),
});

export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  ts: text("ts").notNull(),
  kind: text("kind").notNull(),
  ref: text("ref").notNull(),
  appId: text("app_id").notNull(),
  delivered: integer("delivered", { mode: "boolean" }).notNull(),
  error: text("error"),
}, (table) => [index("notifications_cause_idx").on(table.kind, table.ref)]);

export const boardEvents = sqliteTable("board_events", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  ts: text("ts").notNull(),
  kind: text("kind").notNull(),
  task: text("task"),
  epic: text("epic"),
  question: text("question"),
  run: text("run"),
  payload: text("payload").notNull(),
}, (table) => [
  index("board_events_kind_seq_idx").on(table.kind, table.seq),
  index("board_events_run_idx").on(table.run),
]);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const schema = {
  projects,
  epics,
  tasks,
  taskLog,
  taskDeps,
  taskDecisions,
  decisions,
  questions,
  runs,
  events,
  gateRuns,
  gateStats,
  memoryLeases,
  approvals,
  epicLog,
  notifications,
  boardEvents,
  settings,
};
