import { Database } from "bun:sqlite";
import { join } from "node:path";
import { bunCommand, makeTempDir, removeTempDir, report, runCaptured } from "./common.ts";

const scriptPath = import.meta.path;

async function workerMode(databasePath: string, workerId: string): Promise<void> {
  const database = new Database(databasePath);
  let busyErrors = 0;
  let inserted = 0;
  const errors: string[] = [];
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const insert = database.query("INSERT INTO entries (id, worker_id, ordinal) VALUES (?, ?, ?)");
    for (let ordinal = 0; ordinal < 500; ordinal += 1) {
      try {
        insert.run(`${workerId}-${ordinal}`, workerId, ordinal);
        inserted += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/SQLITE_BUSY|database is locked/i.test(message)) busyErrors += 1;
        errors.push(message);
      }
    }
  } finally {
    database.close();
  }
  console.log(JSON.stringify({ workerId, inserted, busyErrors, errors }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "__worker") {
    await workerMode(args[1]!, args[2]!);
    return;
  }

  const directory = await makeTempDir("agent-board-sqlite");
  const databasePath = join(directory, "probe.db");
  try {
    const initial = new Database(databasePath);
    initial.exec("PRAGMA journal_mode = WAL");
    initial.exec("PRAGMA busy_timeout = 5000");
    initial.exec("CREATE TABLE entries (id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, ordinal INTEGER NOT NULL)");
    initial.close();

    const workers = await Promise.all([
      runCaptured(bunCommand(scriptPath, "__worker", databasePath, "first"), 30000),
      runCaptured(bunCommand(scriptPath, "__worker", databasePath, "second"), 30000),
    ]);
    const workerResults = workers.map((worker) => {
      try {
        return JSON.parse(worker.stdout.trim()) as Record<string, unknown>;
      } catch {
        return { parseError: true, stdout: worker.stdout.trim() };
      }
    });

    const final = new Database(databasePath, { readonly: true });
    const row = final.query("SELECT COUNT(*) AS count FROM entries").get() as { count: number };
    final.close();
    const inserted = workerResults.reduce((sum, result) => sum + Number(result.inserted ?? 0), 0);
    const busyErrors = workerResults.reduce((sum, result) => sum + Number(result.busyErrors ?? 0), 0);
    const noWorkerErrors = workerResults.every((result, index) => workers[index]!.code === 0 && !workers[index]!.timedOut && Array.isArray(result.errors) && result.errors.length === 0);
    report("sqlite", row.count === 1000 && inserted === 1000 && busyErrors === 0 && noWorkerErrors, {
      journalMode: "wal",
      busyTimeoutMs: 5000,
      rowCount: row.count,
      requestedRows: 1000,
      insertedRows: inserted,
      busyErrors,
      workerExitCodes: workers.map((worker) => worker.code),
      workers: workerResults,
    });
  } finally {
    await removeTempDir(directory);
  }
}

main().catch((error: unknown) => {
  report("sqlite", false, { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 0;
});
