import { useCallback, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ResidentDetailDto,
  ResidentMemoryFileDto,
  ResidentOverviewDto,
  RoutineDto,
  RoutineRunDto,
} from "@daedalus/protocol";
import type { DesktopClient } from "../client-types";
import { ResidentLamp, residentStatusLine } from "./ResidentsNav";
import { durationLabel, relativeTime } from "./time";

export type ResidentTab = "routines" | "runs" | "memory";

const TABS: Array<{ id: ResidentTab; label: string }> = [
  { id: "routines", label: "Routines" },
  { id: "runs", label: "Runs" },
  { id: "memory", label: "Memory" },
];

function runOutcome(run: RoutineRunDto): string {
  if (run.status === "done") return run.outcome ?? "done";
  return run.status;
}

function runTone(run: RoutineRunDto): string {
  if (run.status === "failed") return "bad";
  if (run.status === "skipped") return "muted";
  if (run.status === "queued" || run.status === "running") return "live";
  return run.outcome === "quiet" ? "quiet" : "loud";
}

function RunStatus({ run }: { run: RoutineRunDto }) {
  return (
    <span className={`run-status tone-${runTone(run)}`}>{runOutcome(run)}</span>
  );
}

/**
 * The Routines tab of a resident's workspace: what it runs on its own, what
 * it did, and what it remembers. Its findings are on the Board and its
 * session is pinned in Sessions, like any workspace's. Kept out of
 * `WorkspaceApp` on purpose; it loads its own data.
 */
