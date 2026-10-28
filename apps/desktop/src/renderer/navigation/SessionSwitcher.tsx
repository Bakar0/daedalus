/**
 * The ⌃Tab session switcher, as ⌘Tab switches apps: while ⌃ is held, a
 * small list of sessions in the order they were last used, the highlight on
 * the next one. Each further ⌃Tab moves it down and ⌃⇧Tab up (the
 * `session.switch` commands, which the window's dispatcher runs);
 * letting go of ⌃ opens the highlighted session, Escape cancels. A quick
 * tap opens the previous session without the list ever showing.
 *
 * Opened by a key with no modifier to hold (a rebound key, or the Go
 * menu), it stays until Enter or a click opens a session.
 *
 * A listbox with `aria-activedescendant`: it takes focus while it is open,
 * so a screen reader follows the highlight, and gives it back on Escape.
 * What each key does is decided by `switcherDecision` (`session-cycle.ts`).
 */
import { useEffect, useId, useRef, useState } from "react";
import { hasOpenScope } from "../use-focus-scope";
import {
  type HeldModifiers,
  holdsAny,
  type SwitcherInput,
  switcherDecision,
} from "./session-cycle";

export type { HeldModifiers } from "./session-cycle";

export interface SwitcherRow {
  id: string;
  title: string;
  /** Its workspace. */
  subtitle?: string;
  status?: { tone: string; attention: boolean; label: string };
}

/** How long a held ⌃ waits before the list shows, so a tap never flashes it. */
export const SWITCHER_SHOW_DELAY_MS = 150;

export function SessionSwitcher({
  rows,
  index,
  held,
  onMove,
  onCommit,
  onCancel,
}: {
  rows: readonly SwitcherRow[];
  /** The highlighted row. */
  index: number;
  held?: HeldModifiers;
  /** One step of the highlight, as Tab and ⇧Tab take it. */
  onMove: (direction: 1 | -1) => void;
  onCommit: (id: string) => void;
  onCancel: () => void;
}) {
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const holding = holdsAny(held);
  const [visible, setVisible] = useState(!holding);
  const current = rows[Math.min(index, rows.length - 1)];
  // Ends once: a commit, a cancel, nothing after (a late keyup, focus
  // leaving the list as it closes).
  const ended = useRef(false);
  const end = (then: () => void) => {
    if (ended.current) return;
    ended.current = true;
    then();
  };
  const commitTo = (id: string) => end(() => onCommit(id));
  const cancel = () => end(onCancel);
  const latest = useRef({ current, commitTo, cancel, onMove });
  latest.current = { current, commitTo, cancel, onMove };

  useEffect(() => {
    if (visible) return;
    const timer = setTimeout(() => setVisible(true), SWITCHER_SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [visible]);

  // Focus comes in once the list shows; a quick tap never moves it.
  useEffect(() => {
    if (visible) list.current?.focus({ preventScroll: true });
  }, [visible]);

  useEffect(() => {
    const act = (input: SwitcherInput, event?: Event) => {
      const decision = switcherDecision(held, input, {
        scopeOpen: hasOpenScope(),
      });
      if (decision.consume && event) {
        event.preventDefault();
        event.stopPropagation();
      }
      const { current: row, commitTo: open, cancel: stop } = latest.current;
      if (decision.action === "cancel") stop();
      else if (decision.action === "commit") {
        if (row) open(row.id);
        else stop();
      } else if (decision.action === "move" && decision.direction)
        latest.current.onMove(decision.direction);
    };
    const onKey = (event: KeyboardEvent) =>
      act(
        {
          type: event.type === "keyup" ? "keyup" : "keydown",
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          inList:
            event.target instanceof Node &&
            Boolean(list.current?.contains(event.target)),
        },
        event,
      );
    const onBlur = () => act({ type: "blur" });
    // A press outside the list cancels; one on a row is the row's click.
    const onPointerDown = (event: PointerEvent) => {
      if (!(
        event.target instanceof Node && list.current?.contains(event.target)
      ))
        act({ type: "focusout" });
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [held]);

  useEffect(() => {
    if (!current) return;
    document
      .getElementById(`${listId}-${current.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [current, listId]);

  if (!visible) return null;
  return (
    <div className="session-switcher-backdrop" role="presentation">
      <div
        aria-activedescendant={current ? `${listId}-${current.id}` : undefined}
        aria-label="Switch session"
        className="session-switcher"
        // Focus going elsewhere (a dialog, a click) ends the switcher.
        onBlur={(event) => {
          const to = event.relatedTarget;
          if (!(to instanceof Node && event.currentTarget.contains(to)))
            latest.current.cancel();
        }}
        ref={list}
        role="listbox"
        tabIndex={-1}
      >
        <div aria-hidden="true" className="session-switcher-title">
          Recent sessions
        </div>
        {rows.map((row) => {
          const active = row === current;
          return (
            <div
              aria-selected={active}
              className="palette-row"
              data-active={active ? "true" : undefined}
              id={`${listId}-${row.id}`}
              key={row.id}
              onClick={() => commitTo(row.id)}
              onMouseDown={(event) => event.preventDefault()}
              role="option"
            >
              {row.status && (
                <span
                  aria-label={row.status.label}
                  className="palette-dot"
                  data-attention={row.status.attention ? "true" : undefined}
                  data-tone={row.status.tone}
                  role="img"
                />
              )}
              <span className="palette-row-title">{row.title}</span>
              {row.subtitle && (
                <span className="palette-row-detail">{row.subtitle}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
