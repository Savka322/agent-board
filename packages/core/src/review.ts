import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { ExecutorReportSchema, type ExecutorReport } from "@agent-board/contracts";
import { getEpic, getProject, getTask, getRun, listRecentEvents, listRunsForTask, recordAcceptedAssumptions, transitionTask, type BoardStore } from "./store";
import { changedFiles, getEpicWorktreePath, getTaskWorktreePath, gitOutput, removeTaskWorktree } from "./worktrees";

export class AcceptanceRefusedError extends Error {
  constructor(message: string, readonly code: "outside_allowed" | "merge_conflict" | "commit_failed" | "wrong_status" = "outside_allowed") {
    super(message);
    this.name = "AcceptanceRefusedError";
  }
}

function allowedBy(files: string[], patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const normalizedPattern = pattern.replace(/\\/g, "/");
    const normalizedFile = files[0]!.replace(/\\/g, "/");
    const insensitive = process.platform === "win32";
    return new Bun.Glob(insensitive ? normalizedPattern.toLocaleLowerCase("en-US") : normalizedPattern)
      .match(insensitive ? normalizedFile.toLocaleLowerCase("en-US") : normalizedFile);
  });
}

function reportForPath(path: string | null): ExecutorReport | null {
  if (!path || !existsSync(path)) return null;
  try {
    return ExecutorReportSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

function porcelainNewFiles(worktree: string, changed: string[]): string[] {
  const result = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: worktree,
    encoding: "buffer",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr ?? ""}`);
  const changedSet = new Set(changed);
  return result.stdout.toString("utf8").split("\0").filter((path) => path.length > 0 && changedSet.has(path.replace(/\\/g, "/"))).map((path) => path.replace(/\\/g, "/")).sort();
}

export function reviewSummary(store: BoardStore, taskId: string) {
  const task = getTask(store, taskId);
  const worktree = getTaskWorktreePath(store, taskId);
  const files = changedFiles(store, taskId);
  const outside = files.filter((file) => !allowedBy([file], task.allowedFiles));
  const runs = listRunsForTask(store, taskId);
  const lastRun = runs.at(-1);
  const run = lastRun ? getRun(store, lastRun.id) : null;
  const diffStat = gitOutput(["diff", "--stat"], worktree).trim();
  const newFiles = porcelainNewFiles(worktree, files);
  const events = run ? listRecentEvents(store, run.id, 20) : [];
  return {
    task: task.id,
    status: task.status,
    changed_files: files.map((path) => ({ path, outside_allowed: outside.includes(path) })),
    diff_stat: diffStat,
    new_files: newFiles,
    report: run ? reportForPath(run.reportPath) : null,
    events,
  };
}

export interface AcceptOptions {
  allowExtraReason?: string;
}

export function acceptTask(store: BoardStore, taskId: string, options: AcceptOptions = {}) {
  const task = getTask(store, taskId);
  if (task.status !== "review") throw new AcceptanceRefusedError(`Task ${taskId} is ${task.status}; accept requires review`, "wrong_status");

  const epic = getEpic(store, task.epic);
  const profile = getProject(store, epic.project).profile;
  const worktree = getTaskWorktreePath(store, taskId);
  const epicWorktree = getEpicWorktreePath(store, epic.project, epic.id);
  const workingTreeFiles = changedFiles(store, taskId);
  const committedFiles = committedFilesAheadOfEpic(worktree, epic.branch, task.id);
  const files = [...new Set([...workingTreeFiles, ...committedFiles])].sort();
  if (files.length === 0) throw new AcceptanceRefusedError("There is nothing to accept", "commit_failed");
  const outside = files.filter((file) => !allowedBy([file], task.allowedFiles));
  if (outside.length > 0 && !options.allowExtraReason?.trim()) {
    throw new AcceptanceRefusedError(`Files outside allowed_files: ${outside.join(", ")}. Supply --allow-extra with a reason.`, "outside_allowed");
  }

  if (workingTreeFiles.length > 0) {
    runGitChecked(["add", "--", ...workingTreeFiles], worktree, "Could not stage task changes");
    const commit = runGit(["commit", "-m", `${task.id}: ${task.title}`, "-m", `Executed-by: codex/${profile.executor.model}`], worktree);
    if (commit.status !== 0) {
      throw new AcceptanceRefusedError(`Commit failed:\n${`${commit.stdout}${commit.stderr}`.trim()}`, "commit_failed");
    }
  }
  const commitId = runGit(["rev-parse", "HEAD"], worktree).stdout.trim();

  const merge = runGit(["merge", "--no-ff", "--no-edit", `agent/${task.id}`], epicWorktree);
  if (merge.status !== 0) {
    const conflicts = runGit(["diff", "--name-only", "--diff-filter=U"], epicWorktree).stdout.trim().split(/\r?\n/).filter(Boolean);
    const abort = runGit(["merge", "--abort"], epicWorktree);
    const detail = conflicts.length > 0 ? conflicts.join(", ") : `${merge.stdout}${merge.stderr}`.trim();
    if (abort.status !== 0) throw new Error(`Merge conflicted (${detail}) and git merge --abort failed: ${abort.stderr.trim()}`);
    throw new AcceptanceRefusedError(`Merge conflict in: ${detail}`, "merge_conflict");
  }

  const note = options.allowExtraReason?.trim();
  transitionTask(store, taskId, "accept", "claude", 5, note);
  // Accepting the result accepts the assumptions of the run it came from.
  const lastRun = listRunsForTask(store, taskId).at(-1);
  const report = lastRun ? reportForPath(getRun(store, lastRun.id).reportPath) : null;
  const decisions = recordAcceptedAssumptions(store, epic.project, report?.assumptions ?? []);
  removeTaskWorktree(store, taskId);
  return { task: taskId, commit: commitId, merged_into: epic.branch, removed_worktree: true, decisions };
}

export function rejectTask(store: BoardStore, taskId: string) {
  return transitionTask(store, taskId, "reject", "claude");
}

function runGit(args: string[], cwd: string) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function committedFilesAheadOfEpic(worktree: string, epicBranch: string, taskId: string): string[] {
  const result = spawnSync("git", ["diff", "--name-only", "-z", `${epicBranch}...agent/${taskId}`], {
    cwd: worktree,
    encoding: "buffer",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git diff ${epicBranch}...agent/${taskId} failed: ${result.stderr ?? ""}`);
  return result.stdout.toString("utf8").split("\0").filter(Boolean).map((path) => path.replace(/\\/g, "/")).sort();
}

function runGitChecked(args: string[], cwd: string, message: string): void {
  const result = runGit(args, cwd);
  if (result.status !== 0) throw new AcceptanceRefusedError(`${message}: ${`${result.stdout}${result.stderr}`.trim()}`, "commit_failed");
}
