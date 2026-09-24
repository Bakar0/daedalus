/**
 * The task's two fields a person owns, as pills on the line under its title.
 * Each is a view over `Task.status` or `Task.priority` plus the RPC that
 * already sets it; picking an item is the only thing that calls it (BRIEF.md,
 * "Board lanes are derived; task status is the human's").
 *
 * The status colours are the lane colours the board already uses for the
 * lane each status lands in when no agent is involved: to do is Queued's
 * grey, in progress Running's lavender, blocked Parked's violet, done Done's
 * green. Cancelled also lands in Done but is drawn muted and struck through,
 * because a green tick would claim the work was finished.
 */
import { useId } from "react";
import type { TaskPriority, TaskStatus } from "@daedalus/protocol";
import { Menu, MenuCheck, MenuChevron } from "./Menu";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "todo",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

const PRIORITIES: readonly TaskPriority[] = ["high", "normal", "low"];

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  high: "High",
  normal: "Normal",
  low: "Low",
};

export function TaskStatusMenu({
  onChange,
  status,
}: {
  onChange: (status: TaskStatus) => void;
  status: TaskStatus;
}) {
  const valueId = useId();
  return (
    <Menu
      className="task-pill-menu"
      describedBy={valueId}
      label="Task status"
      menuLabel="Set task status"
      summary={
        <>
          <span aria-hidden="true" className="task-pill-dot" />
          <span id={valueId}>{TASK_STATUS_LABEL[status]}</span>
          <MenuChevron />
        </>
      }
      summaryClassName={`task-pill status-${status}`}
    >
      {TASK_STATUSES.map((item) => (
        <button
          aria-checked={item === status}
          className={`quiet menu-item status-${item}`}
          key={item}
          onClick={() => {
            if (item !== status) onChange(item);
          }}
          role="menuitemradio"
          type="button"
        >
          <span aria-hidden="true" className="task-pill-dot" />
          <span className="menu-item-label">{TASK_STATUS_LABEL[item]}</span>
          {item === status && <MenuCheck />}
        </button>
      ))}
    </Menu>
  );
}

export function TaskPriorityMenu({
  onChange,
  priority,
}: {
  onChange: (priority: TaskPriority) => void;
  priority: TaskPriority;
}) {
  const valueId = useId();
  return (
    <Menu
      className="task-pill-menu"
      describedBy={valueId}
      label="Task priority"
      menuLabel="Set task priority"
      summary={
        <>
          <span id={valueId}>{PRIORITY_LABEL[priority]} priority</span>
          <MenuChevron />
        </>
      }
      summaryClassName={`task-pill priority-${priority}`}
    >
      {PRIORITIES.map((item) => (
        <button
          aria-checked={item === priority}
          className={`quiet menu-item priority-${item}`}
          key={item}
          onClick={() => {
            if (item !== priority) onChange(item);
          }}
          role="menuitemradio"
          type="button"
        >
          <span className="menu-item-label">{PRIORITY_LABEL[item]}</span>
          {item === priority && <MenuCheck />}
        </button>
      ))}
    </Menu>
  );
}
