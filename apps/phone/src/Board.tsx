/**
 * A workspace's board on the phone is the Mac's own board: `BoardView` from
 * the desktop renderer, with the Mac's board styles (mac-board.css, copied
 * by scripts/phone-board-css.ts), so the lanes, cards and buttons look and
 * behave as they do on the Mac. Its clicks become requests over the
 * encrypted channel. A task opens on its own screen (`TaskScreen`).
 */
import { useEffect, useMemo, useState } from "react";
import type {
  AgentSessionDto,
  DesktopSnapshotDto,
  RpcResult,
  TaskDto,
  TaskStatus,
  TaskTimelineDto,
} from "@daedalus/protocol";
import type { PhoneConnection } from "@daedalus/remote-protocol";
import {
  boardLanes,
  LANE_LABEL,
  unfinishedDependencies,
} from "../../desktop/src/renderer/board-lanes";
import {
  type BoardLaunch,
  type BoardProvider,
  BoardView,
} from "../../desktop/src/renderer/BoardView";
import { DialogHost } from "../../desktop/src/renderer/dialogs";
import { type SessionRow, SessionRowView } from "./sessions";
import "./mac-board.css";

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

const byId = <T extends { sessionId: string }>(items: readonly T[]) =>
  new Map(items.map((item) => [item.sessionId, item]));

function laneOf(snapshot: DesktopSnapshotDto, task: TaskDto) {
  const tasks = snapshot.tasks.filter(
    (item) => item.workspaceId === task.workspaceId,
  );
  const tasksById = new Map(tasks.map((item) => [item.id, item]));
  return boardLanes(
    tasks,
    {
      sessions: snapshot.agents,
      activity: byId(snapshot.sessionActivity),
      attention: byId(snapshot.attention),
      worktrees: snapshot.worktrees,
    },
    { isWaiting: (item) => unfinishedDependencies(item, tasksById).length > 0 },
  ).find((group) => group.tasks.some((item) => item.id === task.id))?.lane;
}

