import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bunCommand, isProcessAlive, killTree, makeTempDir, removeTempDir, report, runCaptured, waitFor } from "./common.ts";

const scriptPath = import.meta.path;

async function sleeperMode(level: number, directory: string): Promise<void> {
  await writeFile(join(directory, `${level}.pid`), String(process.pid), "utf8");
  if (level < 3) {
    Bun.spawn(bunCommand(scriptPath, "__sleeper", String(level + 1), directory), {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    } as Bun.SpawnOptions);
  }
  await Bun.sleep(30000);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "__sleeper") {
    await sleeperMode(Number(args[1]), args[2]!);
    return;
  }

  const directory = await makeTempDir("agent-board-killtree");
  let childPid = 0;
  let knownPids: number[] = [];
  let outcomeOk = false;
  let outcomeDetails: Record<string, unknown> = {};
  try {
    await mkdir(directory, { recursive: true });
    const child = Bun.spawn(bunCommand(scriptPath, "__sleeper", "1", directory), {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    } as Bun.SpawnOptions);
    childPid = child.pid;
    const ready = await waitFor(async () => {
      try {
        return (await Bun.file(join(directory, "3.pid")).exists());
      } catch {
        return false;
      }
    }, 8000);
    if (!ready) throw new Error("The grandchild chain did not start before the timeout");

    const pids = [
      childPid,
      Number((await Bun.file(join(directory, "2.pid")).text()).trim()),
      Number((await Bun.file(join(directory, "3.pid")).text()).trim()),
    ];
    knownPids = pids;
    const aliveBeforeKill = await Promise.all(pids.map(isProcessAlive));
    const taskkill = await runCaptured(["taskkill.exe", "/T", "/F", "/PID", String(childPid)], 8000);
    const allGone = await waitFor(async () => {
      const states = await Promise.all(pids.map(isProcessAlive));
      return states.every((alive) => !alive);
    }, 8000);
    const states = await Promise.all(pids.map(isProcessAlive));
    const pidsGone = Object.fromEntries(pids.map((pid, index) => [String(pid), !states[index]]));
    outcomeOk = aliveBeforeKill.every(Boolean) && allGone && !taskkill.timedOut && taskkill.code === 0;
    outcomeDetails = {
      childPid,
      descendantPids: pids.slice(1),
      pidsAliveBeforeTaskkill: Object.fromEntries(pids.map((pid, index) => [String(pid), aliveBeforeKill[index]])),
      taskkillExitCode: taskkill.code,
      taskkillStderr: taskkill.stderr.trim(),
      pidsGone,
    };
  } finally {
    for (const pid of knownPids) killTree(pid);
    if (knownPids.length === 0 && childPid > 0) killTree(childPid);
    await removeTempDir(directory);
  }
  const cleanupAlive = await Promise.all(knownPids.map(isProcessAlive));
  const cleanupPidsGone = Object.fromEntries(knownPids.map((pid, index) => [String(pid), !cleanupAlive[index]]));
  const cleanupSucceeded = cleanupAlive.every((alive) => !alive);
  outcomeDetails.cleanupPidsGone = cleanupPidsGone;
  outcomeDetails.cleanupSucceeded = cleanupSucceeded;
  report("killtree", outcomeOk && cleanupSucceeded, outcomeDetails);
}

main().catch((error: unknown) => {
  report("killtree", false, { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 0;
});
