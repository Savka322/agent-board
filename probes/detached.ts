import { appendFile, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { bunCommand, killTree, makeTempDir, removeTempDir, report, runCaptured, waitFor } from "./common.ts";

const scriptPath = import.meta.path;

async function heartbeatMode(path: string): Promise<void> {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    await appendFile(path, `${Date.now()}\n`, "utf8");
    await Bun.sleep(200);
  }
}

async function parentMode(method: string, heartbeatPath: string, pidPath: string): Promise<never> {
  let pid = 0;
  if (method === "bun") {
    const child = Bun.spawn(bunCommand(scriptPath, "__heartbeat", heartbeatPath), {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
      windowsHide: true,
    } as Bun.SpawnOptions);
    pid = child.pid;
    const possiblyUnrefable = child as typeof child & { unref?: () => void };
    possiblyUnrefable.unref?.();
  } else {
    const child = spawn(process.execPath, [scriptPath, "__heartbeat", heartbeatPath], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    pid = child.pid ?? 0;
    child.unref();
  }
  await writeFile(pidPath, String(pid), "utf8");
  process.exit(0);
}

async function inspectMethod(method: "bun" | "node", directory: string): Promise<Record<string, unknown>> {
  const heartbeatPath = `${directory}/${method}.heartbeat`;
  const pidPath = `${directory}/${method}.pid`;
  const parent = await runCaptured(bunCommand(scriptPath, "__parent", method, heartbeatPath, pidPath), 8000);
  if (parent.timedOut || parent.code !== 0) {
    return { started: false, parentExitCode: parent.code, timedOut: parent.timedOut, error: parent.stderr.trim() };
  }
  const parentExitedAt = Date.now();

  let pid = 0;
  try {
    pid = Number((await readFile(pidPath, "utf8")).trim());
  } catch {
    return { started: false, parentExitCode: parent.code, error: "Parent did not record a child process id" };
  }
  const appeared = await waitFor(async () => {
    try {
      return (await readFile(heartbeatPath, "utf8")).trim().length > 0;
    } catch {
      return false;
    }
  }, 2500);
  if (!appeared) {
    killTree(pid);
    return { started: true, parentExitCode: parent.code, childPid: pid, survivedParent: false, heartbeatCount: 0 };
  }

  await Bun.sleep(1000);
  let lines: string[] = [];
  try {
    lines = (await readFile(heartbeatPath, "utf8")).trim().split(/\r?\n/).filter(Boolean);
  } catch {
    // The file can disappear only if the child failed to write it.
  }
  const afterExit = lines.filter((line) => Number(line) > parentExitedAt).length;
  killTree(pid);
  return {
    started: true,
    parentExitCode: parent.code,
    childPid: pid,
    survivedParent: afterExit >= 3,
    heartbeatCount: lines.length,
    heartbeatsAfterParentExit: afterExit,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "__heartbeat") {
    await heartbeatMode(args[1]!);
    return;
  }
  if (args[0] === "__parent") {
    await parentMode(args[1]!, args[2]!, args[3]!);
    return;
  }

  const directory = await makeTempDir("agent-board-detached");
  try {
    const bun = await inspectMethod("bun", directory);
    const node = await inspectMethod("node", directory);
    const bunWorks = bun.survivedParent === true;
    const nodeWorks = node.survivedParent === true;
    report("detached", bunWorks || nodeWorks, { methods: { Bun_spawn: bun, node_child_process_spawn: node } });
  } finally {
    await removeTempDir(directory);
  }
}

main().catch((error: unknown) => {
  report("detached", false, { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 0;
});
