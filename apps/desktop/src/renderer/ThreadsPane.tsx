/**
 * The Threads page: every agent's threads across workspaces, as one list.
 * A thread is a conversation between an agent and the user. The agent opens
 * one and moves on, or the user opens one by asking a read-only fork of the
 * agent, which answers while the agent works on. A row opens the thread in
 * its agent's window over the Factory, where it is read and answered.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ThreadDto } from "@daedalus/protocol";
import { isSnoozed, snoozeChoices, waitsOnUser } from "./threads-shared";
import type { DesktopClient } from "./client-types";

const REFRESH_MS = 5_000;

type ThreadState =
  "blocking" | "waiting" | "replied" | "fork" | "snoozed" | "ended";

/** A thread the user opened on a fork, where nobody has written yet. */
const isForkOnly = (thread: ThreadDto): boolean =>
  !thread.messages.some((message) => message.kind === "message");

export const threadState = (
  thread: ThreadDto,
  now: number = Date.now(),
): ThreadState =>
  thread.resolvedAt
    ? "ended"
    : isSnoozed(thread, now)
      ? "snoozed"
      : thread.blocking
        ? "blocking"
        : thread.turn === "user"
          ? "waiting"
          : thread.turn === "agent"
            ? "replied"
            : "fork";

const STATE_LABEL: Record<ThreadState, string> = {
  blocking: "Blocking agent",
  waiting: "Waiting on you",
  replied: "With the agent",
  fork: "Your thread",
  snoozed: "Snoozed",
  ended: "Resolved today",
};

