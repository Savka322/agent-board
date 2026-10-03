import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("-o");
const reportPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
const resumeIndex = args.indexOf("resume");
const isResume = resumeIndex >= 0;
const sessionId = isResume ? args[resumeIndex + 1] : undefined;
const capture = process.env.AGENT_BOARD_FAKE_SESSION_LOG;
if (capture) appendFileSync(capture, `${isResume ? `resume:${sessionId ?? ""}` : "exec"} ${args.join(" ")}\n`, "utf8");

const delay = Number(process.env.AGENT_BOARD_FAKE_SLEEP_MS ?? 0);
if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));

const edited = process.env.AGENT_BOARD_FAKE_EDIT;
if (edited && edited !== "nothing") {
  const target = resolve(process.cwd(), edited);
  mkdirSync(dirname(target), { recursive: true });
  const previous = await Bun.file(target).exists() ? await Bun.file(target).text() : "";
  writeFileSync(target, `${previous}fake edit\n`, "utf8");
}

const fixtureName = isResume ? "codex-run-resume.jsonl" : "codex-run-initial.jsonl";
const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", fixtureName);
process.stdout.write(await Bun.file(fixturePath).text());
if (process.env.AGENT_BOARD_FAKE_SPLIT_UTF8 === "1") {
  const line = Buffer.from(`${JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "Cyrillic: Привет, emoji: 😀" },
  })}\n`, "utf8");
  const marker = Buffer.from("П", "utf8");
  const splitAt = line.indexOf(marker) + 1;
  process.stdout.write(line.subarray(0, splitAt));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  process.stdout.write(line.subarray(splitAt));
}
if (process.env.AGENT_BOARD_FAKE_STDERR) process.stderr.write(process.env.AGENT_BOARD_FAKE_STDERR);

if (reportPath && process.env.AGENT_BOARD_FAKE_MISSING_REPORT !== "1") {
  const status = process.env.AGENT_BOARD_FAKE_STATUS ?? "DONE";
  const question = status === "BLOCKED" ? {
    decision_key: null,
    text: "The requested change needs clarification.",
    options: ["Option A", "Option B"],
    recommendation: "Option A",
  } : null;
  const changedFiles = edited && edited !== "nothing" ? [edited.replace(/\\/g, "/")] : [];
  const report = {
    status,
    summary: "Fake executor completed the configured run.",
    files_changed: changedFiles,
    tests_run: [],
    assumptions: process.env.AGENT_BOARD_FAKE_ASSUMPTIONS
      ? JSON.parse(process.env.AGENT_BOARD_FAKE_ASSUMPTIONS) as Array<{ decision_key: string | null; text: string }>
      : [],
    question,
    notes: "Fake Codex test report.",
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

if (process.env.AGENT_BOARD_FAKE_EXIT_CODE !== undefined) {
  process.exitCode = Number(process.env.AGENT_BOARD_FAKE_EXIT_CODE);
}