export function ResidentPage({
  client,
  resident,
  tab,
  onTab,
  dataRevision,
  now,
  busy,
  onError,
  onChanged,
}: {
  client: DesktopClient;
  resident: ResidentOverviewDto;
  tab: ResidentTab;
  onTab: (tab: ResidentTab) => void;
  /** Bumped by the app on every data change, so the page reloads with it. */
  dataRevision: number;
  now: number;
  busy: boolean;
  onError: (message: string) => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<ResidentDetailDto>();
  const [memory, setMemory] = useState<ResidentMemoryFileDto[]>();
  const [memoryFile, setMemoryFile] = useState<string>();
  const [working, setWorking] = useState(false);
  /** What the last Run now did, per routine, until the run moves on. */
  const [runNotices, setRunNotices] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    void client.request
      .residentDetail({ reference: resident.id })
      .then((response) => {
        if (cancelled) return;
        if (response.ok) setDetail(response.data);
        else onError(response.error.message);
      });
    return () => {
      cancelled = true;
    };
    // Not on `onError`: it is a fresh closure on every render, and reloading
    // on it would fetch on every keystroke anywhere in the app.
  }, [client, resident.id, dataRevision]);

  useEffect(() => {
    if (tab !== "memory") return;
    let cancelled = false;
    void client.request
      .residentMemory({ reference: resident.id })
      .then((response) => {
        if (cancelled) return;
        if (response.ok) {
          setMemory(response.data);
          setMemoryFile((current) =>
            current && response.data.some((file) => file.path === current)
              ? current
              : response.data[0]?.path,
          );
        } else onError(response.error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [client, resident.id, tab, dataRevision]);

  const act = useCallback(
    async <T,>(
      request: Promise<
        { ok: true; data: T } | { ok: false; error: { message: string } }
      >,
    ) => {
      setWorking(true);
      try {
        const response = await request;
        if (!response.ok) onError(response.error.message);
        else onChanged();
      } finally {
        setWorking(false);
      }
    },
    [onChanged, onError],
  );

  const disabled = busy || working;
  const control = (action: "start" | "stop" | "pause" | "resume") =>
    void act(
      client.request.residentControl({ reference: resident.id, action }),
    );

  const routines = detail?.routines ?? [];
  const runs = detail?.runs ?? [];
  const selectedMemory = memory?.find((file) => file.path === memoryFile);

  return (
    <div className="resident-page">
      <header className="resident-header">
        <div className="resident-title">
          <ResidentLamp resident={resident} />
          <div>
            <span className="eyebrow">Resident</span>
            <h1>{resident.name}</h1>
            <small>{residentStatusLine(resident, now)}</small>
          </div>
        </div>
        <div className="resident-controls">
          {resident.state === "stopped" ? (
            <button disabled={disabled} onClick={() => control("start")}>
              Start
            </button>
          ) : resident.state === "paused" ? (
            <button disabled={disabled} onClick={() => control("resume")}>
              Resume
            </button>
          ) : (
            <button
              className="quiet"
              disabled={disabled}
              onClick={() => control("pause")}
              title="Keep the session, deliver no routines"
            >
              Pause
            </button>
          )}
          {resident.state !== "stopped" && (
            <button
              className="quiet"
              disabled={disabled}
              onClick={() => control("stop")}
              title="Archive the session; routines, tasks and memory stay"
            >
              Stop
            </button>
          )}
        </div>
      </header>

      <p className="resident-explainer">
        {resident.name} runs these routines on its own. What needs you appears
        on the Board as a task; start an agent on it there. To change what{" "}
        {resident.name} watches, tell it in its session, pinned at the top of
        Sessions.
      </p>

      {resident.runsQueued > 0 && resident.deliveryHold && (
        <div className="resident-hold" role="status">
          <strong>
            {resident.runsQueued}{" "}
            {resident.runsQueued === 1 ? "run is" : "runs are"} waiting
          </strong>
          <span>
            {resident.deliveryHold}. Daedalus types the next routine in once
            this clears.
          </span>
        </div>
      )}

      <nav aria-label={`${resident.name} views`} className="resident-tabs">
        {TABS.map((item) => (
          <button
            aria-current={tab === item.id ? "page" : undefined}
            className={`quiet ${tab === item.id ? "active" : ""}`}
            key={item.id}
            onClick={() => onTab(item.id)}
          >
            {item.label}
            {item.id === "routines" && resident.routineErrors > 0 && (
              <span className="resident-tab-count bad">
                {resident.routineErrors}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className={`resident-body resident-body-${tab}`}>
        {tab === "routines" && (
          <RoutinesTable
            detail={detail}
            disabled={disabled}
            now={now}
            onRunNow={async (routine) => {
              setWorking(true);
              try {
                const response = await client.request.routineRunNow({
                  resident: resident.id,
                  name: routine.name,
                });
                setRunNotices((current) => ({
                  ...current,
                  [routine.name]: response.ok
                    ? response.data.alreadyQueued
                      ? `Already queued as run ${response.data.id}`
                      : `Queued as run ${response.data.id}`
                    : response.error.message,
                }));
                if (response.ok) onChanged();
              } finally {
                setWorking(false);
              }
            }}
            runNotices={runNotices}
            hold={resident.runsQueued > 0 ? resident.deliveryHold : null}
            onToggle={(routine) =>
              void act(
                client.request.routineSetEnabled({
                  resident: resident.id,
                  name: routine.name,
                  enabled: !routine.enabled,
                }),
              )
            }
            routines={routines}
          />
        )}
        {tab === "runs" && <RunsTable now={now} runs={runs} />}
        {tab === "memory" && (
          <div className="resident-memory">
            <nav aria-label="Memory files" className="resident-memory-files">
              {!memory && <div className="empty">Loading…</div>}
              {memory?.length === 0 && (
                <div className="empty">Nothing written yet.</div>
              )}
              {(["workspace", "memory"] as const).map((source) => {
                const files = (memory ?? []).filter(
                  (file) => file.source === source,
                );
                if (files.length === 0) return null;
                return (
                  <div key={source}>
                    <span className="eyebrow">
                      {source === "workspace" ? "Workspace" : "Memory"}
                    </span>
                    {files.map((file) => (
                      <button
                        className={`quiet ${file.path === memoryFile ? "active" : ""}`}
                        key={file.path}
                        onClick={() => setMemoryFile(file.path)}
                        title={file.path}
                      >
                        {file.name}
                      </button>
                    ))}
                  </div>
                );
              })}
            </nav>
            <article className="resident-memory-content markdown-body">
              {selectedMemory ? (
                <>
                  <Markdown remarkPlugins={[remarkGfm]}>
                    {selectedMemory.content}
                  </Markdown>
                  {selectedMemory.truncated && (
                    <p className="muted">Shortened; the file is longer.</p>
                  )}
                </>
              ) : null}
            </article>
          </div>
        )}
      </div>
    </div>
  );
}

function RoutinesTable({
  routines,
  detail,
  disabled,
  now,
  onToggle,
  onRunNow,
  runNotices,
  hold,
}: {
  routines: RoutineDto[];
  detail?: ResidentDetailDto;
  disabled: boolean;
  now: number;
  onToggle: (routine: RoutineDto) => void;
  onRunNow: (routine: RoutineDto) => void;
  runNotices: Record<string, string>;
  /** Why queued runs are waiting, if they are. */
  hold: string | null;
}) {
  if (!detail) return <div className="empty">Loading routines…</div>;
  return (
    <div className="resident-table-wrap">
      {detail.errors.map((error) => (
        <div className="resident-routine-error" key={error.path}>
          <strong>{error.name}</strong>
          <span>{error.error}</span>
          <small>{error.path}</small>
        </div>
      ))}
      {routines.length === 0 && detail.errors.length === 0 ? (
        <div className="empty large">
          <strong>No routines yet</strong>
          <span>
            The resident writes them during setup, or when you ask it.
          </span>
        </div>
      ) : (
        <table className="resident-table">
          <thead>
            <tr>
              <th>Routine</th>
              <th>Schedule</th>
              <th>Next</th>
              <th>Last</th>
              <th>Findings</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {routines.map((routine) => (
              <tr className={routine.enabled ? "" : "off"} key={routine.name}>
                <td>
                  <strong>{routine.name}</strong>
                  {routine.model && <small>{routine.model}</small>}
                  {routine.consecutiveFailures > 1 && (
                    <small className="bad">
                      failed {routine.consecutiveFailures}× in a row
                    </small>
                  )}
                </td>
                <td>
                  {routine.schedule}
                  {routine.until && (
                    <small>until {relativeTime(routine.until, now)}</small>
                  )}
                </td>
                <td>
                  {routine.enabled
                    ? relativeTime(routine.nextRunAt, now)
                    : "off"}
                </td>
                <td>
                  {routine.lastRun ? (
                    <>
                      <RunStatus run={routine.lastRun} />{" "}
                      <small>
                        {relativeTime(routine.lastRun.queuedAt, now)}
                      </small>
                    </>
                  ) : (
                    <small>never</small>
                  )}
                </td>
                <td>{routine.findings}</td>
                <td>
                  <div className="resident-row-actions">
                    <button
                      className="quiet"
                      disabled={disabled}
                      onClick={() => onRunNow(routine)}
                    >
                      Run now
                    </button>
                    <label className="resident-switch">
                      <input
                        checked={routine.enabled}
                        disabled={disabled}
                        onChange={() => onToggle(routine)}
                        type="checkbox"
                      />
                      <span>{routine.enabled ? "On" : "Off"}</span>
                    </label>
                  </div>
                  <RunNotice
                    hold={hold}
                    notice={runNotices[routine.name]}
                    routine={routine}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RunsTable({ runs, now }: { runs: RoutineRunDto[]; now: number }) {
  if (runs.length === 0)
    return (
      <div className="empty large">
        <strong>No runs yet</strong>
        <span>Runs appear here once a routine is due.</span>
      </div>
    );
  return (
    <div className="resident-table-wrap">
      <table className="resident-table">
        <thead>
          <tr>
            <th>Run</th>
            <th>Routine</th>
            <th>When</th>
            <th>Took</th>
            <th>Result</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td className="numeric">{run.id}</td>
              <td>{run.routine}</td>
              <td>
                {relativeTime(run.queuedAt, now)}
                {run.missedMs > 0 && (
                  <small>{durationLabel(run.missedMs)} late</small>
                )}
              </td>
              <td className="numeric">
                {run.startedAt && run.finishedAt
                  ? durationLabel(
                      Date.parse(run.finishedAt) - Date.parse(run.startedAt),
                    )
                  : "—"}
              </td>
              <td>
                <RunStatus run={run} />
              </td>
              <td className="resident-run-summary">{run.summary ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Says what Run now did and what happens next: queued and starting, queued
 * and waiting (with the reason), or running. Without it a click that queues
 * a run behind something looks like a click that did nothing.
 */
function RunNotice({
  routine,
  notice,
  hold,
}: {
  routine: RoutineDto;
  notice?: string;
  hold: string | null;
}) {
  const status = routine.lastRun?.status;
  if (status === "running")
    return <small className="resident-run-notice live">Running now</small>;
  if (status !== "queued") return null;
  return (
    <small className="resident-run-notice">
      {notice ?? `Queued as run ${routine.lastRun!.id}`} ·{" "}
      {hold ? `waiting: ${hold}` : "starts within seconds"}
    </small>
  );
}
