import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync, linkSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProjectProfile } from "@agent-board/contracts";
import { getEpic, getProject, getTask, type BoardStore } from "./store";

export class GitCommandError extends Error {
  constructor(readonly args: string[], readonly cwd: string, readonly exitCode: number, readonly output: string) {
    super(`git ${args.join(" ")} failed (${exitCode}): ${output.trim()}`);
    this.name = "GitCommandError";
  }
}

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new GitCommandError(args, cwd, result.status ?? 1, `${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return result.stdout;
}

function hasLocalBranch(repo: string, branch: string): boolean {
  const result = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: repo,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new GitCommandError(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repo, result.status ?? 1, String(result.stderr ?? ""));
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..") {
    throw new TypeError(`${label} must be a simple path segment`);
  }
  return value;
}

function profileForEpic(store: BoardStore, epicId: string): ProjectProfile {
  const epic = getEpic(store, epicId);
  return getProject(store, epic.project).profile;
}

export function epicBranchName(profile: ProjectProfile, epicId: string): string {
  return profile.epic_branch_pattern.replaceAll("{epic}", epicId);
}

export function getEpicWorktreePath(store: BoardStore, project: string, epicId: string): string {
  safeSegment(project, "Project name");
  safeSegment(epicId, "Epic id");
  return join(store.home, "worktrees", project, `_epic-${epicId}`);
}

export function getTaskWorktreePath(store: BoardStore, taskId: string): string {
  const task = getTask(store, taskId);
  const epic = getEpic(store, task.epic);
  safeSegment(epic.project, "Project name");
  safeSegment(task.id, "Task id");
  return join(store.home, "worktrees", epic.project, task.id);
}

function verifyExistingWorktree(path: string, expectedBranch: string): void {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], path).trim();
  if (branch !== expectedBranch) throw new Error(`Worktree ${path} is on ${branch}; expected ${expectedBranch}`);
}

export function ensureEpicWorktree(store: BoardStore, epicId: string): string {
  const epic = getEpic(store, epicId);
  const profile = getProject(store, epic.project).profile;
  const branch = epicBranchName(profile, epicId);
  const repo = resolve(profile.repo);
  if (!existsSync(repo)) throw new Error(`Project repository does not exist: ${repo}`);
  if (!hasLocalBranch(repo, branch)) git(["branch", branch, profile.base_branch], repo);

  const path = getEpicWorktreePath(store, epic.project, epicId);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) verifyExistingWorktree(path, branch);
  else git(["worktree", "add", path, branch], repo);
  return path;
}

function applyDataLinks(worktree: string, profile: ProjectProfile): string[] {
  const destinations: string[] = [];
  for (const dataLink of profile.data_links) {
    const source = resolve(dataLink.from);
    const destination = resolve(worktree, dataLink.to.replace(/[\\/]+/g, sep));
    const relativeDestination = relative(resolve(worktree), destination);
    if (relativeDestination === ".." || relativeDestination.startsWith(`..${sep}`) || isAbsolute(relativeDestination)) {
      throw new Error(`Data link destination escapes the worktree: ${dataLink.to}`);
    }
    if (!existsSync(source)) throw new Error(`Data link source does not exist (${dataLink.to}): ${source}`);
    mkdirSync(dirname(destination), { recursive: true });
    const sourceIsDirectory = statSync(source).isDirectory();
    if (existsSync(destination) || (() => { try { lstatSync(destination); return true; } catch { return false; } })()) {
      const existing = lstatSync(destination);
      const sameTarget = sourceIsDirectory && existing.isSymbolicLink()
        && realpathSync(destination).toLocaleLowerCase("en-US") === realpathSync(source).toLocaleLowerCase("en-US");
      const destinationStats = statSync(destination);
      const sameHardLink = !sourceIsDirectory && existing.isFile() && destinationStats.isFile()
        && destinationStats.dev === statSync(source).dev && destinationStats.ino === statSync(source).ino;
      if (dataLink.mode === "link" && (sameTarget || sameHardLink)) {
        destinations.push(relativeDestination.replace(/\\/g, "/"));
        continue;
      }
      if (dataLink.mode === "copy") {
        if (sameTarget || sameHardLink) unlinkSync(destination);
        else if (existing.isSymbolicLink() || (sourceIsDirectory ? !destinationStats.isDirectory() : !destinationStats.isFile())) {
          throw new Error(`Data copy destination has an incompatible entry: ${dataLink.to}`);
        } else {
          destinations.push(relativeDestination.replace(/\\/g, "/"));
          continue;
        }
      } else {
        throw new Error(`Data link destination already exists: ${dataLink.to}`);
      }
    }
    try {
      if (dataLink.mode === "copy") {
        cpSync(source, destination, { recursive: true, force: false, errorOnExist: true, dereference: true });
      } else if (sourceIsDirectory) {
        // Link mode shares executor writes with the source tree; copy mode is safer for mutable data.
        symlinkSync(source, destination, "junction");
      } else {
        // A hard link shares file contents, so executor writes reach the source file.
        linkSync(source, destination);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (dataLink.mode === "copy") throw new Error(`Could not copy data into the worktree (${dataLink.to}): ${detail}`);
      if (sourceIsDirectory) throw new Error(`Could not create data directory junction ${dataLink.to}: ${detail}`);
      throw new Error(`Could not hard-link data file ${dataLink.to} (source and worktree may be on different volumes): ${detail}`);
    }
    destinations.push(relativeDestination.replace(/\\/g, "/"));
  }
  return destinations;
}

export interface EnsuredTaskWorktree {
  path: string;
  branch: string;
  epicPath: string;
  dataLinkPaths: string[];
}

export function ensureTaskWorktree(store: BoardStore, taskId: string): EnsuredTaskWorktree {
  const task = getTask(store, taskId);
  const epic = getEpic(store, task.epic);
  const profile = getProject(store, epic.project).profile;
  const epicPath = ensureEpicWorktree(store, epic.id);
  const repo = resolve(profile.repo);
  const path = getTaskWorktreePath(store, task.id);
  const branch = `agent/${task.id}`;
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) verifyExistingWorktree(path, branch);
  else if (hasLocalBranch(repo, branch)) git(["worktree", "add", path, branch], repo);
  else git(["worktree", "add", "-b", branch, path, epicBranchName(profile, epic.id)], repo);
  const dataLinkPaths = applyDataLinks(path, profile);
  return { path, branch, epicPath, dataLinkPaths };
}

function isWithin(parent: string, candidate: string): boolean {
  const child = relative(resolve(parent), resolve(candidate));
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

export function removeLeftoverWorktree(path: string): void {
  if (!existsSync(path)) return;
  if (process.platform === "win32") {
    const result = spawnSync("cmd.exe", ["/d", "/s", "/c", `rmdir /s /q "${path}"`], {
      encoding: "utf8",
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Could not remove leftover worktree directory ${path}: ${result.stderr ?? result.error?.message ?? "rmdir failed"}`);
    }
  } else {
    rmSync(path, { recursive: true, force: true });
  }
}

