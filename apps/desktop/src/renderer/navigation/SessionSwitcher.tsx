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
 */
import { useEffect, useId, useRef, useState } from "react";

export interface SwitcherRow {
  id: string;
  title: string;
  /** Its workspace. */
  subtitle?: string;
  status?: { tone: string; attention: boolean; label: string };
}

/** The modifiers the opening key held; the switcher opens when they go. */
export interface HeldModifiers {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
}

/** How long a held ⌃ waits before the list shows, so a tap never flashes it. */
export const SWITCHER_SHOW_DELAY_MS = 150;

const anyHeld = (held: HeldModifiers | undefined) =>
  Boolean(held && (held.mod || held.ctrl || held.alt));

/** Whether a key event says the held modifiers are still down. */
const stillHeld = (
  held: HeldModifiers,
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey">,
) =>
  (!held.mod || event.metaKey) &&
  (!held.ctrl || event.ctrlKey) &&
  (!held.alt || event.altKey);

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
  onMove: (index: number) => void;
  onCommit: (id: string) => void;
  onCancel: () => void;
}) {
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const holding = anyHeld(held);
  const [visible, setVisible] = useState(!holding);
  const current = rows[Math.min(index, rows.length - 1)];
  // Ends once: a commit, a cancel, nothing after (a late keyup, a press
  // landing as it closes).
  const ended = useRef(false);
  const end = (then: () => void) => {
    if (ended.current) return;
    ended.current = true;
    then();
  };
  const commitTo = (id: string) => end(() => onCommit(id));
  const cancel = () => end(onCancel);
  const latest = useRef({ current, commitTo, cancel, onMove, index, rows });
  latest.current = { current, commitTo, cancel, onMove, index, rows };

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
    const commit = () => {
      const { current: row, commitTo: open, cancel: stop } = latest.current;
      if (row) open(row.id);
      else stop();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (held && holding && !stillHeld(held, event)) {
        commit();
        return;
      }
      const { index: at, rows: shown, onMove: move } = latest.current;
      const step = (to: number) =>
        move((to + shown.length) % Math.max(shown.length, 1));
      if (event.key === "Escape") latest.current.cancel();
      else if (event.key === "Enter") commit();
      else if (event.key === "ArrowDown") step(at + 1);
      else if (event.key === "ArrowUp") step(at - 1);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (held && holding && !stillHeld(held, event)) commit();
    };
    // The window losing focus, or a press outside the list, cancels.
    const onBlur = () => latest.current.cancel();
    const onPointerDown = (event: PointerEvent) => {
      if (!(
        event.target instanceof Node && list.current?.contains(event.target)
      ))
        latest.current.cancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [held, holding]);

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
