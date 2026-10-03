import { z } from "zod";

export const TaskStatusSchema = z.enum([
  "canceled",
  "todo",
  "next",
  "running",
  "review",
  "needs_owner",
  "done",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const RunOutcomeSchema = z.enum([
  "done",
  "partial",
  "blocked",
  "failed",
  "canceled",
  "rate_limited",
]);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

export const EventKindSchema = z.enum([
  "think",
  "read",
  "exec",
  "edit",
  "test_pass",
  "test_fail",
  "message",
  "question",
  "error",
  "unknown",
]);
export type EventKind = z.infer<typeof EventKindSchema>;

export const QuestionKindSchema = z.enum(["stop", "assume"]);
export type QuestionKind = z.infer<typeof QuestionKindSchema>;

export const QuestionTargetSchema = z.enum(["claude", "owner"]);
export type QuestionTarget = z.infer<typeof QuestionTargetSchema>;

export const OwnerAnswerBodySchema = z.object({ text: z.string().trim().min(1), reject: z.boolean().optional() }).strict();
export const TaskPriorityBodySchema = z.object({ prio: z.number().int() }).strict();

export const GateStatusSchema = z.enum(["queued", "running", "pass", "fail", "oom"]);
export type GateStatus = z.infer<typeof GateStatusSchema>;

const nonEmptyString = z.string().min(1);
const taskId = z.string().regex(/^[A-Z][A-Z0-9]*-\d+[a-z]?$/);
const decisionKey = z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);

export const GateSchema = z.object({
  cmd: z.string(),
  ram_est_gb: z.number().positive().optional(),
});
export type Gate = z.infer<typeof GateSchema>;

export const TaskCardSchema = z.object({
  id: taskId,
  title: nonEmptyString,
  epic: nonEmptyString,
  goal: nonEmptyString,
  allowed_files: z.array(nonEmptyString).min(1),
  deps: z.array(taskId).default([]),
  decisions: z.array(decisionKey).default([]),
  light_tests: z.array(z.string()).default([]),
  gates: z.array(GateSchema).default([]),
  acceptance: z.array(nonEmptyString).min(1),
  notes: z.string().optional(),
});
export type TaskCard = z.infer<typeof TaskCardSchema>;

const absolutePath = z.string().regex(/^(?:[A-Za-z]:[\\/]|\/)/);
const repoRelativePath = z.string().min(1).refine((value) => {
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(value)) return false;
  return !value.split(/[\\/]+/).includes("..");
}, "Expected a repository-relative path");

export const DataLinkSchema = z.object({
  from: absolutePath,
  to: repoRelativePath,
  mode: z.enum(["copy", "link"]).default("copy"),
});
export type DataLink = z.infer<typeof DataLinkSchema>;

export const BoardEventKindSchema = z.enum([
  "ready",
  "review",
  "answer",
  "assumption_rejected",
  "stale",
  "failed",
  "paused",
  "resumed",
  "owner_question",
  "epic_ready",
  "epic_merged",
]);
export type BoardEventKind = z.infer<typeof BoardEventKindSchema>;

export const ExecutorConfigSchema = z.object({
  kind: z.literal("codex"),
  model: nonEmptyString,
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  sandbox: z.enum(["read-only", "workspace-write"]),
  extra_config: z.array(z.string().regex(/^[^=\s]+=.*$/)),
});
export type ExecutorConfig = z.infer<typeof ExecutorConfigSchema>;

export const ProjectProfileSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  repo: absolutePath,
  base_branch: z.string().default("main"),
  epic_branch_pattern: z.string().refine((value) => value.includes("{epic}"), "Expected {epic} placeholder").default("epic/{epic}"),
  light_tests: z.array(z.string()).default([]),
  gates: z.array(GateSchema).default([]),
  data_links: z.array(DataLinkSchema).default([]),
  forbidden: z.array(z.string()).default([]),
  rules: z.array(z.string()).default([]),
  executor: ExecutorConfigSchema,
});
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;

