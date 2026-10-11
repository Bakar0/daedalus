/**
 * The board on the phone: the Mac's lanes, from the Mac's own rules
 * (`board-lanes.ts`, imported from the desktop renderer, so a task cannot sit
 * in one lane on the Mac and another here), stacked top to bottom. A task
 * opens on its brief, status, sessions and timeline.
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
  type BoardLane,
  boardLanes,
  LANE_LABEL,
  type LaneInputs,
  unfinishedDependencies,
} from "../../desktop/src/renderer/board-lanes";
import { type SessionRow, SessionRowView } from "./sessions";

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

const FILTER_KEY = "daedalus.phone.board-workspace";

function remembered(): string {
  try {
    return localStorage.getItem(FILTER_KEY) ?? "all";
  } catch {
    return "all";
  }
}

function remember(value: string): void {
  try {
    localStorage.setItem(FILTER_KEY, value);
  } catch {
    // A convenience only.
  }
}

function laneInputs(snapshot: DesktopSnapshotDto): LaneInputs {
  return {
    sessions: snapshot.agents,
    activity: new Map(
      snapshot.sessionActivity.map((item) => [item.sessionId, item]),
    ),
    attention: new Map(
      snapshot.attention.map((item) => [item.sessionId, item]),
    ),
    worktrees: snapshot.worktrees,
  };
}

/** Lanes for one workspace, or every active one, in the Mac's order. */
export function phoneBoard(snapshot: DesktopSnapshotDto, workspaceId: string) {
  const active = new Set(
    snapshot.workspaces
      .filter((workspace) => !workspace.archivedAt)
      .map((workspace) => workspace.id),
  );
  const tasks = snapshot.tasks.filter((task) =>
    workspaceId === "all"
      ? active.has(task.workspaceId)
      : task.workspaceId === workspaceId,
  );
  const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
  return boardLanes(tasks, laneInputs(snapshot), {
    isWaiting: (task) => unfinishedDependencies(task, byId).length > 0,
  });
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

export function Board({
  snapshot,
  connection,
  onOpenTask,
  onNewTask,
}: {
  snapshot: DesktopSnapshotDto;
  connection: PhoneConnection | undefined;
  onOpenTask: (id: string) => void;
  onNewTask: () => void;
}) {
  const workspaces = snapshot.workspaces
    .filter((workspace) => !workspace.archivedAt)
    .sort((left, right) => left.position - right.position);
  const [filter, setFilter] = useState(remembered);
  const scope = workspaces.some((workspace) => workspace.id === filter)
    ? filter
    : "all";
  const lanes = useMemo(() => phoneBoard(snapshot, scope), [snapshot, scope]);
  const [doneOpen, setDoneOpen] = useState(false);
  const names = new Map(workspaces.map((item) => [item.id, item.name]));
  const total = lanes.reduce((sum, lane) => sum + lane.tasks.length, 0);

  return (
    <div className="board">
      <div className="board-tools">
        <select
          aria-label="Workspace"
          onChange={(event) => {
            setFilter(event.target.value);
            remember(event.target.value);
          }}
          value={scope}
        >
          <option value="all">All workspaces</option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
        <button
          className="button small"
          disabled={!connection || workspaces.length === 0}
          onClick={onNewTask}
        >
          New task
        </button>
      </div>
      {total === 0 ? <p className="quiet-line">No tasks here yet.</p> : null}
      {lanes.map(({ lane, tasks }) => {
        if (tasks.length === 0) return null;
        const folded = lane === "done" && !doneOpen;
        return (
          <section className="lane" data-lane={lane} key={lane}>
            <header className="lane-head">
              <h2>{LANE_LABEL[lane]}</h2>
              <span className="lane-count">{tasks.length}</span>
              {lane === "done" ? (
                <button className="link" onClick={() => setDoneOpen(!doneOpen)}>
                  {doneOpen ? "Hide" : "Show"}
                </button>
              ) : null}
            </header>
            {folded ? null : (
              <ul className="task-cards">
                {tasks.map((task) => (
                  <li key={task.id}>
                    <TaskCard
                      lane={lane}
                      onOpen={() => onOpenTask(task.id)}
                      snapshot={snapshot}
                      task={task}
                      workspace={
                        scope === "all"
                          ? names.get(task.workspaceId)
                          : undefined
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function TaskCard({
  task,
  lane,
  workspace,
  snapshot,
  onOpen,
}: {
  task: TaskDto;
  lane: BoardLane;
  workspace: string | undefined;
  snapshot: DesktopSnapshotDto;
  onOpen: () => void;
}) {
  const sessions = snapshot.agents.filter(
    (session) => session.taskId === task.id && !session.archivedAt,
  );
  const live = sessions.filter(
    (session) => session.status === "running" || session.status === "starting",
  ).length;
  const details = [
    workspace,
    task.priority === "high" ? "High priority" : undefined,
    sessions.length
      ? `${sessions.length} session${sessions.length === 1 ? "" : "s"}${live ? `, ${live} live` : ""}`
      : undefined,
  ].filter(Boolean);
  return (
    <button
      className="task-card"
      data-lane={lane}
      data-task-id={task.id}
      onClick={onOpen}
    >
      <strong>
        <span className="task-number">#{task.number}</span> {task.title}
      </strong>
      {details.length ? <small>{details.join(" · ")}</small> : null}
    </button>
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
  const [brief, setBrief] = useState(task.description);
  const workspace = snapshot.workspaces.find(
    (item) => item.id === task.workspaceId,
  );
  const lane = useMemo(
    () =>
      phoneBoard(snapshot, task.workspaceId).find((group) =>
        group.tasks.some((item) => item.id === task.id),
      )?.lane,
    [snapshot, task],
  );

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
                  setBrief(task.description);
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
              disabled={!connection}
              onClick={() => {
                setTitle(task.title);
                setBrief(task.description);
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
            {task.description.trim() || "No brief yet."}
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

/** A new task: which workspace, a title, and a brief. */
export function NewTaskScreen({
  snapshot,
  connection,
  onCreated,
}: {
  snapshot: DesktopSnapshotDto;
  connection: PhoneConnection | undefined;
  onCreated: (id: string) => void;
}) {
  const workspaces = snapshot.workspaces
    .filter((workspace) => !workspace.archivedAt)
    .sort((left, right) => left.position - right.position);
  const initial = remembered();
  const [workspace, setWorkspace] = useState(
    workspaces.some((item) => item.id === initial)
      ? initial
      : (workspaces[0]?.id ?? ""),
  );
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
            workspace,
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
        <span>Workspace</span>
        <select
          onChange={(event) => setWorkspace(event.target.value)}
          value={workspace}
        >
          {workspaces.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
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
