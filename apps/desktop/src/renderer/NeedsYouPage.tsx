/**
 * Needs you: every question a session asked the user, as a card with its
 * context, its options and where it sits in its plan, kept until the user
 * answers or dismisses it here, or it closes on its own. Answers go to the
 * asking session with the question and its context. Beside the cards, the
 * selected card's plan shows the task that waits on the user and the tasks
 * held behind it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AskDto, AskPlanDto } from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";

/** An inbox tray: Needs you's mark. */
export const NEEDS_YOU_ICON_PATH =
  "M2 9.5 4 3h8l2 6.5v3.5H2zM2 9.5h3.5l1 1.5h3l1-1.5H14";

/** How often the page reads asks again while shown. */
const REFRESH_MS = 5_000;

/** The person's answer being written, per ask. */
interface Draft {
  option: number | null;
  note: string;
}

const ago = (from: string, now: number): string => {
  const minutes = Math.max(0, Math.round((now - Date.parse(from)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

/** The number of open asks, for the sidebar's count. Polls while mounted. */
export function useOpenAskCount(client: DesktopClient): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    const read = () =>
      void client.request.askList({}).then(
        (response) => {
          if (live && response.ok)
            setCount(
              response.data.filter((ask) => ask.state === "open").length,
            );
        },
        () => undefined,
      );
    read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") read();
    }, REFRESH_MS * 2);
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", read);
    };
  }, [client]);
  return count;
}

type TaskMark = "wait" | "held" | undefined;

/**
 * Marks each task: the one an open ask is pinned to waits on the user; the
 * todo tasks after it at its level, up to its parent's end, are held by it.
 */
export function markPlanTasks(
  tasks: AskPlanDto["tasks"],
  asks: readonly Pick<AskDto, "id" | "taskKey">[],
): { mark: TaskMark; ask?: number }[] {
  const out: { mark: TaskMark; ask?: number }[] = tasks.map(() => ({
    mark: undefined,
  }));
  tasks.forEach((task, index) => {
    const ask = asks.find((item) => item.taskKey && item.taskKey === task.id);
    if (!ask) return;
    out[index] = { mark: "wait", ask: ask.id };
    for (let next = index + 1; next < tasks.length; next += 1) {
      const later = tasks[next]!;
      if (later.depth < task.depth) break;
      if (later.depth > task.depth) continue;
      if (later.state === "todo" && !out[next]!.mark)
        out[next] = { mark: "held", ask: ask.id };
    }
  });
  return out;
}

const BOX: Record<string, string> = {
  done: "[x]",
  doing: "[/]",
  todo: "[ ]",
  blocked: "[!]",
  dropped: "[-]",
  wait: "[?]",
};

