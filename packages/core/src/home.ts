import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve the sole default location used for Agent Board user data. */
export function resolveHome(): string {
  const override = process.env.AGENT_BOARD_HOME;
  return override !== undefined ? override : join(homedir(), ".agent-board");
}
