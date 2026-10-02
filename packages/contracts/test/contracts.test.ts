import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  DataLinkSchema,
  EventKindSchema,
  ExecutorAssumptionSchema,
  ExecutorConfigSchema,
  ExecutorQuestionSchema,
  ExecutorReportSchema,
  ExecutorTestResultSchema,
  GateSchema,
  GateStatusSchema,
  NormalizedEventSchema,
  ProjectProfileSchema,
  QuestionKindSchema,
  QuestionTargetSchema,
  RunOutcomeSchema,
  TaskCardSchema,
  TaskStatusSchema,
  executorReportJsonSchema,
  executorReportSanitizedKeywords,
  executorReportSourceJsonSchema,
} from "../src/index.ts";

const validTask = {
  id: "AB-0a",
  title: "Add a contract",
  epic: "foundation",
  goal: "Describe work consistently",
  allowed_files: ["packages/contracts/**"],
  acceptance: ["Schema validates"],
};

const validProfile = {
  name: "agent-board",
  repo: "C:\\workspace\\agent-board",
  data_links: [{ from: "/var/data/source.db", to: "data/source.db" }],
  forbidden: [".env"],
  rules: ["Keep changes scoped"],
  executor: {
    kind: "codex",
    model: "gpt-test",
    effort: "medium",
    sandbox: "workspace-write",
    extra_config: ["approval_policy=never"],
  },
};

const validReport = {
  status: "DONE",
  summary: "Implemented the contract",
  files_changed: ["packages/contracts/src/index.ts"],
  tests_run: [{ cmd: "bun test", result: "pass", passed: 10, failed: 0 }],
  assumptions: [{ decision_key: null, text: "Used defaults for optional arrays" }],
  question: null,
  notes: "",
};

const strictUnsupported = new Set([
  "$schema", "$id", "$defs", "definitions", "$ref", "default", "format", "pattern",
  "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "minItems", "maxItems", "uniqueItems", "examples", "title", "description", "deprecated",
  "readOnly", "writeOnly", "oneOf", "allOf", "not",
]);
const sanitizeRemovedKeywords = new Set<string>(executorReportSanitizedKeywords);

function assertStrictModeSchema(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertStrictModeSchema(item);
    return;
  }
  if (value === null || typeof value !== "object") return;

  const node = value as Record<string, unknown>;
  expect(value).toBeObject();
  for (const key of Object.keys(node)) expect(strictUnsupported.has(key)).toBe(false);
  if (node.type === "object") {
    expect(node.additionalProperties).toBe(false);
    expect(node.properties).toBeObject();
    expect(node.required).toEqual(Object.keys(node.properties as Record<string, unknown>));
  }
  for (const child of Object.values(node)) assertStrictModeSchema(child);
}

function assertNoSanitizedValidationKeywords(value: unknown, path = "$source"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSanitizedValidationKeywords(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // Zod adds this dialect URI as root metadata; it does not constrain report values.
    if (key !== "$schema" && sanitizeRemovedKeywords.has(key)) {
      throw new Error(`Sanitizer-removed keyword remains at ${path}.${key}`);
    }
    assertNoSanitizedValidationKeywords(child, `${path}.${key}`);
  }
}

describe("enum schemas", () => {
  test("accept listed values and reject unknown values", () => {
    for (const schema of [TaskStatusSchema, RunOutcomeSchema, EventKindSchema, QuestionKindSchema, QuestionTargetSchema, GateStatusSchema]) {
      const accepted = schema.options[0];
      expect(schema.safeParse(accepted).success).toBe(true);
      expect(schema.safeParse("not-a-value").success).toBe(false);
    }
  });
});

describe("TaskCard", () => {
  test("accepts valid values and fills array defaults", () => {
    const result = TaskCardSchema.parse(validTask);
    expect(result.deps).toEqual([]);
    expect(result.decisions).toEqual([]);
    expect(result.light_tests).toEqual([]);
    expect(result.gates).toEqual([]);
    expect(TaskCardSchema.parse({ ...validTask, id: "M-12" }).id).toBe("M-12");
  });

  test("rejects invalid ids, empty acceptance, and bad decision keys", () => {
    expect(TaskCardSchema.safeParse({ ...validTask, id: "ab-1" }).success).toBe(false);
    expect(TaskCardSchema.safeParse({ ...validTask, acceptance: [] }).success).toBe(false);
    expect(TaskCardSchema.safeParse({ ...validTask, decisions: ["Bad-Key"] }).success).toBe(false);
  });
});

