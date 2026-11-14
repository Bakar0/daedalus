import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  AgentSessionDto,
  RpcResult,
  ThreadSuggestionDto,
} from "@daedalus/protocol";
import type { DesktopClient } from "../client-types";
import { relativeTime } from "../routines/time";
import {
  THREAD_GROUPS,
  type ThreadGroup,
  type ThreadRow,
} from "./thread-groups";

/** How often an open pane asks for new suggestions; they move without the snapshot. */
const SUGGESTIONS_MS = 4_000;

/**
 * The header button that shows or hides the Threads pane, with a dot while
 * a thread waits on the user.
 */
export function ThreadsToggle({
  open,
  waiting,
  onToggle,
}: {
  open: boolean;
  waiting: number;
  onToggle: () => void;
}) {
  return (
    <button
      aria-label={
        waiting
          ? `Threads, ${waiting} waiting on you`
          : open
            ? "Hide threads"
            : "Show threads"
      }
      aria-pressed={open}
      className="threads-toggle"
      onClick={onToggle}
      type="button"
    >
      Threads
      {waiting > 0 && <span aria-hidden="true" className="threads-dot" />}
    </button>
  );
}

/** The bar above the main agent's terminal at Home. */
export function HomeBar({ children }: { children: ReactNode }) {
  return (
    <section aria-label="Main agent" className="notice-bar home-bar">
      <div className="notice-bar-row">
        <span className="notice-bar-text">
          <strong>Main agent</strong> · Home · coordinates threads across your
          workspaces
        </span>
        <span className="notice-bar-actions">{children}</span>
      </div>
    </section>
  );
}

function StateDot({ row }: { row: ThreadRow }) {
  return (
    <span
      aria-hidden="true"
      className={`threads-state threads-state-${row.failed ? "failed" : row.group}`}
    />
  );
}

/**
 * Beside a lead's terminal: its threads grouped by what they need, the
 * threads it suggests, and one thread opened in place.
 */
