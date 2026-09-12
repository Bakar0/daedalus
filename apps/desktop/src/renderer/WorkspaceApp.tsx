import { FitAddon, init, Terminal } from "ghostty-web";
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AgentSessionDto,
  DesktopSnapshotDto,
  RpcResult,
  TaskDto,
  TaskStatus,
} from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";

const STATUSES: TaskStatus[] = [
  "todo",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
];

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const sessionName = (session: AgentSessionDto) =>
  session.kind === "terminal"
    ? "Terminal"
    : session.provider.slice(0, 1).toUpperCase() + session.provider.slice(1);

const taskExcerpt = (markdown: string) =>
  markdown
    .replace(/```[\s\S]*?```/g, "Code example")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+] |\d+\. )\s*/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function MarkdownPreview({ source }: { source: string }) {
  if (!source.trim())
    return (
      <div className="brief-placeholder">
        <strong>No task brief yet</strong>
        <span>Add goals, context, and acceptance criteria for the agent.</span>
      </div>
    );
  return (
    <div className="markdown-body">
      <Markdown remarkPlugins={[remarkGfm]}>{source}</Markdown>
    </div>
  );
}

function Modal({
  title,
  onClose,
  wide = false,
  children,
}: {
  children: React.ReactNode;
  onClose: () => void;
  title: string;
  wide?: boolean;
}) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-label={title}
        aria-modal="true"
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
      >
        <div className="detail-title">
          <div>
            <span className="eyebrow">Daedalus</span>
            <h2>{title}</h2>
          </div>
          <button className="quiet" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function SessionTerminal({ session }: { session: AgentSessionDto }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState("connecting");
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (session.status !== "running" && session.status !== "starting") {
      setConnection(session.status);
      return;
    }
    let disposed = false;
    let terminal: Terminal | undefined;
    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempts = 0;
    let ended = false;
    let frame: number | undefined;
    const pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const drain = () => {
      frame = undefined;
      const chunks = pending.splice(0);
      pendingBytes = 0;
      for (const chunk of chunks) terminal?.write(chunk);
    };
    const enqueue = (chunk: Uint8Array) => {
      if (chunk.byteLength >= 1024 * 1024) {
        pending.length = 0;
        pending.push(chunk.slice(chunk.byteLength - 1024 * 1024));
        pendingBytes = 1024 * 1024;
      } else {
        pending.push(chunk);
        pendingBytes += chunk.byteLength;
        while (pendingBytes > 1024 * 1024 && pending.length > 1) {
          const dropped = pending.shift();
          if (dropped) pendingBytes -= dropped.byteLength;
        }
      }
      if (frame === undefined) frame = requestAnimationFrame(drain);
    };

    void (async () => {
      await init();
      if (disposed) return;
      terminal = new Terminal({
        cursorBlink: true,
        fontFamily: '"MesloLGS NF", SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        scrollback: 10_000,
        theme: {
          background: "#11151d",
          foreground: "#dce5f2",
          cursor: "#8ed6c3",
          selectionBackground: "#38546b",
        },
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(container);
      fit.observeResize();
      fit.fit();
      const endpoint = new URLSearchParams(window.location.search).get(
        "terminal",
      );
      if (!endpoint) {
        setConnection("available in Electrobun");
        return;
      }
      const connect = () => {
        if (disposed || ended) return;
        const url = new URL(endpoint);
        url.searchParams.set("agent", session.id);
        socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        socket.onopen = () => {
          reconnectAttempts = 0;
          setConnection("connected");
          socket?.send(
            JSON.stringify({
              type: "resize",
              cols: terminal?.cols ?? 80,
              rows: terminal?.rows ?? 24,
            }),
          );
        };
        socket.onclose = () => {
          if (disposed || ended) return;
          setConnection("reconnecting");
          reconnectTimer = setTimeout(
            connect,
            Math.min(4_000, 250 * 2 ** reconnectAttempts++),
          );
        };
        socket.onerror = () => setConnection("connection error");
        socket.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            enqueue(new Uint8Array(event.data));
            return;
          }
          const value = JSON.parse(String(event.data)) as {
            type: string;
            status?: string;
            message?: string;
            droppedBytes?: number;
          };
          if (value.type === "status" && value.status) {
            setConnection(value.status);
            if (value.status === "exited" || value.status === "lost")
              ended = true;
          }
          if (value.type === "overflow" && value.droppedBytes)
            terminal?.writeln(
              `\r\n\u001b[33m[Daedalus skipped ${value.droppedBytes.toLocaleString()} buffered bytes]\u001b[0m`,
            );
          if (value.type === "error" && value.message) {
            ended = true;
            setConnection("unavailable");
            terminal?.writeln(`\r\n\u001b[31m${value.message}\u001b[0m`);
          }
        };
      };
      connect();
      terminal.onData((data) => {
        if (socket?.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ type: "input", data }));
      });
      terminal.onResize(({ cols, rows }) => {
        if (socket?.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ type: "resize", cols, rows }));
      });
    })();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      socket?.close();
      terminal?.dispose();
    };
  }, [session.id, session.status]);

  return (
    <section className="agent-terminal-shell">
      <div className="terminal-status">
        <span className={`agent-dot ${session.status}`} />
        <span>{sessionName(session)}</span>
        <small>
          {connection} · {session.id.slice(0, 8)}
        </small>
      </div>
      <div
        aria-label={`Terminal for ${sessionName(session)} session ${session.id.slice(0, 8)}`}
        className="terminal"
        ref={containerRef}
      />
    </section>
  );
}

