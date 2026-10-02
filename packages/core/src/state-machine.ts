import type { QuestionKind, TaskStatus } from "@agent-board/contracts";

export type Actor = "claude" | "owner" | "runner" | "dispatcher";
export type TaskAction =
  | "promote"
  | "start"
  | "run_finished"
  | "resume"
  | "escalate"
  | "owner_answered"
  | "accept"
  | "reject"
  | "cancel";

export interface StartTask {
  id: string;
  deps: string[];
  decisions: string[];
  allowed_files: string[];
}

export interface CanStartContext {
  dependencyStatuses?: Record<string, TaskStatus | undefined>;
  questions?: Array<{
    id: string;
    decision_key: string | null;
    kind: QuestionKind;
    status: "open" | "answered";
  }>;
  runningTasks?: Array<{ id: string; allowed_files: string[] }>;
  maxSlots?: number;
}

export type CanStartReason =
  | { code: "deps_pending"; ids: string[] }
  | { code: "waiting_answer"; ids: string[] }
  | { code: "no_slot" }
  | { code: "file_overlap"; ids: string[] };

export type CanStartResult = { ok: true; reasons: [] } | { ok: false; reasons: CanStartReason[] };

function staticPrefix(glob: string): string {
  const normalized = glob.replace(/\\/g, "/");
  const wildcard = normalized.search(/[*?\[{]/);
  const prefix = wildcard === -1 ? normalized : normalized.slice(0, wildcard);
  return prefix.replace(/\/+$/, "").toLocaleLowerCase("en-US");
}

function prefixesOverlap(first: string, second: string): boolean {
  const a = staticPrefix(first);
  const b = staticPrefix(second);
  if (a === "" || b === "") return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function canStart(task: StartTask, ctx: CanStartContext = {}): CanStartResult {
  const reasons: CanStartReason[] = [];
  const dependencyStatuses = ctx.dependencyStatuses ?? {};
  const pendingDeps = task.deps.filter((id) => dependencyStatuses[id] !== "done");
  if (pendingDeps.length > 0) reasons.push({ code: "deps_pending", ids: pendingDeps });

  const decisionKeys = new Set(task.decisions);
  const waitingQuestions = (ctx.questions ?? [])
    .filter((question) => question.status === "open"
      && question.kind === "stop"
      && question.decision_key !== null
      && decisionKeys.has(question.decision_key))
    .map((question) => question.id);
  if (waitingQuestions.length > 0) reasons.push({ code: "waiting_answer", ids: waitingQuestions });

  const running = (ctx.runningTasks ?? []).filter((other) => other.id !== task.id);
  if (running.length >= (ctx.maxSlots ?? 5)) reasons.push({ code: "no_slot" });

  const overlapping = new Set<string>();
  for (const other of running) {
    if (task.allowed_files.some((file) => other.allowed_files.some((otherFile) => prefixesOverlap(file, otherFile)))) {
      overlapping.add(other.id);
    }
  }
  if (overlapping.size > 0) reasons.push({ code: "file_overlap", ids: [...overlapping] });

  return reasons.length === 0 ? { ok: true, reasons: [] } : { ok: false, reasons };
}

export interface TransitionTask {
  status: TaskStatus;
  round: number;
}

export interface TransitionContext {
  canStart?: CanStartResult;
}

export type TransitionErrorCode = "wrong_actor" | "wrong_status" | "unknown_action" | "start_blocked" | "max_rounds";
export type TransitionResult =
  | { ok: true; status: TaskStatus; round: number }
  | { ok: false; error: { code: TransitionErrorCode; reasons?: CanStartReason[] } };

const transitionRules: Record<Exclude<TaskAction, "cancel">, {
  from: TaskStatus;
  to: TaskStatus;
  actor: Actor;
}> = {
  promote: { from: "todo", to: "next", actor: "claude" },
  start: { from: "next", to: "running", actor: "claude" },
  run_finished: { from: "running", to: "review", actor: "runner" },
  resume: { from: "review", to: "running", actor: "claude" },
  escalate: { from: "review", to: "needs_owner", actor: "claude" },
  owner_answered: { from: "needs_owner", to: "next", actor: "owner" },
  accept: { from: "review", to: "done", actor: "claude" },
  reject: { from: "review", to: "todo", actor: "claude" },
};

export function applyTransition(
  task: TransitionTask,
  action: TaskAction,
  actor: Actor,
  ctx: TransitionContext = {},
): TransitionResult {
  if (action === "cancel") {
    if (actor !== "claude" && actor !== "owner") return { ok: false, error: { code: "wrong_actor" } };
    if (task.status === "done" || task.status === "canceled") return { ok: false, error: { code: "wrong_status" } };
    return { ok: true, status: "canceled", round: task.round };
  }

  if (!Object.hasOwn(transitionRules, action)) return { ok: false, error: { code: "unknown_action" } };
  const rule = transitionRules[action];
  if (actor !== rule.actor) return { ok: false, error: { code: "wrong_actor" } };
  if (task.status !== rule.from) return { ok: false, error: { code: "wrong_status" } };
  if (action === "start" && ctx.canStart?.ok !== true) {
    return {
      ok: false,
      error: { code: "start_blocked", ...(ctx.canStart ? { reasons: ctx.canStart.reasons } : {}) },
    };
  }
  if (action === "resume" && task.round >= 3) return { ok: false, error: { code: "max_rounds" } };

  let round = task.round;
  if (action === "start") round = 1;
  if (action === "resume") round += 1;
  if (action === "reject") round = 0;
  return { ok: true, status: rule.to, round };
}
