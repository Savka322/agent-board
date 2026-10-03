import { BoardEventKindSchema, type BoardEventKind } from "@agent-board/contracts";
import { getBoardEventCursor, listBoardEventsAfter, type BoardEvent, type BoardStore } from "./store";

export interface WaitResult {
  events: BoardEvent[];
  cursor: number;
  timed_out: boolean;
}

export async function waitForBoardEvents(
  store: BoardStore,
  options: { kinds: BoardEventKind[]; after?: number; timeoutSeconds?: number; pollMs?: number },
): Promise<WaitResult> {
  if (options.kinds.length === 0) throw new TypeError("At least one board event kind is required");
  const kinds = [...new Set(options.kinds.map((kind) => BoardEventKindSchema.parse(kind)))];
  const cursor = options.after ?? getBoardEventCursor(store);
  if (!Number.isInteger(cursor) || cursor < 0) throw new TypeError("Event cursor must be an integer >= 0");
  if (options.timeoutSeconds !== undefined && (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds < 0)) {
    throw new TypeError("Timeout must be a non-negative number of seconds");
  }
  const pollMs = options.pollMs ?? 500;
  const deadline = options.timeoutSeconds === undefined ? null : Date.now() + options.timeoutSeconds * 1000;
  while (true) {
    const events = listBoardEventsAfter(store, cursor, kinds);
    if (events.length > 0) return { events, cursor: Math.max(...events.map((event) => event.seq)), timed_out: false };
    if (deadline !== null && Date.now() >= deadline) return { events: [], cursor, timed_out: true };
    const remaining = deadline === null ? pollMs : Math.min(pollMs, Math.max(0, deadline - Date.now()));
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}