async function call<T>(
  connection: PhoneConnection,
  method: string,
  params: unknown,
): Promise<T> {
  const result = (await connection.request(method, params)) as RpcResult<T>;
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

/** One workspace's board, as the Mac draws it. */
export function MacBoard({
  workspaceId,
  snapshot,
  connection,
  onOpenTask,
  onOpenSession,
  onNewTask,
}: {
  workspaceId: string;
  snapshot: DesktopSnapshotDto;
  connection: PhoneConnection | undefined;
  onOpenTask: (id: string) => void;
  onOpenSession: (id: string) => void;
  onNewTask: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [launches, setLaunches] = useState<BoardLaunch[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const workspace = snapshot.workspaces.find((item) => item.id === workspaceId);
  const sessions = useMemo(
    () => snapshot.agents.filter((item) => item.workspaceId === workspaceId),
    [snapshot, workspaceId],
  );
  if (!workspace) return <p className="quiet-line">No such workspace.</p>;
  const sessionIds = new Set(sessions.map((item) => item.id));
  const providers = (["claude", "codex"] as const).filter((name) =>
    snapshot.settings.providers.some(
      (provider) => provider.name === name && provider.available,
    ),
  ) as BoardProvider[];

  const act = async (
    work: (connection: PhoneConnection) => Promise<unknown>,
  ) => {
    if (!connection) return false;
    setBusy(true);
    try {
      await work(connection);
      return true;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  };
  const setStatus = (task: TaskDto, status: TaskStatus) =>
    void act((open) => call(open, "taskSetStatus", { id: task.id, status }));
  /** As the Mac's Start: the workspace's provider, a launch row meanwhile. */
  const start = async (
    task: TaskDto,
    options: { provider?: BoardProvider; draftBrief?: boolean } = {},
  ) => {
    const provider =
      options.provider ?? workspace.defaultProvider ?? providers[0];
    if (!connection || !provider) return;
    const key = crypto.randomUUID();
    setLaunches((current) => [
      { key, taskId: task.id, tool: provider, status: "starting" },
      ...current,
    ]);
    try {
      await call<AgentSessionDto>(connection, "agentSpawn", {
        workspace: workspace.id,
        taskId: task.id,
        provider,
        ...(options.draftBrief ? { draftBrief: true } : {}),
      });
      setLaunches((current) => current.filter((item) => item.key !== key));
    } catch (failure) {
      setLaunches((current) =>
        current.map((item) =>
          item.key === key
            ? {
                ...item,
                status: "error",
                error:
                  failure instanceof Error ? failure.message : String(failure),
              }
            : item,
        ),
      );
    }
  };

  return (
    <div className="mac-board">
      <BoardView
        activity={byId(snapshot.sessionActivity)}
        attention={byId(snapshot.attention)}
        availableProviders={providers}
        busy={busy || !connection}
        launches={launches}
        modelCatalogs={{}}
        now={now}
        onAnswer={(session, text) =>
          act((open) => call(open, "agentSend", { id: session.id, text }))
        }
        onCreateTask={onNewTask}
        onDismissLaunch={(key) =>
          setLaunches((current) => current.filter((item) => item.key !== key))
        }
        onDraftBrief={(task) => void start(task, { draftBrief: true })}
        onMarkDone={(task) => setStatus(task, "done")}
        onNeedModels={() => {}}
        onOpenLink={(url) => window.open(url, "_blank", "noopener")}
        onOpenSession={(session) => onOpenSession(session.id)}
        // A worktree is a folder on the Mac; the phone opens the session
        // that made it instead.
        onOpenWorktree={(worktree) => onOpenSession(worktree.sessionId)}
        onPark={(task) => setStatus(task, "blocked")}
        onQuickCapture={(title) =>
          act((open) =>
            call(open, "taskCreate", { workspace: workspace.id, title }),
          )
        }
        onSecondOpinion={(task, provider) => void start(task, { provider })}
        onSelectTask={(task) => onOpenTask(task.id)}
        onSetInProgress={(task) => setStatus(task, "in_progress")}
        onStart={(task) => void start(task)}
        onStartNext={(task) => void start(task)}
        onStartWith={(task) => void start(task)}
        // Board settings change the workspace, which stays on the Mac.
        onUpdateSettings={() => {}}
        sessions={sessions}
        tasks={snapshot.tasks.filter(
          (task) => task.workspaceId === workspaceId,
        )}
        telemetry={byId(snapshot.sessionTelemetry)}
        tmuxAvailable={snapshot.settings.tmuxAvailable}
        workspace={workspace}
        workspaces={snapshot.workspaces.filter((item) => !item.archivedAt)}
        worktrees={snapshot.worktrees.filter((item) =>
          sessionIds.has(item.sessionId),
        )}
      />
      <DialogHost />
    </div>
  );
}

/** One task: what it asks, where it stands, its sessions and history. */
export function TaskScreen({
  task,
  snapshot,
  connection,
  sessionRows,
  onOpenSession,
}: {
  task: TaskDto;
  snapshot: DesktopSnapshotDto;
  connection: PhoneConnection | undefined;
  sessionRows: SessionRow[];
  onOpenSession: (id: string) => void;
}) {
  const [timeline, setTimeline] = useState<TaskTimelineDto>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  // The snapshot carries only the start of a long brief; the whole task
  // comes from the Mac when this screen opens. Editing waits for it, so a
  // save never writes back the shortened start.
  const [full, setFull] = useState<TaskDto | undefined>(
    task.descriptionShortened ? undefined : task,
  );
  const description = full?.description ?? task.description;
  const [brief, setBrief] = useState(description);
  const workspace = snapshot.workspaces.find(
    (item) => item.id === task.workspaceId,
  );
  const lane = useMemo(() => laneOf(snapshot, task), [snapshot, task]);

  useEffect(() => {
    if (!task.descriptionShortened) {
      setFull(task);
      return;
    }
    if (!connection) return;
    let current = true;
    call<TaskDto>(connection, "taskGet", { id: task.id }).then(
      (data) => {
        if (current) setFull(data);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [connection, task]);

  useEffect(() => {
    if (!connection) return;
    let current = true;
    call<TaskTimelineDto>(connection, "taskTimeline", { id: task.id }).then(
      (data) => {
        if (current) setTimeline(data);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [connection, task.id, task.updatedAt]);

  const run = async (work: () => Promise<unknown>) => {
    if (!connection) return;
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const rows = sessionRows.filter((row) => row.session.taskId === task.id);

  return (
    <div className="task-screen">
      <header className="task-head">
        <small>
          #{task.number} · {workspace?.name ?? "Workspace"}
          {lane ? ` · ${LANE_LABEL[lane]}` : ""}
        </small>
        {editing ? (
          <input
            aria-label="Title"
            onChange={(event) => setTitle(event.target.value)}
            value={title}
          />
        ) : (
          <h2>{task.title}</h2>
        )}
      </header>

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="task-actions">
        <label className="task-status">
          <span>Status</span>
          <select
            disabled={busy || !connection}
            onChange={(event) =>
              run(() =>
                call(connection!, "taskSetStatus", {
                  id: task.id,
                  status: event.target.value as TaskStatus,
                }),
              )
            }
            value={task.status}
          >
            {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status]}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button primary"
          disabled={busy || !connection}
          onClick={() =>
            run(async () => {
              const session = await call<AgentSessionDto>(
                connection!,
                "agentSpawn",
                { workspace: task.workspaceId, taskId: task.id },
              );
              onOpenSession(session.id);
            })
          }
        >
          Start a session
        </button>
      </div>

      <section className="group">
        <header className="task-section-head">
          <h3 className="group-title">Brief</h3>
          {editing ? (
            <span>
              <button
                className="link"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setTitle(task.title);
                  setBrief(description);
                }}
              >
                Cancel
              </button>
              <button
                className="link"
                disabled={busy || !title.trim()}
                onClick={() =>
                  run(async () => {
                    await call(connection!, "taskUpdate", {
                      id: task.id,
                      title: title.trim(),
                      description: brief,
                    });
                    setEditing(false);
                  })
                }
              >
                Save
              </button>
            </span>
          ) : (
            <button
              className="link"
              disabled={!connection || !full}
              onClick={() => {
                setTitle(task.title);
                setBrief(description);
                setEditing(true);
              }}
            >
              Edit
            </button>
          )}
        </header>
        {editing ? (
          <textarea
            aria-label="Brief"
            className="task-brief-edit"
            onChange={(event) => setBrief(event.target.value)}
            rows={12}
            value={brief}
          />
        ) : (
          <div className="task-brief">
            {description.trim() || "No brief yet."}
            {full ? null : "…"}
          </div>
        )}
      </section>

      <section className="group">
        <h3 className="group-title">Sessions</h3>
        {rows.length ? (
          <ul className="session-rows">
            {rows.map((row) => (
              <SessionRowView
                key={row.session.id}
                onOpen={onOpenSession}
                row={row}
              />
            ))}
          </ul>
        ) : (
          <p className="quiet-line">No session has worked on this yet.</p>
        )}
      </section>

      {timeline?.events.length ? (
        <section className="group">
          <h3 className="group-title">Timeline</h3>
          <ol className="timeline">
            {timeline.events
              .slice(-20)
              .reverse()
              .map((event, index) => (
                <li key={`${event.kind}-${event.at}-${index}`}>
                  <time>{when(event.at)}</time>
                  <span>{event.text}</span>
                </li>
              ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

function when(at: string | null): string {
  if (!at) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) return at;
  return new Date(at).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
}

/** A new task in one workspace: a title and a brief. */
export function NewTaskScreen({
  workspaceId,
  connection,
  onCreated,
}: {
  workspaceId: string;
  connection: PhoneConnection | undefined;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="task-screen"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!connection || !title.trim()) return;
        setBusy(true);
        setError(undefined);
        try {
          const task = await call<TaskDto>(connection, "taskCreate", {
            workspace: workspaceId,
            title: title.trim(),
            description: brief,
          });
          onCreated(task.id);
        } catch (failure) {
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        <span>Title</span>
        <input
          onChange={(event) => setTitle(event.target.value)}
          value={title}
        />
      </label>
      <label className="field">
        <span>Brief</span>
        <textarea
          onChange={(event) => setBrief(event.target.value)}
          rows={8}
          value={brief}
        />
      </label>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <button
        className="button primary"
        disabled={busy || !connection || !title.trim()}
        type="submit"
      >
        Create task
      </button>
    </form>
  );
}
