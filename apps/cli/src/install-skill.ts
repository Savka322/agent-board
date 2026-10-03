import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class SkillInstallRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillInstallRefusalError";
  }
}

function sourceDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../skills/agent-board");
}

function fileList(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return fileList(path, name);
    if (entry.isFile()) return [name];
    throw new Error(`Unsupported skill entry: ${path}`);
  }).sort();
}

function matches(source: string, target: string): boolean {
  try {
    const sourceFiles = fileList(source);
    const targetFiles = fileList(target);
    return sourceFiles.length === targetFiles.length && sourceFiles.every((name, index) => name === targetFiles[index]
      && readFileSync(join(source, name)).equals(readFileSync(join(target, name))));
  } catch {
    return false;
  }
}

export interface InstallSkillResult {
  target: string;
  files: string[];
  alreadyCurrent: boolean;
}

export function installSkill(options: { target?: string; force?: boolean; source?: string } = {}): InstallSkillResult {
  const source = options.source ?? sourceDirectory();
  if (!existsSync(source) || !lstatSync(source).isDirectory()) throw new Error(`Repository skill source is missing: ${source}`);
  const target = resolve(options.target ?? join(homedir(), ".claude", "skills", "agent-board"));
  const files = fileList(source);
  if (existsSync(target)) {
    if (matches(source, target)) return { target, files, alreadyCurrent: true };
    if (!options.force) throw new SkillInstallRefusalError(`Skill target exists with different contents: ${target}. Use --force to replace it.`);
    rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
  return { target, files, alreadyCurrent: false };
}
