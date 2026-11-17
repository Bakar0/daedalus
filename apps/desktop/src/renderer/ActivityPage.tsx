/**
 * Activity: what waits on the user. Today that is every question a session asked the user, as a card with its
 * context, its options and where it sits in its plan, kept until the user
 * answers or dismisses it here, or it closes on its own. Answers go to the
 * asking session with the question and its context. Beside the cards, the
 * selected card's plan shows the task that waits on the user and the tasks
 * held behind it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type React from "react";
import type { AskDto, AskPlanDto } from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";

/** A pulse line: Activity's mark. */
export const ACTIVITY_ICON_PATH = "M1.5 8h3l2-5 3 10 2-5h3";

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

/** Put off by the user until a time that has not come yet. */
export const isSnoozed = (
  ask: Pick<AskDto, "snoozedUntil">,
  now: number,
): boolean => ask.snoozedUntil !== null && Date.parse(ask.snoozedUntil) > now;

/** The snooze lengths a card offers, as the time each one ends. */
export function snoozeChoices(now: Date): { label: string; until: Date }[] {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return [
    { label: "5 min", until: new Date(now.getTime() + 5 * 60_000) },
    { label: "1 hour", until: new Date(now.getTime() + 60 * 60_000) },
    { label: "Tomorrow 9:00", until: tomorrow },
  ];
}

const clock = (iso: string, now: number): string => {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return at.toDateString() === new Date(now).toDateString()
    ? time
    : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
};

/** Open asks: all of them, and by workspace. */
export interface OpenAskCounts {
  total: number;
  byWorkspace: ReadonlyMap<string, number>;
}

const NO_ASKS: OpenAskCounts = { total: 0, byWorkspace: new Map() };

/**
 * Open asks, counted for the sidebar's Activity and each workspace's
 * Activity tab. Polls while mounted.
 */
