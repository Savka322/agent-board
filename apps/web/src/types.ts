export type TaskStatus = "canceled" | "todo" | "next" | "running" | "review" | "needs_owner" | "done";

export interface EpicSummary {
  id: string;
  project: string;
  title: string;
  status: string;
  merge_approved: boolean;
  ready_for_merge: boolean;
  progress: { done: number; total: number };
}

export interface TaskSummary {
  id: string;
  epic: string;
  title: string;
  status: TaskStatus;
  prio: number;
  round: number;
  labels: string[];
}

export interface OwnerQuestion {
  id: string;
  task: string;
  task_title: string;
  decision_key: string | null;
  kind: "stop" | "assume";
  text: string;
  options: string[];
  recommendation: string;
  created_at: string;
  held_task_ids: string[];
}

export interface BoardData {
  epics: EpicSummary[];
  selected_epic: string | null;
  tasks: TaskSummary[];
  questions: OwnerQuestion[];
  settings: { max_slots: number; paused_until: string | null };
  running_count: number;
  cursor: number;
}

export interface TaskCardData {
  id: string;
  title: string;
  epic: string;
  goal: string;
  allowed_files: string[];
  deps: string[];
  decisions: string[];
  light_tests: string[];
  gates: Array<{ cmd: string; ram_est_gb?: number }>;
  acceptance: string[];
  notes?: string;
  status: TaskStatus;
  prio: number;
  round: number;
  updated_at: string;
}

export interface TaskRun {
  id: string;
  round: number;
  outcome: "done" | "partial" | "blocked" | "failed" | "canceled" | "rate_limited" | null;
  started_at: string;
  ended_at: string | null;
  usage: unknown;
  raw_available: boolean;
}

export interface TaskLogRow {
  id: number;
  task: string;
  ts: string;
  actor: string;
  action: string;
  note: string | null;
}

export interface ReportData {
  status: "DONE" | "PARTIAL" | "BLOCKED";
  summary: string;
  files_changed: string[];
  tests_run: Array<{ cmd: string; result: "pass" | "fail" | "error" | "skipped"; passed: number; failed: number }>;
  assumptions: Array<{ decision_key: string | null; text: string }>;
  question: { decision_key: string | null; text: string; options: string[]; recommendation: string } | null;
  notes: string;
}

export interface ReviewSummary {
  task: string;
  status: string;
  changed_files: Array<{ path: string; outside_allowed: boolean }>;
  diff_stat: string;
  new_files: string[];
  report: ReportData | null;
  events: TaskEvent[];
}

export interface TaskQuestion extends Omit<OwnerQuestion, "created_at" | "held_task_ids"> {
  decisionKey: string | null;
  target: "owner" | "claude";
  status: "open" | "answered" | "rejected";
}

export interface TaskDetailData {
  card: TaskCardData;
  runs: TaskRun[];
  task_log: TaskLogRow[];
  questions: TaskQuestion[];
  last_report: ReportData | null;
  review_summary: ReviewSummary | null;
  review_error: string | null;
}

export interface TaskEvent {
  run_id: string;
  seq: number;
  ts: string;
  kind: "think" | "read" | "exec" | "edit" | "test_pass" | "test_fail" | "message" | "question" | "error" | "unknown";
  text: string;
  raw_line: number;
}
