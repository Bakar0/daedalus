/**
 * The focused session's workflow, under the side panel's tabs: one row per
 * step, a check when it is done and a spinner on the step the agent is in.
 * The agent reports the steps; the user only approves a gated one, and
 * resizes or folds the pane.
 */
import { useRef, useState, type KeyboardEvent } from "react";
import type { WorkflowRunDto, WorkflowStepStateDto } from "@daedalus/protocol";
import { timelineWhen } from "./TaskTimeline";

const STATE_LABEL: Record<WorkflowStepStateDto, string> = {
  pending: "not started",
  waiting: "waits for your approval",
  active: "in progress",
  done: "done",
  skipped: "skipped",
};

/** The workflow mark, shared with the Workflows tab in the editor. */
export const WORKFLOW_ICON_PATH =
  "M4 2.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM4 5.5v5M4 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM12 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM5.5 4h3a2 2 0 0 1 2 2v.5M5.5 12h3a2 2 0 0 0 2-2v-.5";

/** A page of rules: the custom instructions, in their pane and their tab. */
export const INSTRUCTIONS_ICON_PATH =
  "M4 2.5h5.5L12 5v8.5H4zM9.5 2.5V5H12M6 7.5h4M6 9.5h4M6 11.5h2.5";

export function WorkflowIcon() {
  return (
    <svg
      aria-hidden="true"
      className="workflow-icon"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 16 16"
    >
      <path d={WORKFLOW_ICON_PATH} />
    </svg>
  );
}

const HEIGHT_KEY = "daedalus.workflowPane.height";
const FOLDED_KEY = "daedalus.workflowPane.folded";
const MIN_HEIGHT = 96;
const DEFAULT_HEIGHT = 260;

const remembered = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const remember = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A pane that forgets its size is a preference lost, not a bug.
  }
};

