import { useCallback, useEffect, useState } from "react";
import type {
  RoutineDto,
  RoutineRunDto,
  RoutinesDetailDto,
  RoutinesStatusDto,
  RpcResult,
} from "@daedalus/protocol";
import type { DesktopClient } from "../client-types";
import { DOCS_URL, TabIntro } from "../FileEditorParts";
import { durationLabel, relativeTime } from "./time";

const OUTPUT_LABEL: Record<RoutineDto["output"], string> = {
  task: "Files tasks",
  notify: "Notifies",
  none: "Silent",
};

/** How many finished runs the tab lists. */
const RECENT_RUNS = 8;

/** `every 15m` as "Every 15 min"; a cron or `at` schedule as written. */
export function scheduleLabel(schedule: string): string {
  const every = /^every\s+(\d+)\s*([mhd])$/i.exec(schedule.trim());
  if (!every) return schedule;
  const count = Number(every[1]);
  const unit = { m: "min", h: "hour", d: "day" }[
    every[2]!.toLowerCase() as "m" | "h" | "d"
  ];
  if (count === 1) return `Every ${unit}`;
  return `Every ${count} ${unit === "min" ? "min" : `${unit}s`}`;
}

/** What a run came to, as a chip: its words and its tone. */
function runChip(run: RoutineRunDto): {
  text: string;
  tone: "good" | "bad" | "busy" | "plain";
} {
  switch (run.status) {
    case "queued":
      return { text: "waiting", tone: "busy" };
    case "running":
      return { text: "running", tone: "busy" };
    case "failed":
      return { text: "failed", tone: "bad" };
    case "skipped":
      return { text: "skipped", tone: "plain" };
    case "done":
      return run.outcome === "task"
        ? { text: "filed a task", tone: "good" }
        : run.outcome === "notified"
          ? { text: "notified", tone: "good" }
          : { text: "quiet", tone: "plain" };
  }
}

const runAt = (run: RoutineRunDto) =>
  run.finishedAt ?? run.startedAt ?? run.deliveredAt ?? run.queuedAt;

function RunChip({ run }: { run: RoutineRunDto }) {
  const chip = runChip(run);
  return (
    <span className="routine-chip" data-tone={chip.tone}>
      {chip.text}
    </span>
  );
}

/**
 * One routine as a table row. The row opens to show its prompt and limits;
 * a routine that keeps failing says why under its name.
 */
function RoutineRow({
  routine,
  busy,
  now,
  onRunNow,
  onSetEnabled,
}: {
  routine: RoutineDto;
  busy: boolean;
  now: number;
  onRunNow: () => void;
  onSetEnabled: (enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr
        className="routine-row"
        data-enabled={routine.enabled ? "true" : "false"}
        data-failing={routine.consecutiveFailures >= 3 ? "true" : undefined}
        data-open={open ? "true" : undefined}
      >
        <td>
          <button
            aria-expanded={open}
            className="routine-row-name"
            onClick={() => setOpen((value) => !value)}
            type="button"
          >
            <span aria-hidden="true" className="routine-row-caret">
              ›
            </span>
            <strong>{routine.name}</strong>
          </button>
          {routine.consecutiveFailures > 0 && (
            <small className="routine-row-failures">
              {routine.consecutiveFailures === 1
                ? "Last run failed"
                : `${routine.consecutiveFailures} failures in a row`}
              {routine.lastRun?.summary ? `: ${routine.lastRun.summary}` : ""}
            </small>
          )}
        </td>
        <td title={routine.schedule}>{scheduleLabel(routine.schedule)}</td>
        <td>
          {!routine.enabled
            ? "Disabled"
            : routine.nextRunAt
              ? relativeTime(routine.nextRunAt, now)
              : "Not scheduled"}
        </td>
        <td>
          {routine.lastRun ? (
            <span className="routine-row-last">
              <RunChip run={routine.lastRun} />
              {relativeTime(runAt(routine.lastRun), now)}
            </span>
          ) : (
            <span className="routine-row-muted">Never run</span>
          )}
        </td>
        <td>{OUTPUT_LABEL[routine.output]}</td>
        <td className="routine-row-actions">
          <button
            className="quiet"
            disabled={busy || !routine.enabled}
            onClick={onRunNow}
            type="button"
          >
            Run now
          </button>
          <button
            className="quiet"
            disabled={busy}
            onClick={() => onSetEnabled(!routine.enabled)}
            type="button"
          >
            {routine.enabled ? "Disable" : "Enable"}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="routine-row-detail">
          <td colSpan={6}>
            <p>
              Time limit {durationLabel(routine.timeoutMs)}
              {routine.model ? ` · model ${routine.model}` : ""}
              {routine.until
                ? ` · until ${new Date(routine.until).toLocaleDateString()}`
                : ""}
              {` · schedule ${routine.schedule}`}
            </p>
            <pre>{routine.prompt.trim()}</pre>
          </td>
        </tr>
      )}
    </>
  );
}

