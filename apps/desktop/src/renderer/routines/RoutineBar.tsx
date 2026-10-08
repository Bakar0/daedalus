import { useEffect, useState } from "react";
import type { RoutinesStatusDto, SessionColorDto } from "@daedalus/protocol";
import { relativeTime } from "./time";

/** "0:40", "1:20": minutes and seconds, for the typing countdown. */
export function clockLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The short form of each hold, after "N waiting · ". */
const HOLD_LABEL: Record<
  NonNullable<RoutinesStatusDto["hold"]>["reason"],
  string
> = {
  paused: "paused",
  stopped: "session not running",
  handoff: "handoff pending",
  typing: "you typed",
  busy: "session busy",
  "waiting-on-user": "session waiting for an answer",
  "input-text": "input box has text",
  "in-flight-limit": "runs in flight",
  "skill-missing": "routine skill missing",
};

/**
 * What the bar says. With nothing waiting it names the next run. With runs
 * waiting it says why they are not going in; for typing it counts down to
 * the end of the quiet time, which the host computes from the last keystroke.
 */
export function routineBarText(status: RoutinesStatusDto, now: number): string {
  const waiting = status.waiting.length;
  if (waiting === 0) {
    if (status.paused) return "Routines · paused";
    const running = status.running > 0 ? ` · ${status.running} running` : "";
    return status.nextRun
      ? `Routines · next: ${status.nextRun.routine} ${relativeTime(status.nextRun.at, now)}${running}`
      : `Routines · nothing scheduled${running}`;
  }
  const head = `${waiting} waiting`;
  const hold = status.hold;
  if (!hold) return `${head} · going in`;
  if (hold.reason === "typing" && hold.until) {
    const until = Date.parse(hold.until);
    const typedAt = status.lastKeystrokeAt
      ? Date.parse(status.lastKeystrokeAt)
      : undefined;
    const typed =
      typedAt !== undefined
        ? `you typed ${clockLabel(now - typedAt)} ago`
        : "you typed";
    return until > now
      ? `${head} · ${typed} · resumes in ${clockLabel(until - now)}`
      : `${head} · resuming`;
  }
  if (hold.reason === "in-flight-limit")
    return `${head} · ${status.running} ${status.running === 1 ? "run" : "runs"} in flight`;
  if (hold.reason === "skill-missing") return `${head} · ${hold.text}`;
  return `${head} · ${HOLD_LABEL[hold.reason]}`;
}

/**
 * The bar above the terminal of a session holding routines. It says why runs
 * are or are not going in, so a user whose typing is holding them can see it.
 */
export function RoutineBar({
  status,
  color,
  busy,
  onRunNow,
  onTogglePause,
  onOpenPanel,
}: {
  status: RoutinesStatusDto;
  /** The session's color, for the bar's edge. */
  color: SessionColorDto | null;
  busy: boolean;
  onRunNow: () => void;
  onTogglePause: () => void;
  onOpenPanel: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  // A second's tick while the typing countdown shows; the next run's "in 4m"
  // only needs the slower one.
  const counting = status.hold?.reason === "typing";
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(
      () => setNow(Date.now()),
      counting ? 1_000 : 15_000,
    );
    return () => clearInterval(timer);
  }, [counting, status]);
  const [notice, setNotice] = useState<string>();
  useEffect(() => setNotice(undefined), [status.waiting.length]);
  const waiting = status.waiting.length;
  const held = waiting > 0 && status.hold !== null;

  return (
    <section
      aria-label="Routines"
      className="routine-bar"
      data-color={color ?? undefined}
      data-held={held ? "true" : undefined}
      data-paused={status.paused ? "true" : undefined}
    >
      <div className="routine-bar-row">
        <span aria-live="polite" className="routine-bar-text">
          {routineBarText(status, now)}
        </span>
        {notice && <span className="routine-bar-notice">{notice}</span>}
        <span className="routine-bar-actions">
          {waiting > 0 && !status.paused && (
            <button
              className="quiet"
              disabled={busy}
              onClick={() => {
                // Run now skips only the quiet time after typing. Text in the
                // input box still holds the run, so say that here rather than
                // look like the button did nothing.
                if (status.hold?.reason === "input-text")
                  setNotice("Clear the input box first");
                else if (status.hold?.reason === "busy")
                  setNotice("Goes in when the session is idle");
                onRunNow();
              }}
              title="Type the oldest waiting run in now, without the 2-minute wait after typing"
              type="button"
            >
              Run now
            </button>
          )}
          <button
            className="quiet"
            disabled={busy}
            onClick={onTogglePause}
            type="button"
          >
            {status.paused ? "Resume" : "Pause"}
          </button>
          <button
            className="quiet"
            data-panel-toggle
            onClick={onOpenPanel}
            type="button"
          >
            Routines
          </button>
        </span>
      </div>
      {waiting > 0 && (
        <details className="routine-bar-waiting">
          <summary>
            {waiting === 1 ? "1 run waiting" : `${waiting} runs waiting`}
          </summary>
          <ul>
            {status.waiting.map((run) => (
              <li key={run.runId}>
                <strong>{run.routine}</strong>
                <small>due {relativeTime(run.queuedAt, now)}</small>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
