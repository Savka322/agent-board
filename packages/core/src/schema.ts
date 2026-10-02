import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

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
  ramEstBytes: integer("ram_est_bytes").notNull(),
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

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  epic: text("epic").notNull().references(() => epics.id),
  kind: text("kind").notNull(),
  source: text("source").notNull(),
  createdAt: text("created_at").notNull(),
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
  approvals,
};
