/**
 * Arrow keys for a row of tabs, as the WAI-ARIA tabs pattern has them: the
 * row is one Tab stop (the selected tab), and ← / → / Home / End move
 * between the tabs inside it, wrapping at the ends.
 */
import type { KeyboardEvent } from "react";

/** The tab a key moves to from `index` of `count`, or undefined if none. */
export function rovingTarget(
  key: string,
  index: number,
  count: number,
): number | undefined {
  if (count <= 0) return undefined;
  switch (key) {
    case "ArrowRight":
      return index < 0 ? 0 : (index + 1) % count;
    case "ArrowLeft":
      return index < 0 ? count - 1 : (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}

/**
 * The `tabIndex` of tab `index`: 0 for the selected one, or for the first
 * when none is selected, so the row always has its one stop; -1 otherwise.
 */
export function rovingTabIndex(index: number, selected: number): 0 | -1 {
  return index === (selected < 0 ? 0 : selected) ? 0 : -1;
}

/**
 * The tablist's `onKeyDown`. It moves focus between the list's
 * `[role="tab"]` elements and selects nothing: Enter or Space selects, as
 * for any button (manual activation).
 */
export function onTabListKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  const tabs = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
  ];
  const index = tabs.findIndex((tab) => tab === event.target);
  // Keys on something else in the row, such as a close button, are its own.
  if (index < 0) return;
  const next = rovingTarget(event.key, index, tabs.length);
  if (next === undefined) return;
  event.preventDefault();
  tabs[next]?.focus();
}
