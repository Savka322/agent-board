import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface ProbeResult {
  probe: string;
  ok: boolean;
  details: Record<string, unknown>;
}

let reportWritten = false;

export function report(probe: string, ok: boolean, details: Record<string, unknown>): void {
  if (reportWritten) return;
  reportWritten = true;
  console.log(JSON.stringify({ probe, ok, details } satisfies ProbeResult));
}

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

export async function removeTempDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export function killTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    const result = spawnSync("taskkill.exe", ["/T", "/F", "/PID", String(pid)], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 5000,
    });
    if (result.status === 0) return;
  } catch {
    // Fall through to the direct-process fallback.
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process may have already exited.
  }
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await Bun.sleep(intervalMs);
  }
  return await predicate();
}

export async function runCaptured(
  command: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const child = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  } as Bun.SpawnOptions);
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    child.exited.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (timedOut) {
    killTree(child.pid);
    await Promise.race([child.exited, Bun.sleep(2000)]);
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return { code: timedOut ? null : await child.exited, stdout, stderr, timedOut };
}

export function bunCommand(script: string, ...args: string[]): string[] {
  return [process.execPath, script, ...args];
}

export async function isProcessAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "EPERM") return true;
  }
  const result = Bun.spawnSync(["tasklist.exe", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
    stdout: "pipe",
    stderr: "ignore",
    windowsHide: true,
  } as Bun.SpawnOptions);
  const output = new TextDecoder().decode(result.stdout);
  return output.split(/\r?\n/).some((line) => line.match(/^"[^"]*","(\d+)"/)?.[1] === String(pid));
}
