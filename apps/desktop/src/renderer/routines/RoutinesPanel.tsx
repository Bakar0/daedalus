import { useEffect, useState } from "react";
import type { RoutineDto, RoutinesDetailDto } from "@daedalus/protocol";
import { durationLabel, relativeTime } from "./time";

const OUTPUT_LABEL: Record<RoutineDto["output"], string> = {
  task: "files tasks",
  notify: "notifies",
  none: "silent",
};

function lastRunLabel(routine: RoutineDto, now: number): string {
  const run = routine.lastRun;
  if (!run) return "never run";
  const at = run.finishedAt ?? run.startedAt ?? run.deliveredAt ?? run.queuedAt;
  const what =
    run.status === "done"
      ? (run.outcome ?? "done")
      : run.status === "queued"
        ? "waiting"
        : run.status;
  return `${what} ${relativeTime(at, now)}`;
}

/**
 * The drawer on a session holding routines: what they are for and each
 * routine's schedule and last run. The user changes routines by talking to
 * the session, so the drawer only edits the purpose and runs, enables and
 * disables them.
 */
export function RoutinesPanel({
  sessionName,
  detail,
  error,
  busy,
  now,
  onClose,
  onSavePurpose,
  onRunNow,
  onSetEnabled,
}: {
  sessionName: string;
  detail: RoutinesDetailDto | undefined;
  error: string | undefined;
  busy: boolean;
  now: number;
  onClose: () => void;
  onSavePurpose: (purpose: string) => void;
  onRunNow: (name: string) => void;
  onSetEnabled: (name: string, enabled: boolean) => void;
}) {
  const [purpose, setPurpose] = useState(detail?.purpose ?? "");
  useEffect(() => setPurpose(detail?.purpose ?? ""), [detail?.purpose]);
  const purposeChanged = purpose.trim() !== (detail?.purpose ?? "").trim();

  return (
    <aside
      aria-label={`Routines of ${sessionName}`}
      className="routines-panel"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
      role="dialog"
    >
      <div className="routines-panel-heading">
        <div>
          <span className="eyebrow">{sessionName}</span>
          <h2>Routines</h2>
        </div>
        <button className="quiet" onClick={onClose} type="button">
          Close
        </button>
      </div>
      {error && <p className="routines-panel-error">{error}</p>}
      {!detail && !error && <p className="routines-panel-empty">Loading…</p>}
      {detail && (
        <>
          <form
            className="routines-panel-purpose"
            onSubmit={(event) => {
              event.preventDefault();
              if (purposeChanged) onSavePurpose(purpose.trim());
            }}
          >
            <label>
              <strong>Purpose</strong>
              <small>
                The session judges each finding against this before it files a
                task.
              </small>
              <textarea
                maxLength={2000}
                onChange={(event) => setPurpose(event.target.value)}
                placeholder="What these routines watch for, and what counts as worth a task"
                rows={3}
                value={purpose}
              />
            </label>
            {purposeChanged && (
              <button disabled={busy} type="submit">
                Save purpose
              </button>
            )}
          </form>
          <h3>
            {detail.routines.length === 1
              ? "1 routine"
              : `${detail.routines.length} routines`}
          </h3>
          {detail.routines.length === 0 ? (
            <p className="routines-panel-empty">
              No routines yet. Ask the session to add one, for example "check CI
              on main every 15 minutes".
            </p>
          ) : (
            <ul className="routines-panel-list">
              {detail.routines.map((routine) => (
                <li
                  data-enabled={routine.enabled ? "true" : "false"}
                  data-failing={
                    routine.consecutiveFailures >= 3 ? "true" : undefined
                  }
                  key={routine.name}
                >
                  <div className="routine-row-head">
                    <strong>{routine.name}</strong>
                    <code>{routine.schedule}</code>
                  </div>
                  <small className="routine-row-meta">
                    {routine.enabled
                      ? routine.nextRunAt
                        ? `next ${relativeTime(routine.nextRunAt, now)}`
                        : "not scheduled"
                      : "disabled"}
                    {" · "}
                    {lastRunLabel(routine, now)}
                    {" · "}
                    {OUTPUT_LABEL[routine.output]}
                    {routine.model ? ` · ${routine.model}` : ""}
                    {` · ${durationLabel(routine.timeoutMs)} limit`}
                    {routine.until
                      ? ` · until ${new Date(routine.until).toLocaleDateString()}`
                      : ""}
                  </small>
                  {routine.consecutiveFailures > 0 && (
                    <small className="routine-row-failures">
                      {routine.consecutiveFailures === 1
                        ? "Last run failed"
                        : `${routine.consecutiveFailures} failures in a row`}
                      {routine.lastRun?.summary
                        ? `: ${routine.lastRun.summary}`
                        : ""}
                    </small>
                  )}
                  <span className="routine-row-actions">
                    <button
                      className="quiet"
                      disabled={busy || !routine.enabled}
                      onClick={() => onRunNow(routine.name)}
                      type="button"
                    >
                      Run now
                    </button>
                    <button
                      className="quiet"
                      disabled={busy}
                      onClick={() =>
                        onSetEnabled(routine.name, !routine.enabled)
                      }
                      type="button"
                    >
                      {routine.enabled ? "Disable" : "Enable"}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {detail.templates.length > 0 && (
            <>
              <h3>Templates</h3>
              <ul className="routines-panel-list routines-panel-templates">
                {detail.templates.map((template) => (
                  <li key={template.name}>
                    <div className="routine-row-head">
                      <strong>{template.name}</strong>
                      <code>{template.schedule}</code>
                    </div>
                    <small className="routine-row-meta">
                      Ask the session to use this template to add it.
                    </small>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </aside>
  );
}
