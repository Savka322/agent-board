import { Hono } from "hono";
import { existsSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { OwnerAnswerBodySchema, TaskPriorityBodySchema } from "@agent-board/contracts";
import {
  answerOwnerQuestion,
  approveEpicForWeb,
  boardSnapshot,
  cancelTask,
  closeStore,
  getSetting,
  getRun,
  getTask,
  listBoardEventsAfter,
  listEventsAfter,
  listQuestions,
  listRecentEvents,
  listRunsForTask,
  openStore,
  RuleRefusalError,
  setTaskPriority,
  IllegalTaskTransitionError,
  taskDetail,
  type BoardStore,
} from "@agent-board/core";

const DEFAULT_WEB_PORT = 8790;
const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 1000;
const encoder = new TextEncoder();
const distDirectory = resolve(fileURLToPath(new URL("../../web/dist/", import.meta.url)));

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function configuredPort(store: BoardStore): number {
  const port = getSetting(store, "web_port");
  return isPort(port) ? port : DEFAULT_WEB_PORT;
}

function parseInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number | null {
  if (raw === undefined || raw === "") return fallback;
  if (!/^-?\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function confinedHomePath(home: string, path: string | null): string | null {
  if (!path) return null;
  try {
    const realHome = realpathSync(home);
    const candidate = realpathSync(resolve(home, path));
    const fromHome = relative(realHome, candidate);
    if (fromHome === ".." || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) return null;
    if (!statSync(candidate).isFile()) return null;
    return candidate;
  } catch {
    return null;
  }
}

function sseResponse(poll: (send: (event: string, id: number, value: unknown) => void, close: () => void) => void): Response {
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let polling = false;

  const cleanup = () => {
    stopped = true;
    if (pollTimer !== undefined) clearInterval(pollTimer);
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, id: number, value: unknown) => {
        if (stopped) return;
        try {
          controller.enqueue(encoder.encode(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const close = () => {
        if (stopped) return;
        cleanup();
        try { controller.close(); } catch { /* The client already disconnected. */ }
      };
      const runPoll = () => {
        if (stopped || polling) return;
        polling = true;
        try { poll(send, close); } catch {
          send("error", 0, { message: "The event stream could not read the board." });
        } finally {
          polling = false;
        }
      };
      runPoll();
      if (!stopped) {
        pollTimer = setInterval(runPoll, 500);
        heartbeatTimer = setInterval(() => {
          if (stopped) return;
          try { controller.enqueue(encoder.encode(": heartbeat\n\n")); } catch { cleanup(); }
        }, 15_000);
      }
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function taskEvents(store: BoardStore, taskId: string, after: number, before: number | null, limit: number) {
  getTask(store, taskId);
  const run = listRunsForTask(store, taskId).at(-1);
  if (!run) return [];
  if (before !== null) {
    return listEventsAfter(store, run.id, -1, 100_000).filter((event) => event.seq < before).slice(-limit);
  }
  if (after >= 0) return listEventsAfter(store, run.id, after, limit);
  return listRecentEvents(store, run.id, limit);
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".json": return "application/json; charset=utf-8";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

function serveWebFile(pathname: string): Response | null {
  if (!existsSync(distDirectory)) return null;
  let decodedPath: string;
  try { decodedPath = decodeURIComponent(pathname); } catch { decodedPath = "/"; }
  const candidate = resolve(distDirectory, `.${decodedPath}`);
  const fromDist = relative(distDirectory, candidate);
  const safe = fromDist !== ".." && !fromDist.startsWith(`..${sep}`) && !isAbsolute(fromDist);
  let filePath = safe && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : resolve(distDirectory, "index.html");
  if (!existsSync(filePath)) return null;
  try {
    const realDist = realpathSync(distDirectory);
    const realFile = realpathSync(filePath);
    const realRelative = relative(realDist, realFile);
    if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative) || !statSync(realFile).isFile()) {
      filePath = resolve(distDirectory, "index.html");
    } else {
      filePath = realFile;
    }
  } catch {
    return null;
  }
  if (!existsSync(filePath)) return null;
  return new Response(Bun.file(filePath), { headers: { "Content-Type": contentType(filePath) } });
}

export interface CreateAppOptions {
  stopRunner?: (store: BoardStore, id: string) => unknown;
}

function refusal(context: { json: (value: unknown, status?: number) => Response }, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return context.json({ error: message, reason: message }, 409);
}

export function createApp(store: BoardStore, port = DEFAULT_WEB_PORT, token = randomBytes(32).toString("hex"), options: CreateAppOptions = {}): Hono {
  const app = new Hono();

  app.use("*", async (context, next) => {
    const host = context.req.header("host");
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return context.text("Forbidden", 403);
    await next();
  });

  app.use("/api/*", async (context, next) => {
    if (context.req.method !== "POST") return next();
    const expectedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
    if (context.req.header("x-board-token") !== token || !expectedOrigins.has(context.req.header("origin") ?? "")) {
      return context.text("Forbidden", 403);
    }
    return next();
  });

  app.get("/api/session", (context) => {
    context.header("Cache-Control", "no-store");
    return context.json({ token, port });
  });

  app.post("/api/questions/:id/answer", async (context) => {
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "Invalid JSON body." }, 400); }
    const parsed = OwnerAnswerBodySchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "Invalid answer body.", details: parsed.error.issues }, 400);
    try {
      return context.json(answerOwnerQuestion(store, context.req.param("id"), parsed.data.text, parsed.data.reject ?? false));
    } catch (error) {
      if (error instanceof RuleRefusalError || error instanceof IllegalTaskTransitionError || error instanceof TypeError) return refusal(context, error);
      if (error instanceof Error && error.name === "StoreNotFoundError") return context.json({ error: error.message }, 404);
      return context.json({ error: "Could not answer question." }, 500);
    }
  });

  app.post("/api/tasks/:id/cancel", (context) => {
    try {
      return context.json(cancelTask(store, context.req.param("id"), options.stopRunner, "owner"));
    } catch (error) {
      if (error instanceof IllegalTaskTransitionError || error instanceof RuleRefusalError || error instanceof TypeError) return refusal(context, error);
      if (error instanceof Error && error.name === "StoreNotFoundError") return context.json({ error: error.message }, 404);
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post("/api/tasks/:id/prio", async (context) => {
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "Invalid JSON body." }, 400); }
    const parsed = TaskPriorityBodySchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "Invalid priority body.", details: parsed.error.issues }, 400);
    try {
      const task = getTask(store, context.req.param("id"));
      if (task.status !== "todo" && task.status !== "next") return refusal(context, new RuleRefusalError(`Priority can only change for todo or next tasks (current status: ${task.status})`));
      return context.json(setTaskPriority(store, task.id, parsed.data.prio));
    } catch (error) {
      if (error instanceof RuleRefusalError || error instanceof TypeError) return refusal(context, error);
      if (error instanceof Error && error.name === "StoreNotFoundError") return context.json({ error: error.message }, 404);
      return context.json({ error: "Could not update task priority." }, 500);
    }
  });

  app.post("/api/epics/:id/approve-merge", (context) => {
    try {
      return context.json(approveEpicForWeb(store, context.req.param("id")));
    } catch (error) {
      if (error instanceof RuleRefusalError || error instanceof TypeError) return refusal(context, error);
      if (error instanceof Error && error.name === "StoreNotFoundError") return context.json({ error: error.message }, 404);
      return context.json({ error: "Could not approve epic merge." }, 500);
    }
  });

  app.get("/api/board", (context) => {
    try {
      const epic = context.req.query("epic");
      return context.json(boardSnapshot(store, epic ? { epic } : {}));
    } catch {
      return context.json({ error: "Could not load the board." }, 500);
    }
  });

  app.get("/api/tasks/:id", (context) => {
    try {
      return context.json(taskDetail(store, context.req.param("id")));
    } catch {
      return context.json({ error: "Task not found." }, 404);
    }
  });

  app.get("/api/tasks/:id/events", (context) => {
    const after = parseInteger(context.req.query("after"), -1, -1, Number.MAX_SAFE_INTEGER);
    const beforeRaw = context.req.query("before");
    const before = beforeRaw === undefined ? null : parseInteger(beforeRaw, -1, 0, Number.MAX_SAFE_INTEGER);
    const limit = parseInteger(context.req.query("limit"), DEFAULT_EVENT_LIMIT, 1, MAX_EVENT_LIMIT);
    if (after === null || (beforeRaw !== undefined && (before === null || before === -1)) || limit === null) {
      return context.json({ error: "Invalid event cursor or limit." }, 400);
    }
    try {
      return context.json(taskEvents(store, context.req.param("id"), after, before, limit));
    } catch {
      return context.json({ error: "Task not found." }, 404);
    }
  });

  app.get("/api/runs/:id/raw", (context) => {
    let run;
    try { run = getRun(store, context.req.param("id")); } catch { return context.text("Run not found", 404); }
    const path = confinedHomePath(store.home, run.rawPath);
    if (!path) return context.text("Raw log not found", 404);
    return new Response(Bun.file(path), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  });

  app.get("/api/questions", (context) => {
    const open = context.req.query("open") === "1";
    try {
      return context.json(listQuestions(store, { ...(open ? { open: true } : {}), target: "owner" }));
    } catch {
      return context.json({ error: "Could not load questions." }, 500);
    }
  });

  app.get("/api/stream", (context) => {
    const after = parseInteger(context.req.query("after"), 0, 0, Number.MAX_SAFE_INTEGER);
    if (after === null) return context.json({ error: "Invalid board event cursor." }, 400);
    let cursor = after;
    return sseResponse((send) => {
      for (const event of listBoardEventsAfter(store, cursor)) {
        cursor = event.seq;
        send("board", event.seq, event);
      }
    });
  });

  app.get("/api/tasks/:id/stream", (context) => {
    const taskId = context.req.param("id");
    const after = parseInteger(context.req.query("after"), -1, -1, Number.MAX_SAFE_INTEGER);
    if (after === null) return context.json({ error: "Invalid task event cursor." }, 400);
    try { getTask(store, taskId); } catch { return context.json({ error: "Task not found." }, 404); }
    let cursor = after;
    let activeRunId = listRunsForTask(store, taskId).find((run) => run.endedAt === null)?.id ?? null;
    return sseResponse((send, close) => {
      const runs = listRunsForTask(store, taskId);
      const activeRun = runs.find((run) => run.endedAt === null) ?? null;
      if (activeRun) {
        if (activeRun.id !== activeRunId) {
          cursor = -1;
          activeRunId = activeRun.id;
        }
        for (const event of listEventsAfter(store, activeRun.id, cursor, 1000)) {
          cursor = event.seq;
          send("task", event.seq, event);
        }
        return;
      }
      if (activeRunId) {
        const finishedRun = runs.find((run) => run.id === activeRunId);
        if (finishedRun) {
          for (const event of listEventsAfter(store, finishedRun.id, cursor, 1000)) {
            cursor = event.seq;
            send("task", event.seq, event);
          }
          const remaining = listEventsAfter(store, finishedRun.id, cursor, 1);
          if (finishedRun.endedAt !== null && remaining.length === 0) close();
        }
      }
    });
  });

  app.notFound((context) => {
    if (context.req.path.startsWith("/api/")) return context.json({ error: "Not found." }, 404);
    const webFile = serveWebFile(context.req.path);
    if (webFile) return webFile;
    return context.text("The web build is missing. Run `bun run web:build` to create it.", 200);
  });

  return app;
}

export interface StartServerOptions {
  home?: string;
  port?: number;
  token?: string;
  store?: BoardStore;
}

export function startServer(options: StartServerOptions = {}) {
  const ownsStore = options.store === undefined;
  const store = options.store ?? (options.home ? openStore(options.home) : openStore());
  const port = options.port ?? configuredPort(store);
  if (!isPort(port)) {
    if (ownsStore) closeStore(store);
    throw new RangeError("web port must be an integer from 1 to 65535");
  }
  try {
    const token = options.token ?? randomBytes(32).toString("hex");
    const app = createApp(store, port, token);
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch });
    return {
      server,
      store,
      port,
      token,
      close() {
        server.stop(true);
        if (ownsStore) closeStore(store);
      },
    };
  } catch (error) {
    if (ownsStore) closeStore(store);
    throw error;
  }
}
