import { describe, expect, test } from "bun:test";
import { applyTransition, canStart, type CanStartContext, type StartTask, type TaskAction } from "../src/state-machine";
import { installFreshHome } from "./helpers";

installFreshHome(false);

const transitions: Array<{ action: TaskAction; from: string; to: string; actor: "claude" | "owner" | "runner" | "dispatcher"; round?: number; ctx?: { canStart?: { ok: true; reasons: [] }; lastRunOutcome?: "rate_limited" } }> = [
  { action: "promote", from: "todo", to: "next", actor: "claude" },
  { action: "start", from: "next", to: "running", actor: "claude", ctx: { canStart: { ok: true, reasons: [] } } },
  { action: "run_finished", from: "running", to: "review", actor: "runner" },
  { action: "resume", from: "review", to: "running", actor: "claude", round: 2 },
  { action: "escalate", from: "review", to: "needs_owner", actor: "claude" },
  { action: "owner_answered", from: "needs_owner", to: "next", actor: "owner" },
  { action: "accept", from: "review", to: "done", actor: "claude" },
  { action: "reject", from: "review", to: "todo", actor: "claude" },
  { action: "requeue", from: "review", to: "next", actor: "dispatcher", ctx: { lastRunOutcome: "rate_limited" } },
  { action: "cancel", from: "todo", to: "canceled", actor: "owner" },
];

describe("task state machine", () => {
  test("allows every defined transition", () => {
    for (const rule of transitions) {
      const task = { status: rule.from as never, round: rule.action === "start" ? 0 : rule.action === "resume" ? 1 : 2 };
      const result = applyTransition(task, rule.action, rule.actor, rule.ctx);
      expect(result).toMatchObject({ ok: true, status: rule.to });
      if (rule.action === "start") expect(result).toMatchObject({ round: 1 });
      else if (rule.action === "resume") expect(result).toMatchObject({ round: 2 });
      else if (rule.action === "reject") expect(result).toMatchObject({ round: 0 });
      else expect(result).toMatchObject({ round: 2 });
    }
    expect(applyTransition({ status: "review", round: 1 }, "cancel", "claude")).toMatchObject({ ok: true, status: "canceled", round: 1 });
  });

  test("refuses every defined transition for a wrong actor and wrong status", () => {
    for (const rule of transitions) {
      const wrongActor = rule.action === "cancel" ? "runner" : rule.actor === "claude" ? "owner" : "claude";
      expect(applyTransition({ status: rule.from as never, round: 0 }, rule.action, wrongActor as never, rule.ctx)).toMatchObject({ ok: false, error: { code: "wrong_actor" } });
      if (rule.action !== "cancel") {
        expect(applyTransition({ status: "done", round: 0 }, rule.action, rule.actor, rule.ctx)).toMatchObject({ ok: false, error: { code: "wrong_status" } });
      }
    }
    expect(applyTransition({ status: "done", round: 0 }, "cancel", "claude")).toMatchObject({ ok: false, error: { code: "wrong_status" } });
  });

  test("starts run 1, permits only two resumes, and resets rejected work", () => {
    expect(applyTransition({ status: "next", round: 0 }, "start", "claude")).toMatchObject({ ok: false, error: { code: "start_blocked" } });
    expect(applyTransition({ status: "next", round: 0 }, "start", "claude", { canStart: { ok: false, reasons: [{ code: "no_slot" }] } })).toMatchObject({ ok: false, error: { code: "start_blocked", reasons: [{ code: "no_slot" }] } });
    expect(applyTransition({ status: "next", round: 0 }, "start", "claude", { canStart: { ok: true, reasons: [] } })).toMatchObject({ ok: true, status: "running", round: 1 });
    expect(applyTransition({ status: "next", round: 1 }, "start", "claude", { canStart: { ok: true, reasons: [] } })).toMatchObject({ ok: true, status: "running", round: 2 });
    expect(applyTransition({ status: "review", round: 1 }, "resume", "claude")).toMatchObject({ ok: true, status: "running", round: 2 });
    expect(applyTransition({ status: "review", round: 2 }, "resume", "claude")).toMatchObject({ ok: true, status: "running", round: 3 });
    expect(applyTransition({ status: "review", round: 3 }, "resume", "claude")).toMatchObject({ ok: false, error: { code: "max_rounds" } });
    expect(applyTransition({ status: "review", round: 2 }, "reject", "claude")).toMatchObject({ ok: true, status: "todo", round: 0 });
    expect(applyTransition({ status: "todo", round: 0 }, "invented" as TaskAction, "claude")).toMatchObject({ ok: false, error: { code: "unknown_action" } });
    expect(applyTransition({ status: "review", round: 1 }, "requeue", "dispatcher", { lastRunOutcome: "failed" })).toMatchObject({ ok: false, error: { code: "requeue_requires_rate_limited" } });
    expect(applyTransition({ status: "review", round: 1 }, "requeue", "dispatcher", { lastRunOutcome: "rate_limited" })).toMatchObject({ ok: true, status: "next" });
  });
});

