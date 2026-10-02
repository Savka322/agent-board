import { NormalizedEventSchema, type NormalizedEvent } from "@agent-board/contracts";

export interface CodexNormalizerContext {
  run_id: string;
  seq: number;
  line: number;
  repoRoot: string;
  now: () => string | Date;
  testCommands?: string[];
}

export interface CodexNormalizerResult {
  events: NormalizedEvent[];
  sessionId?: string;
  usage?: unknown;
}

const defaultTestCommands = ["bun test", "pytest", "npm test", "vitest", "jest", "go test", "cargo test"];
const knownItemTypes = new Set(["reasoning", "agent_message", "command_execution", "file_change"]);

function truncate(text: string): string {
  return text.slice(0, 2000);
}

function safeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function eventTimestamp(ctx: CodexNormalizerContext): string {
  try {
    const value = ctx.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  } catch {
    // Fall through to a stable valid timestamp for malformed caller context.
  }
  return "1970-01-01T00:00:00.000Z";
}

function unwrapCommand(command: string): string {
  const wrapped = command.match(/^"[^"\r\n]*powershell(?:\.exe)?"\s+-Command\s+'([\s\S]*)'$/i);
  return wrapped ? wrapped[1]!.replace(/''/g, "'") : command;
}

function isTestCommand(command: string, configured: string[]): boolean {
  const segments = command.split(/(?:&&|\|\||[;|\r\n])/);
  return segments.some((segment) => {
    const candidate = segment.trim().toLocaleLowerCase("en-US");
    return configured.some((testCommand) => {
      const prefix = testCommand.trim().toLocaleLowerCase("en-US");
      return prefix.length > 0 && candidate.startsWith(prefix)
        && (candidate.length === prefix.length || /\s/.test(candidate[prefix.length]!));
    });
  });
}

function relativeFilePath(filePath: string, repoRoot: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const normalizedRoot = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const pathLower = normalizedPath.toLocaleLowerCase("en-US");
  const rootLower = normalizedRoot.toLocaleLowerCase("en-US");
  if (pathLower === rootLower) return ".";
  if (pathLower.startsWith(`${rootLower}/`)) return normalizedPath.slice(normalizedRoot.length + 1);

  // Codex normally reports paths beneath the repository root. Keep unexpected
  // absolute paths from leaking drive or home-directory prefixes into events.
  const driveRelative = normalizedPath.replace(/^[A-Za-z]:\//, "").replace(/^\/+/, "");
  return driveRelative;
}

function parsedObject(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Normalize one codex exec --json line. Malformed and unknown input is represented as an event. */
export function normalizeCodexLine(line: string, ctx: CodexNormalizerContext): CodexNormalizerResult {
  const rawLine = typeof line === "string" ? line : safeText(line);
  const baseSeq = Number.isInteger(ctx?.seq) && ctx.seq >= 0 ? ctx.seq : 0;
  const rawLineNumber = Number.isInteger(ctx?.line) && ctx.line >= 0 ? ctx.line : 0;
  const runId = typeof ctx?.run_id === "string" ? ctx.run_id : "";
  const timestamp = eventTimestamp(ctx);
  const emitted: NormalizedEvent[] = [];
  const result: CodexNormalizerResult = { events: emitted };

  const push = (kind: NormalizedEvent["kind"], text: string): void => {
    const seq = baseSeq + emitted.length;
    emitted.push(NormalizedEventSchema.parse({
      run_id: runId,
      seq,
      ts: timestamp,
      kind,
      text: truncate(text),
      raw_line: rawLineNumber,
    }));
  };
  const unknown = (): CodexNormalizerResult => {
    push("unknown", rawLine);
    return result;
  };

  try {
    const record = parsedObject(rawLine);
    if (!record) return unknown();
    const type = record.type;

    if (type === "thread.started") {
      if (typeof record.thread_id === "string") result.sessionId = record.thread_id;
      return result;
    }
    if (type === "turn.started") return result;
    if (type === "turn.completed") {
      if (Object.hasOwn(record, "usage")) result.usage = record.usage;
      else if (Object.hasOwn(record, "total_token_usage")) result.usage = record.total_token_usage;
      return result;
    }

    if (type === "item.started" || type === "item.completed") {
      const item = record.item;
      if (item === null || typeof item !== "object" || Array.isArray(item)) return unknown();
      const itemRecord = item as Record<string, unknown>;
      const itemType = itemRecord.type;
      if (typeof itemType !== "string" || !knownItemTypes.has(itemType)) return unknown();

      if (type === "item.started") {
        if (itemType === "command_execution") push("exec", unwrapCommand(safeText(itemRecord.command)));
        return result;
      }

      if (itemType === "reasoning") {
        const text = safeText(itemRecord.text).replace(/\*\*([\s\S]*?)\*\*/g, "$1");
        if (itemRecord.text !== undefined) push("think", text);
        return result;
      }
      if (itemType === "agent_message") {
        if (itemRecord.text !== undefined) push("message", safeText(itemRecord.text));
        return result;
      }
      if (itemType === "command_execution") {
        const command = unwrapCommand(safeText(itemRecord.command));
        const exitCode = itemRecord.exit_code;
        if (isTestCommand(command, ctx.testCommands ?? defaultTestCommands)) {
          push(exitCode === 0 ? "test_pass" : "test_fail", exitCode === 0 ? command : `exit ${safeText(exitCode)}: ${command}`);
        } else if (typeof exitCode === "number" && exitCode !== 0) {
          push("exec", `exit ${exitCode}: ${command}`);
        }
        return result;
      }

      const changes = itemRecord.changes;
      if (!Array.isArray(changes)) return result;
      for (const change of changes) {
        if (change === null || typeof change !== "object" || Array.isArray(change)) continue;
        const changeRecord = change as Record<string, unknown>;
        const kind = safeText(changeRecord.kind);
        const filePath = safeText(changeRecord.path);
        push("edit", `${kind} ${relativeFilePath(filePath, typeof ctx?.repoRoot === "string" ? ctx.repoRoot : "")}`.trim());
      }
      return result;
    }

    return unknown();
  } catch {
    // Invalid fields or timestamps should never interrupt the stream consumer.
    emitted.length = 0;
    push("unknown", rawLine);
    return result;
  }
}