export function useOpenAskCounts(client: DesktopClient): OpenAskCounts {
  const [count, setCount] = useState(NO_ASKS);
  useEffect(() => {
    let live = true;
    const read = () =>
      void client.request.askList({}).then(
        (response) => {
          if (live && response.ok) {
            const now = Date.now();
            const open = response.data.filter(
              (ask) => ask.state === "open" && !isSnoozed(ask, now),
            );
            const byWorkspace = new Map<string, number>();
            for (const ask of open)
              byWorkspace.set(
                ask.workspaceId,
                (byWorkspace.get(ask.workspaceId) ?? 0) + 1,
              );
            setCount({ total: open.length, byWorkspace });
          }
        },
        () => undefined,
      );
    read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") read();
    }, REFRESH_MS * 2);
    window.addEventListener("focus", read);
    // An ask answered here, or asked or closed anywhere, announces a full
    // change: the count follows it at once instead of on the next poll.
    // Partial ones (activity, telemetry) never carry asks.
    const unsubscribe = client.subscribe((change) => {
      if (!change?.parts?.length) read();
    });
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", read);
      unsubscribe();
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

/** A plan task as Activity lists it: its group, and what marks it. */
export interface GroupedTask {
  task: AskPlanDto["tasks"][number];
  /** The ask it waits on (in Waits on you), or waits after (Not started). */
  ask?: number;
}

/** The groups the plan is shown in, in this order; Done comes folded. */
export const PLAN_GROUPS = [
  { key: "wait", label: "Waits on you" },
  { key: "blocked", label: "Blocked" },
  { key: "doing", label: "In progress" },
  { key: "todo", label: "Not started" },
  { key: "done", label: "Done" },
] as const;

export type PlanGroup = (typeof PLAN_GROUPS)[number]["key"];

/**
 * The plan's tasks by what they need: the ones that wait on the user first,
 * then blocked, in progress, not started, and done (dropped ones with it).
 * Only tasks with no subtasks are listed; a parent is the sum of its own.
 */
export function groupPlanTasks(
  tasks: AskPlanDto["tasks"],
  asks: readonly Pick<AskDto, "id" | "taskKey">[],
): Record<PlanGroup, GroupedTask[]> {
  const marks = markPlanTasks(tasks, asks);
  const groups: Record<PlanGroup, GroupedTask[]> = {
    wait: [],
    blocked: [],
    doing: [],
    todo: [],
    done: [],
  };
  tasks.forEach((task, index) => {
    const next = tasks[index + 1];
    if (next && next.depth > task.depth) return;
    const { mark, ask } = marks[index]!;
    const group: PlanGroup =
      mark === "wait" ? "wait" : task.state === "dropped" ? "done" : task.state;
    groups[group].push(ask === undefined ? { task } : { task, ask });
  });
  return groups;
}

function PlanMap({
  client,
  path,
  asks,
  selectedTask,
  selectedAsk,
  onOpenPlan,
}: {
  client: DesktopClient;
  path: string;
  asks: AskDto[];
  selectedTask: string | null;
  /** The card the plan is shown for. */
  selectedAsk?: number;
  onOpenPlan: (path: string) => void;
}) {
  const plan = usePlan(client, path, asks);
  if (plan === undefined) return null;
  if (plan === null)
    return <p className="needs-empty">This plan can no longer be read.</p>;
  const groups = groupPlanTasks(plan.tasks, asks);
  const total =
    PLAN_GROUPS.reduce((sum, { key }) => sum + groups[key].length, 0) || 1;
  const summary = [
    `${groups.done.length} of ${total} done`,
    groups.doing.length ? `${groups.doing.length} in progress` : "",
    groups.blocked.length ? `${groups.blocked.length} blocked` : "",
    groups.wait.length
      ? `${groups.wait.length} ${groups.wait.length === 1 ? "waits" : "wait"} on you`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const row = ({ task, ask }: GroupedTask, group: PlanGroup) => (
    <li
      className={`needs-task needs-task-${group}${task.id && task.id === selectedTask ? " selected" : ""}`}
      key={task.key}
    >
      <span className="needs-task-title">{task.title}</span>
      {ask !== undefined && group === "wait" && (
        <span className="needs-task-tag">#{ask}</span>
      )}
      {ask !== undefined && group === "todo" && (
        <span className="needs-task-tag">after #{ask}</span>
      )}
      {task.owner && <span className="needs-task-owner">@{task.owner}</span>}
    </li>
  );
  return (
    <div className="needs-plan">
      <div className="needs-plan-head">
        <span className="needs-plan-whose">
          {plan.owner ? `Plan of @${plan.owner}` : "Plan"}
          {selectedAsk !== undefined ? `, where #${selectedAsk} waits` : ""}
        </span>
        <button
          className="needs-link"
          onClick={() => onOpenPlan(plan.path)}
          type="button"
        >
          Open plan ↗
        </button>
      </div>
      <div className="needs-plan-title">{plan.title}</div>
      <div className="needs-plan-summary">{summary}</div>
      <div aria-hidden="true" className="needs-progress">
        {(["done", "doing", "wait", "blocked"] as const).map((key) => (
          <span
            className={`needs-progress-${key}`}
            key={key}
            style={{ width: `${(groups[key].length / total) * 100}%` }}
          />
        ))}
      </div>
      {PLAN_GROUPS.map(({ key, label }) => {
        const items = groups[key];
        if (!items.length) return null;
        const heading = `${label} · ${items.length}`;
        const list = (
          <ul className="needs-tasks">{items.map((item) => row(item, key))}</ul>
        );
        return key === "done" ? (
          <details className={`needs-group needs-group-${key}`} key={key}>
            <summary className="needs-group-head">{heading}</summary>
            {list}
          </details>
        ) : (
          <section className={`needs-group needs-group-${key}`} key={key}>
            <div className="needs-group-head">{heading}</div>
            {list}
          </section>
        );
      })}
    </div>
  );
}

/**
 * A plan, read again when the asks pinned to it change; `undefined` while
 * it is read, `null` when it cannot be.
 */
function usePlan(
  client: DesktopClient,
  path: string,
  asks: readonly Pick<AskDto, "id" | "taskKey">[],
): AskPlanDto | null | undefined {
  const [plan, setPlan] = useState<AskPlanDto | null>();
  const pins = asks.map((ask) => `${ask.id}:${ask.taskKey}`).join();
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
  }, [client, path, pins]);
  return plan;
}

/** The title of the task an ask waits at, read from its plan. */
function TaskTitle({ client, ask }: { client: DesktopClient; ask: AskDto }) {
  const plan = usePlan(client, ask.planPath!, [ask]);
  const task = plan?.tasks.find((each) => each.id === ask.taskKey);
  return <>{task?.title ?? `^${ask.taskKey}`}</>;
}

/**
 * A card's plan, folded under it. Shown where the page is one column (the
 * side panel, or a narrow pane), so the plan sits by its question instead of
 * after the whole list. The plan is read only once it is opened.
 */
