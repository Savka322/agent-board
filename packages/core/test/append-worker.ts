import { appendEvents, closeStore, openStore } from "../src/store";

const [home, runId, label] = process.argv.slice(2);
if (!home || !runId || !label) throw new Error("Expected home, run id, and label");
process.env.AGENT_BOARD_HOME = home;

const store = openStore(home);
try {
  appendEvents(store, runId, Array.from({ length: 12 }, (_, index) => ({
    ts: "2026-01-01T00:00:00.000Z",
    kind: "message" as const,
    text: `${label}-${index}`,
    raw_line: index,
  })));
} finally {
  closeStore(store);
}
