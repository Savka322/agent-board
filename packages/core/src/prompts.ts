import type { ProjectProfile, TaskCard } from "@agent-board/contracts";

export const EXECUTOR_PREAMBLE = `You are the executor for one task card on an agent-board. Rules:
- Change only files matching the card's allowed_files. If you need any other file, stop with status BLOCKED and ask.
- Do not guess unclear requirements: stop with status BLOCKED, a question, options and your recommendation.
- Small assumptions are fine; list each one in \`assumptions\`.
- Do not commit and do not push. The board commits your changes after review.
- You have no network access. Do not try to install packages.
- Run only the light tests listed in the card; report every command you ran with its real result.
- Your final message is a JSON report following the schema provided by the harness.`;

export interface PromptDecision {
  key: string;
  answer: string;
}

export interface BuildPromptInput {
  profile: ProjectProfile;
  card: TaskCard;
  decisions: PromptDecision[];
  resumeNote?: string;
}

function list(values: string[]): string {
  return values.length === 0 ? "- (none)" : values.map((value) => `- ${value}`).join("\n");
}

function decisionsText(decisions: PromptDecision[]): string {
  return decisions.length === 0 ? "(none)" : decisions.map(({ key, answer }) => `${key}: ${answer}`).join("\n");
}

export function buildPrompt(input: BuildPromptInput): string {
  const { card, profile } = input;
  const sections = [
    EXECUTOR_PREAMBLE,
    `## Project rules\n${list(profile.rules)}`,
    [
      "## Task card",
      `id: ${card.id}`,
      `title: ${card.title}`,
      `goal: ${card.goal}`,
      "allowed_files:",
      list(card.allowed_files),
      "light_tests:",
      list(card.light_tests),
      "acceptance:",
      list(card.acceptance),
      `notes: ${card.notes ?? "(none)"}`,
    ].join("\n"),
    `## Answered decisions\n${decisionsText(input.decisions)}`,
  ];
  if (input.resumeNote !== undefined) sections.push(`## Review note or owner answer\n${input.resumeNote}`);
  return `${sections.join("\n\n")}\n`;
}

export function buildResumePrompt(note: string, decisions: PromptDecision[]): string {
  const sections = [`## Review note or owner answer\n${note}`];
  if (decisions.length > 0) sections.push(`## New answered decisions\n${decisionsText(decisions)}`);
  return `${sections.join("\n\n")}\n`;
}

export function buildContinuationPrompt(input: {
  decisions: PromptDecision[];
  rateLimited: boolean;
  note?: string;
}): string {
  const update = input.rateLimited
    ? "the previous run was interrupted by a rate limit"
    : input.decisions.length > 0
      ? decisionsText(input.decisions)
      : "No decisions have been answered since the previous run.";
  const sections = [`## Board update\n${update}`];
  if (input.note !== undefined) sections.push(`## Additional note\n${input.note}`);
  return `${sections.join("\n\n")}\n`;
}