/** Today's steps by the clock alone; the pane is narrow. */
function stepTime(iso: string | null, now = new Date()): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toDateString() === now.toDateString()
    ? `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
    : timelineWhen(iso);
}

/**
 * The line under a step, in the agent's words for this work: what it will
 * do there until the step ends, then what came out.
 */
function stepLine(step: WorkflowRunDto["steps"][number]): string | null {
  const finished = step.state === "done" || step.state === "skipped";
  if (finished) return step.note ?? step.plan;
  return step.plan ?? (step.dynamic ? step.description : null);
}

/**
 * Opening a cut-off line in place: one row at a time, by clicking the row.
 * A hover tooltip takes a second to appear; a click does not.
 */
function useOpenRow() {
  const [opened, setOpened] = useState<string | null>(null);
  return (key: string, line: string | null) =>
    line
      ? {
          "aria-expanded": opened === key,
          onClick: () => setOpened((value) => (value === key ? null : key)),
          onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            setOpened((value) => (value === key ? null : key));
          },
          tabIndex: 0,
          open: opened === key,
        }
      : { open: false };
}

const rowClass = (base: string, open: boolean, line: string | null) =>
  `${base}${line ? " has-note" : ""}${open ? " open" : ""}`;

function StepMark({ state }: { state: WorkflowStepStateDto }) {
  if (state === "active")
    return <span aria-hidden="true" className="workflow-mark spinning" />;
  return (
    <span aria-hidden="true" className={`workflow-mark state-${state}`}>
      {state === "done"
        ? "✓"
        : state === "skipped"
          ? "–"
          : state === "waiting"
            ? "‖"
            : ""}
    </span>
  );
}

/** Dynamic, changed for this run, and which time round a loop is on. */
function RunTags({ run }: { run: WorkflowRunDto }) {
  return (
    <>
      {run.dynamic && (
        <span className="workflow-tag" title="Assembled for this work only">
          dynamic
        </span>
      )}
      {run.modified && (
        <span
          className="workflow-tag"
          title="Steps were added or removed for this run; the workflow file is unchanged"
        >
          changed
        </span>
      )}
      {run.loopTo && (
        <span
          className="workflow-tag"
          title={`Goes back to ${run.loopTo} after its last step${run.until ? `, until: ${run.until}` : ""}`}
        >
          ↻ {run.iteration}
        </span>
      )}
      {run.endedAt &&
        (run.steps.every(
          (step) => step.state === "done" || step.state === "skipped",
        ) ? (
          <span className="workflow-tag" title="Every step is finished">
            done
          </span>
        ) : (
          <span
            className="workflow-tag"
            title="Ended before all of its steps were finished"
          >
            stopped
          </span>
        ))}
    </>
  );
}

export function WorkflowSteps({
  busy,
  onApprove,
  run,
}: {
  busy: boolean;
  onApprove: (run: WorkflowRunDto) => void;
  run: WorkflowRunDto;
}) {
  const openRow = useOpenRow();
  const endLine = run.endedAt && run.endNote ? `Stopped: ${run.endNote}` : null;
  const end = openRow("end", endLine);
  return (
    <>
      <ol className="workflow-steps">
        {run.steps.map((step) => {
          const line = stepLine(step);
          const { open, ...row } = openRow(step.name, line);
          return (
            <li
              aria-current={step.state === "active" ? "step" : undefined}
              className={rowClass(
                `workflow-step state-${step.state}`,
                open,
                line,
              )}
              key={step.name}
              {...row}
            >
              <StepMark state={step.state} />
              <span className="workflow-step-name">
                {step.name}
                {step.gate && <span className="workflow-gate">gate</span>}
              </span>
              <time className="workflow-step-when">
                {stepTime(step.endedAt ?? step.startedAt)}
              </time>
              {step.state === "waiting" && (
                <button
                  className="workflow-approve"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    onApprove(run);
                  }}
                  title={`Let the agent do step '${step.name}'`}
                  type="button"
                >
                  Approve
                </button>
              )}
              {line && <span className="workflow-step-note">{line}</span>}
            </li>
          );
        })}
      </ol>
      {run.until && !run.endedAt && (
        <p className="workflow-footnote">until: {run.until}</p>
      )}
      {endLine && (
        <p
          className={rowClass("workflow-footnote", end.open, endLine)}
          {...(({ open: _open, ...row }) => row)(end)}
        >
          {endLine}
        </p>
      )}
      {run.history.length > 0 && (
        <details className="workflow-history">
          <summary>Earlier iterations ({run.iteration - 1})</summary>
          <ol className="workflow-steps">
            {run.history.map((record, index) => {
              const key = `${record.iteration}:${record.name}:${index}`;
              const { open, ...row } = openRow(key, record.note);
              return (
                <li
                  className={rowClass(
                    `workflow-step state-${record.state}`,
                    open,
                    record.note,
                  )}
                  key={key}
                  {...row}
                >
                  <StepMark state={record.state} />
                  <span className="workflow-step-name">
                    {record.name}
                    <span className="workflow-step-when">
                      {STATE_LABEL[record.state]}
                    </span>
                  </span>
                  <span className="workflow-step-when">{record.iteration}</span>
                  {record.note && (
                    <span className="workflow-step-note">{record.note}</span>
                  )}
                </li>
              );
            })}
          </ol>
        </details>
      )}
    </>
  );
}

/**
 * The pane itself: a header that folds it, a top edge that resizes it, and
 * the steps. With workflows off it says so and links to Settings. Without a run it says so in one dim line.
 */
export function WorkflowPane({
  busy,
  enabled,
  onApprove,
  onOpenEditor,
  onOpenSettings,
  run,
  task,
}: {
  busy: boolean;
  /** Whether agents run work in workflows at all; off, the pane says so. */
  enabled: boolean;
  onApprove: (run: WorkflowRunDto) => void;
  /** Opens Settings where workflows are turned on. */
  onOpenSettings: () => void;
  /** Opens the workflows editor as a center tab. */
  onOpenEditor: () => void;
  run?: WorkflowRunDto;
  /** The session's task, named in small print as what the work is for. */
  task?: { number: number; title: string };
}) {
  const [folded, setFolded] = useState(() => remembered(FOLDED_KEY) === "1");
  const [height, setHeight] = useState(
    () => Number(remembered(HEIGHT_KEY)) || DEFAULT_HEIGHT,
  );
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  const open = enabled && !folded;
  const current = run?.steps.find(
    (step) => step.state === "active" || step.state === "waiting",
  );
  return (
    <section
      aria-label="Workflow"
      className={`workflow-pane${open ? "" : " folded"}`}
      style={open && run ? { height } : undefined}
    >
      {open && run && (
        <div
          aria-label="Resize workflow pane"
          aria-orientation="horizontal"
          className="workflow-pane-edge"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { startY: event.clientY, startHeight: height };
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            const limit = Math.max(MIN_HEIGHT, window.innerHeight * 0.75);
            setHeight(
              Math.min(
                limit,
                Math.max(
                  MIN_HEIGHT,
                  drag.current.startHeight +
                    (drag.current.startY - event.clientY),
                ),
              ),
            );
          }}
          onPointerUp={() => {
            drag.current = null;
            remember(HEIGHT_KEY, String(Math.round(height)));
          }}
          role="separator"
        />
      )}
      <div className="workflow-pane-header">
        <button
          aria-expanded={open}
          className="workflow-pane-heading"
          disabled={!enabled}
          onClick={() =>
            setFolded((value) => {
              remember(FOLDED_KEY, value ? "0" : "1");
              return !value;
            })
          }
          type="button"
        >
          <span className="workflow-pane-title">
            <WorkflowIcon />
            Workflow
          </span>
          {!open && current && (
            <span className="workflow-pane-current">
              {current.state === "waiting" ? "‖" : "▸"} {current.name}
            </span>
          )}
        </button>
        {/* Open even with workflows off, to read or write them first. */}
        <button
          className="quiet workflow-pane-open"
          onClick={onOpenEditor}
          title="Workflows, steps and examples"
          type="button"
        >
          Open <span aria-hidden="true">↗</span>
        </button>
      </div>
      {!enabled && (
        <p className="workflow-pane-empty">
          Workflows are off ·{" "}
          <button
            className="workflow-pane-link"
            onClick={onOpenSettings}
            type="button"
          >
            Turn on in Settings
          </button>
        </p>
      )}
      {open && run && (
        <div className="workflow-pane-run">
          <span className="workflow-pane-name">{run.workflow}</span>
          <RunTags run={run} />
          {task && (
            <span
              className="workflow-pane-task"
              title={`#${task.number} ${task.title}`}
            >
              #{task.number} {task.title}
            </span>
          )}
        </div>
      )}
      {open &&
        (run ? (
          <div className="workflow-pane-body">
            <WorkflowSteps busy={busy} onApprove={onApprove} run={run} />
          </div>
        ) : (
          <p className="workflow-pane-empty">No workflow in this session</p>
        ))}
    </section>
  );
}
