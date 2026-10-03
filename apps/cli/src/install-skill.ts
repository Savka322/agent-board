import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class SkillInstallRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillInstallRefusalError";
  }
}

/** Placeholder in the repository skill, replaced with the command that runs agentctl on this machine. */
export const AGENTCTL_PLACEHOLDER = "{{agentctl}}";

function sourceDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../skills/agent-board");
}

/** A session in another repository cannot use `bun run agentctl`, so the skill gets an absolute entry point. */
export function defaultAgentctlCommand(): string {
  const entry = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts").replaceAll("\\", "/");
  return `bun "${entry}"`;
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

function rendered(source: string, name: string, command: string): Buffer {
  const content = readFileSync(join(source, name));
  if (!name.endsWith(".md")) return content;
  return Buffer.from(content.toString("utf8").replaceAll(AGENTCTL_PLACEHOLDER, command), "utf8");
}

function matches(source: string, target: string, command: string): boolean {
  try {
    const sourceFiles = fileList(source);
    const targetFiles = fileList(target);
    return sourceFiles.length === targetFiles.length && sourceFiles.every((name, index) => name === targetFiles[index]
      && rendered(source, name, command).equals(readFileSync(join(target, name))));
  } catch {
    return false;
  }
}

export interface InstallSkillResult {
  target: string;
  files: string[];
  command: string;
  alreadyCurrent: boolean;
}

export function installSkill(options: { target?: string; force?: boolean; source?: string; command?: string } = {}): InstallSkillResult {
  const source = options.source ?? sourceDirectory();
  if (!existsSync(source) || !lstatSync(source).isDirectory()) throw new Error(`Repository skill source is missing: ${source}`);
  const target = resolve(options.target ?? join(homedir(), ".claude", "skills", "agent-board"));
  const command = options.command ?? defaultAgentctlCommand();
  const files = fileList(source);
  if (existsSync(target)) {
    if (matches(source, target, command)) return { target, files, command, alreadyCurrent: true };
    if (!options.force) throw new SkillInstallRefusalError(`Skill target exists with different contents: ${target}. Use --force to replace it.`);
    rmSync(target, { recursive: true, force: true });
  }
  for (const name of files) {
    const path = join(target, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rendered(source, name, command), { flag: "wx" });
  }
  return { target, files, command, alreadyCurrent: false };
}