function CardPlan({
  client,
  path,
  asks,
  taskKey,
  onOpenPlan,
}: {
  client: DesktopClient;
  path: string;
  asks: AskDto[];
  taskKey: string | null;
  onOpenPlan: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="needs-card-plan"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Plan{taskKey ? ` · ^${taskKey}` : ""}</summary>
      {open && (
        <PlanMap
          asks={asks}
          client={client}
          onOpenPlan={onOpenPlan}
          path={path}
          selectedTask={taskKey}
        />
      )}
    </details>
  );
}

function AskCard({
  client,
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
  onSnooze,
  children,
}: {
  client: DesktopClient;
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
  /** Puts it off until a time, or brings it back with null. */
  onSnooze?: (until: string | null) => void;
  /** What goes at the card's foot: its plan, in the side panel. */
  children?: React.ReactNode;
}) {
  const open = ask.state === "open";
  const [choosing, setChoosing] = useState(false);
  const snoozed = isSnoozed(ask, now);
  const answer = [ask.answer, ask.note ? `"${ask.note}"` : null]
    .filter(Boolean)
    .join(", ");
  return (
    <article
      aria-label={ask.title}
      className={`needs-card${open ? "" : " ended"}${selected ? " selected" : ""}`}
      onClick={(event) => {
        if (
          (event.target as HTMLElement).closest("button,textarea,label,details")
        )
          return;
        onSelect();
      }}
    >
      <div className="needs-card-top">
        <span className="needs-card-who">{ask.sessionName ?? "A session"}</span>
        <span className="needs-card-meta">
          asks · {ago(ask.createdAt, now)} ago
        </span>
        <span className="needs-card-number">#{ask.id}</span>
      </div>
      <div className="needs-card-title">{ask.title}</div>
      {ask.why && (
        <div className="needs-card-why">
          <span className="needs-card-why-label">Why</span>
          <span>{ask.why}</span>
        </div>
      )}
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
      {ask.context && (
        <details className="needs-card-details">
          <summary>Details</summary>
          <div className="needs-card-context">{ask.context}</div>
        </details>
      )}
      {open ? (
        <>
          <textarea
            aria-label={`Answer #${ask.id}`}
            className="needs-card-answer"
            onChange={(event) =>
              onDraft({ ...draft, note: event.target.value })
            }
            onKeyDown={(event) => {
              // Enter sends; Shift+Enter starts a new line.
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                onSend();
              }
            }}
            placeholder={
              ask.options.length
                ? "Pick one, write your own answer, or both · Enter sends"
                : "Write your answer · Enter sends"
            }
            rows={2}
            value={draft.note}
          />
          <div className="needs-card-act">
            <button
              className="needs-send"
              disabled={draft.option === null && !draft.note.trim()}
              onClick={onSend}
              type="button"
            >
              Send
            </button>
            <button
              className="needs-link"
              onClick={onOpenSession}
              type="button"
            >
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
            {onSnooze &&
              (snoozed ? (
                <span className="needs-card-snoozed">
                  Snoozed until {clock(ask.snoozedUntil!, now)}{" "}
                  <button
                    className="needs-link"
                    onClick={() => onSnooze(null)}
                    type="button"
                  >
                    Unsnooze
                  </button>
                </span>
              ) : choosing ? (
                <span className="needs-card-snooze">
                  {snoozeChoices(new Date()).map((choice) => (
                    <button
                      className="needs-link"
                      key={choice.label}
                      onClick={() => {
                        setChoosing(false);
                        onSnooze(choice.until.toISOString());
                      }}
                      type="button"
                    >
                      {choice.label}
                    </button>
                  ))}
                  <button
                    className="needs-link muted"
                    onClick={() => setChoosing(false)}
                    type="button"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  className="needs-link muted"
                  onClick={() => setChoosing(true)}
                  title="Put it off: it leaves the count and comes back when the time is up"
                  type="button"
                >
                  Snooze
                </button>
              ))}
            {ask.planPath && ask.taskKey && (
              <span className="needs-card-where">
                In the plan:{" "}
                <span className="needs-card-task">
                  <TaskTitle ask={ask} client={client} />
                </span>
              </span>
            )}
          </div>
        </>
      ) : (
        <div className="needs-card-ended">
          {ask.state === "dismissed"
            ? "You dismissed it."
            : ask.state === "closed"
              ? `${ask.closedReason ?? "Closed"}.`
              : ask.closedReason
                ? `${ask.closedReason}${answer ? `: ${answer}` : ""}.`
                : `Answered: ${answer}. Sent to ${ask.sessionName ?? "its session"}.`}{" "}
          {ask.undoable && (
            <button className="needs-link" onClick={onUndo} type="button">
              Undo
            </button>
          )}
        </div>
      )}
      {children}
    </article>
  );
}

