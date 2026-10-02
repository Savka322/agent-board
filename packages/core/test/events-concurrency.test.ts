import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { renderCardFile } from "../src/cards";
import { addProject, addTask, createEpic, createRun, listEventsAfter } from "../src/store";
import type { TaskCard } from "@agent-board/contracts";
import { installFreshHome, writeProfile } from "./helpers";

const fresh = installFreshHome();

describe("concurrent event append", () => {
  test("serializes event sequence allocation from separate processes", async () => {
    writeProfile(fresh.home);
    addProject(fresh.store, "sample");
    const epic = createEpic(fresh.store, { id: "EPIC-1", project: "sample", title: "Concurrency", branch: "epic/concurrency" });
    const card: TaskCard = {
      id: "DEMO-1",
      title: "Append events",
      epic: epic.id,
      goal: "Append events concurrently.",
      allowed_files: ["src/events.ts"],
      deps: [],
      decisions: [],
      light_tests: [],
      gates: [],
      acceptance: ["All events are stored in sequence."],
    };
    const cardPath = `${fresh.home}/DEMO-1.md`;
    await Bun.write(cardPath, renderCardFile(card));
    addTask(fresh.store, epic.id, cardPath);
    const run = createRun(fresh.store, { id: "run-concurrent", task: card.id, executor: "codex" });
    const workerPath = fileURLToPath(new URL("./append-worker.ts", import.meta.url));

    const children = ["left", "right"].map((label) => Bun.spawn(
      [process.execPath, workerPath, fresh.home, run.id, label],
      { stdout: "pipe", stderr: "pipe" },
    ));
    const results = await Promise.all(children.map(async (child) => ({
      code: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    })));
    expect(results).toEqual([
      { code: 0, stdout: "", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ]);

    const events = listEventsAfter(fresh.store, run.id, -1, 100);
    expect(events).toHaveLength(24);
    expect(events.map(({ seq }) => seq)).toEqual(Array.from({ length: 24 }, (_, index) => index));
    expect(new Set(events.map(({ text }) => text)).size).toBe(24);
  });
});
