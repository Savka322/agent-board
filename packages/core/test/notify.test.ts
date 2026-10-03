import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { addProject, addTask as addStoredTask, createEpic, createQuestion, dispatchTick, installNotificationApp, listBoardEventsAfter, listNotifications, renderCardFile, transitionTask, uninstallNotificationApp, type BoardStore } from "../src";
import { APP_USER_MODEL_ID_KEY, DEFAULT_NOTIFY_APP_ID, notifyCause, POWERSHELL_NOTIFY_APP_ID, WindowsToastNotifier, type Notifier, type RegistryWriter } from "../src/notify";
import { installFreshHome, writeProfile } from "./helpers";

const fresh = installFreshHome();

function addTask(store: BoardStore, epic: string, id: string, decisions: string[] = []) {
  const card = {
    id,
    title: `Task ${id}`,
    epic,
    goal: "Test notifications.",
    allowed_files: [`src/${id.toLowerCase()}.ts`],
    deps: [],
    decisions,
    light_tests: [],
    gates: [],
    acceptance: ["Notification behavior is recorded."],
  };
  const path = join(fresh.home, `${id}.md`);
  writeFileSync(path, renderCardFile(card), "utf8");
  return addStoredTask(store, epic, path);
}

describe("Windows notifications", () => {
  test("dispatcher emits and notifies once for owner questions and ready epics", async () => {
    writeProfile(fresh.home);
    const project = addProject(fresh.store, "sample");
    createEpic(fresh.store, { id: "EPIC-1", project: project.name, title: "Question epic", branch: "epic/one" });
    const ownerTask = addTask(fresh.store, "EPIC-1", "AB-1", ["release_mode"]);
    const question = createQuestion(fresh.store, {
      id: "question-1", task: ownerTask.id, decision_key: "release_mode", kind: "assume", target: "owner",
      text: "Choose a release mode", options: ["automatic"], recommendation: "automatic",
    });
    createEpic(fresh.store, { id: "EPIC-2", project: project.name, title: "Ready epic", branch: "epic/two" });
    const terminalTask = addTask(fresh.store, "EPIC-2", "AB-2");
    transitionTask(fresh.store, terminalTask.id, "cancel", "owner");

    const drafts: Array<{ kind: string; ref: string; launch: string }> = [];
    const first = dispatchTick(fresh.store, { onNotification: (draft) => drafts.push(draft) });
    const second = dispatchTick(fresh.store, { onNotification: (draft) => drafts.push(draft) });
    expect(first.notifications.map(({ kind, ref }) => [kind, ref])).toEqual([
      ["owner_question", question.id],
      ["epic_ready", "EPIC-2"],
    ]);
    expect(second.notifications).toEqual([]);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]?.launch).toContain("#q=question-1");
    expect(drafts[1]?.launch).toContain("#epic=EPIC-2");
    expect(listBoardEventsAfter(fresh.store, 0).filter((event) => event.kind === "owner_question" || event.kind === "epic_ready")).toHaveLength(2);

    const sent: Array<{ appId: string; title: string }> = [];
    const notifier: Notifier = { notify: async ({ appId, title }) => { sent.push({ appId, title }); return { delivered: true }; } };
    const registry: RegistryWriter = { write() {}, remove() {}, exists: () => false };
    for (const draft of first.notifications) await notifyCause(fresh.store, draft, { notifier, registry });
    expect(sent.map((item) => item.appId)).toEqual([POWERSHELL_NOTIFY_APP_ID, POWERSHELL_NOTIFY_APP_ID]);
    expect(listNotifications(fresh.store)).toHaveLength(2);
    expect(listNotifications(fresh.store).every((entry) => entry.delivered)).toBe(true);
  });

  test("uses registered app ids and injectable registry install and uninstall operations", async () => {
    const calls: unknown[][] = [];
    const installed = new Set<string>();
    const writer: RegistryWriter = {
      write: (appId, displayName) => { calls.push(["write", `${APP_USER_MODEL_ID_KEY}\\${appId}`, displayName]); installed.add(appId); },
      remove: (appId) => { calls.push(["remove", `${APP_USER_MODEL_ID_KEY}\\${appId}`]); installed.delete(appId); },
      exists: (appId) => installed.has(appId),
    };
    installNotificationApp(DEFAULT_NOTIFY_APP_ID, writer);
    expect(calls[0]).toEqual(["write", `${APP_USER_MODEL_ID_KEY}\\${DEFAULT_NOTIFY_APP_ID}`, "agent-board"]);

    const chosen: string[] = [];
    await notifyCause(fresh.store, { kind: "test", ref: "registered", title: "Test", text: "Text", launch: "http://127.0.0.1:8790/" }, {
      registry: writer,
      notifier: { notify: async ({ appId }) => { chosen.push(appId); return { delivered: false, error: "test failure" }; } },
    });
    expect(chosen).toEqual([DEFAULT_NOTIFY_APP_ID]);
    const failed = listNotifications(fresh.store).find((item) => item.kind === "test");
    expect(failed).toMatchObject({ appId: DEFAULT_NOTIFY_APP_ID, delivered: false, error: "test failure" });

    uninstallNotificationApp(DEFAULT_NOTIFY_APP_ID, writer);
    expect(calls[1]).toEqual(["remove", `${APP_USER_MODEL_ID_KEY}\\${DEFAULT_NOTIFY_APP_ID}`]);
    expect(installed.has(DEFAULT_NOTIFY_APP_ID)).toBe(false);
  });

  test("encodes the PowerShell script and XML-escapes toast strings", async () => {
    let script = "";
    let argsSeen: string[] = [];
    const notifier = new WindowsToastNotifier(async (args) => {
      argsSeen = args;
      script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
      return { status: 0, stdout: "DELIVERED", stderr: "" };
    });
    const result = await notifier.notify({ appId: DEFAULT_NOTIFY_APP_ID, title: "A < B & C", text: "say \"hello\"\u0001", launch: "http://127.0.0.1:8790/#q=a&b" });
    expect(result.delivered).toBe(true);
    expect(argsSeen).toContain("-EncodedCommand");
    expect(script).toContain("A &lt; B &amp; C");
    expect(script).toContain("say &quot;hello&quot;\uFFFD");
    expect(script).toContain("#q=a&amp;b");
    expect(script).toContain("History.GetHistory($appId)");
  });
});
