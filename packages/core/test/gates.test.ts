import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Gate } from "@agent-board/contracts";
import { addProject, addTask, closeStore, createEpic, getGateStats, listGateRunsForTask, openStore, setSetting, type BoardStore } from "../src/store";
import { removeTaskWorktree } from "../src/worktrees";
import { BYTES_PER_MB } from "../src/memory/ledger";
import { renderCardFile } from "../src/cards";
import type { TaskCard } from "@agent-board/contracts";

const GIB = 1024 ** 3;
let tempRoot = "";
let home = "";
let repo = "";
let markerPath = "";
let cardPath = "";
let store: BoardStore | undefined;
let oldHome: string | undefined;
let oldMarker: string | undefined;

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, windowsHide: true, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr ?? result.error?.message ?? result.status}`);
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function command(mode: string, name: string): string {
  return `${quote(process.execPath)} ${quote(join(repo, "gate-work.ts"))} ${mode} ${name}`;
}

function runGateCli() {
  const entrypoint = join(import.meta.dir, "../../../apps/cli/src/index.ts");
  return spawnSync(process.execPath, [entrypoint, "gate", "GATE-1", "--json"], {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
    encoding: "utf8",
  });
}

function writeTaskGates(gates: Gate[]): void {
  const card: TaskCard = {
    id: "GATE-1",
    title: "Exercise gate leases",
    epic: "EPIC-1",
    goal: "Run memory-limited project gates.",
    allowed_files: ["**"],
    deps: [],
    decisions: [],
    light_tests: [],
    gates,
    acceptance: ["Gate execution is memory bounded."],
  };
  cardPath = join(tempRoot, "gate-task.md");
  writeFileSync(cardPath, renderCardFile(card), "utf8");
  addTask(store!, "EPIC-1", cardPath);
}

function setup(): void {
  oldHome = process.env.AGENT_BOARD_HOME;
  oldMarker = process.env.AGENT_BOARD_GATE_MARKERS;
  tempRoot = mkdtempSync(join(tmpdir(), "agent-board-gates-"));
  home = join(tempRoot, "agent board home");
  repo = join(tempRoot, "repo");
  markerPath = join(tempRoot, "gate markers.txt");
  mkdirSync(repo, { recursive: true });
  run("git", ["init", "-b", "main", repo], tempRoot);
  writeFileSync(join(repo, "README.md"), "temporary gates integration repo\n", "utf8");
  writeFileSync(join(repo, "gate-work.ts"), [
    'import { appendFileSync } from "node:fs";',
    'const [mode, name] = process.argv.slice(2);',
    'const marker = process.env.AGENT_BOARD_GATE_MARKERS!;',
    'appendFileSync(marker, `start:${name}:${Date.now()}\\n`);',
    'if (mode === "oom" && process.platform === "win32") {',
    '  const held: Uint8Array[] = [];',
    '  try {',
    '    for (let index = 0; index < 48; index += 1) {',
    '      const block = new Uint8Array(32 * 1024 * 1024);',
    '      for (let offset = 0; offset < block.length; offset += 4096) block[offset] = 1;',
    '      held.push(block);',
    '    }',
    '  } catch (error) { console.error(error); process.exitCode = 2; }',
    '} else if (mode === "oom") {',
    '  console.error("Out of memory");',
    '  process.exitCode = 2;',
    '} else if (mode === "fail") {',
    '  console.error("gate test failure");',
    '  process.exitCode = 1;',
    '} else {',
    '  await Bun.sleep(600);',
    '}',
    'appendFileSync(marker, `end:${name}:${Date.now()}\\n`);',
    "",
  ].join("\n"), "utf8");
  run("git", ["add", "README.md", "gate-work.ts"], repo);
  run("git", ["-c", "user.name=Agent Board Test", "-c", "user.email=agent-board-test@example.invalid", "commit", "-m", "initial"], repo);

  process.env.AGENT_BOARD_HOME = home;
  process.env.AGENT_BOARD_GATE_MARKERS = markerPath;
  mkdirSync(join(home, "projects"), { recursive: true });
  const profile = [
    'name = "sample"',
    `repo = ${JSON.stringify(repo)}`,
    'base_branch = "main"',
    'epic_branch_pattern = "epic/{epic}"',
    'light_tests = []',
    'gates = []',
    'data_links = []',
    'forbidden = []',
    'rules = []',
    '[executor]',
    'kind = "codex"',
    'model = "codex-test-model"',
    'effort = "medium"',
    'sandbox = "workspace-write"',
    'extra_config = []',
    "",
  ].join("\n");
  writeFileSync(join(home, "projects", "sample.toml"), profile, "utf8");
  store = openStore(home);
  const project = addProject(store, "sample");
  createEpic(store, { id: "EPIC-1", project: project.name, title: "Gate test", branch: "epic/gates" });
  setSetting(store, "memory_limit_gb", 600 * BYTES_PER_MB / GIB);
}

describe("memory-limited gate launcher", () => {
  beforeEach(setup);

  afterEach(() => {
    if (store) {
      try {
        if (store.sqlite.query("SELECT id FROM tasks WHERE id = ?").get("GATE-1")) removeTaskWorktree(store, "GATE-1");
      } finally {
        closeStore(store);
        store = undefined;
      }
    }
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    if (oldHome === undefined) delete process.env.AGENT_BOARD_HOME;
    else process.env.AGENT_BOARD_HOME = oldHome;
    if (oldMarker === undefined) delete process.env.AGENT_BOARD_GATE_MARKERS;
    else process.env.AGENT_BOARD_GATE_MARKERS = oldMarker;
  });

  test("600 MB admission serializes two 400 MB gates and reports why the second waits", async () => {
    writeTaskGates([
      { cmd: command("sleep", "first"), ram_est_gb: 400 * BYTES_PER_MB / GIB },
      { cmd: command("sleep", "second"), ram_est_gb: 400 * BYTES_PER_MB / GIB },
    ]);
    const cli = runGateCli();
    expect(cli.status).toBe(0);
    const result = JSON.parse(cli.stdout) as Array<{ id: string; cmd: string; status: string }>;
    expect(cli.stderr).toContain("Gate queued");
    expect(cli.stderr).toContain("needs 512 MB");
    expect(result.find(({ cmd }) => cmd.includes("first"))?.status).toBe("pass");
    expect(result.find(({ cmd }) => cmd.includes("second"))?.status).toBe("pass");
    expect((store!.sqlite.query("SELECT COUNT(*) AS count FROM memory_leases").get() as { count: number }).count).toBe(0);
    const entries = readFileSync(markerPath, "utf8").trim().split(/\r?\n/).map((line) => {
      const [event, name, timestamp] = line.split(":");
      return { event, name, timestamp: Number(timestamp) };
    });
    const intervals = ["first", "second"].map((name) => ({
      start: entries.find((entry) => entry.event === "start" && entry.name === name)!.timestamp,
      end: entries.find((entry) => entry.event === "end" && entry.name === name)!.timestamp,
    })).sort((first, second) => first.start - second.start);
    expect(intervals[0]!.end).toBeLessThanOrEqual(intervals[1]!.start);
  }, { timeout: 30_000 });

  test("classifies OOM separately, retries it exclusively once, and records failures and peaks", async () => {
    setSetting(store!, "memory_limit_gb", 512 * BYTES_PER_MB / GIB);
    writeTaskGates([
      { cmd: command("oom", "oom"), ram_est_gb: 400 * BYTES_PER_MB / GIB },
      { cmd: command("sleep", "peer"), ram_est_gb: 400 * BYTES_PER_MB / GIB },
      { cmd: command("fail", "fail"), ram_est_gb: 400 * BYTES_PER_MB / GIB },
    ]);
    const cli = runGateCli();
    expect(cli.status).toBe(2);
    const result = JSON.parse(cli.stdout) as Array<{ id: string; cmd: string; status: string; exit_code: number | null; peak_commit_bytes: number | null }>;
    const oomResult = result.find(({ cmd }) => cmd.includes("oom"))!;
    expect(oomResult.status).toBe("oom");
    expect(result.find(({ cmd }) => cmd.includes("peer"))?.status).toBe("pass");
    expect(result.find(({ cmd }) => cmd.includes("fail"))?.status).toBe("fail");
    expect((store!.sqlite.query("SELECT COUNT(*) AS count FROM memory_leases").get() as { count: number }).count).toBe(0);
    expect(result.find(({ cmd }) => cmd.includes("oom"))?.exit_code).not.toBe(0);
    expect(result.find(({ cmd }) => cmd.includes("fail"))?.exit_code).toBe(1);
    expect(cli.stderr).toContain("needs 512 MB");
    const oomStarts = readFileSync(markerPath, "utf8").trim().split(/\r?\n/)
      .filter((line) => line.startsWith("start:oom:"));
    expect(oomStarts).toHaveLength(2);
    if (process.platform === "win32") {
      const passing = result.find(({ cmd }) => cmd.includes("peer"))!;
      expect(passing.peak_commit_bytes).toBeGreaterThan(0);
      const hash = createHash("sha256").update(passing.cmd, "utf8").digest("hex");
      expect(getGateStats(store!, "sample", hash).peakCommitMaxBytes).toBe(passing.peak_commit_bytes);
      const lines = readFileSync(markerPath, "utf8").trim().split(/\r?\n/);
      const peerEnd = Number(lines.find((line) => line.startsWith("end:peer:"))!.split(":")[2]);
      const oomRetryStart = Number(oomStarts[1]!.split(":")[2]);
      const failEnd = Number(lines.find((line) => line.startsWith("end:fail:"))!.split(":")[2]);
      expect(oomRetryStart).toBeGreaterThanOrEqual(Math.max(peerEnd, failEnd));
    } else {
      expect(result.find(({ cmd }) => cmd.includes("peer"))?.peak_commit_bytes).toBeNull();
    }
  }, { timeout: 30_000 });
});
