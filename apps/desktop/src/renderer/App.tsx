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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`pill status-${status}`}>{status.replace("_", " ")}</span>
  );
}

function taskExcerpt(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "Code example")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+] |\d+\. )\s*/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

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
  children,
}: {
  children: React.ReactNode;
  onClose: () => void;
  title: string;
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
        className="modal"
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

function AgentTerminal({ agent }: { agent: AgentSessionDto }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("connecting");
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (agent.status !== "running" && agent.status !== "starting") {
      setStatus(agent.status);
      return;
    }
    let disposed = false;
    let terminal: Terminal | undefined;
    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempts = 0;
    let terminalEnded = false;
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
        if (frame === undefined) frame = requestAnimationFrame(drain);
        return;
      }
      pending.push(chunk);
      pendingBytes += chunk.byteLength;
      while (pendingBytes > 1024 * 1024 && pending.length > 1) {
        const dropped = pending.shift();
        if (dropped) pendingBytes -= dropped.byteLength;
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
        setStatus("available in Electrobun");
        return;
      }
      const connect = () => {
        if (disposed || terminalEnded) return;
        const url = new URL(endpoint);
        url.searchParams.set("agent", agent.id);
        socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        socket.onopen = () => {
          reconnectAttempts = 0;
          setStatus("connected");
          socket?.send(
            JSON.stringify({
              type: "resize",
              cols: terminal?.cols ?? 80,
              rows: terminal?.rows ?? 24,
            }),
          );
        };
        socket.onclose = () => {
          if (disposed || terminalEnded) return;
          setStatus("reconnecting");
          reconnectTimer = setTimeout(
            connect,
            Math.min(4_000, 250 * 2 ** reconnectAttempts++),
          );
        };
        socket.onerror = () => setStatus("connection error");
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
            setStatus(value.status);
            if (value.status === "exited" || value.status === "lost")
              terminalEnded = true;
          }
          if (value.type === "overflow" && value.droppedBytes) {
            terminal?.writeln(
              `\r\n\u001b[33m[Daedalus skipped ${value.droppedBytes.toLocaleString()} buffered bytes; reconnect to recapture scrollback]\u001b[0m`,
            );
          }
          if (value.type === "error" && value.message) {
            terminalEnded = true;
            setStatus("unavailable");
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
  }, [agent.id, agent.status]);
  return (
    <section className="agent-terminal-shell">
      <div className="terminal-status">
        <span className={`agent-dot ${agent.status}`} />
        <span>{agent.provider}</span>
        <small>
          {status} · {agent.id.slice(0, 8)}
        </small>
      </div>
      <div
        aria-label={`Terminal for ${agent.provider} session ${agent.id.slice(0, 8)}`}
        className="terminal"
        ref={containerRef}
      />
    </section>
  );
}