export function WorkspaceApp({
  injectedClient,
  initialSnapshot,
  initialSelectedTaskId,
  initialActiveAgentId,
  initialWorkspaceView = "board",
  initialModal,
}: {
  injectedClient?: DesktopClient;
  initialSnapshot?: DesktopSnapshotDto;
  initialSelectedTaskId?: string;
  initialActiveAgentId?: string;
  initialDetailView?: "brief" | "terminal";
  initialWorkspaceView?: "board" | "sessions";
  initialModal?: "workspace" | "task" | "session" | "settings";
} = {}) {
  const clientRef = useRef(injectedClient);
  if (!clientRef.current)
    throw new Error("The desktop RPC client was not provided");
  const client = clientRef.current;
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [workspaceId, setWorkspaceId] = useState(
    initialSnapshot?.workspaces[0]?.id,
  );
  const [selectedTaskId, setSelectedTaskId] = useState(initialSelectedTaskId);
  const [activeSessionId, setActiveSessionId] = useState(initialActiveAgentId);
  const [view, setView] = useState<"board" | "sessions">(initialWorkspaceView);
  const [filter, setFilter] = useState<TaskStatus | "all">("all");
  const [modal, setModal] = useState<
    "workspace" | "task" | "session" | "settings" | undefined
  >(initialModal);
  const [editingTask, setEditingTask] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [workspaceForm, setWorkspaceForm] = useState({
    name: "",
    slug: "",
    path: "",
  });
  const [taskForm, setTaskForm] = useState({ title: "", description: "" });
  const [sessionType, setSessionType] = useState("codex");

  const refresh = useCallback(async () => {
    try {
      const response = await client.request.snapshot({});
      if (!response.ok) throw new Error(response.error.message);
      setSnapshot(response.data);
      setError(undefined);
      setWorkspaceId((current) =>
        response.data.workspaces.some((item) => item.id === current)
          ? current
          : response.data.workspaces[0]?.id,
      );
      setSelectedTaskId((current) =>
        response.data.tasks.some((item) => item.id === current)
          ? current
          : undefined,
      );
      setActiveSessionId((current) =>
        response.data.agents.some((item) => item.id === current)
          ? current
          : undefined,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    return client.subscribe(() => void refresh());
  }, [client, refresh]);
  useEffect(() => {
    const stored = window.localStorage.getItem("daedalus.theme");
    if (stored === "dark" || stored === "light") setTheme(stored);
  }, []);
  useEffect(() => {
    if (!snapshot || sessionType === "terminal") return;
    const selected = snapshot.settings.providers.find(
      (item) => item.name === sessionType,
    );
    if (!selected?.available) {
      const available = snapshot.settings.providers.find(
        (item) => item.available,
      );
      setSessionType(available?.name ?? "terminal");
    }
  }, [sessionType, snapshot]);

  async function perform<T>(operation: Promise<RpcResult<T>>) {
    setBusy(true);
    setError(undefined);
    try {
      const response = await operation;
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      await refresh();
      return response.data;
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const workspace = snapshot?.workspaces.find(
    (item) => item.id === workspaceId,
  );
  const allTasks = (snapshot?.tasks ?? []).filter(
    (item) => item.workspaceId === workspaceId,
  );
  const tasks = allTasks.filter(
    (item) => filter === "all" || item.status === filter,
  );
  const sessions = (snapshot?.agents ?? [])
    .filter((item) => item.workspaceId === workspaceId)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  const selectedTask = snapshot?.tasks.find(
    (item) => item.id === selectedTaskId,
  );
  const activeSession = sessions.find((item) => item.id === activeSessionId);

  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault();
    const created = await perform(
      client.request.workspaceCreate({
        name: workspaceForm.name,
        slug: workspaceForm.slug || undefined,
        path: workspaceForm.path || undefined,
      }),
    );
    if (created) {
      setWorkspaceId(created.id);
      setWorkspaceForm({ name: "", slug: "", path: "" });
      setModal(undefined);
    }
  }

  async function createTask(event: React.FormEvent) {
    event.preventDefault();
    if (!workspace) return;
    const created = await perform(
      client.request.taskCreate({
        workspace: workspace.id,
        title: taskForm.title,
        description: taskForm.description,
      }),
    );
    if (created) {
      setSelectedTaskId(created.id);
      setTaskForm({ title: "", description: "" });
      setModal(undefined);
    }
  }

  async function createSession(event: React.FormEvent) {
    event.preventDefault();
    if (!workspace) return;
    const isTerminal = sessionType === "terminal";
    const created = await perform(
      client.request.agentSpawn({
        workspace: workspace.id,
        terminal: isTerminal || undefined,
        provider: isTerminal ? undefined : (sessionType as "codex" | "claude"),
      }),
    );
    if (created) {
      setActiveSessionId(created.id);
      setView("sessions");
      setModal(undefined);
    }
  }

  async function updateTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTask) return;
    const data = new FormData(event.currentTarget);
    const updated = await perform(
      client.request.taskUpdate({
        id: selectedTask.id,
        title: String(data.get("title") ?? ""),
        description: String(data.get("description") ?? ""),
      }),
    );
    if (updated) setEditingTask(false);
  }

  async function stopSession(session: AgentSessionDto) {
    if (
      !window.confirm(`Stop ${sessionName(session)} ${session.id.slice(0, 8)}?`)
    )
      return;
    await perform(client.request.agentStop({ id: session.id, force: false }));
  }

  async function removeSession(session: AgentSessionDto) {
    if (!window.confirm(`Remove session history ${session.id.slice(0, 8)}?`))
      return;
    await perform(client.request.agentRemove({ id: session.id }));
  }

  function selectWorkspace(id: string) {
    setWorkspaceId(id);
    setSelectedTaskId(undefined);
    setActiveSessionId(undefined);
    setView("board");
  }

  const taskInspector = !selectedTask ? (
    <div className="empty large">
      <strong>Select a task</strong>
      <span>Its brief and linked sessions will appear here.</span>
    </div>
  ) : editingTask ? (
    <form className="task-editor brief-editor" onSubmit={updateTask}>
      <label>
        Title
        <input name="title" defaultValue={selectedTask.title} required />
      </label>
      <label>
        <span className="field-heading">
          Markdown <small>⌘↵ to save</small>
        </span>
        <textarea
          name="description"
          defaultValue={selectedTask.description}
          rows={16}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter")
              event.currentTarget.form?.requestSubmit();
          }}
        />
      </label>
      <div className="editor-actions">
        <button
          className="quiet"
          onClick={() => setEditingTask(false)}
          type="button"
        >
          Cancel
        </button>
        <button disabled={busy} type="submit">
          Save brief
        </button>
      </div>
    </form>
  ) : (
    <div className="task-brief">
      <div className="brief-modal-toolbar">
        <select
          aria-label="Task status"
          value={selectedTask.status}
          onChange={(event) =>
            void perform(
              client.request.taskSetStatus({
                id: selectedTask.id,
                status: event.target.value as TaskStatus,
              }),
            )
          }
        >
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {status.replace("_", " ")}
            </option>
          ))}
        </select>
      </div>
      <h2>{selectedTask.title}</h2>
      <MarkdownPreview source={selectedTask.description} />
      <section className="linked-sessions">
        <span className="eyebrow">Sessions</span>
        {sessions
          .filter((item) => item.taskId === selectedTask.id)
          .map((session) => (
            <button
              className="linked-session"
              key={session.id}
              onClick={() => {
                setActiveSessionId(session.id);
                setView("sessions");
              }}
            >
              <span className={`agent-dot ${session.status}`} />
              <span>
                <strong>{sessionName(session)}</strong>
                <small>
                  {session.status} · {session.id.slice(0, 8)}
                </small>
              </span>
            </button>
          ))}
      </section>
      <button
        className="danger-link brief-delete"
        onClick={() =>
          void (async () => {
            if (
              !window.confirm(
                `Permanently delete task “${selectedTask.title}”?`,
              )
            )
              return;
            await perform(
              client.request.taskRemove({ id: selectedTask.id, force: true }),
            );
            setSelectedTaskId(undefined);
          })()
        }
      >
        Delete task
      </button>
    </div>
  );

  return (
    <main className="app" data-theme={theme}>
      <header className="topbar">
        <div className="brand">
          <span aria-hidden="true" className="brand-mark">
            D
          </span>
          <span className="brand-copy">
            <strong>Daedalus</strong>
            <small>Agent workspace</small>
          </span>
        </div>
        <nav className="app-mode-switcher" aria-label="Workspace mode">
          <button
            aria-current={view === "board" ? "page" : undefined}
            className={view === "board" ? "active" : ""}
            disabled={!workspace}
            onClick={() => setView("board")}
          >
            Board
          </button>
          <button
            aria-current={view === "sessions" ? "page" : undefined}
            className={view === "sessions" ? "active" : ""}
            disabled={!workspace}
            onClick={() => setView("sessions")}
          >
            Sessions
          </button>
        </nav>
        <div className="top-actions">
          {busy && <span className="syncing">Working…</span>}
          <button className="quiet" onClick={() => void refresh()}>
            Refresh
          </button>
          <button className="quiet" onClick={() => setModal("settings")}>
            Settings
          </button>
        </div>
      </header>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(undefined)}>Dismiss</button>
        </div>
      )}

      <div className={`workspace-shell mode-${view}`}>
        <aside className="workspace-column">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Projects</span>
              <h1>Workspaces</h1>
            </div>
            <button
              aria-label="Create workspace"
              className="icon-button"
              onClick={() => setModal("workspace")}
            >
              +
            </button>
          </div>
          <nav aria-label="Workspaces" className="item-list">
            {!snapshot && !error && (
              <div className="empty">Loading workspaces…</div>
            )}
            {snapshot?.workspaces.length === 0 && (
              <div className="empty large">
                <strong>No workspaces yet</strong>
                <span>Use + to create one.</span>
              </div>
            )}
            {snapshot?.workspaces.map((item) => (
              <button
                className={`workspace-item ${item.id === workspaceId ? "selected" : ""}`}
                key={item.id}
                onClick={() => selectWorkspace(item.id)}
              >
                <span className="workspace-icon">
                  {item.name.slice(0, 1).toUpperCase()}
                </span>
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {item.available
                      ? item.slug
                      : `${item.slug} · folder missing`}
                  </small>
                </span>
              </button>
            ))}
          </nav>
        </aside>

        <section
          className={`workspace-main ${view === "board" ? "board-column" : "session-navigator"}`}
        >
          <div className="workspace-main-header">
            <div>
              <span className="eyebrow">
                {workspace?.slug ?? "Select a workspace"}
              </span>
              <h1>{workspace?.name ?? "Workspace"}</h1>
            </div>
          </div>
          {!workspace ? (
            <div className="empty large">
              <strong>Choose a workspace</strong>
              <span>Its board and sessions will appear here.</span>
            </div>
          ) : view === "board" ? (
            <>
              <div className="board-toolbar">
                <div>
                  <strong>Tasks</strong>
                  <span className="count-badge">{tasks.length}</span>
                </div>
                <div className="heading-actions">
                  <select
                    aria-label="Filter tasks by status"
                    value={filter}
                    onChange={(event) =>
                      setFilter(event.target.value as TaskStatus | "all")
                    }
                  >
                    <option value="all">All statuses</option>
                    {STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {status.replace("_", " ")}
                      </option>
                    ))}
                  </select>
                  <button
                    aria-label="Create task"
                    className="icon-button"
                    onClick={() => setModal("task")}
                  >
                    +
                  </button>
                </div>
              </div>
              <div className="board-grid">
                {tasks.length === 0 && (
                  <div className="empty large">
                    <strong>No matching tasks</strong>
                    <span>Use + to create a task.</span>
                  </div>
                )}
                {tasks.map((task) => {
                  const linked = sessions.filter(
                    (item) => item.taskId === task.id,
                  );
                  const live = linked.filter(
                    (item) =>
                      item.status === "running" || item.status === "starting",
                  );
                  return (
                    <article
                      className={`task-item status-card-${task.status} ${task.id === selectedTaskId ? "selected" : ""}`}
                      key={task.id}
                      onClick={() => {
                        setSelectedTaskId(task.id);
                        setEditingTask(false);
                      }}
                    >
                      <div className="task-card-top">
                        <span className={`pill status-${task.status}`}>
                          {task.status.replace("_", " ")}
                        </span>
                        <small>
                          {new Date(task.updatedAt).toLocaleDateString()}
                        </small>
                      </div>
                      <strong>{task.title}</strong>
                      <p>{taskExcerpt(task.description) || "No task brief"}</p>
                      <div className="task-session-summary">
                        <span
                          className={`agent-dot ${live.length ? "running" : "exited"}`}
                        />
                        {live.length
                          ? `${live.length} live`
                          : linked.length
                            ? `${linked.length} sessions`
                            : "No sessions"}
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <div className="sessions-toolbar">
                <div>
                  <strong>Sessions</strong>
                  <span className="count-badge">{sessions.length}</span>
                </div>
                <button
                  disabled={!snapshot?.settings.tmuxAvailable}
                  onClick={() => setModal("session")}
                >
                  + New session
                </button>
              </div>
              <div className="session-grid item-list">
                {sessions.length === 0 && (
                  <div className="empty large">
                    <strong>No sessions yet</strong>
                    <span>Create an agent or free terminal.</span>
                  </div>
                )}
                {sessions.map((session) => {
                  const task = allTasks.find(
                    (item) => item.id === session.taskId,
                  );
                  const live =
                    session.status === "running" ||
                    session.status === "starting";
                  const timestamp = session.endedAt ?? session.startedAt;
                  return (
                    <div
                      className={`session-card ${session.id === activeSessionId ? "selected" : ""}`}
                      key={session.id}
                    >
                      <button
                        className="session-card-main"
                        onClick={() => setActiveSessionId(session.id)}
                      >
                        <span className={`session-kind-icon ${session.kind}`}>
                          {session.kind === "terminal"
                            ? ">_"
                            : session.provider.slice(0, 1).toUpperCase()}
                        </span>
                        <span>
                          <strong>{sessionName(session)}</strong>
                          <small>{task?.title ?? "Workspace session"}</small>
                          <em>
                            <span className={`agent-dot ${session.status}`} />
                            {session.status} · {session.id.slice(0, 6)}
                          </em>
                          <time dateTime={timestamp}>
                            {session.endedAt ? "Ended" : "Started"} ·{" "}
                            {new Date(timestamp).toLocaleString()}
                          </time>
                        </span>
                      </button>
                      <button
                        aria-label={`${live ? "Stop" : "Remove"} ${sessionName(session)} session`}
                        className="session-card-action"
                        onClick={() =>
                          void (live
                            ? stopSession(session)
                            : removeSession(session))
                        }
                      >
                        {live ? "■" : "×"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>

        {view === "board" && workspace && (
          <aside className="board-detail-column">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Inspector</span>
                <h1>Task brief</h1>
              </div>
              {selectedTask && (
                <button
                  className="quiet"
                  onClick={() => setEditingTask((current) => !current)}
                >
                  {editingTask ? "Cancel" : "Edit"}
                </button>
              )}
            </div>
            {taskInspector}
          </aside>
        )}

        {view === "sessions" && workspace && (
          <section className="terminal-column">
            <div className="terminal-heading">
              <div>
                <span className="eyebrow">Terminal</span>
                <h1>
                  {activeSession
                    ? sessionName(activeSession)
                    : "No session selected"}
                </h1>
              </div>
              {activeSession && <small>{activeSession.status}</small>}
            </div>
            {activeSession ? (
              <SessionTerminal key={activeSession.id} session={activeSession} />
            ) : (
              <div className="terminal-empty">
                <strong>Select a session</strong>
                <span>
                  Choose a card or create a new agent or free terminal.
                </span>
              </div>
            )}
          </section>
        )}
      </div>

      {modal === "workspace" && (
        <Modal onClose={() => setModal(undefined)} title="Create workspace">
          <form className="modal-form" onSubmit={createWorkspace}>
            <label>
              Name
              <input
                autoFocus
                required
                value={workspaceForm.name}
                onChange={(event) =>
                  setWorkspaceForm({
                    ...workspaceForm,
                    name: event.target.value,
                  })
                }
                placeholder="My project"
              />
            </label>
            <label>
              Slug <small>optional</small>
              <input
                value={workspaceForm.slug}
                onChange={(event) =>
                  setWorkspaceForm({
                    ...workspaceForm,
                    slug: event.target.value,
                  })
                }
                placeholder="my-project"
              />
            </label>
            <label>
              Custom path <small>optional</small>
              <input
                value={workspaceForm.path}
                onChange={(event) =>
                  setWorkspaceForm({
                    ...workspaceForm,
                    path: event.target.value,
                  })
                }
                placeholder={snapshot?.settings.workspaceRoot}
              />
            </label>
            <div className="modal-actions">
              <button
                className="quiet"
                onClick={() => setModal(undefined)}
                type="button"
              >
                Cancel
              </button>
              <button disabled={busy} type="submit">
                Create workspace
              </button>
            </div>
          </form>
        </Modal>
      )}

      {modal === "task" && workspace && (
        <Modal onClose={() => setModal(undefined)} title="Create task">
          <form className="modal-form" onSubmit={createTask}>
            <label>
              Title
              <input
                autoFocus
                required
                value={taskForm.title}
                onChange={(event) =>
                  setTaskForm({ ...taskForm, title: event.target.value })
                }
                placeholder="What needs to be done?"
              />
            </label>
            <label>
              Task brief <small>Markdown</small>
              <textarea
                value={taskForm.description}
                onChange={(event) =>
                  setTaskForm({ ...taskForm, description: event.target.value })
                }
                rows={7}
              />
            </label>
            <div className="modal-actions">
              <button
                className="quiet"
                onClick={() => setModal(undefined)}
                type="button"
              >
                Cancel
              </button>
              <button disabled={busy} type="submit">
                Create task
              </button>
            </div>
          </form>
        </Modal>
      )}

      {modal === "session" && workspace && snapshot && (
        <Modal onClose={() => setModal(undefined)} title="Create session">
          <form className="modal-form" onSubmit={createSession}>
            <fieldset className="session-tool-picker">
              <legend>Choose a tool</legend>
              <div
                aria-label="Session tool"
                className="session-tool-row"
                role="radiogroup"
              >
                {(
                  [
                    { id: "codex", icon: "CX", label: "Codex" },
                    { id: "claude", icon: "CL", label: "Claude" },
                    { id: "terminal", icon: ">_", label: "Terminal" },
                  ] as const
                ).map((tool) => {
                  const available =
                    tool.id === "terminal" ||
                    Boolean(
                      snapshot.settings.providers.find(
                        (item) => item.name === tool.id,
                      )?.available,
                    );
                  return (
                    <button
                      aria-checked={sessionType === tool.id}
                      autoFocus={sessionType === tool.id}
                      className={`session-tool ${sessionType === tool.id ? "selected" : ""}`}
                      disabled={!available}
                      key={tool.id}
                      onClick={() => setSessionType(tool.id)}
                      role="radio"
                      type="button"
                    >
                      <span className={`session-tool-icon ${tool.id}`}>
                        {tool.icon}
                      </span>
                      <strong>{tool.label}</strong>
                      <small>{available ? "Available" : "Unavailable"}</small>
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <div className="session-workspace-note">
              <span className="workspace-icon">
                {workspace.name.slice(0, 1).toUpperCase()}
              </span>
              <span>
                <strong>{workspace.name}</strong>
                <small>Opens in {workspace.path}</small>
              </span>
            </div>
            <div className="modal-actions">
              <button
                className="quiet"
                onClick={() => setModal(undefined)}
                type="button"
              >
                Cancel
              </button>
              <button disabled={busy} type="submit">
                Create session
              </button>
            </div>
          </form>
        </Modal>
      )}

      {modal === "settings" && snapshot && (
        <Modal onClose={() => setModal(undefined)} title="Settings">
          <dl className="settings-list">
            <dt>Daedalus home</dt>
            <dd>{snapshot.settings.home}</dd>
            <dt>Workspace root</dt>
            <dd>{snapshot.settings.workspaceRoot}</dd>
            <dt>Database</dt>
            <dd>{snapshot.settings.databasePath}</dd>
            <dt>tmux</dt>
            <dd>{snapshot.settings.tmuxVersion ?? "Not found"}</dd>
            <dt>Theme</dt>
            <dd>
              <select
                aria-label="Theme"
                value={theme}
                onChange={(event) => {
                  const value = event.target.value as "dark" | "light";
                  setTheme(value);
                  window.localStorage.setItem("daedalus.theme", value);
                }}
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </dd>
          </dl>
          <h3>Agent executables</h3>
          <div className="provider-grid">
            {snapshot.settings.providers.map((item) => (
              <div key={item.name}>
                <span
                  className={`agent-dot ${item.available ? "running" : "lost"}`}
                />
                <strong>{item.name}</strong>
                <code>{item.executable}</code>
                <small>
                  {item.available ? "Available" : "Not found on PATH"}
                </small>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </main>
  );
}