export const ExecutorQuestionSchema = z.object({
  decision_key: z.string().nullable(),
  text: z.string(),
  options: z.array(z.string()),
  recommendation: z.string(),
});
export type ExecutorQuestion = z.infer<typeof ExecutorQuestionSchema>;

export const ExecutorAssumptionSchema = z.object({
  decision_key: z.string().nullable(),
  text: z.string(),
});
export type ExecutorAssumption = z.infer<typeof ExecutorAssumptionSchema>;

const reportIntegerSchema = z.number().refine(Number.isInteger, "Expected an integer");

export const ExecutorTestResultSchema = z.object({
  cmd: z.string(),
  result: z.enum(["pass", "fail", "error", "skipped"]),
  passed: reportIntegerSchema,
  failed: reportIntegerSchema,
});
export type ExecutorTestResult = z.infer<typeof ExecutorTestResultSchema>;

const ExecutorReportBaseSchema = z.object({
  status: z.enum(["DONE", "PARTIAL", "BLOCKED"]),
  summary: z.string(),
  files_changed: z.array(z.string()),
  tests_run: z.array(ExecutorTestResultSchema),
  assumptions: z.array(ExecutorAssumptionSchema),
  question: ExecutorQuestionSchema.nullable(),
  notes: z.string(),
});

export const ExecutorReportSchema = ExecutorReportBaseSchema.superRefine((report, context) => {
  if (report.status === "BLOCKED" && report.question === null) {
    context.addIssue({
      code: "custom",
      path: ["question"],
      message: "A blocked report must include a question",
    });
  }
});
export type ExecutorReport = z.infer<typeof ExecutorReportSchema>;

export const NormalizedEventSchema = z.object({
  run_id: z.string(),
  seq: z.number().int().min(0),
  ts: z.iso.datetime({ offset: true }),
  kind: EventKindSchema,
  text: z.string(),
  raw_line: z.number().int().min(0),
});
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;

export const executorReportSanitizedKeywords = [
  "$schema",
  "$id",
  "$defs",
  "definitions",
  "$ref",
  "default",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
  "uniqueItems",
  "examples",
  "title",
  "description",
  "deprecated",
  "readOnly",
  "writeOnly",
] as const;
const unsupportedStrictKeywords = new Set<string>(executorReportSanitizedKeywords);

/** Return the JSON Schema conversion before strict-mode sanitization. */
export function executorReportSourceJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ExecutorReportBaseSchema, {
    target: "draft-7",
    override({ zodSchema, jsonSchema }) {
      // Preserve the integer predicate without Zod's narrower safe-integer bounds.
      if (zodSchema === reportIntegerSchema) jsonSchema.type = "integer";
    },
  }) as Record<string, unknown>;
}

/**
 * Convert the same structural schema used by ExecutorReportSchema and then
 * reduce it to the subset accepted by OpenAI Structured Outputs strict mode.
 * Cross-field refinements intentionally remain enforced by Zod at runtime.
 */
export function executorReportJsonSchema(): Record<string, unknown> {
  const converted = executorReportSourceJsonSchema();

  const sanitize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (value === null || typeof value !== "object") return value;

    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source)) {
      if (unsupportedStrictKeywords.has(key) || key === "oneOf" || key === "allOf" || key === "not") continue;
      if (key === "properties" && child !== null && typeof child === "object" && !Array.isArray(child)) {
        const properties: Record<string, unknown> = {};
        for (const [propertyName, propertySchema] of Object.entries(child as Record<string, unknown>)) {
          properties[propertyName] = sanitize(propertySchema);
        }
        result.properties = properties;
        result.required = Object.keys(properties);
        continue;
      }
      if (key === "additionalProperties") continue;
      if (key === "anyOf") {
        result.anyOf = sanitize(child);
        continue;
      }
      if (!["type", "items", "enum", "const"].includes(key)) continue;
      result[key] = sanitize(child);
    }

    if (result.type === "object") result.additionalProperties = false;
    return result;
  };

  return sanitize(converted) as Record<string, unknown>;
}
