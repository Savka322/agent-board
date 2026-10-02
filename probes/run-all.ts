import { runCaptured } from "./common.ts";

const names = ["detached", "killtree", "jobobject", "toast", "sqlite"] as const;
const scriptDirectory = import.meta.dir;

async function main(): Promise<void> {
  const results: Array<{ name: string; ok: boolean; raw: string }> = [];
  for (const name of names) {
    const command = [process.execPath, `${scriptDirectory}/${name}.ts`];
    const execution = await runCaptured(command, 60000);
    const lines = execution.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    let parsed: { probe?: string; ok?: boolean } | undefined;
    try {
      parsed = JSON.parse(lines[lines.length - 1] ?? "") as { probe?: string; ok?: boolean };
    } catch {
      parsed = undefined;
    }
    const raw = parsed?.probe === name
      ? lines[lines.length - 1]!
      : JSON.stringify({
          probe: name,
          ok: false,
          details: {
            error: "Probe did not return a JSON result",
            exitCode: execution.code,
            timedOut: execution.timedOut,
            stdout: execution.stdout.trim(),
            stderr: execution.stderr.trim(),
          },
        });
    results.push({ name, ok: parsed?.ok === true && !execution.timedOut && execution.code === 0, raw });
  }

  console.log("Probe summary");
  console.log(`${"Probe".padEnd(12)} ${"Result"}`);
  console.log(`${"-".repeat(12)} ${"-".repeat(8)}`);
  for (const result of results) console.log(`${result.name.padEnd(12)} ${result.ok ? "PASS" : "FAIL"}`);
  console.log("Raw JSON lines");
  for (const result of results) console.log(result.raw);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