/** A template as a row: its name, schedule, and prompt when opened. */
function TemplateRow({ template }: { template: RoutineDto }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="routine-row" data-open={open ? "true" : undefined}>
        <td>
          <button
            aria-expanded={open}
            className="routine-row-name"
            onClick={() => setOpen((value) => !value)}
            type="button"
          >
            <span aria-hidden="true" className="routine-row-caret">
              ›
            </span>
            <strong>{template.name}</strong>
          </button>
        </td>
        <td title={template.schedule}>{scheduleLabel(template.schedule)}</td>
        <td>{OUTPUT_LABEL[template.output]}</td>
      </tr>
      {open && (
        <tr className="routine-row-detail">
          <td colSpan={3}>
            <pre>{template.prompt.trim()}</pre>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The Routines tab of a session. It reads the detail itself, and again
 * whenever the session's routine status moves, and reads it again after
 * each action.
 */
export function RoutinesPage({
  client,
  sessionId,
  sessionName,
  status,
  busy,
  now,
  run,
}: {
  client: DesktopClient;
  sessionId: string;
  sessionName: string;
  /** The session's routine status from the snapshot, which moves on its own. */
  status: RoutinesStatusDto | undefined;
  busy: boolean;
  now: number;
  /** Sends a request the way the app's other actions do, with its errors. */
  run: <T>(operation: Promise<RpcResult<T>>) => Promise<T | undefined>;
}) {
  const [detail, setDetail] = useState<RoutinesDetailDto>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      const response = await client.request.routinesDetail({ sessionId });
      if (response.ok) {
        setDetail(response.data);
        setError(undefined);
      } else setError(response.error.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client, sessionId]);
  // A run went in, finished or was queued: read again.
  const fingerprint = status
    ? JSON.stringify([
        status.waiting.map((item) => item.runId),
        status.running,
        status.paused,
        status.nextRun,
        status.routines,
      ])
    : undefined;
  useEffect(() => {
    void load();
  }, [load, fingerprint]);

  const act = async <T,>(operation: Promise<RpcResult<T>>) => {
    const result = await run(operation);
    await load();
    return result;
  };

  return (
    <RoutinesView
      actions={{
        runNow: (name) =>
          void act(client.request.routineRunNow({ sessionId, name })),
        setEnabled: (name, enabled) =>
          void act(
            client.request.routineSetEnabled({ sessionId, name, enabled }),
          ),
        savePurpose: (purpose) =>
          void act(client.request.routinesPurpose({ sessionId, purpose })),
        togglePause: (paused) =>
          void act(
            client.request.routinesControl({
              sessionId,
              action: paused ? "resume" : "pause",
            }),
          ),
        readMore: () =>
          void client.request.openExternal({
            url: `${DOCS_URL}/abilities.md#routines`,
          }),
      }}
      busy={busy}
      detail={detail}
      error={error}
      now={now}
      sessionId={sessionId}
      sessionName={sessionName}
      status={status}
    />
  );
}

export interface RoutinesActions {
  runNow(name: string): void;
  setEnabled(name: string, enabled: boolean): void;
  savePurpose(purpose: string): void;
  /** Pauses the session's routines, or resumes them when `paused`. */
  togglePause(paused: boolean): void;
  /** Opens the routines docs. */
  readMore(): void;
}

/**
 * What the Routines tab shows: what the routines are for, each routine as a
 * card, the runs that finished lately and the templates the session can use.
 * The user changes routines by talking to the session, so the tab only edits
 * the purpose and runs, enables, disables and pauses them.
 */
export function RoutinesView({
  sessionId,
  sessionName,
  detail,
  error,
  status,
  busy,
  now,
  actions,
}: {
  sessionId: string;
  sessionName: string;
  detail: RoutinesDetailDto | undefined;
  error: string | undefined;
  status: RoutinesStatusDto | undefined;
  busy: boolean;
  now: number;
  actions: RoutinesActions;
}) {
  const [purpose, setPurpose] = useState(detail?.purpose ?? "");
  useEffect(() => setPurpose(detail?.purpose ?? ""), [detail?.purpose]);
  const purposeChanged = purpose.trim() !== (detail?.purpose ?? "").trim();

  if (!detail)
    return (
      <div className="ability-page">
        <p className={error ? "ability-page-error" : "ability-page-empty"}>
          {error ?? "Loading routines…"}
        </p>
      </div>
    );

  const enabled = detail.routines.filter((routine) => routine.enabled).length;
  const finished = detail.runs
    .filter((item) => item.status !== "queued" && item.status !== "running")
    .slice(0, RECENT_RUNS);

  return (
    <div className="workflows-tab">
      {/* The session is told nothing, so this is how the user learns. */}
      <TabIntro onReadMore={actions.readMore}>
        Routines are checks this session runs on a schedule; it files a task or
        tells you when one finds something. Add or change one by asking the
        session in plain words, like "check CI on main every 15 minutes".
      </TabIntro>
      <div className="ability-page routines-page">
        <header className="ability-page-header">
          <div className="ability-page-title">
            <span className="eyebrow">{sessionName}</span>
            <h2>Routines</h2>
            <small>
              {detail.routines.length === 0
                ? "No routines yet"
                : `${enabled} of ${detail.routines.length} on`}
              {status?.paused ? " · paused" : ""}
              {status && status.waiting.length > 0
                ? ` · ${status.waiting.length} waiting`
                : ""}
              {status?.hold ? ` · held: ${status.hold.text}` : ""}
            </small>
          </div>
          {status && (
            <div className="ability-page-actions">
              <button
                className="quiet"
                disabled={busy}
                onClick={() => actions.togglePause(status.paused)}
                type="button"
              >
                {status.paused ? "Resume" : "Pause all"}
              </button>
            </div>
          )}
          {error && <p className="ability-page-error">{error}</p>}
        </header>
        <form
          className="ability-page-field"
          onSubmit={(event) => {
            event.preventDefault();
            if (purposeChanged) actions.savePurpose(purpose.trim());
          }}
        >
          <label htmlFor={`routines-purpose-${sessionId}`}>Purpose</label>
          <textarea
            id={`routines-purpose-${sessionId}`}
            maxLength={2000}
            onChange={(event) => setPurpose(event.target.value)}
            placeholder="What these routines watch for, and what counts as worth a task. The session judges each finding against it."
            rows={2}
            value={purpose}
          />
          {purposeChanged && (
            <div className="ability-page-field-actions">
              <button
                className="quiet"
                onClick={() => setPurpose(detail.purpose ?? "")}
                type="button"
              >
                Cancel
              </button>
              <button disabled={busy} type="submit">
                Save purpose
              </button>
            </div>
          )}
        </form>
        <div className="ability-page-scroll">
          {detail.routines.length === 0 ? (
            <p className="ability-page-empty">No routines yet.</p>
          ) : (
            <table className="routines-table">
              <thead>
                <tr>
                  <th>Routine</th>
                  <th>Schedule</th>
                  <th>Next</th>
                  <th>Last run</th>
                  <th>Output</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {detail.routines.map((routine) => (
                  <RoutineRow
                    busy={busy}
                    key={routine.name}
                    now={now}
                    onRunNow={() => actions.runNow(routine.name)}
                    onSetEnabled={(value) =>
                      actions.setEnabled(routine.name, value)
                    }
                    routine={routine}
                  />
                ))}
              </tbody>
            </table>
          )}
          {finished.length > 0 && (
            <section className="ability-page-section">
              <h3>Recent runs</h3>
              <ul className="routine-runs">
                {finished.map((item) => (
                  <li key={item.id}>
                    <RunChip run={item} />
                    <strong>{item.routine}</strong>
                    <span className="routine-run-summary">
                      {item.summary ?? ""}
                    </span>
                    <time dateTime={runAt(item)}>
                      {relativeTime(runAt(item), now)}
                    </time>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {detail.templates.length > 0 && (
            <section className="ability-page-section">
              <h3>Templates</h3>
              <p className="ability-page-hint">
                Ask the session to use one of these to add a routine.
              </p>
              <table className="routines-table">
                <thead>
                  <tr>
                    <th>Template</th>
                    <th>Schedule</th>
                    <th>Output</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.templates.map((template) => (
                    <TemplateRow key={template.name} template={template} />
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
