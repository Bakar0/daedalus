/**
 * Threads. A thread is a conversation between a session's agent and the
 * user, hanging off a message in the agent's main by its transcript id. The
 * agent opens one and moves on; the user replies at a prompt that works like
 * the terminal's, and the reply goes to the agent as a message. The user may
 * also open one on a message, talked through with a read-only fork of the
 * session, shown as a terminal, while the session works on. "show" opens
 * main's messages, read from the transcript, at that message.
 *
 * `ThreadsPane` is one session's threads, in the side panel beside it.
 * `ThreadsHome` is every session's, at Home; opening one there opens its
 * session with the thread in the pane.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type React from "react";
import type { ReactNode } from "react";
import type {
  AgentSessionDto,
  MainMessageDto,
  ThreadDto,
  ThreadMessageDto,
} from "@daedalus/protocol";
import { isSnoozed, snoozeChoices, waitsOnUser } from "./threads-shared";
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

const firstLine = (text: string) => text.split("\n")[0] ?? "";

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

/**
 * The message a thread hangs off, quoted, with one plain way to see it in
 * its conversation. The same in a card and in a fork.
 */
/**
 * What makes a thread's text clickable: a URL opens in the browser, and an
 * `@handle` in a thread opens the session it names in that thread's team.
 * Without a provider the text stays plain.
 */
export interface ThreadLinks {
  openUrl: (url: string) => void;
  /** The session `@handle` names, as seen from the thread owner's team. */
  sessionForHandle: (ownerId: string, handle: string) => string | undefined;
  openSession: (sessionId: string) => void;
}

export const ThreadLinksContext = createContext<ThreadLinks | null>(null);

const LINK_PATTERN =
  /(https?:\/\/[^\s<>"'`]+)|(^|[\s(])@([a-z0-9][a-z0-9-]*)/gi;

/** Text with its URLs and team handles as links. */
export function LinkedText({
  text,
  ownerId,
}: {
  text: string;
  /** The session the text belongs to: its team names the handles. */
  ownerId: string;
}) {
  const links = useContext(ThreadLinksContext);
  if (!links) return <>{text}</>;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const at = match.index ?? 0;
    if (match[1]) {
      // A sentence's closing punctuation is not part of the URL.
      const url = match[1].replace(/[.,;:!?)\]]+$/, "");
      parts.push(text.slice(last, at));
      parts.push(
        <a
          className="threads-text-link"
          href={url}
          key={`${at}-url`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            links.openUrl(url);
          }}
        >
          {url}
        </a>,
      );
      last = at + url.length;
      continue;
    }
    const handle = match[3]!;
    const target = links.sessionForHandle(ownerId, handle.toLowerCase());
    if (!target) continue;
    const start = at + match[2]!.length;
    parts.push(text.slice(last, start));
    parts.push(
      <button
        className="threads-text-link"
        key={`${at}-handle`}
        onClick={(event) => {
          event.stopPropagation();
          links.openSession(target);
        }}
        title={`Open @${handle}'s session`}
        type="button"
      >
        @{handle}
      </button>,
    );
    last = start + handle.length + 1;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