export function ThreadsPane({
  client,
  lead,
  rows,
  now,
  run,
  workspaceName,
  openThreadId,
  onOpenThread,
  onOpenSession,
  renderTerminal,
}: {
  client: DesktopClient;
  lead: AgentSessionDto;
  rows: readonly ThreadRow[];
  now: number;
  run: <T>(operation: Promise<RpcResult<T>>) => Promise<T | undefined>;
  /** A workspace's name by id, for a suggestion's row. */
  workspaceName: (id: string | null) => string;
  openThreadId: string | undefined;
  onOpenThread: (sessionId: string | undefined) => void;
  /** Opens the thread's own session in the center. */
  onOpenSession: (session: AgentSessionDto) => void;
  renderTerminal: (session: AgentSessionDto) => ReactNode;
}) {
  const [folded, setFolded] = useState<ReadonlySet<ThreadGroup>>(
    () => new Set<ThreadGroup>(["resolved"]),
  );
  const [suggestions, setSuggestions] = useState<ThreadSuggestionDto[]>([]);
  const [starting, setStarting] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const loadSuggestions = useCallback(async () => {
    try {
      const response = await client.request.threadSuggestions({
        leadId: lead.id,
      });
      if (response.ok) setSuggestions(response.data);
    } catch {
      // The next poll tries again.
    }
  }, [client, lead.id]);
  useEffect(() => {
    void loadSuggestions();
    const timer = setInterval(() => void loadSuggestions(), SUGGESTIONS_MS);
    return () => clearInterval(timer);
  }, [loadSuggestions]);

  const start = async (ids: readonly number[]) => {
    setStarting((current) => new Set([...current, ...ids]));
    try {
      // One at a time: each joins the lead's team, which counts its members.
      for (const id of ids)
        await run(client.request.threadSuggestionStart({ id }));
    } finally {
      setStarting((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
      await loadSuggestions();
    }
  };
  const dismiss = async (id: number) => {
    await run(client.request.threadSuggestionDismiss({ id }));
    await loadSuggestions();
  };

  const opened = openThreadId
    ? rows.find((row) => row.session.id === openThreadId)
    : undefined;
  if (opened)
    return (
      <aside aria-label="Threads" className="threads-pane">
        <OpenThread
          client={client}
          onBack={() => onOpenThread(undefined)}
          onOpenSession={onOpenSession}
          renderTerminal={renderTerminal}
          row={opened}
          run={run}
        />
      </aside>
    );

  return (
    <aside aria-label="Threads" className="threads-pane">
      <div className="threads-head">
        <h2>Threads</h2>
        <span className="threads-count">
          {rows.filter((row) => row.group !== "resolved").length} open
        </span>
      </div>
      <div className="threads-list">
        {suggestions.length > 0 && (
          <section aria-label="Suggested threads" className="threads-suggested">
            <h3>Suggested threads</h3>
            {suggestions.map((suggestion) => (
              <div className="threads-suggestion" key={suggestion.id}>
                <span className="threads-suggestion-text">
                  <span className="threads-suggestion-title">
                    {suggestion.title}
                  </span>
                  <span className="threads-where">
                    {workspaceName(suggestion.workspaceId)}
                  </span>
                </span>
                <button
                  className="threads-link"
                  disabled={starting.has(suggestion.id)}
                  onClick={() => void start([suggestion.id])}
                  title={suggestion.message ?? suggestion.title}
                  type="button"
                >
                  {starting.has(suggestion.id) ? "Starting…" : "Start →"}
                </button>
                <button
                  aria-label={`Dismiss ${suggestion.title}`}
                  className="threads-link threads-dismiss"
                  disabled={starting.has(suggestion.id)}
                  onClick={() => void dismiss(suggestion.id)}
                  title="Dismiss"
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
            {suggestions.length > 1 && (
              <button
                className="threads-button"
                disabled={starting.size > 0}
                onClick={() => void start(suggestions.map((item) => item.id))}
                type="button"
              >
                Start all
              </button>
            )}
          </section>
        )}
        {rows.length === 0 && suggestions.length === 0 && (
          <p className="threads-empty">
            No threads yet. Ask {lead.name} for work, and it starts a thread for
            each piece.
          </p>
        )}
        {THREAD_GROUPS.map(({ group, label }) => {
          const members = rows.filter((row) => row.group === group);
          if (!members.length) return null;
          const isFolded = folded.has(group);
          return (
            <section className="threads-group" key={group}>
              <h3>
                <button
                  aria-expanded={!isFolded}
                  className="threads-group-toggle"
                  onClick={() =>
                    setFolded((current) => {
                      const next = new Set(current);
                      if (next.has(group)) next.delete(group);
                      else next.add(group);
                      return next;
                    })
                  }
                  type="button"
                >
                  <span aria-hidden="true">{isFolded ? "▸" : "▾"}</span>
                  {label}
                  <span className="threads-group-count">{members.length}</span>
                </button>
              </h3>
              {!isFolded &&
                members.map((row) => (
                  <button
                    className="threads-row"
                    key={row.session.id}
                    onClick={() => onOpenThread(row.session.id)}
                    type="button"
                  >
                    <StateDot row={row} />
                    <span className="threads-row-title">{row.title}</span>
                    <span className="threads-where">
                      {row.workspaceName} · {relativeTime(row.at, now)}
                    </span>
                    <span className="threads-row-detail">{row.detail}</span>
                  </button>
                ))}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

/** One thread in the pane: what it asks, its terminal, a message box, Stop. */
function OpenThread({
  client,
  row,
  run,
  onBack,
  onOpenSession,
  renderTerminal,
}: {
  client: DesktopClient;
  row: ThreadRow;
  run: <T>(operation: Promise<RpcResult<T>>) => Promise<T | undefined>;
  onBack: () => void;
  onOpenSession: (session: AgentSessionDto) => void;
  renderTerminal: (session: AgentSessionDto) => ReactNode;
}) {
  const { session } = row;
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const live = session.status === "running" || session.status === "starting";
  const send = async () => {
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const sent = await run(
        client.request.agentSend({ id: session.id, text }),
      );
      if (sent) setMessage("");
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="threads-open">
      <div className="threads-open-head">
        <button className="threads-link" onClick={onBack} type="button">
          ← Threads
        </button>
        <span className="threads-open-title" title={row.title}>
          {row.title}
        </span>
        <span className="threads-where">{row.workspaceName}</span>
      </div>
      <div className="threads-open-actions">
        <button
          className="threads-link"
          onClick={() => onOpenSession(session)}
          type="button"
        >
          Open in full
        </button>
        <button
          className="threads-link"
          onClick={() =>
            void run(
              client.request.threadResolve({
                sessionId: session.id,
                resolved: !session.resolvedAt,
              }),
            )
          }
          type="button"
        >
          {session.resolvedAt ? "Reopen" : "Mark done"}
        </button>
        {live && (
          <button
            className="threads-button threads-stop"
            onClick={() =>
              void run(
                client.request.agentStop({ id: session.id, force: false }),
              )
            }
            type="button"
          >
            Stop
          </button>
        )}
      </div>
      {row.group === "waiting" && (
        <div className="threads-asks" role="status">
          <strong>{row.failed ? "It failed" : "It waits on you"}</strong>
          <span>{row.detail}</span>
          {!row.failed && (
            <span className="threads-asks-hint">
              Answer or approve it in its terminal below.
            </span>
          )}
        </div>
      )}
      <div className="threads-terminal">{renderTerminal(session)}</div>
      <form
        className="threads-message"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <input
          aria-label={`Message ${row.title}`}
          disabled={!live}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={
            live ? "Message this thread directly" : "This thread is not running"
          }
          value={message}
        />
        <button
          className="threads-button"
          disabled={!live || sending || !message.trim()}
          type="submit"
        >
          Send
        </button>
      </form>
    </div>
  );
}