export function App({
  injectedClient,
  initialSnapshot,
  initialSelectedTaskId,
  initialActiveAgentId,
  initialDetailView = "brief",
}: {
  injectedClient?: DesktopClient;
  initialSnapshot?: DesktopSnapshotDto;
  initialSelectedTaskId?: string;
  initialActiveAgentId?: string;
  initialDetailView?: "brief" | "terminal";
} = {}) {
  const clientRef = useRef<DesktopClient | undefined>(injectedClient);
  if (!clientRef.current)
    throw new Error("The desktop RPC client was not provided");
  const client = clientRef.current;
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(
    initialSnapshot?.workspaces[0]?.id,
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(
    initialSelectedTaskId,
  );
  const [editingTaskId, setEditingTaskId] = useState<string>();
  const [filter, setFilter] = useState<TaskStatus | "all">("all");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<"workspace" | "task" | "settings">();
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [workspaceForm, setWorkspaceForm] = useState({
    name: "",
    slug: "",
    path: "",
  });
  const [taskForm, setTaskForm] = useState({ title: "", description: "" });
  const [provider, setProvider] = useState("codex");
  const [detailView, setDetailView] = useState<"brief" | "terminal">(
    initialDetailView,
  );
  const [activeAgentId, setActiveAgentId] = useState<string | undefined>(
    initialActiveAgentId,
  );

  const refresh = useCallback(async () => {
    try {
      const response = await client.request.snapshot({});
      if (!response.ok) throw new Error(response.error.message);
      setSnapshot(response.data);
      setError(undefined);
      setSelectedWorkspaceId((current) =>
        response.data.workspaces.some((item) => item.id === current)
          ? current
          : response.data.workspaces[0]?.id,
      );
      setSelectedTaskId((current) =>
        response.data.tasks.some((item) => item.id === current)
          ? current
          : undefined,
      );
      setActiveAgentId((current) =>
        response.data.agents.some((item) => item.id === current)
          ? current
          : undefined,
      );
    } catch (cause) {
      setError(message(cause));
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
    if (!snapshot) return;
    const selected = snapshot.settings.providers.find(
      (item) => item.name === provider,
    );
    if (!selected?.available) {
      setProvider(
        snapshot.settings.providers.find((item) => item.available)?.name ??
          snapshot.settings.providers[0]?.name ??
          "",
      );
    }
  }, [provider, snapshot]);

  useEffect(() => {
    if (detailView === "terminal" && !activeAgentId) setDetailView("brief");
  }, [activeAgentId, detailView]);

  async function perform<T>(
    operation: Promise<RpcResult<T>>,
  ): Promise<T | undefined> {
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
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  const workspace = snapshot?.workspaces.find(
    (item) => item.id === selectedWorkspaceId,
  );
  const tasks = (snapshot?.tasks ?? []).filter(
    (item) =>
      item.workspaceId === selectedWorkspaceId &&
      (filter === "all" || item.status === filter),
  );
  const selectedTask = snapshot?.tasks.find(
    (item) => item.id === selectedTaskId,
  );
  const activeAgent = snapshot?.agents.find(
    (item) => item.id === activeAgentId,
  );
  const taskAgents = (taskId: string) =>
    (snapshot?.agents ?? []).filter((agent) => agent.taskId === taskId);

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
      setWorkspaceForm({ name: "", slug: "", path: "" });
      setSelectedWorkspaceId(created.id);
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
      setTaskForm({ title: "", description: "" });
      setSelectedTaskId(created.id);
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
    if (updated) setEditingTaskId(undefined);
  }

  async function spawnAgent(task: TaskDto) {
    if (!workspace || !provider) return;
    const builtIn = provider === "codex" || provider === "claude";
    const spawned = await perform(
      client.request.agentSpawn({
        workspace: workspace.id,
        taskId: task.id,
        provider: builtIn ? provider : undefined,
        command: builtIn ? undefined : provider,
      }),
    );
    if (spawned) {
      setSelectedTaskId(task.id);
      setActiveAgentId(spawned.id);
      setDetailView("terminal");
    }
  }

  function openAgent(
    agent: AgentSessionDto,
    event?: React.MouseEvent<HTMLButtonElement>,
  ) {
    event?.currentTarget.closest("details")?.removeAttribute("open");
    if (agent.taskId) setSelectedTaskId(agent.taskId);
    setActiveAgentId(agent.id);
    setDetailView("terminal");
    setEditingTaskId(undefined);
  }

  async function stopAgent(agent: AgentSessionDto) {
    if (
      !window.confirm(`Stop ${agent.provider} session ${agent.id.slice(0, 8)}?`)
    )
      return;
    await perform(client.request.agentStop({ id: agent.id, force: false }));
  }

  async function removeAgent(agent: AgentSessionDto) {
    if (!window.confirm(`Remove session history ${agent.id.slice(0, 8)}?`))
      return;
    await perform(client.request.agentRemove({ id: agent.id }));
  }

  async function removeTask() {
    if (
      !selectedTask ||
      !window.confirm(`Permanently delete task “${selectedTask.title}”?`)
    )
      return;
    await perform(
      client.request.taskRemove({ id: selectedTask.id, force: true }),
    );
    setSelectedTaskId(undefined);
  }

  async function renameWorkspace() {
    if (!workspace) return;
    const name = window.prompt("Workspace name", workspace.name);
    if (name !== null && name !== workspace.name)
      await perform(
        client.request.workspaceUpdate({ reference: workspace.id, name }),
      );
  }

  async function removeWorkspace() {
    if (!workspace) return;
    const deleteFiles = window.confirm(
      `Also permanently delete the workspace folder?\n\n${workspace.path}\n\nChoose Cancel to preserve its files.`,
    );
    const action = deleteFiles
      ? "delete its folder and unregister it"
      : "unregister it and preserve its files";
    if (!window.confirm(`Confirm you want to ${action}: ${workspace.name}`))
      return;
    await perform(
      client.request.workspaceRemove({
        reference: workspace.id,
        deleteFiles,
        force: true,
      }),
    );
  }

  function changeTheme(value: "dark" | "light") {
    setTheme(value);
    window.localStorage.setItem("daedalus.theme", value);
  }

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

      <div className="columns">
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
                className={`workspace-item ${item.id === selectedWorkspaceId ? "selected" : ""}`}
                key={item.id}
                onClick={() => {
                  setSelectedWorkspaceId(item.id);
                  setSelectedTaskId(undefined);
                  setActiveAgentId(undefined);
                  setDetailView("brief");
                }}
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
          {workspace && (
            <div className="workspace-actions">
              <button className="quiet" onClick={renameWorkspace}>
                Rename
              </button>
              <button className="danger-link" onClick={removeWorkspace}>
                Unregister
              </button>
            </div>
          )}
        </aside>

        <section className="task-column">
          <div className="section-heading">
            <div>
              <span className="eyebrow">
                {workspace?.slug ?? "Select a workspace"}
              </span>
              <div className="heading-title">
                <h1>Tasks</h1>
                {workspace && (
                  <span className="count-badge">{tasks.length}</span>
                )}
              </div>
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
                disabled={!workspace}
                onClick={() => setModal("task")}
              >
                +
              </button>
            </div>
          </div>
          {!workspace ? (
            <div className="empty large">
              <strong>Choose a workspace</strong>
              <span>Its tasks will appear here.</span>
            </div>
          ) : (
            <div className="item-list task-list">
              {tasks.length === 0 && (
                <div className="empty large">
                  <strong>No matching tasks</strong>
                  <span>Use + to create a task.</span>
                </div>
              )}
              {tasks.map((task) => {
                const sessions = taskAgents(task.id);
                const running = sessions.filter(
                  (agent) =>
                    agent.status === "running" || agent.status === "starting",
                );
                return (
                  <article
                    className={`task-item status-card-${task.status} ${task.id === selectedTaskId ? "selected" : ""}`}
                    key={task.id}
                    onClick={() => {
                      setSelectedTaskId(task.id);
                      setEditingTaskId(undefined);
                      setActiveAgentId(undefined);
                      setDetailView("brief");
                    }}
                  >
                    <div className="task-card-top">
                      <StatusPill status={task.status} />
                      <small>
                        {new Date(task.updatedAt).toLocaleDateString()}
                      </small>
                    </div>
                    <strong>{task.title}</strong>
                    <p>{taskExcerpt(task.description) || "No task brief"}</p>
                    <div
                      className="task-agent-controls"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <select
                        aria-label={`Agent tool for ${task.title}`}
                        value={provider}
                        onChange={(event) => setProvider(event.target.value)}
                      >
                        {(snapshot?.settings.providers ?? []).map((item) => (
                          <option key={item.name} value={item.name}>
                            {item.name}
                            {item.available ? "" : " — unavailable"}
                          </option>
                        ))}
                      </select>
                      <button
                        disabled={
                          busy || !snapshot?.settings.tmuxAvailable || !provider
                        }
                        onClick={() => void spawnAgent(task)}
                      >
                        <span aria-hidden="true">▶</span> Spawn
                      </button>
                      {sessions.length > 0 && (
                        <details className="session-menu">
                          <summary>
                            <span
                              className={`agent-dot ${running.length ? "running" : "exited"}`}
                            />
                            {running.length || sessions.length}{" "}
                            {running.length ? "running" : "sessions"} ▾
                          </summary>
                          <div className="session-popover">
                            {sessions.map((agent) => (
                              <div key={agent.id}>
                                <button
                                  className="session-open quiet"
                                  onClick={(event) => openAgent(agent, event)}
                                >
                                  <span
                                    className={`agent-dot ${agent.status}`}
                                  />
                                  <span>
                                    <strong>{agent.provider}</strong>
                                    <small>
                                      {agent.status} · {agent.id.slice(0, 8)}
                                    </small>
                                  </span>
                                </button>
                                {agent.status === "running" ||
                                agent.status === "starting" ? (
                                  <button
                                    className="danger-link"
                                    onClick={() => void stopAgent(agent)}
                                  >
                                    Stop
                                  </button>
                                ) : (
                                  <button
                                    className="danger-link"
                                    onClick={() => void removeAgent(agent)}
                                  >
                                    Remove
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <aside className="detail-column">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Inspector</span>
              <div
                className="detail-tabs"
                role="tablist"
                aria-label="Task detail view"
              >
                <button
                  aria-selected={detailView === "brief"}
                  className={detailView === "brief" ? "active" : ""}
                  onClick={() => setDetailView("brief")}
                  role="tab"
                >
                  Task brief
                </button>
                <button
                  aria-selected={detailView === "terminal"}
                  className={detailView === "terminal" ? "active" : ""}
                  disabled={!activeAgent}
                  onClick={() => setDetailView("terminal")}
                  role="tab"
                >
                  Terminal
                </button>
              </div>
            </div>
            {detailView === "brief" &&
              selectedTask &&
              selectedTask.workspaceId === workspace?.id && (
                <button
                  className="quiet"
                  onClick={() =>
                    setEditingTaskId(
                      editingTaskId === selectedTask.id
                        ? undefined
                        : selectedTask.id,
                    )
                  }
                >
                  {editingTaskId === selectedTask.id ? "Cancel" : "Edit"}
                </button>
              )}
          </div>
          {detailView === "terminal" && activeAgent ? (
            <div className="terminal-detail">
              <label className="session-switcher">
                <span>Session</span>
                <select
                  aria-label="Active terminal session"
                  value={activeAgent.id}
                  onChange={(event) => setActiveAgentId(event.target.value)}
                >
                  {taskAgents(activeAgent.taskId ?? "").map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.provider} · {agent.status} · {agent.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
              <AgentTerminal agent={activeAgent} key={activeAgent.id} />
            </div>
          ) : !selectedTask || selectedTask.workspaceId !== workspace?.id ? (
            <div className="empty large">
              <strong>Select a task</strong>
              <span>Its brief will appear here.</span>
            </div>
          ) : editingTaskId === selectedTask.id ? (
            <form
              className="task-editor brief-editor"
              key={selectedTask.id}
              onSubmit={updateTask}
            >
              <label>
                Title
                <input
                  name="title"
                  defaultValue={selectedTask.title}
                  required
                />
              </label>
              <label>
                <span className="field-heading">
                  Markdown <small>plain text for agents · ⌘↵ to save</small>
                </span>
                <textarea
                  aria-label="Markdown task brief"
                  name="description"
                  defaultValue={selectedTask.description}
                  onKeyDown={(event) => {
                    if (
                      (event.metaKey || event.ctrlKey) &&
                      event.key === "Enter"
                    )
                      event.currentTarget.form?.requestSubmit();
                  }}
                  rows={16}
                  placeholder={
                    "## Goal\n\nWhat should change?\n\n## Context\n\nWhat should the agent know?\n\n## Acceptance criteria\n\n- [ ] Expected outcome"
                  }
                />
              </label>
              <div className="editor-actions">
                <button
                  className="quiet"
                  onClick={() => setEditingTaskId(undefined)}
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
              <div className="brief-meta">
                <span className="meta-label">Status</span>
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
                <span className="eyebrow">Agent sessions</span>
                {taskAgents(selectedTask.id).length === 0 ? (
                  <p className="hint">
                    No agent has been started for this task.
                  </p>
                ) : (
                  taskAgents(selectedTask.id).map((agent) => (
                    <div className="linked-session" key={agent.id}>
                      <span className={`agent-dot ${agent.status}`} />
                      <div>
                        <strong>{agent.provider}</strong>
                        <small>
                          {agent.status} · {agent.id.slice(0, 8)}
                        </small>
                      </div>
                      <button
                        className="quiet linked-session-open"
                        onClick={() => openAgent(agent)}
                      >
                        Open
                      </button>
                    </div>
                  ))
                )}
              </section>
              <button className="danger-link brief-delete" onClick={removeTask}>
                Delete task
              </button>
            </div>
          )}
        </aside>
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
                rows={6}
                placeholder={
                  "## Goal\n\nWhat should change?\n\n## Context\n\nWhat should the agent know?\n\n## Acceptance criteria\n\n- [ ] Expected outcome"
                }
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
                onChange={(event) =>
                  changeTheme(event.target.value as "dark" | "light")
                }
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