const ago = (from: string, now: number): string => {
  const minutes = Math.max(0, Math.round((now - Date.parse(from)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

const until = (iso: string): string => {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return at.toDateString() === new Date().toDateString()
    ? time
    : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
};

/**
 * Threads, kept fresh while shown: these sessions' (a session and, for a
 * lead, its members), or every one's.
 */
function useThreads(
  client: DesktopClient,
  sessionIds: readonly string[] | undefined | null,
): { threads: ThreadDto[]; reload: () => void } {
  const [threads, setThreads] = useState<ThreadDto[]>([]);
  const key = sessionIds === null ? null : sessionIds?.join(",");
  const reload = useCallback(() => {
    if (key === undefined) return;
    const ids = key === null ? null : new Set(key.split(","));
    void client.request.threadList({}).then(
      (response) => {
        if (response.ok)
          setThreads(
            ids === null
              ? response.data
              : response.data.filter((thread) => ids.has(thread.sessionId)),
          );
      },
      () => undefined,
    );
  }, [client, key]);
  useEffect(() => {
    setThreads([]);
    reload();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, REFRESH_MS);
    const unsubscribe = client.subscribe((change) => {
      if (!change?.parts?.length) reload();
    });
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [client, reload]);
  return { threads, reload };
}

/** Takes a resolved thread back to open. */
function ReopenButton({
  client,
  thread,
  onDone,
  onError,
}: {
  client: DesktopClient;
  thread: ThreadDto;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  if (!thread.resolvedAt) return null;
  return (
    <button
      className="threads-quiet"
      onClick={(event) => {
        event.stopPropagation();
        void client.request.threadReopen({ id: thread.id }).then((response) => {
          if (!response.ok) onError(response.error.message);
          onDone();
        });
      }}
      title={
        isForkOnly(thread)
          ? "Open it again, with its fork"
          : `Open it again; ${thread.sessionName ?? "the agent"} is told`
      }
      type="button"
    >
      Reopen
    </button>
  );
}

/** Put off until later, or bring back now. */
function SnoozeButton({
  client,
  thread,
  onDone,
  onError,
}: {
  client: DesktopClient;
  thread: ThreadDto;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLSpanElement>(null);
  // A click anywhere else, or Escape, puts the menu away.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  if (thread.resolvedAt || isForkOnly(thread)) return null;
  const snooze = async (time: string | null) => {
    setOpen(false);
    const response = await client.request.threadSnooze({
      id: thread.id,
      until: time,
    });
    if (!response.ok) onError(response.error.message);
    onDone();
  };
  if (isSnoozed(thread, Date.now()))
    return (
      <button
        className="threads-quiet"
        onClick={(event) => {
          event.stopPropagation();
          void snooze(null);
        }}
        type="button"
      >
        Unsnooze
      </button>
    );
  return (
    <span className="threads-snooze" ref={menu}>
      <button
        aria-expanded={open}
        className="threads-quiet"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        type="button"
      >
        Snooze
      </button>
      {open && (
        <span className="threads-snooze-menu" role="menu">
          {snoozeChoices(new Date()).map((choice) => (
            <button
              key={choice.label}
              onClick={(event) => {
                event.stopPropagation();
                void snooze(choice.until.toISOString());
              }}
              role="menuitem"
              type="button"
            >
              {choice.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function ThreadRow({
  thread,
  onOpen,
  action,
}: {
  thread: ThreadDto;
  onOpen: () => void;
  action?: ReactNode;
}) {
  const now = Date.now();
  const state = threadState(thread, now);
  const meta = [
    state === "ended" || state === "snoozed" ? null : STATE_LABEL[state],
    `#${thread.id}`,
    thread.sessionName ?? "a session",
    thread.workspaceName,
    state === "snoozed" && thread.snoozedUntil
      ? `until ${until(thread.snoozedUntil)}`
      : ago(thread.resolvedAt ?? thread.updatedAt, now),
  ].filter(Boolean);
  return (
    <div className={`threads-row ${state}${thread.unread ? " unread" : ""}`}>
      <button className="threads-row-main" onClick={onOpen} type="button">
        <span aria-hidden="true" className="threads-dot" />
        <span className="threads-row-text">
          <span className="threads-title">{thread.title}</span>
          <span className="threads-meta">{meta.join(" · ")}</span>
        </span>
      </button>
      {action && <span className="threads-row-action">{action}</span>}
    </div>
  );
}

/** What comes first in the list: what stops an agent, then what waits. */
const STATE_ORDER: readonly ThreadState[] = [
  "blocking",
  "waiting",
  "replied",
  "fork",
];

/**
 * The list: open threads as rows, the ones that stop an agent first, then
 * the snoozed and the resolved. Resolved rows sit in a section that starts
 * collapsed, so they do not crowd what is still open.
 */
function ThreadFeed({
  client,
  threads,
  onOpen,
  onChanged,
  onError,
}: {
  client: DesktopClient;
  threads: ThreadDto[];
  onOpen: (thread: ThreadDto) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const now = Date.now();
  const stateOf = (thread: ThreadDto) => threadState(thread, now);
  const live = threads
    .filter((thread) => STATE_ORDER.includes(stateOf(thread)))
    .sort(
      (a, b) =>
        STATE_ORDER.indexOf(stateOf(a)) - STATE_ORDER.indexOf(stateOf(b)) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  const snoozed = threads.filter((thread) => stateOf(thread) === "snoozed");
  const ended = threads.filter((thread) => stateOf(thread) === "ended");
  const row = (thread: ThreadDto) => (
    <ThreadRow
      action={
        <>
          <SnoozeButton
            client={client}
            onDone={onChanged}
            onError={onError}
            thread={thread}
          />
          <ReopenButton
            client={client}
            onDone={onChanged}
            onError={onError}
            thread={thread}
          />
        </>
      }
      key={thread.id}
      onOpen={() => onOpen(thread)}
      thread={thread}
    />
  );
  return (
    <div className="threads-feed">
      {live.length === 0 && (
        <p className="threads-empty">Nothing waits on you.</p>
      )}
      {live.map(row)}
      {snoozed.length > 0 && (
        <section className="threads-folded">
          <h3 className="threads-group">
            {STATE_LABEL.snoozed} · {snoozed.length}
          </h3>
          {snoozed.map(row)}
        </section>
      )}
      {ended.length > 0 && (
        <section className="threads-folded">
          <h3 className="threads-group">
            <button
              aria-expanded={showResolved}
              className="threads-group-toggle"
              onClick={() => setShowResolved((open) => !open)}
              type="button"
            >
              <span aria-hidden="true">{showResolved ? "▾" : "▸"}</span>{" "}
              {STATE_LABEL.ended} · {ended.length}
            </button>
          </h3>
          {showResolved && ended.map(row)}
        </section>
      )}
    </div>
  );
}

/** Every agent's threads, at Home. */
export function ThreadsHome({
  client,
  onOpenThread,
  onError,
}: {
  client: DesktopClient;
  /** Opens the thread in its agent's window; a resolved one in its History. */
  onOpenThread: (thread: ThreadDto) => void;
  onError: (message: string) => void;
}) {
  const { threads, reload } = useThreads(client, null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  // A thread with a fork that the user closed or deleted is in its agent's
  // History, not here.
  const questions = threads.filter(
    (thread) => !(isForkOnly(thread) && (thread.closedAt || thread.resolvedAt)),
  );
  const waitsOnYou = (thread: ThreadDto) => waitsOnUser(thread, Date.now());
  // Every workspace with a thread, those waiting on you first.
  const workspaces = [
    ...new Map(
      questions.map((thread) => [
        thread.workspaceId,
        thread.workspaceName ?? thread.workspaceId,
      ]),
    ),
  ]
    .map(([id, name]) => ({
      id,
      name,
      waiting: questions.filter(
        (thread) => thread.workspaceId === id && waitsOnYou(thread),
      ).length,
    }))
    .sort((a, b) => b.waiting - a.waiting || a.name.localeCompare(b.name));
  // A workspace whose threads are all gone falls back to every workspace.
  const filter = workspaces.some((item) => item.id === workspaceId)
    ? workspaceId
    : null;
  const shown = filter
    ? questions.filter((thread) => thread.workspaceId === filter)
    : questions;
  const waiting = questions.filter(waitsOnYou).length;
  return (
    <div className="threads-home">
      <header className="threads-home-head">
        <h1>
          Threads{" "}
          {waiting > 0 && <span className="threads-count">{waiting}</span>}
        </h1>
        <p>
          Every agent&apos;s threads, the ones that wait on you first. Click one
          to read and answer it.
        </p>
        {workspaces.length > 1 && (
          <div
            aria-label="Show threads from"
            className="threads-filter"
            role="radiogroup"
          >
            {[{ id: null, name: "All", waiting }, ...workspaces].map((item) => (
              <button
                aria-checked={filter === item.id}
                className="threads-filter-chip"
                key={item.id ?? "all"}
                onClick={() => setWorkspaceId(item.id)}
                role="radio"
                type="button"
              >
                {item.name}
                {item.waiting > 0 && (
                  <span className="threads-filter-count">{item.waiting}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </header>
      <ThreadFeed
        client={client}
        onChanged={reload}
        onError={onError}
        onOpen={onOpenThread}
        key={filter ?? "all"}
        threads={shown}
      />
    </div>
  );
}
