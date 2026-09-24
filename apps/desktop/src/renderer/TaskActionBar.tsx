/**
 * The task drawer's action bar (#34): the row under the status and priority
 * pills that does to the task what its board card does. Start with the
 * workspace default or a chosen provider, Draft brief, Set in progress, Mark
 * done, the worktree and PR, the running agent's terminal, and a second
 * opinion, each shown only while it applies. The drawer covers the workspace
 * column, not the board, so the card is still visible beside it; this bar is
 * for the person who opened the brief to read it and then wants to act
 * without going back to the card.
 *
 * What applies comes from `taskActions`, the same derivation the card uses,
 * so the two cannot disagree. Starts in flight and failed ones are listed
 * under the buttons, as the card lists them.
 *
 * Draft brief is always there, at the end of the lane's actions: on a card
 * it shows only while the brief is empty, but a person reading a brief in
 * the drawer is exactly the one who might want an agent to redo it. The
 * right end holds Edit and an overflow menu with Delete. They were in the
 * drawer's heading beside Close, which left a person looking in two places
 * for one kind of thing; the heading is now the drawer's own, title and
 * Close only.
 */
import type { ReactNode } from "react";
import type {
  AgentSessionDto,
  SessionWorktreeDto,
  TaskDto,
} from "@daedalus/protocol";
import { confirmStartDespite } from "./BoardView";
import { providerLabel, sessionName } from "./session-view";
import { TaskActionsMenu } from "./TaskActionsMenu";
import type { BoardProvider, TaskActions } from "./task-actions";

export interface TaskActionBarProps {
  task: TaskDto;
  actions: TaskActions;
  busy: boolean;
  tmuxAvailable: boolean;
  onStart: () => void;
  /** Start with a provider and model chosen in the session dialog. */
  onStartWith: () => void;
  onDraftBrief: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSecondOpinion: (provider: BoardProvider) => void;
  onSetInProgress: () => void;
  onMarkDone: () => void;
  onOpenSession: (session: AgentSessionDto) => void;
  onOpenWorktree: (worktree: SessionWorktreeDto) => void;
  onOpenLink: (url: string) => void;
  onDismissLaunch: (key: string) => void;
}

export function TaskActionBar(props: TaskActionBarProps) {
  const { actions, task, tmuxAvailable } = props;
  const waitingList = actions.waitingOn
    .map((item) => `#${item.number}`)
    .join(", ");
  const buttons: ReactNode[] = [];
  if (actions.startable)
    buttons.push(
      <span className="board-start-group" key="start">
        <button
          aria-label={
            actions.waitingOn.length
              ? `Start ${task.title}, waiting on ${waitingList}`
              : `Start ${task.title}`
          }
          className={`board-start${actions.waitingOn.length ? " waiting" : ""}`}
          disabled={!tmuxAvailable || actions.starting}
          onClick={() => {
            if (confirmStartDespite(task, actions.waitingOn)) props.onStart();
          }}
          title={
            !tmuxAvailable
              ? "Needs tmux to start a session"
              : actions.waitingOn.length
                ? `Waiting on ${waitingList}`
                : "Start an agent on this task with the workspace default provider"
          }
          type="button"
        >
          Start{actions.waitingOn.length ? " ⚠" : ""}
        </button>
        <button
          aria-label={`Choose how to start ${task.title}`}
          className="board-start-choose"
          disabled={!tmuxAvailable || actions.starting}
          onClick={() => {
            if (confirmStartDespite(task, actions.waitingOn))
              props.onStartWith();
          }}
          title="Choose provider and model"
          type="button"
        >
          ▾
        </button>
      </span>,
    );
  if (actions.canSetInProgress)
    buttons.push(
      <button
        disabled={props.busy}
        key="in-progress"
        onClick={props.onSetInProgress}
        title="The agent is running; the status still says to do"
        type="button"
      >
        Set in progress
      </button>,
    );
  if (actions.canMarkDone)
    buttons.push(
      <button
        disabled={props.busy}
        key="done"
        onClick={props.onMarkDone}
        title="Merging stays yours; this only records the verdict"
        type="button"
      >
        Mark done
      </button>,
    );
  if (actions.liveSession) {
    const live = actions.liveSession;
    buttons.push(
      <button
        className="quiet"
        key="terminal"
        onClick={() => props.onOpenSession(live)}
        title={`Open the terminal of ${sessionName(live)}`}
        type="button"
      >
        Open terminal
      </button>,
    );
  }
  if (actions.reviewWorktree) {
    const worktree = actions.reviewWorktree;
    buttons.push(
      <button
        className="quiet"
        key="worktree"
        onClick={() => props.onOpenWorktree(worktree)}
        title={worktree.path}
        type="button"
      >
        Open worktree
      </button>,
    );
  }
  if (actions.reviewPullRequest) {
    const pullRequest = actions.reviewPullRequest;
    buttons.push(
      <button
        className="quiet"
        key="pr"
        onClick={() => props.onOpenLink(pullRequest.url)}
        title={pullRequest.url}
        type="button"
      >
        Open PR #{pullRequest.number}
      </button>,
    );
  }
  if (actions.offersSecondOpinion) {
    const other = actions.otherProvider;
    buttons.push(
      <button
        className="quiet"
        disabled={!tmuxAvailable || !other || actions.starting}
        key="second"
        onClick={() => {
          if (other) props.onSecondOpinion(other);
        }}
        title={
          other
            ? `Start ${providerLabel(other)} on this task beside ${providerLabel(actions.lastAgent!.provider)}`
            : "Needs a second provider installed"
        }
        type="button"
      >
        Second opinion
      </button>,
    );
  }
  buttons.push(
    <button
      className="quiet"
      disabled={!tmuxAvailable || actions.starting}
      key="draft"
      onClick={props.onDraftBrief}
      title={
        task.description.trim()
          ? "Start a session that reads the workspace and rewrites this brief. It does not start the task."
          : "Start a session that reads the workspace and writes this brief. It does not start the task."
      }
      type="button"
    >
      Draft brief
    </button>,
  );
  return (
    <div
      aria-label={`Actions for #${task.number}`}
      className="task-action-bar"
      role="group"
    >
      <div className="task-action-buttons">
        {/* The lead wraps as the drawer narrows; the tail keeps its place at
            the right end, so the menu's popover never opens off the drawer. */}
        <div className="task-action-lead">{buttons}</div>
        <div className="task-action-tail">
          <button
            className="quiet"
            onClick={props.onEdit}
            title="Edit the title and brief"
            type="button"
          >
            Edit
          </button>
          <TaskActionsMenu onDelete={props.onDelete} />
        </div>
      </div>
      {actions.launches.map((launch) => (
        <div
          aria-busy={launch.status === "starting"}
          className={`board-launch-row board-launch-${launch.status}`}
          key={launch.key}
        >
          {launch.status === "starting" ? (
            <>
              <span aria-hidden="true" className="session-launch-spinner" />
              <span>Starting {launch.tool}…</span>
            </>
          ) : (
            <>
              <span role="alert">
                {launch.tool} failed to start: {launch.error}
              </span>
              <button
                className="quiet"
                onClick={() => props.onDismissLaunch(launch.key)}
                type="button"
              >
                Dismiss
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