describe("canStart", () => {
  const task: StartTask = {
    id: "DEMO-1",
    deps: ["DEMO-2"],
    decisions: ["api_shape"],
    allowed_files: ["src/**"],
  };
  const ready: CanStartContext = {
    dependencyStatuses: { "DEMO-2": "done" },
    questions: [],
    runningTasks: [],
  };

  test("reports each blocker alone and all blockers together", () => {
    const deps = canStart(task, { ...ready, dependencyStatuses: { "DEMO-2": "running" } });
    expect(deps).toEqual({ ok: false, reasons: [{ code: "deps_pending", ids: ["DEMO-2"] }] });

    const waiting = canStart(task, { ...ready, questions: [{ id: "Q-1", decision_key: "api_shape", kind: "stop", status: "open" }] });
    expect(waiting).toEqual({ ok: false, reasons: [{ code: "waiting_answer", ids: ["Q-1"] }] });

    const assumption = canStart(task, { ...ready, questions: [{ id: "Q-2", decision_key: "api_shape", kind: "assume", status: "open" }] });
    expect(assumption).toEqual({ ok: true, reasons: [] });

    const paused = canStart(task, { ...ready, pausedUntil: new Date(Date.now() + 60_000).toISOString() });
    expect(paused).toMatchObject({ ok: false, reasons: [{ code: "paused", until: expect.any(String) }] });

    const noSlot = canStart(task, { ...ready, maxSlots: 5, runningTasks: Array.from({ length: 5 }, (_, index) => ({ id: `RUN-${index}`, allowed_files: [`other/${index}.ts`] })) });
    expect(noSlot).toEqual({ ok: false, reasons: [{ code: "no_slot" }] });

    const overlap = canStart(task, { ...ready, runningTasks: [{ id: "DEMO-3", allowed_files: ["src/a.ts"] }] });
    expect(overlap).toEqual({ ok: false, reasons: [{ code: "file_overlap", ids: ["DEMO-3"] }] });

    const combined = canStart(task, {
      dependencyStatuses: { "DEMO-2": "todo" },
      questions: [{ id: "Q-1", decision_key: "api_shape", kind: "stop", status: "open" }],
      runningTasks: [
        ...Array.from({ length: 5 }, (_, index) => ({ id: `RUN-${index}`, allowed_files: [index === 0 ? "src/a.ts" : `other/${index}.ts`] })),
      ],
    });
    expect(combined).toEqual({ ok: false, reasons: [
      { code: "deps_pending", ids: ["DEMO-2"] },
      { code: "waiting_answer", ids: ["Q-1"] },
      { code: "no_slot" },
      { code: "file_overlap", ids: ["RUN-0"] },
    ] });
  });

  test("checks conservative glob prefixes on path boundaries without case sensitivity", () => {
    const check = (ours: string, theirs: string) => canStart({ ...task, deps: [], decisions: [], allowed_files: [ours] }, {
      runningTasks: [{ id: "DEMO-2", allowed_files: [theirs] }],
    }).reasons.some((reason) => reason.code === "file_overlap");

    expect(check("src/**", "src/a.ts")).toBe(true);
    expect(check("src/a/**", "src/b/**")).toBe(false);
    expect(check("SRC/x", "src/x/**")).toBe(true);
    expect(check("src-old/**", "src/**")).toBe(false);
  });
});
