import { useCallback, useEffect, useState } from "react";
import type {
  RoutinesPageDto,
  RoutineTranscriptDto,
  RpcResult,
  WorkspaceRoutineDto,
  WorkspaceRoutineRunDto,
} from "@daedalus/protocol";
import type { DesktopClient } from "../client-types";
import { relativeTime } from "./time";

/** The value the form's workspace menu uses for "All workspaces". */
const ALL = "";

/** "in 14m 02s", "in 6h 14m", "in 1d 20h": ticks down on the page. */
export function countdown(iso: string | null, now: number): string {
  if (!iso) return "—";
  let seconds = Math.max(0, Math.round((Date.parse(iso) - now) / 1000));
  if (seconds === 0) return "due";
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  const pad = (value: number) => String(value).padStart(2, "0");
  if (days) return `in ${days}d ${hours}h`;
  if (hours) return `in ${hours}h ${pad(minutes)}m`;
  return `in ${minutes}m ${pad(seconds % 60)}s`;
}

/** "today 13:00", "Fri 09:00". */
function clockTime(iso: string, now: number): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return at.toDateString() === new Date(now).toDateString()
    ? `today ${time}`
    : `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

function tickTone(run: WorkspaceRoutineRunDto): string {
  return run.status;
}

/**
 * The Routines page: every routine across the workspaces, each a schedule and
 * a prompt, and the runs they made. A run is a headless session; opening one
 * shows what it did, and Continue makes it a live session.
 */
export function RoutinesHome({
  client,
  workspaces,
  run,
  onOpenSession,
}: {
  client: DesktopClient;
  workspaces: Array<{ id: string; name: string }>;
  /** Sends a request the way the app's other actions do, with its errors. */
  run: <T>(operation: Promise<RpcResult<T>>) => Promise<T | undefined>;
  onOpenSession(sessionId: string): void;
}) {
  const [page, setPage] = useState<RoutinesPageDto>();
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<number>();

  const load = useCallback(async () => {
    try {
      const response = await client.request.routinesPage({});
      if (response.ok) {
        setPage(response.data);
        setError(undefined);
      } else setError(response.error.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client]);

  useEffect(() => {
    void load();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    // Runs start and end on the host's tick, which sends no change for them.
    const poll = setInterval(() => void load(), 4000);
    return () => {
      clearInterval(clock);
      clearInterval(poll);
    };
  }, [load]);

  const act = async <T,>(operation: Promise<RpcResult<T>>) => {
    const result = await run(operation);
    await load();
    return result;
  };

  if (viewing !== undefined)
    return (
      <RunView
        client={client}
        onBack={() => {
          setViewing(undefined);
          void load();
        }}
        onContinue={async () => {
          const session = await act(
            client.request.routineContinue({ runId: viewing }),
          );
          if (session) onOpenSession(session.id);
        }}
        runId={viewing}
      />
    );

  if (!page)
    return (
      <div className="ability-page">
        <p className={error ? "ability-page-error" : "ability-page-empty"}>
          {error ?? "Loading routines…"}
        </p>
      </div>
    );

  const workspaceOf = new Map(
    page.routines.map((item) => [item.id, item.workspaceName]),
  );
  return (
    <div className="workflows-tab">
      <div className="ability-page routines-page routines-home">
        <header className="ability-page-header">
          <div className="ability-page-title">
            <h2>Routines</h2>
            <small>
              A time and a prompt. Each run is a headless Claude session in the
              routine's workspace; open a run to read it or carry on from it.
            </small>
          </div>
          <div className="ability-page-actions">
            <button onClick={() => setAdding(true)} type="button">
              + New
            </button>
          </div>
          {error && <p className="ability-page-error">{error}</p>}
        </header>
        <div className="ability-page-scroll">
          {adding && (
            <RoutineForm
              client={client}
              onCancel={() => setAdding(false)}
              onSave={async (input) => {
                const created = await act(client.request.routineCreate(input));
                if (created) {
                  setAdding(false);
                  setOpen(created.id);
                }
              }}
              workspaces={workspaces}
            />
          )}
          {page.routines.length === 0 && !adding ? (
            <p className="ability-page-empty">
              No routines yet. Add one with + New.
            </p>
          ) : (
            page.routines.length > 0 && (
              <table className="routines-table routines-home-table">
                <thead>
                  <tr>
                    <th aria-label="On" />
                    <th>Routine</th>
                    <th>Workspace</th>
                    <th>Schedule</th>
                    <th>Last 7 runs</th>
                    <th>Last result</th>
                    <th>Next run</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {page.routines.map((routine) => (
                    <RoutineRows
                      key={routine.id}
                      now={now}
                      onDelete={() =>
                        void act(
                          client.request.routineDelete({ id: routine.id }),
                        )
                      }
                      onOpenRun={setViewing}
                      onRunNow={() =>
                        void act(
                          client.request.routineStart({ id: routine.id }),
                        )
                      }
                      onSavePrompt={(prompt) =>
                        act(
                          client.request.routineUpdate({
                            id: routine.id,
                            prompt,
                          }),
                        )
                      }
                      onSetEnabled={(enabled) =>
                        void act(
                          client.request.routineUpdate({
                            id: routine.id,
                            enabled,
                          }),
                        )
                      }
                      onToggle={() =>
                        setOpen(open === routine.id ? undefined : routine.id)
                      }
                      open={open === routine.id}
                      routine={routine}
                    />
                  ))}
                </tbody>
              </table>
            )
          )}
          {page.runs.length > 0 && (
            <section className="ability-page-section">
              <h3>Latest runs</h3>
              <ul className="routine-runs routines-home-runs">
                {page.runs.map((item) => (
                  <li key={item.id}>
                    <button onClick={() => setViewing(item.id)} type="button">
                      <span
                        className="routine-tick"
                        data-tone={tickTone(item)}
                      />
                      <time dateTime={item.startedAt}>
                        {relativeTime(item.startedAt, now)}
                      </time>
                      <strong>{item.routineName}</strong>
                      <span className="routine-row-muted">
                        {workspaceOf.get(item.routineId) ?? "All workspaces"}
                      </span>
                      <span className="routine-run-summary">
                        {item.status === "running"
                          ? "running…"
                          : (item.summary ?? "")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function RoutineRows({
  routine,
  now,
  open,
  onToggle,
  onSetEnabled,
  onRunNow,
  onOpenRun,
  onSavePrompt,
  onDelete,
}: {
  routine: WorkspaceRoutineDto;
  now: number;
  open: boolean;
  onToggle(): void;
  onSetEnabled(enabled: boolean): void;
  onRunNow(): void;
  onOpenRun(runId: number): void;
  onSavePrompt(prompt: string): Promise<unknown>;
  onDelete(): void;
}) {
  const [editing, setEditing] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const running = routine.recentRuns.some((item) => item.status === "running");
  const last = [...routine.recentRuns]
    .reverse()
    .find((item) => item.status !== "running");
  return (
    <>
      <tr
        className="routine-row"
        data-enabled={routine.enabled}
        data-open={open}
      >
        <td>
          <button
            aria-label={routine.enabled ? "Pause" : "Resume"}
            aria-pressed={routine.enabled}
            className="routine-switch"
            onClick={() => onSetEnabled(!routine.enabled)}
            type="button"
          />
        </td>
        <td>
          <button className="routine-row-name" onClick={onToggle} type="button">
            <span aria-hidden="true" className="routine-row-caret">
              ▸
            </span>
            <strong>{routine.name}</strong>
          </button>
        </td>
        <td className="routine-row-workspace">
          {routine.workspaceName ?? "All workspaces"}
        </td>
        <td>
          {routine.scheduleText}
          <small className="routine-row-muted routine-cron">
            {routine.schedule.replace(/^cron\s+/, "")}
          </small>
        </td>
        <td>
          <span className="routine-ticks">
            {routine.recentRuns.map((item) => (
              <button
                aria-label={`${item.status} ${clockTime(item.startedAt, now)}`}
                className="routine-tick"
                data-tone={tickTone(item)}
                key={item.id}
                onClick={() => onOpenRun(item.id)}
                title={`${clockTime(item.startedAt, now)} · ${item.summary ?? item.status}`}
                type="button"
              />
            ))}
          </span>
        </td>
        <td className="routine-row-last">
          {last ? (
            <>
              <span>{last.summary ?? last.status}</span>
              <small className="routine-row-muted">
                {relativeTime(last.finishedAt ?? last.startedAt, now)}
              </small>
            </>
          ) : (
            <span className="routine-row-muted">Not run yet</span>
          )}
        </td>
        <td>
          {running ? (
            <span className="routine-running">running</span>
          ) : !routine.enabled ? (
            <span className="routine-row-muted">paused</span>
          ) : routine.nextRunAt ? (
            <>
              <strong className="routine-next">
                {countdown(routine.nextRunAt, now)}
              </strong>
              <small className="routine-row-muted">
                {clockTime(routine.nextRunAt, now)}
              </small>
            </>
          ) : (
            <span className="routine-row-muted">—</span>
          )}
        </td>
        <td className="routine-row-actions">
          <button disabled={running} onClick={onRunNow} type="button">
            ▶ Run now
          </button>
        </td>
      </tr>
      {open && (
        <tr className="routine-row-detail">
          <td />
          <td colSpan={7}>
            {editing === undefined ? (
              <div className="routine-prompt">
                <pre>{routine.prompt}</pre>
                <div className="routine-prompt-actions">
                  <button
                    className="quiet"
                    onClick={() => setEditing(routine.prompt)}
                    type="button"
                  >
                    Edit
                  </button>
                  {confirmDelete ? (
                    <button className="danger" onClick={onDelete} type="button">
                      Delete {routine.name}?
                    </button>
                  ) : (
                    <button
                      className="quiet"
                      onClick={() => setConfirmDelete(true)}
                      type="button"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <form
                className="routine-prompt"
                onSubmit={async (event) => {
                  event.preventDefault();
                  await onSavePrompt(editing);
                  setEditing(undefined);
                }}
              >
                <textarea
                  aria-label="Prompt"
                  onChange={(event) => setEditing(event.target.value)}
                  rows={10}
                  value={editing}
                />
                <div className="routine-prompt-actions">
                  <button
                    className="quiet"
                    onClick={() => setEditing(undefined)}
                    type="button"
                  >
                    Cancel
                  </button>
                  <button type="submit">Save</button>
                </div>
              </form>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function RoutineForm({
  client,
  workspaces,
  onSave,
  onCancel,
}: {
  client: DesktopClient;
  workspaces: Array<{ id: string; name: string }>;
  onSave(input: {
    workspace: string | null;
    when: string;
    prompt: string;
  }): Promise<void>;
  onCancel(): void;
}) {
  const [when, setWhen] = useState("weekdays 9:00");
  const [workspace, setWorkspace] = useState(workspaces[0]?.id ?? ALL);
  const [prompt, setPrompt] = useState("");
  const [reading, setReading] = useState<{ text?: string; error?: string }>({});
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      void client.request.routineParseWhen({ when }).then((response) => {
        if (!current) return;
        setReading(
          response.ok
            ? {
                text: `${response.data.text} · ${response.data.schedule.replace(/^cron\s+/, "")}`,
              }
            : { error: response.error.message },
        );
      });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [client, when]);
  return (
    <form
      className="routine-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({
          workspace: workspace === ALL ? null : workspace,
          when,
          prompt,
        });
      }}
    >
      <div className="routine-form-row">
        <label>
          <span>When</span>
          <input
            onChange={(event) => setWhen(event.target.value)}
            placeholder="weekdays 9:00"
            value={when}
          />
          <small data-error={Boolean(reading.error)}>
            {reading.error ?? reading.text ?? " "}
          </small>
        </label>
        <label>
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
            <option value={ALL}>All workspaces</option>
          </select>
        </label>
      </div>
      <label>
        <span>Prompt</span>
        <textarea
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="What the agent should do on each run, and what is worth telling you."
          rows={10}
          value={prompt}
        />
      </label>
      <div className="routine-prompt-actions">
        <button className="quiet" onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          disabled={!prompt.trim() || Boolean(reading.error)}
          type="submit"
        >
          Save
        </button>
      </div>
    </form>
  );
}

function RunView({
  client,
  runId,
  onBack,
  onContinue,
}: {
  client: DesktopClient;
  runId: number;
  onBack(): void;
  onContinue(): Promise<void>;
}) {
  const [transcript, setTranscript] = useState<RoutineTranscriptDto>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    const response = await client.request.routineTranscript({ runId });
    if (response.ok) setTranscript(response.data);
    else setError(response.error.message);
  }, [client, runId]);
  const running = transcript?.run.status === "running";
  useEffect(() => {
    void load();
    if (!running && transcript) return;
    const poll = setInterval(() => void load(), 2000);
    return () => clearInterval(poll);
  }, [load, running, transcript]);
  const item = transcript?.run;
  return (
    <div className="workflows-tab">
      <div className="ability-page routine-run-view">
        <header className="ability-page-header">
          <button className="quiet" onClick={onBack} type="button">
            ← Routines
          </button>
          {item && (
            <div className="ability-page-title">
              <h2>
                {item.routineName} · {new Date(item.startedAt).toLocaleString()}
              </h2>
              <small>
                Headless Claude,{" "}
                {item.trigger === "manual" ? "Run now" : "on schedule"} ·{" "}
                {item.status}
                {item.workingDirectory ? ` · in ${item.workingDirectory}` : ""}
              </small>
            </div>
          )}
          {item && item.status !== "running" && item.status !== "skipped" && (
            <div className="ability-page-actions">
              <button onClick={() => void onContinue()} type="button">
                {item.continuedSessionId
                  ? "Open session"
                  : "Continue in session"}
              </button>
            </div>
          )}
          {error && <p className="ability-page-error">{error}</p>}
        </header>
        <div className="ability-page-scroll routine-transcript">
          {transcript?.entries.length === 0 && (
            <p className="ability-page-empty">
              {running
                ? "Starting…"
                : (item?.summary ?? "Nothing was written.")}
            </p>
          )}
          {transcript?.entries.map((entry, index) => (
            <div className="routine-entry" data-kind={entry.kind} key={index}>
              {entry.text}
            </div>
          ))}
          {running && <p className="routine-running">running…</p>}
        </div>
      </div>
    </div>
  );
}
