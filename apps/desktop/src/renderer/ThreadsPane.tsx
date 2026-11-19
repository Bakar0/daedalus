/**
 * Threads. A question thread is something a session's agent asked the user
 * and moved on from; the user answers it at a prompt that works like the
 * terminal's, and the answer goes to the agent as a message. A fork thread is
 * one the user opened: a read-only fork of the session, shown as a terminal,
 * to talk a message through while the session works on. Every thread hangs
 * off a message in main by its transcript id; "show" opens main's messages,
 * read from the transcript, at that message.
 *
 * `ThreadsPane` is one session's threads, in the side panel beside it.
 * `ThreadsHome` is every session's, at Home; opening one there opens its
 * session with the thread in the pane.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import type { ReactNode } from "react";
import type {
  AgentSessionDto,
  AskDto,
  MainMessageDto,
} from "@daedalus/protocol";
import { isSnoozed, snoozeChoices } from "./threads-shared";
import type { DesktopClient } from "./client-types";
import { MarkdownPreview } from "./markdown-preview";

const REFRESH_MS = 5_000;

type View =
  | { kind: "list" }
  | { kind: "thread"; id: number }
  | {
      kind: "messages";
      sessionId: string;
      name: string;
      focus: string | null;
      back: View;
    };

type ThreadState = "blocking" | "waiting" | "fork" | "snoozed" | "ended";

export const threadState = (
  ask: AskDto,
  now: number = Date.now(),
): ThreadState =>
  ask.state !== "open"
    ? "ended"
    : ask.kind === "fork"
      ? "fork"
      : isSnoozed(ask, now)
        ? "snoozed"
        : ask.bumpedAt
          ? "blocking"
          : "waiting";

const STATE_LABEL: Record<ThreadState, string> = {
  blocking: "Blocking agent",
  waiting: "Waiting on you",
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

const firstLine = (text: string) => text.split("\n")[0] ?? "";

/**
 * Threads, kept fresh while shown: these sessions' (a session and, for a
 * lead, its members), or every one's.
 */
