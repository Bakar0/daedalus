/**
 * The action bar's icons (#34): one 24-unit glyph per action, drawn in the
 * 1.8 stroke the app's other icons use, in `currentColor` so each takes the
 * colour of the button it sits in. They sit beside the labels, never in
 * their place: an icon alone needs a tooltip to be understood, and a bar of
 * eight labels alone needs reading to be scanned.
 */
import type { ReactNode } from "react";

export type TaskActionIconName =
  | "start"
  | "in-progress"
  | "done"
  | "terminal"
  | "worktree"
  | "pull-request"
  | "draft"
  | "second-opinion"
  | "edit"
  | "delete";

const PATHS: Record<TaskActionIconName, ReactNode> = {
  start: <path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none" />,
  "in-progress": (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 12V7M12 12l3.5 3.5" />
    </>
  ),
  done: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  terminal: (
    <>
      <rect height="15" rx="2.5" width="18" x="3" y="4.5" />
      <path d="m7.5 9.5 3 3-3 3M13 15.5h4" />
    </>
  ),
  worktree: (
    <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  ),
  "pull-request": (
    <>
      <circle cx="6.5" cy="6" r="2.5" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="17.5" cy="18" r="2.5" />
      <path d="M6.5 8.5v7M17.5 15.5V11a3 3 0 0 0-3-3h-3M14 5.5 11.5 8l2.5 2.5" />
    </>
  ),
  draft: (
    <>
      <path d="M12 4.5 13.6 9l4.4 1.5-4.4 1.5L12 16.5 10.4 12 6 10.5 10.4 9z" />
      <path d="M5.5 16.5v3M4 18h3M18.5 15.5v3M17 17h3" />
    </>
  ),
  "second-opinion": (
    <>
      <path d="M4 6.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H9l-3 2.5v-2.5H6a2 2 0 0 1-2-2z" />
      <path d="M17 9.5h1a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-.5V20l-3-2.5H12a2 2 0 0 1-2-1.5" />
    </>
  ),
  edit: (
    <>
      <path d="M4.5 19.5h4L19 9a2.1 2.1 0 0 0-3-3L5.5 16.5z" />
      <path d="M13.5 8.5 16 11" />
    </>
  ),
  delete: (
    <>
      <path d="M4.5 7h15M9.5 7V4.5h5V7" />
      <path d="M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.5h6.4a1.5 1.5 0 0 0 1.5-1.5l.8-12" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
};

export function TaskActionIcon({ name }: { name: TaskActionIconName }) {
  return (
    <svg
      aria-hidden="true"
      className="task-action-icon"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      {PATHS[name]}
    </svg>
  );
}
