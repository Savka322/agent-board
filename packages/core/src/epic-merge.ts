import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  emitBoardEvent,
  getEpic,
  getProject,
  hasWebMergeApproval,
  listTasksByEpic,
  updateEpicStatus,
  writeEpicLog,
  type BoardStore,
} from "./store";

export class EpicMergeRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpicMergeRefusalError";
  }
}

class GitFailure extends Error {
  constructor(readonly args: string[], readonly cwd: string, readonly status: number | null, readonly detail: string) {
    super(`git ${args.join(" ")} failed (${status ?? "unknown"}): ${detail.trim()}`);
    this.name = "GitFailure";
  }
}

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new GitFailure(args, cwd, result.status, `${result.stdout ?? ""}${result.stderr ?? ""}`);
  return result.stdout ?? "";
}

interface Worktree {
  path: string;
  branch: string | null;
}

function worktrees(repo: string): Worktree[] {
  const blocks = git(["worktree", "list", "--porcelain"], repo).trim().split(/\r?\n\r?\n/).filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split(/\r?\n/);
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    const branch = lines.find((line) => line.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length) ?? null;
    if (!path) throw new Error("Git returned a malformed worktree list");
    return { path, branch };
  });
}

function quoted(value: string): string {
  return `"${value.replaceAll("\"", "\\\"")}"`;
}

function manualCommands(repo: string, worktree: string, baseBranch: string, epicBranch: string): string {
  return [
    `git -C ${quoted(worktree)} status --short`,
    `git -C ${quoted(worktree)} stash push --include-untracked -m "agent-board: clear base branch for epic merge"`,
    `git -C ${quoted(worktree)} switch ${quoted(baseBranch)}`,
    `git -C ${quoted(worktree)} merge --no-ff --no-edit ${quoted(epicBranch)}`,
    `# Repository: ${quoted(repo)}`,
  ].join("\n");
}

function assertMergeTreeClean(repo: string, baseBranch: string, epicBranch: string): void {
  const result = spawnSync("git", ["merge-tree", "--write-tree", baseBranch, epicBranch], { cwd: repo, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new EpicMergeRefusalError(`Epic merge could not be preflighted cleanly. ${detail || "Check that the Git version supports git merge-tree --write-tree and resolve merge conflicts manually."}`);
  }
}

/** Merge an approved epic branch into its base without operating on a dirty base checkout. */
export function mergeEpic(store: BoardStore, epicId: string) {
  const epic = getEpic(store, epicId);
  if (!hasWebMergeApproval(store, epicId)) throw new EpicMergeRefusalError(`Epic ${epicId} has no web merge approval`);
  if (epic.status === "merged") throw new EpicMergeRefusalError(`Epic ${epicId} is already merged`);
  const tasks = listTasksByEpic(store, epicId);
  if (tasks.length === 0 || tasks.some((task) => task.status !== "done" && task.status !== "canceled")) {
    throw new EpicMergeRefusalError(`Epic ${epicId} is not ready: every task must be done or canceled`);
  }
  const profile = getProject(store, epic.project).profile;
  const repo = resolve(profile.repo);
  const baseBranch = profile.base_branch;
  const epicBranch = epic.branch;
  const baseWorktree = worktrees(repo).find((entry) => entry.branch === baseBranch);
  let mergeDirectory = baseWorktree?.path;
  let temporary = false;

  if (mergeDirectory) {
    const dirty = git(["status", "--porcelain=v1", "--untracked-files=no"], mergeDirectory).trim();
    if (dirty) {
      throw new EpicMergeRefusalError([
        `Base branch ${baseBranch} is checked out at ${mergeDirectory} and has tracked modifications. No files were changed.`,
        "After deciding how to handle the changes, run:",
        manualCommands(repo, mergeDirectory, baseBranch, epicBranch),
      ].join("\n"));
    }
  } else {
    const parent = join(store.home, "worktrees");
    mkdirSync(parent, { recursive: true });
    mergeDirectory = join(parent, `_merge-${crypto.randomUUID()}`);
    temporary = true;
    try {
      git(["worktree", "add", mergeDirectory, baseBranch], repo);
    } catch (error) {
      throw new EpicMergeRefusalError(`Could not create a temporary worktree for ${baseBranch}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let commit = "";
  try {
    assertMergeTreeClean(mergeDirectory!, baseBranch, epicBranch);
    git(["merge", "--no-ff", "--no-edit", epicBranch], mergeDirectory!);
    commit = git(["rev-parse", "HEAD"], mergeDirectory!).trim();
  } catch (error) {
    if (error instanceof EpicMergeRefusalError) throw error;
    if (error instanceof GitFailure && error.args[0] === "merge") {
      throw new EpicMergeRefusalError(`Git refused the epic merge: ${error.detail.trim() || error.message}`);
    }
    throw error;
  } finally {
    if (temporary && mergeDirectory && existsSync(mergeDirectory)) {
      const result = spawnSync("git", ["worktree", "remove", "--force", mergeDirectory], { cwd: repo, encoding: "utf8", windowsHide: true });
      if (result.error || result.status !== 0) {
        throw new Error(`Merged worktree cleanup failed for ${mergeDirectory}: ${result.stderr ?? result.error?.message ?? "git worktree remove failed"}`);
      }
    }
  }

  store.sqlite.exec("BEGIN IMMEDIATE");
  try {
    updateEpicStatus(store, epicId, "merged");
    writeEpicLog(store, { epic: epicId, actor: "claude", action: "merge", note: `Merged ${epicBranch} into ${baseBranch} (${commit})` });
    store.sqlite.exec("COMMIT");
  } catch (error) {
    try { store.sqlite.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
    throw error;
  }
  emitBoardEvent(store, { kind: "epic_merged", epic: epicId, payload: { base_branch: baseBranch, branch: epicBranch, commit } }, { epic: epicId });
  return { epic: epicId, branch: epicBranch, merged_into: baseBranch, commit };
}