function PlanMap({
  client,
  path,
  asks,
  selectedTask,
  onOpenPlan,
}: {
  client: DesktopClient;
  path: string;
  asks: AskDto[];
  selectedTask: string | null;
  onOpenPlan: (path: string) => void;
}) {
  const [plan, setPlan] = useState<AskPlanDto | null>();
  useEffect(() => {
    let live = true;
    void client.request.askPlan({ path }).then(
      (response) => {
        if (live) setPlan(response.ok ? response.data : null);
      },
      () => live && setPlan(null),
    );
    return () => {
      live = false;
    };
  }, [client, path, asks]);
  if (plan === undefined) return null;
  if (plan === null)
    return <p className="needs-empty">This plan can no longer be read.</p>;
  const marks = markPlanTasks(plan.tasks, asks);
  const leaves = plan.tasks.filter((task, index) =>
    plan.tasks[index + 1]?.depth !== undefined
      ? plan.tasks[index + 1]!.depth <= task.depth
      : true,
  );
  const count = (wanted: string) =>
    plan.tasks.filter((task, index) => {
      if (!leaves.includes(task)) return false;
      const mark = marks[index]!.mark;
      if (wanted === "wait" || wanted === "held") return mark === wanted;
      return !mark && task.state === wanted;
    }).length;
  const total = leaves.length || 1;
  return (
    <div className="needs-plan">
      <div className="needs-plan-head">
        <span className="needs-plan-title">{plan.title}</span>
        {plan.owner && <span className="needs-pin">@{plan.owner}</span>}
        <div aria-label="Plan progress" className="needs-progress">
          {(["done", "doing", "wait", "held"] as const).map((key) => (
            <span
              className={`needs-progress-${key}`}
              key={key}
              style={{ width: `${(count(key) / total) * 100}%` }}
            />
          ))}
        </div>
        <button
          className="needs-link"
          onClick={() => onOpenPlan(plan.path)}
          type="button"
        >
          Open plan ↗
        </button>
      </div>
      <div className="needs-legend">
        <span>
          <i className="needs-progress-done" />
          done
        </span>
        <span>
          <i className="needs-progress-doing" />
          doing
        </span>
        <span>
          <i className="needs-progress-wait" />
          waits on you
        </span>
        <span>
          <i className="needs-progress-held" />
          held by it
        </span>
      </div>
      <ul className="needs-tasks">
        {plan.tasks.map((task, index) => {
          const { mark, ask } = marks[index]!;
          const state = mark === "wait" ? "wait" : task.state;
          return (
            <li
              className={`needs-task needs-task-${mark ?? task.state}${task.id && task.id === selectedTask ? " selected" : ""}`}
              key={task.key}
              style={{ paddingLeft: 6 + task.depth * 18 }}
            >
              <span className="needs-task-box">{BOX[state] ?? "[ ]"}</span>
              <span className="needs-task-title">{task.title}</span>
              {mark === "wait" && (
                <span className="needs-task-tag">#{ask} waits on you</span>
              )}
              {mark === "held" && (
                <span className="needs-task-tag held">held by #{ask}</span>
              )}
              {task.owner && (
                <span className="needs-task-owner">@{task.owner}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AskCard({
  ask,
  draft,
  selected,
  now,
  onSelect,
  onDraft,
  onSend,
  onDismiss,
  onUndo,
  onOpenSession,
}: {
  ask: AskDto;
  draft: Draft;
  selected: boolean;
  now: number;
  onSelect: () => void;
  onDraft: (draft: Draft) => void;
  onSend: () => void;
  onDismiss: () => void;
  onUndo: () => void;
  onOpenSession: () => void;
}) {
  const open = ask.state === "open";
  const answer = [ask.answer, ask.note ? `"${ask.note}"` : null]
    .filter(Boolean)
    .join(", ");
  return (
    <article
      aria-label={ask.title}
      className={`needs-card${open ? "" : " ended"}${selected ? " selected" : ""}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button,textarea,label"))
          return;
        onSelect();
      }}
    >
      <div className="needs-card-top">
        <span className="needs-card-title">
          <span className="needs-card-number">#{ask.id}</span> {ask.title}
        </span>
        <span className="needs-card-meta">
          {ask.sessionName ?? "a session"} · {ago(ask.createdAt, now)}
        </span>
      </div>
      {ask.context && <div className="needs-card-context">{ask.context}</div>}
      {ask.why && <div className="needs-card-why">{ask.why}</div>}
      {open && ask.options.length > 0 && (
        <div className="needs-card-options" role="radiogroup">
          {ask.options.map((option, index) => (
            <label key={option}>
              <input
                checked={draft.option === index}
                name={`ask-${ask.id}`}
                onChange={() => onDraft({ ...draft, option: index })}
                onClick={() => {
                  // Clicking the picked option again clears it.
                  if (draft.option === index)
                    onDraft({ ...draft, option: null });
                }}
                type="radio"
              />
              <span>{option}</span>
              {index === ask.recommended && (
                <span className="needs-card-rec">recommended</span>
              )}
            </label>
          ))}
        </div>
      )}
      {ask.planPath && ask.taskKey && (
        <div className="needs-card-where">
          Waits in its plan at <span className="needs-pin">^{ask.taskKey}</span>
        </div>
      )}
      {open ? (
        <div className="needs-card-act">
          <textarea
            aria-label={`Answer #${ask.id}`}
            onChange={(event) =>
              onDraft({ ...draft, note: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                onSend();
            }}
            placeholder={
              ask.options.length
                ? "Pick one, write your own answer, or both"
                : "Write your answer"
            }
            rows={1}
            value={draft.note}
          />
          <button
            className="needs-send"
            disabled={draft.option === null && !draft.note.trim()}
            onClick={onSend}
            type="button"
          >
            Send
          </button>
          <button className="needs-link" onClick={onOpenSession} type="button">
            Open session
          </button>
          <button
            className="needs-link muted"
            onClick={onDismiss}
            title="No longer needed: the session is told not to ask again"
            type="button"
          >
            Dismiss
          </button>
        </div>
      ) : (
        <div className="needs-card-ended">
          {ask.state === "dismissed"
            ? "You dismissed it."
            : ask.state === "closed"
              ? `${ask.closedReason ?? "Closed"}.`
              : ask.closedReason
                ? `${ask.closedReason}${answer ? `: ${answer}` : ""}.`
                : `Answered: ${answer}. Sent to ${ask.sessionName ?? "its session"}.`}{" "}
          <button className="needs-link" onClick={onUndo} type="button">
            Undo
          </button>
        </div>
      )}
    </article>
  );
}

export function NeedsYouPage({
  client,
  onError,
  onOpenSession,
  onOpenPlan,
}: {
  client: DesktopClient;
  onError: (message: string) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenPlan: (path: string, workspaceId: string) => void;
}) {
  const [asks, setAsks] = useState<AskDto[]>();
  const [selected, setSelected] = useState<number | null>(null);
  const [workspace, setWorkspace] = useState<string>("all");
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [now, setNow] = useState(() => Date.now());
  const load = useCallback(async () => {
    try {
      const response = await client.request.askList({});
      if (response.ok) setAsks(response.data);
      setNow(Date.now());
    } catch {
      // The next read tries again.
    }
  }, [client]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    const read = () => void load();
    window.addEventListener("focus", read);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", read);
    };
  }, [load]);

  const workspaces = useMemo(() => {
    const seen = new Map<string, string>();
    for (const ask of asks ?? [])
      if (ask.state === "open")
        seen.set(ask.workspaceId, ask.workspaceName ?? "Workspace");
    return [...seen];
  }, [asks]);
  const shown = (asks ?? []).filter(
    (ask) => workspace === "all" || ask.workspaceId === workspace,
  );
  const open = shown.filter((ask) => ask.state === "open").reverse();
  const ended = shown.filter((ask) => ask.state !== "open");
  const current =
    open.find((ask) => ask.id === selected) ??
    open.find((ask) => ask.planPath) ??
    open[0];
  const planAsks = current?.planPath
    ? (asks ?? []).filter(
        (ask) => ask.state === "open" && ask.planPath === current.planPath,
      )
    : [];

  const run = async (
    request: Promise<
      { ok: true; data: AskDto } | { ok: false; error: { message: string } }
    >,
  ) => {
    const response = await request;
    if (!response.ok) onError(response.error.message);
    await load();
  };
  const draftOf = (id: number): Draft =>
    drafts[id] ?? { option: null, note: "" };

  return (
    <section aria-label="Needs you" className="needs-page">
      <header className="needs-head">
        <h2 className="needs-title">
          Needs you
          <span className="needs-count">{open.length}</span>
        </h2>
        {workspaces.length > 1 && (
          <div className="needs-chips">
            {[["all", "All workspaces"] as const, ...workspaces].map(
              ([id, name]) => (
                <button
                  aria-pressed={workspace === id}
                  className="needs-chip"
                  key={id}
                  onClick={() => setWorkspace(id)}
                  type="button"
                >
                  {name}
                </button>
              ),
            )}
          </div>
        )}
      </header>
      <div className="needs-columns">
        <div className="needs-cards">
          {asks && open.length === 0 && (
            <p className="needs-empty">
              Nothing waits on you. When a session asks you something with
              daedal ask, it shows here with its context.
            </p>
          )}
          {open.map((ask) => (
            <AskCard
              ask={ask}
              draft={draftOf(ask.id)}
              key={ask.id}
              now={now}
              onDismiss={() =>
                void run(client.request.askDismiss({ id: ask.id }))
              }
              onDraft={(draft) =>
                setDrafts((all) => ({ ...all, [ask.id]: draft }))
              }
              onOpenSession={() => onOpenSession(ask.sessionId)}
              onSelect={() => setSelected(ask.id)}
              onSend={() => {
                const draft = draftOf(ask.id);
                if (draft.option === null && !draft.note.trim()) return;
                void run(
                  client.request.askAnswer({
                    id: ask.id,
                    option: draft.option,
                    note: draft.note.trim() || null,
                  }),
                ).then(() => setDrafts(({ [ask.id]: _, ...rest }) => rest));
              }}
              onUndo={() => undefined}
              selected={current?.id === ask.id}
            />
          ))}
          {ended.length > 0 && (
            <>
              <div className="needs-section">Answered or closed today</div>
              {ended.map((ask) => (
                <AskCard
                  ask={ask}
                  draft={draftOf(ask.id)}
                  key={ask.id}
                  now={now}
                  onDismiss={() => undefined}
                  onDraft={() => undefined}
                  onOpenSession={() => onOpenSession(ask.sessionId)}
                  onSelect={() => undefined}
                  onSend={() => undefined}
                  onUndo={() =>
                    void run(client.request.askReopen({ id: ask.id }))
                  }
                  selected={false}
                />
              ))}
            </>
          )}
        </div>
        <div className="needs-side">
          {current?.planPath ? (
            <PlanMap
              asks={planAsks}
              client={client}
              onOpenPlan={(path) => onOpenPlan(path, current.workspaceId)}
              path={current.planPath}
              selectedTask={current.taskKey}
            />
          ) : (
            current && (
              <p className="needs-empty">
                #{current.id} is not pinned to a plan task.
              </p>
            )
          )}
        </div>
      </div>
    </section>
  );
}