function AnchorQuote({
  thread,
  label,
  onShow,
}: {
  thread: ThreadDto;
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
      <span className="threads-anchor-text">
        <LinkedText ownerId={thread.sessionId} text={thread.anchorText} />
      </span>
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
  showSession,
  onOpen,
  action,
}: {
  thread: ThreadDto;
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

/** One message or notice of a thread, as the card prints it. */
function ThreadMessageLine({
  thread,
  message,
  now,
}: {
  thread: ThreadDto;
  message: ThreadMessageDto;
  now: number;
}) {
  const owner = thread.sessionName ?? "the agent";
  if (message.kind === "notice") {
    const at = message.body.indexOf(":");
    const event = (at < 0 ? message.body : message.body.slice(0, at)).trim();
    const reason = at < 0 ? "" : message.body.slice(at + 1).trim();
    const who =
      message.author === "user"
        ? "you"
        : message.author === "agent"
          ? owner
          : message.author === "lead"
            ? "the lead"
            : "Daedalus";
    const what =
      event === "blocked"
        ? `${owner} is blocked on this`
        : event === "reopened"
          ? `reopened by ${who}`
          : event === "resolved"
            ? `resolved by ${who}`
            : event;
    return (
      <div className="threads-line hint">
        ⎿ {what}
        {reason ? `: ${reason}` : ""} · {ago(message.createdAt, now)}
      </div>
    );
  }
  const mine = message.author === "user";
  return (
    <>
      <div className={`threads-line${mine ? " you" : ""}`}>
        {mine ? ">" : "●"}
        {message.author === "lead" ? " lead:" : ""}{" "}
        <LinkedText ownerId={thread.sessionId} text={message.body} />
      </div>
      {message.details && (
        <details className="threads-details">
          <summary>Details</summary>
          <div className="threads-line dim">
            <LinkedText ownerId={thread.sessionId} text={message.details} />
          </div>
        </details>
      )}
    </>
  );
}

/**
 * The options the user can pick from now: the latest message from the
 * other side that offers some, with nothing from the user after it.
 */
const openOffer = (thread: ThreadDto): ThreadMessageDto | undefined => {
  const said = thread.messages.filter((message) => message.kind === "message");
  const last = said.at(-1);
  return last && last.author !== "user" && last.options.length
    ? last
    : undefined;
};

/**
 * A thread, open in place: the message it hangs off, its conversation, the
 * picker for the latest options and a prompt. Keys typed anywhere in the
 * card drive its picker. Writing in a resolved thread reopens it.
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
  thread: ThreadDto;
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
  const open = !thread.resolvedAt;
  const forkOnly = isForkOnly(thread);
  const offer = openOffer(thread);
  const options = offer?.options.length ?? 0;
  const [selected, setSelected] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  // Fits its text, as the terminal's prompt does: it grows with each line
  // and shrinks back when the text goes, sent or deleted.
  useLayoutEffect(() => {
    const box = input.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  }, [draft]);

  const markRead = () => {
    if (thread.unread)
      void client.request.threadRead({ id: thread.id }).then(
        () => onChanged(),
        () => undefined,
      );
  };

  const closeFork = async () => {
    if (closing) return;
    setClosing(true);
    try {
      const response = await client.request.threadCloseFork({ id: thread.id });
      if (!response.ok) onError(response.error.message);
      onChanged();
    } finally {
      setClosing(false);
    }
  };

  const send = async (option: number | null, body: string | null) => {
    if (sending || forkOnly) return;
    setSending(true);
    try {
      const response = await client.request.threadSay({
        id: thread.id,
        body,
        option,
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
      !typing &&
      /^[1-9]$/.test(event.key) &&
      Number(event.key) <= options
    ) {
      // Picks it; only Enter sends, so a stray key or click sends nothing.
      event.preventDefault();
      setSelected(Number(event.key) - 1);
    } else if (
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
  return (
    <article
      className={`threads-card ${state}${thread.unread ? " unread" : ""}`}
      id={`thread-card-${thread.id}`}
      onFocus={markRead}
      onKeyDown={onKeyDown}
      onMouseDown={markRead}
      onClick={(event) => {
        // A click on the card, not on a control, sends the keys to the
        // reply box. A drag that selected text keeps its selection.
        if (
          (event.target as HTMLElement).closest(
            "button, a, summary, input, textarea",
          ) ||
          !(window.getSelection()?.isCollapsed ?? true)
        )
          return;
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
                  .threadResolve({ id: thread.id })
                  .then((response) => {
                    if (!response.ok) onError(response.error.message);
                    onChanged();
                  })
              }
              title={
                forkOnly
                  ? "Done with this thread; its fork ends. You can reopen it."
                  : `Done with this thread; ${owner} is told. You can reopen it.`
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
        label={forkOnly ? "Your thread is on" : "On"}
        onShow={onShow}
        thread={thread}
      />
      <div className="threads-term">
        {thread.messages.map((message) => (
          <ThreadMessageLine
            key={message.id}
            message={message}
            now={now}
            thread={thread}
          />
        ))}
        {forkOnly && (
          <div className="threads-line hint">
            ⎿ a read-only fork of {owner}; {owner} sees nothing until you send
          </div>
        )}
        {thread.forkOpen && (
          <div className="threads-line hint threads-fork-line">
            ⎿ talking it through in a fork ·{" "}
            <button onClick={onFork} type="button">
              open the fork ↗
            </button>
            {!forkOnly && (
              <>
                {" · "}
                <button
                  disabled={closing}
                  onClick={() => void closeFork()}
                  type="button"
                >
                  close the fork
                </button>
              </>
            )}
          </div>
        )}
        {offer && (
          <div className="threads-picker" role="listbox">
            {offer.options.map((option, index) => (
              <div
                aria-selected={index === selected}
                className={`threads-option${index === selected ? " on" : ""}`}
                key={option}
                onClick={() => {
                  setSelected(index);
                  input.current?.focus();
                }}
                role="option"
              >
                <span className="threads-caret">
                  {index === selected ? "❯" : ""}
                </span>
                <span className="threads-option-text">
                  {index + 1}. {option}
                </span>
              </div>
            ))}
          </div>
        )}
        {!forkOnly && (
          <>
            <div className="threads-prompt">
              <span className="you">&gt;</span>
              <textarea
                aria-label={`Reply in thread ${thread.id}`}
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                disabled={sending}
                onChange={(event) => setDraft(event.target.value)}
                ref={input}
                rows={1}
                spellCheck={false}
                value={draft}
              />
            </div>
            <div className="threads-foot">
              {options
                ? `↑↓ or 1-${options} pick · enter sends · ⇧enter new line · `
                : open
                  ? "enter sends · ⇧enter new line · "
                  : "writing here reopens it · "}
              <button
                className="threads-foot-link"
                onClick={onFork}
                type="button"
              >
                {thread.forkOpen ? "ctrl+f open the fork" : "ctrl+f fork"}
              </button>
            </div>
          </>
        )}
        {forkOnly && open && (
          <button
            className="threads-foot-link threads-fork-open"
            onClick={onFork}
            type="button"
          >
            Open the fork ↗
          </button>
        )}
      </div>
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
  threads: ThreadDto[];
  showSession: boolean;
  ownerTag?: (thread: ThreadDto) => string | null;
  onShow: (thread: ThreadDto, focus: string | null) => void;
  onFork: (thread: ThreadDto) => void;
  onOpenFork?: (thread: ThreadDto) => void;
  onOpenSession?: (thread: ThreadDto) => void;
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
  const card = (thread: ThreadDto, collapsible: boolean) => (
    <ThreadCard
      client={client}
      key={thread.id}
      onChanged={onChanged}
      onError={onError}
      onFork={() =>
        isForkOnly(thread) && onOpenFork ? onOpenFork(thread) : onFork(thread)
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
    return (
      state === "blocking" ||
      state === "waiting" ||
      state === "replied" ||
      state === "fork"
    );
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
        (items as ThreadDto[]).length ? (
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
                  {STATE_LABEL.ended} · {(items as ThreadDto[]).length}
                </button>
              </h3>
            ) : (
              <h3 className="threads-group">
                {STATE_LABEL[state as ThreadState]} ·{" "}
                {(items as ThreadDto[]).length}
              </h3>
            )}
            {(state !== "ended" || showResolved
              ? (items as ThreadDto[])
              : []
            ).map((thread) =>
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
                    isForkOnly(thread) && onOpenFork
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
  onForkThread,
  onError,
}: {
  client: DesktopClient;
  /** Opens the thread's session, with the thread (or main at `focus`) beside it. */
  onOpenThread: (thread: ThreadDto, focus?: string | null) => void;
  /** Opens the thread's session, with the thread's fork open beside it. */
  onForkThread: (thread: ThreadDto) => void;
  onError: (message: string) => void;
}) {
  const { threads, reload } = useThreads(client, null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  // A thread the user opened on a fork lives beside its session only.
  const questions = threads.filter((thread) => !isForkOnly(thread));
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
        <p>Your conversations with agents that kept working. Reply here.</p>
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
        onFork={onForkThread}
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
    /** Open the thread's fork, starting one if it has none. */
    fork?: { sessionId: string; anchorId: string | null };
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
    if (openRequest.fork) {
      void openFork(
        openRequest.fork.sessionId,
        openRequest.fork.anchorId,
        openRequest.threadId,
      );
      return;
    }
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
        onClosed={() => {
          reload();
          setView({ kind: "list" });
        }}
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
            thread.forkOpen
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
  onClosed,
}: {
  client: DesktopClient;
  thread: ThreadDto;
  onBack: () => void;
  /** The user closed a thread's fork: back to the thread's card. */
  onClosed: () => void;
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
  const open = !thread.resolvedAt;
  /** A thread's fork replies in the thread; a fork thread talks to main. */
  const question = !isForkOnly(thread);
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
  const closeFork = () =>
    run(async () => {
      const response = await client.request.threadCloseFork({ id: thread.id });
      if (!response.ok) onError(response.error.message);
      else onClosed();
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
            {!open ? "Resolved" : question ? "Fork of a thread" : "Your thread"}
          </span>
        </h2>
        {question && thread.forkOpen && (
          <button
            className="threads-link"
            disabled={busy}
            onClick={() => void closeFork()}
            title="Archive this fork; the thread stays open, and ctrl+f brings the fork back"
            type="button"
          >
            Close the fork
          </button>
        )}
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
          <div className="threads-fork-question">
            ● <LinkedText ownerId={thread.sessionId} text={thread.title} />
          </div>
        )}
      </div>
      {draft !== null && (
        <div className="threads-draft">
          <label className="threads-draft-label" htmlFor="threads-draft">
            {question
              ? "Your reply in the thread"
              : "Message to the main agent"}
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
              ? "This is your reply in the thread. The agent gets it with a pointer to the fork's whole conversation."
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
              {question ? "Reply" : "Send to main agent"}
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
          {question ? "Reply with what you worked out…" : "Send to main…"}
          <span>
            starts from the fork&apos;s &quot;For main&quot; lines, or its last
            reply; you edit it first
          </span>
        </button>
      )}
      {sent && draft === null && (
        <div className="threads-sent">
          <span>
            {question ? "Replied" : "Sent to main"} at {sent.at}:
          </span>{" "}
          {firstLine(sent.text)}
        </div>
      )}
      <div className="threads-fork-note">
        A read-only fork of the session. Main keeps working and sees nothing
        until you send to main.
      </div>
      <div className="threads-fork-terminal">
        {thread.forkOpen && thread.forkSessionId && renderTerminal ? (
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