export function ActivityPage({
  client,
  onError,
  onOpenSession,
  onOpenPlan,
  workspaceId,
}: {
  client: DesktopClient;
  onError: (message: string) => void;
  onOpenSession: (sessionId: string) => void;
  onOpenPlan: (path: string, workspaceId: string) => void;
  /**
   * One workspace only, as the side panel's Activity tab shows it: one
   * column, each card with its plan folded under it.
   */
  workspaceId?: string;
}) {
  const narrow = workspaceId !== undefined;
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
    const unsubscribe = client.subscribe((change) => {
      if (!change?.parts?.length) read();
    });
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", read);
      unsubscribe();
    };
  }, [client, load]);

  const workspaces = useMemo(() => {
    const seen = new Map<string, string>();
    for (const ask of asks ?? [])
      if (ask.state === "open")
        seen.set(ask.workspaceId, ask.workspaceName ?? "Workspace");
    return [...seen];
  }, [asks]);
  const scope = workspaceId ?? workspace;
  const shown = (asks ?? []).filter(
    (ask) => scope === "all" || ask.workspaceId === scope,
  );
  const waiting = shown.filter((ask) => ask.state === "open").reverse();
  // Snoozed asks are open but put off: out of the count and folded away
  // until their time comes.
  const open = waiting.filter((ask) => !isSnoozed(ask, now));
  const snoozed = waiting.filter((ask) => isSnoozed(ask, now));
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
    return response.ok;
  };
  const draftOf = (id: number): Draft =>
    drafts[id] ?? { option: null, note: "" };

  const openCard = (ask: AskDto) => (
    <AskCard
      client={client}
      ask={ask}
      draft={draftOf(ask.id)}
      key={ask.id}
      now={now}
      onDismiss={() => void run(client.request.askDismiss({ id: ask.id }))}
      onDraft={(draft) => setDrafts((all) => ({ ...all, [ask.id]: draft }))}
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
        ).then((sent) => {
          if (sent) setDrafts(({ [ask.id]: _, ...rest }) => rest);
        });
      }}
      onSnooze={(until) =>
        void run(client.request.askSnooze({ id: ask.id, until }))
      }
      onUndo={() => undefined}
      selected={!narrow && current?.id === ask.id}
    >
      {ask.planPath && (
        <CardPlan
          asks={(asks ?? []).filter(
            (other) =>
              other.state === "open" && other.planPath === ask.planPath,
          )}
          client={client}
          onOpenPlan={(path) => onOpenPlan(path, ask.workspaceId)}
          path={ask.planPath}
          taskKey={ask.taskKey}
        />
      )}
    </AskCard>
  );
  return (
    <section
      aria-label="Activity"
      className={`needs-page${narrow ? " narrow" : ""}`}
    >
      <header className="needs-head">
        <h2 className="needs-title">
          {narrow ? "Waiting on you" : "Activity"}
          <span className="needs-count">{open.length}</span>
        </h2>
        {!narrow && workspaces.length > 1 && (
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
              {narrow
                ? "Nothing in this workspace waits on you."
                : "Nothing waits on you. When a session asks you something with daedal activity ask, it shows here with its context."}
            </p>
          )}
          {open.map(openCard)}
          {snoozed.length > 0 && (
            <details className="needs-ended">
              <summary className="needs-section">
                Snoozed · {snoozed.length}
              </summary>
              <div className="needs-ended-cards">{snoozed.map(openCard)}</div>
            </details>
          )}
          {ended.length > 0 && (
            // Folded by default: what is done today should not pull the eye
            // from what still waits.
            <details className="needs-ended">
              <summary className="needs-section">
                Answered or closed today · {ended.length}
              </summary>
              <div className="needs-ended-cards">
                {ended.map((ask) => (
                  <AskCard
                    client={client}
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
              </div>
            </details>
          )}
        </div>
        {!narrow && (
          <div className="needs-side">
            {current?.planPath ? (
              <PlanMap
                asks={planAsks}
                client={client}
                onOpenPlan={(path) => onOpenPlan(path, current.workspaceId)}
                path={current.planPath}
                selectedAsk={current.id}
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
        )}
      </div>
    </section>
  );
}