function removeDataDirectoryJunctions(worktree: string, profile: ProjectProfile): void {
  for (const dataLink of profile.data_links) {
    const source = resolve(dataLink.from);
    if (!existsSync(source) || !statSync(source).isDirectory()) continue;
    const destination = resolve(worktree, dataLink.to.replace(/[\\/]+/g, sep));
    if (!existsSync(destination)) continue;
    if (lstatSync(destination).isSymbolicLink()) removeLeftoverWorktree(destination);
  }
}

export function removeTaskWorktree(store: BoardStore, taskId: string): void {
  const task = getTask(store, taskId);
  const epic = getEpic(store, task.epic);
  const profile = getProject(store, epic.project).profile;
  const path = getTaskWorktreePath(store, taskId);
  const repo = resolve(profile.repo);
  if (!isWithin(join(store.home, "worktrees"), path)) throw new Error("Refusing to remove a path outside the worktree home");

  if (existsSync(path)) {
    // Git for Windows can recurse through data-link junctions and erase their targets.
    removeDataDirectoryJunctions(path, profile);
    const result = spawnSync("git", ["worktree", "remove", "--force", path], { cwd: repo, encoding: "utf8", windowsHide: true });
    if (result.error) throw result.error;
    if (existsSync(path)) {
      // Bun may leave junction-containing worktree folders behind on Windows.
      removeLeftoverWorktree(path);
    }
  }
  git(["worktree", "prune"], repo);
  if (hasLocalBranch(repo, `agent/${taskId}`)) git(["branch", "-D", `agent/${taskId}`], repo);
}

export function changedFiles(store: BoardStore, taskId: string): string[] {
  const task = getTask(store, taskId);
  const profile = profileForEpic(store, task.epic);
  const worktree = getTaskWorktreePath(store, taskId);
  const bytes = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: worktree, windowsHide: true, encoding: "buffer" });
  const rawEntries = bytes.toString("utf8").split("\0");
  const changed: string[] = [];
  for (let index = 0; index < rawEntries.length; index += 1) {
    const entry = rawEntries[index]!;
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3).replace(/\\/g, "/");
    changed.push(path);
    if (status.includes("R") || status.includes("C")) {
      const previous = rawEntries[index + 1];
      if (previous) changed.push(previous.replace(/\\/g, "/"));
      index += 1;
    }
  }
  const excluded = profile.data_links.map((link) => link.to.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""));
  return [...new Set(changed)].filter((path) => !excluded.some((linkPath) => path === linkPath || path.startsWith(`${linkPath}/`))).sort();
}

export function gitOutput(args: string[], cwd: string): string {
  return git(args, cwd);
}