describe("profile component schemas", () => {
  test("validates gate memory estimates", () => {
    expect(GateSchema.safeParse({ cmd: "bun test", ram_est_gb: 2 }).success).toBe(true);
    expect(GateSchema.safeParse({ cmd: "bun test", ram_est_gb: 0 }).success).toBe(false);
  });

  test("validates absolute source and repository-relative target paths", () => {
    expect(DataLinkSchema.safeParse({ from: "D:\\data\\input.db", to: "data/input.db" }).success).toBe(true);
    expect(DataLinkSchema.safeParse({ from: "relative/input.db", to: "C:\\data\\input.db" }).success).toBe(false);
    expect(DataLinkSchema.safeParse({ from: "/data/input.db", to: "../outside.db" }).success).toBe(false);
  });

  test("validates executor fields and key=value config", () => {
    expect(ExecutorConfigSchema.safeParse(validProfile.executor).success).toBe(true);
    expect(ExecutorConfigSchema.safeParse({ ...validProfile.executor, extra_config: ["missing-value-marker"] }).success).toBe(false);
    expect(ExecutorConfigSchema.safeParse({ ...validProfile.executor, effort: "extreme" }).success).toBe(false);
    expect(ExecutorConfigSchema.safeParse({ ...validProfile.executor, model: "" }).success).toBe(false);
  });

  test("applies defaults and validates slug, paths, and epic placeholder", () => {
    const result = ProjectProfileSchema.parse(validProfile);
    expect(result.base_branch).toBe("main");
    expect(result.epic_branch_pattern).toBe("epic/{epic}");
    expect(result.light_tests).toEqual([]);
    expect(result.gates).toEqual([]);
    const { data_links: _dataLinks, forbidden: _forbidden, rules: _rules, ...profileWithoutLists } = validProfile;
    const defaulted = ProjectProfileSchema.parse(profileWithoutLists);
    expect(defaulted.data_links).toEqual([]);
    expect(defaulted.forbidden).toEqual([]);
    expect(defaulted.rules).toEqual([]);
    expect(ProjectProfileSchema.safeParse({ ...validProfile, name: "Invalid Name" }).success).toBe(false);
    expect(ProjectProfileSchema.safeParse({ ...validProfile, repo: "relative/repo" }).success).toBe(false);
    expect(ProjectProfileSchema.safeParse({ ...validProfile, epic_branch_pattern: "epic/name" }).success).toBe(false);
  });
});

describe("ExecutorReport", () => {
  test("accepts report values and nullable decisions", () => {
    expect(ExecutorReportSchema.parse(validReport)).toMatchObject(validReport);
    expect(ExecutorReportSchema.safeParse({
      ...validReport,
      assumptions: [{ decision_key: "Stop Rule-1", text: "A free-form decision reference" }],
      question: { decision_key: "Stop Rule-1", text: "Clarify this", options: [], recommendation: "Proceed" },
    }).success).toBe(true);
  });

  test("requires a question when blocked and validates test counts", () => {
    expect(ExecutorReportSchema.safeParse({ ...validReport, status: "BLOCKED" }).success).toBe(false);
    expect(ExecutorReportSchema.safeParse({
      ...validReport,
      status: "BLOCKED",
      question: { decision_key: "choose_path", text: "Which path?", options: ["A", "B"], recommendation: "A" },
    }).success).toBe(true);
    expect(ExecutorReportSchema.safeParse({
      ...validReport,
      tests_run: [{ cmd: "bun test", result: "pass", passed: 1.5, failed: 0 }],
    }).success).toBe(false);
  });
});

describe("executor report component schemas", () => {
  test("validates question and assumption values", () => {
    const question = { decision_key: "choose_path", text: "Which path?", options: ["A", "B"], recommendation: "A" };
    expect(ExecutorQuestionSchema.safeParse(question).success).toBe(true);
    expect(ExecutorQuestionSchema.safeParse({ ...question, options: "A" }).success).toBe(false);
    expect(ExecutorAssumptionSchema.safeParse({ decision_key: null, text: "Use the default" }).success).toBe(true);
    expect(ExecutorAssumptionSchema.safeParse({ decision_key: 1, text: "Use the default" }).success).toBe(false);
  });

  test("validates test result counts and result values", () => {
    expect(ExecutorTestResultSchema.safeParse({ cmd: "bun test", result: "pass", passed: 2, failed: 0 }).success).toBe(true);
    expect(ExecutorTestResultSchema.safeParse({ cmd: "bun test", result: "unknown", passed: -1, failed: 0 }).success).toBe(false);
    expect(ExecutorTestResultSchema.safeParse({
      cmd: "bun test",
      result: "pass",
      passed: Number.MAX_SAFE_INTEGER + 1,
      failed: 0,
    }).success).toBe(true);
  });
});

describe("NormalizedEvent", () => {
  test("accepts valid values and rejects invalid sequence, timestamp, and kind", () => {
    const event = { run_id: "run-1", seq: 0, ts: "2026-10-03T10:00:00Z", kind: "exec", text: "bun test", raw_line: 0 };
    expect(NormalizedEventSchema.safeParse(event).success).toBe(true);
    expect(NormalizedEventSchema.safeParse({ ...event, seq: -1 }).success).toBe(false);
    expect(NormalizedEventSchema.safeParse({ ...event, ts: "yesterday" }).success).toBe(false);
    expect(NormalizedEventSchema.safeParse({ ...event, kind: "other" }).success).toBe(false);
  });
});

describe("Structured Outputs schema", () => {
  test("has strict-mode structure recursively", () => {
    assertStrictModeSchema(executorReportJsonSchema());
  });

  test("generated JSON is strict and matches the function output", async () => {
    const generated = JSON.parse(await readFile(new URL("../generated/report.schema.json", import.meta.url), "utf8")) as unknown;
    assertStrictModeSchema(generated);
    expect(generated).toEqual(executorReportJsonSchema());
  });

  test("the report's Zod source schema has no constraints removed by sanitization", () => {
    assertNoSanitizedValidationKeywords(executorReportSourceJsonSchema());
  });
});
