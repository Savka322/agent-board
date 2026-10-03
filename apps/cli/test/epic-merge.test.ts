import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeStore, createEpic, openStore, projects } from "@agent-board/core";

describe("agentctl epic merge", () => {
  test("exits 2 when the epic has no web approval", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-board-cli-merge-"));
    const previousHome = process.env.AGENT_BOARD_HOME;
    const store = openStore(home);
    store.db.insert(projects).values({ name: "sample", profilePath: "", createdAt: new Date().toISOString() }).run();
    createEpic(store, { id: "EPIC-1", project: "sample", title: "No approval", branch: "epic/EPIC-1" });
    closeStore(store);
    try {
      const entrypoint = fileURLToPath(new URL("../src/index.ts", import.meta.url));
      const result = spawnSync(process.execPath, [entrypoint, "epic", "merge", "EPIC-1", "--json"], {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGENT_BOARD_HOME: home },
      });
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout ?? "")).toMatchObject({ code: "refused", error: expect.stringContaining("no web merge approval") });
    } finally {
      if (previousHome === undefined) delete process.env.AGENT_BOARD_HOME;
      else process.env.AGENT_BOARD_HOME = previousHome;
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
