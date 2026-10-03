import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import i18n from "./i18n";
import type { BoardData, OwnerQuestion, TaskDetailData, TaskEvent, TaskStatus, TaskSummary } from "./types";

type PanelSelection = { type: "task"; id: string } | { type: "question"; id: string } | null;
type Theme = "light" | "dark";

const statuses: TaskStatus[] = ["canceled", "todo", "next", "running", "review", "needs_owner", "done"];

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
  return response.json() as Promise<T>;
}

function useTheme() {
  const [manualTheme, setManualTheme] = useState<Theme | null>(() => {
    const stored = localStorage.getItem("agent-board-theme");
    return stored === "light" || stored === "dark" ? stored : null;
  });
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const theme = manualTheme ?? (systemDark ? "dark" : "light");

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    if (manualTheme) localStorage.setItem("agent-board-theme", manualTheme);
    else localStorage.removeItem("agent-board-theme");
  }, [manualTheme, theme]);

  return { theme, toggle: () => setManualTheme(theme === "dark" ? "light" : "dark") };
}

function eventCursor(events: TaskEvent[]): number {
  return events.reduce((cursor, event) => Math.max(cursor, event.seq), -1);
}

function Panel({ selection, questions, onClose }: { selection: PanelSelection; questions: OwnerQuestion[]; onClose: () => void }) {
  const { t, i18n: currentI18n } = useTranslation();
  const queryClient = useQueryClient();
  const taskId = selection?.type === "task" ? selection.id : null;
  const detailQuery = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => fetchJson<TaskDetailData>(`/api/tasks/${encodeURIComponent(taskId ?? "")}`),
    enabled: taskId !== null,
  });
  const question = selection?.type === "question" ? questions.find((item) => item.id === selection.id) : undefined;
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState(false);
  const [hasOlderEvents, setHasOlderEvents] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  useEffect(() => {
    if (!taskId) {
      setEvents([]);
      setEventsError(false);
      setHasOlderEvents(false);
      return;
    }
    let disposed = false;
    let source: EventSource | undefined;
    setEventsLoading(true);
    setEventsError(false);
    setHasOlderEvents(false);

    void fetchJson<TaskEvent[]>(`/api/tasks/${encodeURIComponent(taskId)}/events?limit=200`)
      .then((initialEvents) => {
        if (disposed) return;
        setEvents(initialEvents.slice(-500));
        setHasOlderEvents(initialEvents.length === 200);
        const after = eventCursor(initialEvents);
        source = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/stream?after=${after}`);
        source.addEventListener("task", (message: MessageEvent<string>) => {
          const event = JSON.parse(message.data) as TaskEvent;
          setEvents((current) => {
            const merged = [...current.filter((item) => !(item.run_id === event.run_id && item.seq === event.seq)), event]
              .sort((first, second) => Date.parse(first.ts) - Date.parse(second.ts) || first.seq - second.seq);
            return merged.slice(-500);
          });
          void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
        });
      })
      .catch(() => {
        if (!disposed) setEventsError(true);
      })
      .finally(() => {
        if (!disposed) setEventsLoading(false);
      });

    return () => {
      disposed = true;
      source?.close();
    };
  }, [queryClient, taskId]);

  useEffect(() => {
    if (!selection) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, selection]);

  const loadOlder = async () => {
    if (!taskId || events.length === 0) return;
    const first = events[0];
    if (!first) return;
    setLoadingOlder(true);
    try {
      const older = await fetchJson<TaskEvent[]>(`/api/tasks/${encodeURIComponent(taskId)}/events?before=${first.seq}&limit=200`);
      setEvents((current) => {
        const keys = new Set(current.map((event) => `${event.run_id}/${event.seq}`));
        const combined = [...older.filter((event) => !keys.has(`${event.run_id}/${event.seq}`)), ...current];
        return combined.slice(-500);
      });
      setHasOlderEvents(older.length === 200);
    } catch {
      setEventsError(true);
    } finally {
      setLoadingOlder(false);
    }
  };

  if (!selection) return null;

  return (
    <div className="panel-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="detail-panel" role="dialog" aria-modal="true" aria-label={selection.type === "task" ? t("taskDetails") : t("questionDetails")}>
        <div className="panel-header">
          <div>
            <p className="eyebrow">{selection.type === "task" ? t("taskDetails") : t("questionDetails")}</p>
            <h2>{selection.type === "task" ? (detailQuery.data?.card.id ?? selection.id) : (question ? questionCode(question, questions, t) : t("openQuestion"))}</h2>
          </div>
          <button className="icon-button close-button" type="button" onClick={onClose} aria-label={t("closePanel")}>
            <span aria-hidden="true">×</span>
          </button>
        </div>

        {selection.type === "task" && (
          detailQuery.isLoading ? <PanelSkeleton />
            : detailQuery.isError ? <p className="inline-error">{t("loadError")}</p>
              : detailQuery.data ? <TaskPanel
                detail={detailQuery.data}
                events={events}
                eventsLoading={eventsLoading}
                eventsError={eventsError}
                hasOlderEvents={hasOlderEvents}
                loadingOlder={loadingOlder}
                onLoadOlder={loadOlder}
                locale={currentI18n.language}
              /> : null
        )}

        {selection.type === "question" && question && <QuestionPanel question={question} code={questionCode(question, questions, t)} />}
        {selection.type === "question" && !question && <p className="empty-inline">{t("noQuestions")}</p>}
      </aside>
    </div>
  );
}

function questionCode(question: OwnerQuestion, questions: OwnerQuestion[], t: (key: string, options?: Record<string, unknown>) => string) {
  return t("questionCode", { n: questions.findIndex((item) => item.id === question.id) + 1 });
}

function PanelSkeleton() {
  return <div className="panel-skeleton" aria-hidden="true"><i /><i /><i /><i /><i /></div>;
}

function formatDate(value: string | null, locale: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function TaskPanel({
  detail,
  events,
  eventsLoading,
  eventsError,
  hasOlderEvents,
  loadingOlder,
  onLoadOlder,
  locale,
}: {
  detail: TaskDetailData;
  events: TaskEvent[];
  eventsLoading: boolean;
  eventsError: boolean;
  hasOlderEvents: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  locale: string;
}) {
  const { t } = useTranslation();
  const { card } = detail;
  return (
    <div className="panel-content">
      <div className="task-detail-heading">
        <h3>{card.title}</h3>
        <div className="task-meta-line">
          <span className={`status-tag status-${card.status}`}>{t(`status.${card.status}`)}</span>
          {card.round > 0 && <span className="round-tag">{t("round", { n: card.round })}</span>}
        </div>
      </div>

      <section className="detail-section">
        <h4>{t("goal")}</h4>
        <p className="prewrap goal-text">{card.goal}</p>
      </section>
      <section className="detail-section">
        <h4>{t("allowedFiles")}</h4>
        <ul className="code-list">{card.allowed_files.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
      </section>
      <section className="detail-section">
        <h4>{t("acceptance")}</h4>
        <ul className="plain-list">{card.acceptance.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
      </section>
      {detail.questions.length > 0 && <section className="detail-section">
        <h4>{t("openQuestion")}</h4>
        <div className="task-question-list">{detail.questions.map((question) => <div className="task-question" key={question.id}>
          <p>{question.text}</p>
          {question.options.length > 0 && <ul className="plain-list">{question.options.map((option, index) => <li key={`${index}-${option}`}>{option}</li>)}</ul>}
          <p className="question-recommendation">{t("recommendation")}: {question.recommendation}</p>
        </div>)}</div>
      </section>}

      <section className="detail-section live-log-section">
        <div className="section-heading"><h4>{t("liveLog")}</h4><span className="live-mark" /></div>
        {hasOlderEvents && <button className="text-button load-older" type="button" disabled={loadingOlder} onClick={onLoadOlder}>{t(loadingOlder ? "loadingEvents" : "loadOlder")}</button>}
        {eventsError && <p className="inline-error">{t("eventsError")}</p>}
        {eventsLoading ? <div className="event-placeholder" />
          : events.length === 0 ? <p className="empty-inline">{t("noEvents")}</p>
            : <ol className="event-list">
              {events.map((event) => <li className={`event-row event-${event.kind}`} key={`${event.run_id}/${event.seq}`}>
                <span className={`event-kind kind-${event.kind}`}>{t(`event.${event.kind}`)}</span>
                <time dateTime={event.ts}>{formatDate(event.ts, locale)}</time>
                <p>{event.text}</p>
              </li>)}
            </ol>}
      </section>

      <section className="detail-section">
        <h4>{t("report")}</h4>
        {detail.last_report ? <ReportView report={detail.last_report} /> : <p className="empty-inline">{t("noReport")}</p>}
      </section>

      {card.status === "review" && <section className="detail-section">
        <h4>{t("reviewSummary")}</h4>
        {detail.review_summary ? <ReviewView review={detail.review_summary} />
          : <p className="empty-inline">{detail.review_error ?? t("reviewUnavailable")}</p>}
      </section>}

      <section className="detail-section">
        <h4>{t("rounds")}</h4>
        {detail.runs.length === 0 ? <p className="empty-inline">{t("noRuns")}</p> : <div className="run-list">
          {detail.runs.map((run) => <details className="run-item" key={run.id}>
            <summary><span>{t("roundLabel", { n: run.round })}</span><span>{run.outcome ? t(`outcomes.${run.outcome}`) : t("running")}</span></summary>
            <div className="run-details">
              <p><b>{t("started")}:</b> {formatDate(run.started_at, locale)}</p>
              <p><b>{t("ended")}:</b> {formatDate(run.ended_at, locale)}</p>
              {run.usage !== null && run.usage !== undefined && <div><b>{t("usage")}</b><pre>{JSON.stringify(run.usage, null, 2)}</pre></div>}
              {run.raw_available ? <a className="text-link" href={`/api/runs/${encodeURIComponent(run.id)}/raw`} target="_blank" rel="noreferrer">{t("rawLog")}</a>
                : <span className="muted-copy">{t("rawLogUnavailable")}</span>}
            </div>
          </details>)}
        </div>}
      </section>

      <section className="detail-section">
        <h4>{t("taskHistory")}</h4>
        {detail.task_log.length === 0 ? <p className="empty-inline">{t("noHistory")}</p> : <ol className="history-list">
          {detail.task_log.map((entry) => <li key={entry.id}>
            <time dateTime={entry.ts}>{formatDate(entry.ts, locale)}</time>
            <p><b>{entry.actor}</b><span>{entry.action}</span></p>
            {entry.note && <p className="history-note">{entry.note}</p>}
          </li>)}
        </ol>}
      </section>
    </div>
  );
}

function ReportView({ report }: { report: NonNullable<TaskDetailData["last_report"]> }) {
  const { t } = useTranslation();
  return <div className="report-view">
    <span className={`report-status report-${report.status.toLowerCase()}`}>{t(`reportStatuses.${report.status}`)}</span>
    {report.summary && <p className="prewrap">{report.summary}</p>}
    {report.files_changed.length > 0 && <div><h5>{t("filesChanged")}</h5><ul className="code-list">{report.files_changed.map((path) => <li key={path}><code>{path}</code></li>)}</ul></div>}
    {report.tests_run.length > 0 && <div><h5>{t("tests")}</h5><ul className="report-test-list">{report.tests_run.map((test, index) => <li key={`${index}-${test.cmd}`}>
      <span className={`test-result test-${test.result}`}>{test.result === "pass" ? "✓" : test.result === "fail" || test.result === "error" ? "✗" : "–"}</span>
      <div><code>{test.cmd}</code><small>{t("passed")}: {test.passed} · {t("failedCount")}: {test.failed}</small></div>
    </li>)}</ul></div>}
    {report.assumptions.length > 0 && <div><h5>{t("assumptions")}</h5><ul className="plain-list">{report.assumptions.map((assumption, index) => <li key={`${index}-${assumption.text}`}>{assumption.text}</li>)}</ul></div>}
    {report.question && <div className="report-question"><h5>{t("openQuestion")}</h5><p className="prewrap">{report.question.text}</p>
      {report.question.options.length > 0 && <ul className="plain-list">{report.question.options.map((option, index) => <li key={`${index}-${option}`}>{option}</li>)}</ul>}
      <p><b>{t("recommendation")}:</b> {report.question.recommendation}</p>
    </div>}
    {report.notes && <div><h5>{t("notes")}</h5><p className="prewrap">{report.notes}</p></div>}
  </div>;
}

function ReviewView({ review }: { review: NonNullable<TaskDetailData["review_summary"]> }) {
  const { t } = useTranslation();
  return <div className="review-view">
    {review.changed_files.length === 0 ? <p className="empty-inline">{t("noChangedFiles")}</p> : <ul className="review-files">
      {review.changed_files.map((file) => <li key={file.path}><code>{file.path}</code>{file.outside_allowed && <span className="outside-mark">{t("outsideAllowed")}</span>}</li>)}
    </ul>}
    {review.diff_stat && <div><h5>{t("diffStat")}</h5><pre>{review.diff_stat}</pre></div>}
    {review.new_files.length > 0 && <div><h5>{t("newFiles")}</h5><ul className="code-list">{review.new_files.map((file) => <li key={file}><code>{file}</code></li>)}</ul></div>}
  </div>;
}

function QuestionPanel({ question, code }: { question: OwnerQuestion; code: string }) {
  const { t } = useTranslation();
  return <div className="panel-content question-panel-content">
    <span className="question-code">{code}</span>
    <p className="question-text">{question.text}</p>
    {question.decision_key && <p className="decision-key"><code>{question.decision_key}</code></p>}
    {question.options.length > 0 && <section className="detail-section"><h4>{t("options")}</h4><ul className="plain-list">{question.options.map((option, index) => <li key={`${index}-${option}`}>{option}</li>)}</ul></section>}
    <section className="detail-section recommendation"><h4>{t("recommendation")}</h4><p>{question.recommendation}</p></section>
    <section className="detail-section"><h4>{t("heldTasks")}</h4>{question.held_task_ids.length > 0
      ? <ul className="code-list">{question.held_task_ids.map((id) => <li key={id}><code>{id}</code></li>)}</ul>
      : <p className="empty-inline">{t("noTasksHeld")}</p>}</section>
  </div>;
}

function taskLabel(label: string, questionCodes: Map<string, string>, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (label.startsWith("deps_pending:")) return t("waitsFor", { ids: label.slice("deps_pending:".length).split(",").join(", ") });
  if (label.startsWith("waiting_answer:")) {
    const id = label.slice("waiting_answer:".length);
    return t("waitsForAnswer", { id: questionCodes.get(id) ?? id.slice(0, 8) });
  }
  if (label.startsWith("file_overlap:")) return t("overlaps", { ids: label.slice("file_overlap:".length).split(",").join(", ") });
  if (label === "no_slot") return t("noSlot");
  if (label.startsWith("paused:")) return t("paused");
  if (label === "stale") return t("stale");
  if (label === "failed") return t("failed");
  return label;
}

function TaskCard({ task, questionCodes, onClick }: { task: TaskSummary; questionCodes: Map<string, string>; onClick: () => void }) {
  const { t } = useTranslation();
  const labels = task.status === "next" && task.labels.length === 0 ? [t("canStart")] : task.labels.map((label) => taskLabel(label, questionCodes, t));
  return <button className={`task-card${task.status === "canceled" ? " task-canceled" : ""}`} type="button" onClick={onClick} aria-label={`${task.id} ${task.title}`}>
    <div className="task-card-top"><span className="task-id">{task.id}</span>{task.round > 0 && <span className="round-tag">{t("round", { n: task.round })}</span>}</div>
    <span className="task-title">{task.title}</span>
    {labels.length > 0 && <span className="chip-list">{labels.map((label, index) => <span className={`reason-chip chip-${task.labels[index]?.split(":")[0] ?? "start"}`} key={`${index}-${label}`}>{label}</span>)}</span>}
  </button>;
}

function QuestionCard({ question, code, onClick }: { question: OwnerQuestion; code: string; onClick: () => void }) {
  const { t } = useTranslation();
  return <button className="question-card" type="button" onClick={onClick} aria-label={`${code} ${question.text}`}>
    <div className="question-card-top"><span className="question-code">{code}</span><span className="question-marker">{t("question")}</span></div>
    <span className="question-card-text">{question.text}</span>
    {question.options.length > 0 && <span className="question-options"><b>{t("options")}:</b> {question.options.join(" · ")}</span>}
    {question.recommendation && <span className="question-recommendation">{t("recommendation")}: {question.recommendation}</span>}
    <span className="holds-tag">{t("holds", { count: question.held_task_ids.length })}</span>
  </button>;
}

export function App() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [epic, setEpic] = useState("");
  const [selection, setSelection] = useState<PanelSelection>(null);
  const [pollFallback, setPollFallback] = useState(false);
  const { theme, toggle: toggleTheme } = useTheme();
  const boardQuery = useQuery({
    queryKey: ["board", epic],
    queryFn: () => fetchJson<BoardData>(`/api/board${epic ? `?epic=${encodeURIComponent(epic)}` : ""}`),
    refetchInterval: pollFallback ? 2000 : false,
  });
  const board = boardQuery.data;

  useEffect(() => {
    if (!board) return;
    const source = new EventSource(`/api/stream?after=${board.cursor}`);
    source.addEventListener("board", () => {
      void queryClient.invalidateQueries({ queryKey: ["board"] });
      void queryClient.invalidateQueries({ queryKey: ["task"] });
    });
    source.onopen = () => setPollFallback(false);
    source.onerror = () => {
      source.close();
      setPollFallback(true);
    };
    return () => source.close();
  }, [board?.cursor, queryClient]);

  const questionCodes = useMemo(() => new Map(board?.questions.map((question, index) => [question.id, t("questionCode", { n: index + 1 })]) ?? []), [board?.questions, t]);
  const columnTasks = useMemo(() => {
    const grouped = new Map<TaskStatus, TaskSummary[]>();
    for (const status of statuses) grouped.set(status, []);
    for (const task of board?.tasks ?? []) grouped.get(task.status)?.push(task);
    return grouped;
  }, [board?.tasks]);
  const progress = useMemo(() => {
    const selected = board?.epics ?? [];
    return selected.reduce((total, item) => ({ done: total.done + item.progress.done, count: total.count + item.progress.total }), { done: 0, count: 0 });
  }, [board?.epics]);
  const startableCount = board?.tasks.filter((task) => task.status === "next" && task.labels.length === 0).length ?? 0;
  const questionCards = board?.questions ?? [];
  const isWaitingForOwner = questionCards.length > 0 && board?.running_count === 0;
  const pauseUntil = board?.settings.paused_until ?? null;
  const isPaused = pauseUntil !== null && Date.parse(pauseUntil) > Date.now();

  const toggleLanguage = () => {
    void i18n.changeLanguage(i18n.language.toLowerCase().startsWith("ru") ? "en" : "ru");
  };

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="masthead">
          <div className="brand-mark" aria-hidden="true">AB</div>
          <div className="brand-copy"><h1>{t("appName")}</h1><span>{t("localOnly")}</span></div>
          <span className="read-only-tag">{t("readOnly")}</span>
          <div className="header-actions">
            <button className="header-button language-button" type="button" onClick={toggleLanguage} aria-label={t("switchLanguage")}>{i18n.language.toLowerCase().startsWith("ru") ? "EN" : "RU"}</button>
            <button className="header-button theme-button" type="button" onClick={toggleTheme} aria-label={t(theme === "dark" ? "switchToLight" : "switchToDark")} title={t("theme")}>
              <span className="theme-glyph" aria-hidden="true">{theme === "dark" ? "◐" : "◑"}</span>
              <span className="theme-label">{t(theme === "dark" ? "darkTheme" : "lightTheme")}</span>
            </button>
          </div>
        </div>
        {board && <div className="board-toolbar">
          <label className="epic-select-label"><span>{t("epic")}</span>
            <select value={epic} onChange={(event) => setEpic(event.target.value)} aria-label={t("epic")}>
              <option value="">{t("allEpics")}</option>
              {board.epics.map((item) => <option key={item.id} value={item.id}>{item.id} · {item.title}</option>)}
            </select>
          </label>
          <div className="progress-block">
            <div className="progress-copy"><span>{t("progress")}</span><span>{t("completedOfTotal", { done: progress.done, total: progress.count })}</span></div>
            <div className="progress-track" role="progressbar" aria-label={t("progress")} aria-valuemin={0} aria-valuemax={progress.count} aria-valuenow={progress.done}>
              <span style={{ width: `${progress.count > 0 ? (progress.done / progress.count) * 100 : 0}%` }} />
            </div>
          </div>
          <div className="slot-counter"><span className="slot-dot" /><span>{t("slots")}</span><strong>{board.running_count}<small> / {board.settings.max_slots}</small></strong></div>
        </div>}
      </header>

      {board && (isPaused || startableCount > 0 || isWaitingForOwner) && <section className="banner-row" aria-label={t("localOnly")}>
        {isPaused && pauseUntil && <div className="notice-banner notice-pause"><span className="notice-indicator" />{t("pausedUntil", { date: formatDate(pauseUntil, i18n.language) })}</div>}
        {startableCount > 0 && <div className="notice-banner notice-start"><span className="notice-indicator" />{t("waitingForClaude")}</div>}
        {isWaitingForOwner && <div className="notice-banner notice-owner"><span className="notice-indicator" />{t("epicWaitingForYou")}</div>}
      </section>}

      {boardQuery.isLoading && <section className="loading-board" aria-live="polite"><div className="loading-title" /><div className="loading-columns">{statuses.map((status) => <div className="loading-column" key={status}><i /><i /><i /></div>)}</div><p>{t("loadingBoard")}</p></section>}
      {boardQuery.isError && <section className="error-state"><div className="error-symbol">!</div><h2>{t("loadError")}</h2><button className="primary-button" type="button" onClick={() => void boardQuery.refetch()}>{t("retry")}</button></section>}
      {board && <>
        {board.epics.length === 0 && board.tasks.length === 0 && <section className="welcome-state"><span className="welcome-index">AB / 01</span><h2>{t("welcomeTitle")}</h2><p>{t("welcomeBody")}</p></section>}
        <div className="board-scroll" aria-label={t("appName")}>
          <div className="board-grid">
            {statuses.map((status) => {
              const tasks = columnTasks.get(status) ?? [];
              const questions = status === "needs_owner" ? questionCards : [];
              return <section className={`board-column column-${status}`} key={status} aria-labelledby={`column-${status}`}>
                <header className="column-heading">
                  <div><span className={`column-marker marker-${status}`} /><h2 id={`column-${status}`}>{t(status)}</h2></div>
                  <span className="column-count">{tasks.length + questions.length}</span>
                </header>
                <div className="column-subtitle">{t("tasksCount", { count: tasks.length })}{questions.length > 0 && <span> · {t("questionsCount", { count: questions.length })}</span>}</div>
                <div className="column-cards">
                  {status === "needs_owner" && questions.map((question, index) => <QuestionCard key={question.id} question={question} code={t("questionCode", { n: index + 1 })} onClick={() => setSelection({ type: "question", id: question.id })} />)}
                  {tasks.map((task) => <TaskCard key={task.id} task={task} questionCodes={questionCodes} onClick={() => setSelection({ type: "task", id: task.id })} />)}
                  {tasks.length === 0 && questions.length === 0 && <p className="column-empty">{t(status === "needs_owner" ? "noQuestions" : "noTasks")}</p>}
                </div>
              </section>;
            })}
          </div>
        </div>
      </>}

      <footer className="app-footer"><span>{t("appName")}</span><span>{t("readOnly")}</span></footer>
      <Panel selection={selection} questions={questionCards} onClose={() => setSelection(null)} />
    </main>
  );
}