function useThreads(
  client: DesktopClient,
  sessionIds: readonly string[] | undefined | null,
): { threads: AskDto[]; reload: () => void } {
  const [threads, setThreads] = useState<AskDto[]>([]);
  const key = sessionIds === null ? null : sessionIds?.join(",");
  const reload = useCallback(() => {
    if (key === undefined) return;
    const ids = key === null ? null : new Set(key.split(","));
    void client.request.askList({}).then(
      (response) => {
        if (response.ok)
          setThreads(
            ids === null
              ? response.data
              : response.data.filter((ask) => ids.has(ask.sessionId)),
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

/**
 * The message a thread hangs off, quoted, with one plain way to see it in
 * its conversation. The same in a card and in a fork.
 */
function AnchorQuote({
  thread,
  label,
  onShow,
}: {
  thread: AskDto;
  label: string;
  onShow: (focus: string | null) => void;
}) {
  if (!thread.anchorId || !thread.anchorText) return null;
  const owner = thread.sessionName ?? "the agent";
  return (
    <div className="threads-quote">
      <span className="threads-quote-label">
        {label} {owner}&apos;s message:
      </span>
      <span className="threads-anchor-text">{thread.anchorText}</span>
      <button
        className="threads-quote-go"
        onClick={() => onShow(thread.anchorId)}
        type="button"
      >
        See it in {owner}&apos;s conversation →
      </button>
    </div>
  );
}

/** Takes a resolved thread back to open. */
function ReopenButton({
  client,
  thread,
  onDone,
  onError,
}: {
  client: DesktopClient;
  thread: AskDto;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  if (thread.state === "open") return null;
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
        thread.kind === "question"
          ? `Open it again; ${thread.sessionName ?? "the agent"} is told to wait for a new answer`
          : "Open it again, with its fork"
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
  thread: AskDto;
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
  if (thread.kind !== "question" || thread.state !== "open") return null;
  const snooze = async (time: string | null) => {
    setOpen(false);
    const response = await client.request.askSnooze({
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
  showSession,
  onOpen,
  action,
}: {
  thread: AskDto;
  showSession: boolean;
  onOpen: () => void;
  action?: ReactNode;
}) {
  const now = Date.now();
  const state = threadState(thread, now);
  const meta = [
    `#${thread.id}`,
    showSession ? (thread.sessionName ?? "a session") : null,
    showSession ? thread.workspaceName : null,
    state === "snoozed" && thread.snoozedUntil
      ? `until ${until(thread.snoozedUntil)}`
      : ago(thread.closedAt ?? thread.createdAt, now),
  ].filter(Boolean);
  return (
    <div className={`threads-row ${state}`}>
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

/**
 * A question thread, open in place: the message it hangs off, the question,
 * the picker and a prompt. Keys typed anywhere in the card drive its picker.
 */
function ThreadCard({
  client,
  thread,
  showSession,
  ownerTag,
  onShow,
  onFork,
  onOpenSession,
  onChanged,
  onError,
  onCollapse,
}: {
  client: DesktopClient;
  thread: AskDto;
  showSession: boolean;
  /** "lead" or "member", in a lead's pane. */
  ownerTag?: string | null;
  onShow: (focus: string | null) => void;
  onFork: () => void;
  onOpenSession?: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
  /** Folds a snoozed or resolved card back to its row. */
  onCollapse?: () => void;
}) {
  const now = Date.now();
  const state = threadState(thread, now);
  const open = thread.state === "open";
  const isFork = thread.kind === "fork";
  const options = thread.options.length;
  const [selected, setSelected] = useState(thread.recommended ?? 0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  const send = async (option: number | null, note: string | null) => {
    if (sending || !open || isFork) return;
    setSending(true);
    try {
      const response = await client.request.askAnswer({
        id: thread.id,
        option,
        note,
      });
      if (!response.ok) onError(response.error.message);
      else setDraft("");
      onChanged();
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const typing = draft.length > 0;
    if (event.key === "Escape") {
      event.preventDefault();
      input.current?.blur();
      onCollapse?.();
    } else if (event.key === "f" && event.ctrlKey) {
      event.preventDefault();
      onFork();
    } else if (
      open &&
      options &&
      !typing &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      event.preventDefault();
      setSelected(
        (current) =>
          (current + (event.key === "ArrowDown" ? 1 : options - 1)) % options,
      );
    } else if (
      open &&
      !typing &&
      /^[1-9]$/.test(event.key) &&
      Number(event.key) <= options
    ) {
      event.preventDefault();
      setSelected(Number(event.key) - 1);
      void send(Number(event.key) - 1, null);
    } else if (
      open &&
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      const text = draft.trim();
      if (text) void send(null, text);
      else if (options) void send(selected, null);
    }
  };

  const owner = thread.sessionName ?? "an agent";
  const meta = [
    showSession ? thread.workspaceName : null,
    ago(thread.createdAt, now),
    `#${thread.id}`,
  ].filter(Boolean);
  const answer = [thread.answer, thread.note ? `"${thread.note}"` : null]
    .filter(Boolean)
    .join(", ");
  return (
    <article
      className={`threads-card ${state}`}
      id={`thread-card-${thread.id}`}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        // A click on the card, not on a control, sends the keys here.
        if (
          (event.target as HTMLElement).closest(
            "button, a, summary, input, textarea, .threads-anchor-text",
          )
        )
          return;
        event.preventDefault();
        input.current?.focus();
      }}
    >
      <header className="threads-card-head">
        <span aria-hidden="true" className="threads-dot" />
        <button
          className="threads-owner"
          onClick={() => onShow(null)}
          title={`Open ${owner}'s conversation`}
          type="button"
        >
          {owner}
        </button>
        {ownerTag && <span className="threads-owner-tag">{ownerTag}</span>}
        <span className="threads-meta">{meta.join(" · ")}</span>
        {state !== "waiting" && (
          <span className={`threads-state ${state}`}>
            {state === "snoozed" && thread.snoozedUntil
              ? `Snoozed until ${until(thread.snoozedUntil)}`
              : state === "blocking"
                ? "Blocking"
                : STATE_LABEL[state]}
          </span>
        )}
        <span className="threads-card-actions">
          <SnoozeButton
            client={client}
            onDone={onChanged}
            onError={onError}
            thread={thread}
          />
          {onOpenSession && (
            <button
              className="threads-quiet"
              onClick={onOpenSession}
              type="button"
            >
              Open session
            </button>
          )}
          {open && (
            <button
              className="threads-quiet"
              onClick={() =>
                void client.request
                  .threadClose({ id: thread.id })
                  .then((response) => {
                    if (!response.ok) onError(response.error.message);
                    onChanged();
                  })
              }
              title={
                isFork
                  ? "Done with this thread; its fork ends. You can reopen it."
                  : `Done without answering; ${owner} is told. You can reopen it.`
              }
              type="button"
            >
              Resolve
            </button>
          )}
          <ReopenButton
            client={client}
            onDone={onChanged}
            onError={onError}
            thread={thread}
          />
          {onCollapse && (
            <button
              className="threads-quiet"
              onClick={onCollapse}
              type="button"
            >
              Fold
            </button>
          )}
        </span>
      </header>
      <AnchorQuote
        label={isFork ? "Your thread is on" : "Asked on"}
        onShow={onShow}
        thread={thread}
      />
      {isFork ? (
        <div className="threads-term">
          <div className="threads-line hint">
            ⎿ a read-only fork of {owner}; {owner} sees nothing until you send
          </div>
          {open && (
            <button
              className="threads-foot-link threads-fork-open"
              onClick={onFork}
              type="button"
            >
              Open the fork ↗
            </button>
          )}
          {!open && (
            <div className="threads-line hint">
              ⎿ {thread.closedReason ?? thread.state}
            </div>
          )}
        </div>
      ) : (
        <div className="threads-term">
          <div className="threads-line">● {thread.title}</div>
          {thread.why && <div className="threads-line dim"> {thread.why}</div>}
          {thread.context && (
            <details className="threads-details">
              <summary>Details</summary>
              <div className="threads-line dim">{thread.context}</div>
            </details>
          )}
          {open && thread.forkSessionId && (
            <button
              className="threads-line hint threads-fork-line"
              onClick={onFork}
              type="button"
            >
              ⎿ talking it through in a fork · <span>open the fork ↗</span>
            </button>
          )}
          {open && thread.bumpedAt && (
            <div className="threads-line hint">
              ⎿ blocked on this since {ago(thread.bumpedAt, now)} ago
            </div>
          )}
          {open && options > 0 && (
            <div className="threads-picker" role="listbox">
              {thread.options.map((option, index) => (
                <div
                  aria-selected={index === selected}
                  className={`threads-option${index === selected ? " on" : ""}`}
                  key={option}
                  onClick={() => void send(index, draft.trim() || null)}
                  onMouseEnter={() => setSelected(index)}
                  role="option"
                >
                  <span className="threads-caret">
                    {index === selected ? "❯" : ""}
                  </span>
                  <span className="threads-option-text">
                    {index + 1}. {option}
                    {index === thread.recommended && (
                      <span className="dim"> (recommended)</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
          {!open && (
            <>
              {answer && <div className="threads-line you">&gt; {answer}</div>}
              <div className="threads-line hint">
                ⎿{" "}
                {thread.state === "answered" && !thread.closedReason
                  ? "sent to main"
                  : (thread.closedReason ?? thread.state)}
              </div>
            </>
          )}
          {open && (
            <>
              <div className="threads-prompt">
                <span className="you">&gt;</span>
                <textarea
                  aria-label={`Answer thread ${thread.id}`}
                  autoCapitalize="off"
                  autoComplete="off"
                  autoCorrect="off"
                  disabled={sending}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    // Grows with each line, as the terminal's prompt does.
                    event.target.style.height = "auto";
                    event.target.style.height = `${event.target.scrollHeight}px`;
                  }}
                  ref={input}
                  rows={1}
                  spellCheck={false}
                  value={draft}
                />
              </div>
              <div className="threads-foot">
                {options
                  ? `↑↓ or 1-${options} pick · enter sends · ⇧enter new line · `
                  : "enter sends · ⇧enter new line · "}
                <button
                  className="threads-foot-link"
                  onClick={onFork}
                  type="button"
                >
                  {thread.forkSessionId
                    ? "ctrl+f open the fork"
                    : "ctrl+f fork"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * The feed: open questions as cards, blocking first; forks, snoozed and
 * resolved as rows that open in place. Resolved rows sit in a section that
 * starts collapsed, so they do not crowd what is still open.
 */
function ThreadFeed({
  client,
  threads,
  showSession,
  ownerTag,
  onShow,
  onFork,
  onOpenFork,
  onOpenSession,
  onChanged,
  onError,
}: {
  client: DesktopClient;
  threads: AskDto[];
  showSession: boolean;
  ownerTag?: (thread: AskDto) => string | null;
  onShow: (thread: AskDto, focus: string | null) => void;
  onFork: (thread: AskDto) => void;
  onOpenFork?: (thread: AskDto) => void;
  onOpenSession?: (thread: AskDto) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [showResolved, setShowResolved] = useState(false);
  const toggle = (id: number) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const now = Date.now();
  const card = (thread: AskDto, collapsible: boolean) => (
    <ThreadCard
      client={client}
      key={thread.id}
      onChanged={onChanged}
      onError={onError}
      onFork={() =>
        thread.kind === "fork" && onOpenFork
          ? onOpenFork(thread)
          : onFork(thread)
      }
      onShow={(focus) => onShow(thread, focus)}
      ownerTag={ownerTag?.(thread) ?? null}
      showSession={showSession}
      thread={thread}
      {...(onOpenSession ? { onOpenSession: () => onOpenSession(thread) } : {})}
      {...(collapsible ? { onCollapse: () => toggle(thread.id) } : {})}
    />
  );
  const live = threads.filter((thread) => {
    const state = threadState(thread, now);
    return state === "blocking" || state === "waiting" || state === "fork";
  });
  const folded = (state: ThreadState) =>
    threads.filter((thread) => threadState(thread, now) === state);
  const snoozed = folded("snoozed");
  const ended = folded("ended");
  return (
    <div className="threads-feed">
      {live.length === 0 && (
        <p className="threads-empty">Nothing waits on you.</p>
      )}
      {live.map((thread) => card(thread, false))}
      {[
        ["snoozed", snoozed],
        ["ended", ended],
      ].map(([state, items]) =>
        (items as AskDto[]).length ? (
          <section className="threads-folded" key={state as string}>
            {state === "ended" ? (
              <h3 className="threads-group">
                <button
                  aria-expanded={showResolved}
                  className="threads-group-toggle"
                  onClick={() => setShowResolved((open) => !open)}
                  type="button"
                >
                  <span aria-hidden="true">{showResolved ? "▾" : "▸"}</span>{" "}
                  {STATE_LABEL.ended} · {(items as AskDto[]).length}
                </button>
              </h3>
            ) : (
              <h3 className="threads-group">
                {STATE_LABEL[state as ThreadState]} ·{" "}
                {(items as AskDto[]).length}
              </h3>
            )}
            {(state !== "ended" || showResolved ? (items as AskDto[]) : []).map(
              (thread) =>
                expanded.has(thread.id) ? (
                  card(thread, true)
                ) : (
                  <ThreadRow
                    action={
                      state === "ended" ? (
                        <ReopenButton
                          client={client}
                          onDone={onChanged}
                          onError={onError}
                          thread={thread}
                        />
                      ) : state === "snoozed" ? (
                        <SnoozeButton
                          client={client}
                          onDone={onChanged}
                          onError={onError}
                          thread={thread}
                        />
                      ) : undefined
                    }
                    key={thread.id}
                    onOpen={() =>
                      thread.kind === "fork" && onOpenFork
                        ? onOpenFork(thread)
                        : toggle(thread.id)
                    }
                    showSession={showSession}
                    thread={thread}
                  />
                ),
            )}
          </section>
        ) : null,
      )}
    </div>
  );
}

/** Every session's threads, at Home. */
export function ThreadsHome({
  client,
  onOpenThread,
  onError,
}: {
  client: DesktopClient;
  /** Opens the thread's session, with the thread (or main at `focus`) beside it. */
  onOpenThread: (thread: AskDto, focus?: string | null) => void;
  onError: (message: string) => void;
}) {
  const { threads, reload } = useThreads(client, null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const questions = threads.filter((thread) => thread.kind === "question");
  const waitsOnYou = (thread: AskDto) => {
    const state = threadState(thread);
    return state === "blocking" || state === "waiting";
  };
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
        <p>What the agents asked you and kept working on. Answer here.</p>
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
        onFork={(thread) => onOpenThread(thread)}
        onOpenSession={(thread) => onOpenThread(thread)}
        onShow={(thread, focus) => onOpenThread(thread, focus)}
        key={filter ?? "all"}
        showSession
        threads={shown}
      />
    </div>
  );
}

/** One session's threads, in the side panel beside it. */
export function ThreadsPane({
  client,
  session,
  onError,
  renderTerminal,
  openRequest,
  members = [],
  onOpenInTab,
  onOpenThreadInTab,
  startThreadId,
}: {
  client: DesktopClient;
  session: AgentSessionDto | undefined;
  /** A lead's team members: their threads show here too. */
  members?: readonly { id: string; name: string }[];
  /** Moves these threads to a tab of their own, for more room. */
  onOpenInTab?: () => void;
  /** Moves one thread (its fork) to a tab of its own. */
  onOpenThreadInTab?: (threadId: number) => void;
  /** In a thread's own tab: the thread it shows. */
  startThreadId?: number;
  onError: (message: string) => void;
  /** The app's terminal for a session: a fork thread's fork runs in it. */
  renderTerminal?: (sessionId: string) => ReactNode;
  /** A thread to bring forward, or main at a message, as Home asks. */
  openRequest?: {
    threadId: number;
    focus?: string | null;
    nonce: number;
  } | null;
}) {
  const ids = session
    ? [session.id, ...members.map((one) => one.id)]
    : undefined;
  const { threads, reload } = useThreads(client, ids);
  const nameOf = (sessionId: string) =>
    sessionId === session?.id
      ? (session.name ?? "this session")
      : (members.find((one) => one.id === sessionId)?.name ?? "a member");
  const [view, setView] = useState<View>(
    startThreadId === undefined
      ? { kind: "list" }
      : { kind: "thread", id: startThreadId },
  );
  const [forking, setForking] = useState(false);
  useEffect(
    () =>
      setView(
        startThreadId === undefined
          ? { kind: "list" }
          : { kind: "thread", id: startThreadId },
      ),
    [session?.id, startThreadId],
  );
  useEffect(() => {
    if (!openRequest) return;
    if (openRequest.focus !== undefined && session)
      setView({
        kind: "messages",
        sessionId: session.id,
        name: session.name ?? "this session",
        focus: openRequest.focus,
        back: { kind: "list" },
      });
    else setView({ kind: "list" });
    // Once the feed shows it: scroll to the card and put the keys there.
    const timer = window.setTimeout(() => {
      const card = document.getElementById(
        `thread-card-${openRequest.threadId}`,
      );
      card?.scrollIntoView({ block: "start" });
      card?.querySelector("textarea")?.focus();
    }, 150);
    return () => window.clearTimeout(timer);
  }, [openRequest]);
  const openFork = async (
    sessionId: string,
    anchorId: string | null,
    threadId?: number,
  ) => {
    if (forking) return;
    setForking(true);
    setView({ kind: "thread", id: -1 });
    try {
      const response = await client.request.threadOpenFork({
        sessionId,
        anchorId,
        ...(threadId === undefined ? {} : { threadId }),
      });
      if (!response.ok) {
        onError(response.error.message);
        setView({ kind: "list" });
      } else {
        reload();
        setView({ kind: "thread", id: response.data.id });
      }
    } finally {
      setForking(false);
    }
  };

  if (!session || session.kind !== "agent")
    return (
      <div className="threads-pane">
        <p className="threads-empty">
          Open an agent session to see its threads.
        </p>
      </div>
    );
  const showMain = (sessionId: string, focus: string | null) =>
    setView({
      kind: "messages",
      sessionId,
      name: nameOf(sessionId),
      focus,
      back: view,
    });
  if (view.kind === "messages")
    return (
      <MainMessages
        client={client}
        focus={view.focus}
        onBack={() => setView(view.back)}
        name={view.name}
        onFork={(id) => void openFork(view.sessionId, id)}
        sessionId={view.sessionId}
      />
    );
  const fork = view.kind === "thread" && threads.find((t) => t.id === view.id);
  if (fork)
    return (
      <ForkView
        client={client}
        onBack={() => setView({ kind: "list" })}
        onOpenInTab={
          onOpenThreadInTab
            ? () => {
                onOpenThreadInTab(fork.id);
                setView({ kind: "list" });
              }
            : undefined
        }
        onError={onError}
        onShow={(focus) => showMain(fork.sessionId, focus)}
        renderTerminal={renderTerminal}
        thread={fork}
      />
    );
  if (view.kind === "thread")
    return (
      <div className="threads-pane">
        <p className="threads-empty">Opening the fork…</p>
      </div>
    );
  return (
    <div className="threads-pane">
      <div className="threads-head">
        <h2>
          Threads
          {members.length > 0 && (
            <span className="threads-head-sub">
              {session.name ?? "lead"} and {members.length} member
              {members.length === 1 ? "" : "s"}
            </span>
          )}
        </h2>
        <button
          className="threads-link"
          onClick={() => showMain(session.id, null)}
          title={`Pick one of ${session.name ?? "this session"}'s messages and start a thread on it`}
          type="button"
        >
          + New thread
        </button>
        {onOpenInTab && (
          <button
            aria-label="Open threads in a tab"
            className="threads-quiet"
            onClick={onOpenInTab}
            title="Open these threads in a tab, for more room"
            type="button"
          >
            Open in tab
          </button>
        )}
      </div>
      <div className="threads-scroll">
        <ThreadFeed
          client={client}
          onChanged={reload}
          onError={onError}
          onFork={(thread) =>
            thread.forkSessionId
              ? setView({ kind: "thread", id: thread.id })
              : void openFork(thread.sessionId, thread.anchorId, thread.id)
          }
          onOpenFork={(thread) => setView({ kind: "thread", id: thread.id })}
          onShow={(thread, focus) => showMain(thread.sessionId, focus)}
          ownerTag={
            members.length
              ? (thread) =>
                  thread.sessionId === session.id ? "lead" : "member"
              : undefined
          }
          showSession={false}
          threads={threads}
        />
      </div>
    </div>
  );
}

/** Every match of `query` in the text under `root`, case-insensitive. */
function findRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.toLowerCase();
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(".threads-open-fork")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? "").toLowerCase();
    for (
      let at = text.indexOf(needle);
      at >= 0;
      at = text.indexOf(needle, at + needle.length)
    ) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
}

/** The CSS Custom Highlight registry, where the webview has one. */
type HighlightRegistry = {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
};
const highlights = (): HighlightRegistry | undefined =>
  (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
const highlightOf = (ranges: Range[]): unknown => {
  const Constructor = (
    window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }
  ).Highlight;
  return Constructor ? new Constructor(...ranges) : undefined;
};

function MainMessages({
  client,
  sessionId,
  name,
  focus,
  onBack,
  onFork,
}: {
  client: DesktopClient;
  sessionId: string;
  name: string;
  focus: string | null;
  onBack: () => void;
  onFork: (messageId: string) => void;
}) {
  const [messages, setMessages] = useState<MainMessageDto[] | null>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Range[]>([]);
  const [current, setCurrent] = useState(0);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const focused = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    void client.request.sessionMessages({ sessionId }).then(
      (response) => {
        if (live) setMessages(response.ok ? response.data : []);
      },
      () => live && setMessages([]),
    );
    return () => {
      live = false;
    };
  }, [client, sessionId]);
  useEffect(() => {
    if (!messages) return;
    if (focused.current) focused.current.scrollIntoView({ block: "center" });
    else list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages]);

  // Search: every match is marked; the current one is marked twice and
  // scrolled to, and its message shows Open thread.
  useEffect(() => {
    const root = list.current;
    const trimmed = query.trim();
    const found = root && trimmed && messages ? findRanges(root, trimmed) : [];
    setMatches(found);
    setCurrent(found.length ? found.length - 1 : 0);
    const registry = highlights();
    if (!registry) return;
    registry.delete("threads-search");
    if (found.length) registry.set("threads-search", highlightOf(found));
  }, [query, messages]);
  useEffect(() => {
    const registry = highlights();
    registry?.delete("threads-search-current");
    const range = matches[current];
    if (!range) {
      setCurrentId(null);
      return;
    }
    if (registry) registry.set("threads-search-current", highlightOf([range]));
    const message =
      range.startContainer.parentElement?.closest<HTMLElement>(
        ".threads-message",
      );
    setCurrentId(message?.dataset.id ?? null);
    range.startContainer.parentElement?.scrollIntoView({ block: "center" });
  }, [matches, current]);
  useEffect(
    () => () => {
      highlights()?.delete("threads-search");
      highlights()?.delete("threads-search-current");
    },
    [],
  );
  const step = (by: number) =>
    matches.length &&
    setCurrent((at) => (at + by + matches.length) % matches.length);

  return (
    <div
      className="threads-pane"
      onKeyDown={(event) => {
        if (event.key === "f" && event.metaKey) {
          event.preventDefault();
          search.current?.focus();
          search.current?.select();
        }
      }}
    >
      <div className="threads-head">
        <button className="threads-back" onClick={onBack} type="button">
          ← Threads
        </button>
        <h2>{name}&apos;s conversation</h2>
      </div>
      <div className="threads-search">
        <input
          aria-label="Search this conversation"
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              step(event.shiftKey ? 1 : -1);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (query) setQuery("");
              else onBack();
            }
          }}
          placeholder="Search this conversation (paste from the session)"
          ref={search}
          spellCheck={false}
          type="search"
          value={query}
        />
        {query.trim() && (
          <span className="threads-search-count">
            {matches.length
              ? `${matches.length - current} of ${matches.length}`
              : "no match"}
          </span>
        )}
        <button
          aria-label="Earlier match"
          className="threads-quiet"
          disabled={!matches.length}
          onClick={() => step(-1)}
          title="Earlier match (enter)"
          type="button"
        >
          ↑
        </button>
        <button
          aria-label="Later match"
          className="threads-quiet"
          disabled={!matches.length}
          onClick={() => step(1)}
          title="Later match (shift+enter)"
          type="button"
        >
          ↓
        </button>
      </div>
      <div
        className="threads-term threads-conversation"
        onKeyDown={(event) => event.key === "Escape" && onBack()}
        ref={list}
        tabIndex={-1}
      >
        {messages === null ? (
          <div className="threads-line dim">Reading the transcript…</div>
        ) : messages.length === 0 ? (
          <div className="threads-line dim">
            No messages in this session's transcript yet.
          </div>
        ) : (
          messages.map((message) => (
            <div
              className={`threads-message ${message.role}${message.id === focus ? " focus" : ""}${message.id === currentId ? " current" : ""}`}
              data-id={message.id}
              key={message.id}
              ref={message.id === focus ? focused : undefined}
            >
              {message.role === "agent" ? (
                <MarkdownPreview source={message.text} />
              ) : (
                <div className="threads-user-text">{message.text}</div>
              )}
              {message.role === "agent" && (
                <button
                  className="threads-open-fork"
                  onClick={() => onFork(message.id)}
                  type="button"
                >
                  Open thread
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ForkView({
  client,
  thread,
  onBack,
  onShow,
  onError,
  renderTerminal,
  onOpenInTab,
}: {
  client: DesktopClient;
  thread: AskDto;
  onBack: () => void;
  onShow: (focus: string | null) => void;
  /** Moves this thread to a tab of its own. */
  onOpenInTab?: (() => void) | undefined;
  onError: (message: string) => void;
  renderTerminal: ((sessionId: string) => ReactNode) | undefined;
}) {
  const [sent, setSent] = useState<{ text: string; at: string } | null>(null);
  /** The message to main being written; null while the box is closed. */
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = thread.state === "open";
  /** A question's fork answers the question; a fork thread talks to main. */
  const question = thread.kind === "question";
  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await operation();
    } finally {
      setBusy(false);
    }
  };
  const startDraft = () =>
    run(async () => {
      const response = await client.request.threadForkDraft({ id: thread.id });
      if (!response.ok) onError(response.error.message);
      else setDraft(response.data.text);
    });
  const sendToMain = (text: string) =>
    run(async () => {
      const response = await client.request.threadSendToMain({
        id: thread.id,
        text,
      });
      if (!response.ok) onError(response.error.message);
      else {
        setSent({
          text: response.data.text,
          at: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        });
        setDraft(null);
      }
    });
  return (
    <div className="threads-pane">
      <div className="threads-head">
        <button className="threads-back" onClick={onBack} type="button">
          ← Threads
        </button>
        <h2>
          #{thread.id}{" "}
          <span className={`threads-state ${threadState(thread)}`}>
            {!open
              ? thread.state === "answered"
                ? "Answered"
                : "Resolved"
              : question
                ? "Fork of a question"
                : "Your thread"}
          </span>
        </h2>
        {onOpenInTab && (
          <button
            className="threads-link"
            onClick={onOpenInTab}
            title="Open this thread in a tab of its own, beside the session"
            type="button"
          >
            Open in tab
          </button>
        )}
      </div>
      <div className="threads-fork-top">
        <AnchorQuote
          label={question ? "Asked on" : "Your thread is on"}
          onShow={onShow}
          thread={thread}
        />
        {question && (
          <div className="threads-fork-question">● {thread.title}</div>
        )}
      </div>
      {draft !== null && (
        <div className="threads-draft">
          <label className="threads-draft-label" htmlFor="threads-draft">
            {question ? "Your answer" : "Message to the main agent"}
          </label>
          <textarea
            autoFocus
            id="threads-draft"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setDraft(null);
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                void sendToMain(draft);
            }}
            placeholder="The fork has not replied yet. Write what main should know."
            rows={5}
            spellCheck={false}
            value={draft}
          />
          <p className="threads-draft-note">
            {question
              ? "This answers the question. The agent gets it with a pointer to the fork's whole conversation, and the fork closes."
              : "The main agent gets this at its next turn, with the message this thread is on and a pointer to the fork's whole conversation."}
          </p>
          <div className="threads-draft-actions">
            <button
              className="threads-back"
              onClick={() => setDraft(null)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="threads-action"
              disabled={busy || !draft.trim()}
              onClick={() => void sendToMain(draft)}
              type="button"
            >
              {question ? "Answer" : "Send to main agent"}
            </button>
          </div>
        </div>
      )}
      {open && draft === null && (
        <button
          className="threads-send-bar"
          disabled={busy}
          onClick={() => void startDraft()}
          type="button"
        >
          {question ? "Answer with what you worked out…" : "Send to main…"}
          <span>
            starts from the fork&apos;s &quot;For main&quot; lines, or its last
            reply; you edit it first
          </span>
        </button>
      )}
      {sent && draft === null && (
        <div className="threads-sent">
          <span>
            {question ? "Answered" : "Sent to main"} at {sent.at}:
          </span>{" "}
          {firstLine(sent.text)}
        </div>
      )}
      <div className="threads-fork-note">
        A read-only fork of the session. Main keeps working and sees nothing
        until you send to main.
      </div>
      <div className="threads-fork-terminal">
        {open && thread.forkSessionId && renderTerminal ? (
          renderTerminal(thread.forkSessionId)
        ) : (
          <p className="threads-empty">
            {open ? "Starting the fork…" : "This thread is closed."}
          </p>
        )}
      </div>
    </div>
  );
}
