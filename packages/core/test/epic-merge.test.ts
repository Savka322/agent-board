import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addApproval, addProject, addTask, closeStore, createEpic, getEpic, listBoardEventsAfter, listEpicLog, mergeEpic, openStore, renderCardFile, transitionTask, type BoardStore } from "../src";

let temporary = "";
let activeStore: BoardStore | undefined;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? result.stdout}`);
  return result.stdout ?? "";
}

function setup(withApproval = true): { store: BoardStore; repo: string; epic: string; home: string } {
  const home = mkdtempSync(join(tmpdir(), "agent-board-epic-merge-"));
  temporary = home;
  const repo = join(home, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-b", "main", repo], { encoding: "utf8", windowsHide: true });
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "base.txt"), "base\n", "utf8");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base");
  git(repo, "switch", "-c", "epic/EPIC-1");
  writeFileSync(join(repo, "feature.txt"), "feature\n", "utf8");
  git(repo, "add", "feature.txt");
  git(repo, "commit", "-m", "epic feature");
  git(repo, "switch", "main");

  const store = openStore(home);
  activeStore = store;
  const repoToml = repo.replace(/\\/g, "\\\\");
  writeFileSync(join(home, "projects", "sample.toml"), [
    'name = "sample"', `repo = "${repoToml}"`, 'base_branch = "main"',
    'epic_branch_pattern = "epic/{epic}"', "light_tests = []", "gates = []", "data_links = []",
    "forbidden = []", "rules = []", "[executor]", 'kind = "codex"', 'model = "codex-test"',
    'effort = "medium"', 'sandbox = "workspace-write"', "extra_config = []", "",
  ].join("\n"), "utf8");
  addProject(store, "sample");
  const epic = createEpic(store, { id: "EPIC-1", project: "sample", title: "Merge epic", branch: "epic/EPIC-1" });
  const card = { id: "AB-1", title: "Completed task", epic: epic.id, goal: "Finish feature", allowed_files: ["feature.txt"], deps: [], decisions: [], light_tests: [], gates: [], acceptance: ["Feature is merged"] };
  const cardPath = join(home, "AB-1.md");
  writeFileSync(cardPath, renderCardFile(card), "utf8");
  const task = addTask(store, epic.id, cardPath);
  transitionTask(store, task.id, "cancel", "owner");
  if (withApproval) addApproval(store, { epic: epic.id, kind: "merge", source: "web" });
  return { store, repo, epic: epic.id, home };
}

afterEach(() => {
  if (activeStore) closeStore(activeStore);
  activeStore = undefined;
  if (temporary) rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  temporary = "";
});

describe("epic merge", () => {
  test("refuses without web approval", () => {
    const fixture = setup(false);
    expect(() => mergeEpic(fixture.store, fixture.epic)).toThrow("no web merge approval");
  });

  test("merges clean base branch with --no-ff and records status, history, and event", () => {
    const fixture = setup();
    const result = mergeEpic(fixture.store, fixture.epic);
    expect(result.merged_into).toBe("main");
    expect(readFileSync(join(fixture.repo, "feature.txt"), "utf8").trim()).toBe("feature");
    expect(git(fixture.repo, "rev-list", "--parents", "-n", "1", "HEAD").trim().split(/\s+/)).toHaveLength(3);
    expect(getEpic(fixture.store, fixture.epic).status).toBe("merged");
    expect(listEpicLog(fixture.store, fixture.epic)).toMatchObject([{ actor: "claude", action: "merge" }]);
    expect(listBoardEventsAfter(fixture.store, 0).some((event) => event.kind === "epic_merged" && event.epic === fixture.epic)).toBe(true);
  });

  test("refuses a tracked modification without changing the dirty base working copy", () => {
    const fixture = setup();
    writeFileSync(join(fixture.repo, "base.txt"), "local modification\n", "utf8");
    const beforeStatus = git(fixture.repo, "status", "--porcelain=v1", "--untracked-files=no");
    expect(() => mergeEpic(fixture.store, fixture.epic)).toThrow(/tracked modifications[\s\S]*git -C/);
    expect(readFileSync(join(fixture.repo, "base.txt"), "utf8")).toBe("local modification\n");
    expect(git(fixture.repo, "status", "--porcelain=v1", "--untracked-files=no")).toBe(beforeStatus);
    expect(git(fixture.repo, "worktree", "list", "--porcelain")).not.toContain("_merge-");
  });

  test("uses and removes a temporary worktree when the base branch is not checked out", () => {
    const fixture = setup();
    git(fixture.repo, "switch", "epic/EPIC-1");
    const result = mergeEpic(fixture.store, fixture.epic);
    expect(result.merged_into).toBe("main");
    expect(git(fixture.repo, "show", "main:feature.txt").trim()).toBe("feature");
    expect(git(fixture.repo, "worktree", "list", "--porcelain")).not.toContain("_merge-");
  });
});
