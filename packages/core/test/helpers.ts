import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStore, openStore, type BoardStore } from "../src/store";

export function installFreshHome(openDatabase = true) {
  let home = "";
  let store: BoardStore | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.AGENT_BOARD_HOME;
    home = mkdtempSync(join(tmpdir(), "agent-board-core-test-"));
    process.env.AGENT_BOARD_HOME = home;
    store = openDatabase ? openStore() : undefined;
  });

  afterEach(() => {
    try {
      if (store) closeStore(store);
    } finally {
      store = undefined;
      if (previousHome === undefined) delete process.env.AGENT_BOARD_HOME;
      else process.env.AGENT_BOARD_HOME = previousHome;
      if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  return {
    get home(): string { return home; },
    get store(): BoardStore {
      if (!store) throw new Error("This test did not open a store");
      return store;
    },
    close(): void {
      if (store) closeStore(store);
      store = undefined;
    },
    reopen(): BoardStore {
      store = openStore(home);
      return store;
    },
  };
}

export function writeProfile(home: string, name = "sample"): string {
  const path = join(home, "projects", `${name}.toml`);
  const toml = [
    `name = ${JSON.stringify(name)}`,
    `repo = ${JSON.stringify("C:\\work\\repo")}`,
    `base_branch = "main"`,
    `epic_branch_pattern = "epic/{epic}"`,
    "light_tests = [\"bun test\"]",
    "gates = [{ cmd = \"bun test\", ram_est_gb = 2 }]",
    "data_links = []",
    "forbidden = []",
    "rules = []",
    "[executor]",
    "kind = \"codex\"",
    "model = \"codex-test-model\"",
    "effort = \"medium\"",
    "sandbox = \"workspace-write\"",
    "extra_config = []",
    "",
  ].join("\n");
  writeFileSync(path, toml, "utf8");
  return path;
}
