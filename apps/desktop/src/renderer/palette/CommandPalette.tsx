/**
 * The ⌘K palette: one field, and below it every command that would run
 * where focus was, the places to go (sessions, tasks, workspaces) and the
 * focused item's own actions, filtered as the field is typed. A combobox on
 * the ARIA pattern: focus stays in the field, the arrows move the active row
 * (`aria-activedescendant`), Enter runs it, Escape closes and gives focus
 * back. It is a dialog with the app's focus scope, so the page behind is
 * inert while it is open.
 *
 * Built here rather than on cmdk: cmdk brings Radix's dialog and its own
 * focus trap, which would fight `useFocusScope`, and the ranking (prefixes,
 * recent commands, groups ordered by their best row) is the palette's own
 * anyway; see `palette-model.ts`.
 */
import { useId, useMemo, useRef, useState } from "react";
import { useFocusScope } from "../use-focus-scope";
import { KeyGlyphs } from "../keyboard-ui";
import { flattenGroups, type PaletteEntry, rankPalette } from "./palette-model";

export interface PaletteRow extends PaletteEntry {
  run(): void;
  disabled?: boolean;
  /** Ask for a second Enter first; says what confirming does. */
  confirm?: string;
  /** A session's status, drawn as a dot: its tone, and whether it needs you. */
  status?: { tone: string; attention: boolean };
  /** A switch's state, for an item action that toggles. */
  checked?: boolean;
}

export function CommandPalette({
  entries,
  initialQuery = "",
  itemTitle,
  onChoose,
  onClose,
  recent,
}: {
  entries: readonly PaletteRow[];
  initialQuery?: string;
  /** What the focused item is, heading its actions. */
  itemTitle?: string;
  /** Runs a row; the palette has closed by the time it runs. */
  onChoose: (row: PaletteRow) => void;
  onClose: () => void;
  recent: readonly string[];
}) {
  const section = useRef<HTMLElement>(null);
  useFocusScope(section);
  const listId = useId();
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const [armed, setArmed] = useState<string>();
  const groups = useMemo(
    () => rankPalette(entries, query, recent),
    [entries, query, recent],
  );
  const rows = flattenGroups(groups);
  const current = rows[Math.min(active, rows.length - 1)];
  const optionId = (row: PaletteRow) =>
    `${listId}-${row.key.replace(/[^\w-]/g, "_")}`;

  const move = (to: number) => {
    if (rows.length === 0) return;
    const next = (to + rows.length) % rows.length;
    setActive(next);
    setArmed(undefined);
    const row = rows[next];
    if (row)
      document
        .getElementById(optionId(row))
        ?.scrollIntoView({ block: "nearest" });
  };
  const choose = (row: PaletteRow | undefined) => {
    if (!row || row.disabled) return;
    if (row.confirm && armed !== row.key) {
      setArmed(row.key);
      return;
    }
    onChoose(row);
  };

  return (
    <div
      className="modal-backdrop palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <section
        aria-label="Command palette"
        aria-modal="true"
        className="palette"
        ref={section}
        role="dialog"
        tabIndex={-1}
      >
        <input
          aria-activedescendant={current ? optionId(current) : undefined}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded="true"
          aria-label="Search commands, sessions, tasks and workspaces"
          autoFocus
          className="palette-input"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setArmed(undefined);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              move(active + 1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              move(active - 1);
            } else if (event.key === "PageDown") {
              event.preventDefault();
              move(Math.min(active + 8, rows.length - 1));
            } else if (event.key === "PageUp") {
              event.preventDefault();
              move(Math.max(active - 8, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(current);
            } else if (
              event.key === "Escape" ||
              // ⌘K again closes it, as it opened it.
              (event.metaKey && event.key.toLowerCase() === "k")
            ) {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
          placeholder="Type a command, or > commands, @ sessions, # tasks"
          role="combobox"
          spellCheck={false}
          type="text"
          value={query}
        />
        <div
          aria-label="Results"
          className="palette-list"
          id={listId}
          role="listbox"
        >
          {groups.map((group) => (
            <div
              aria-labelledby={`${listId}-${group.section}`}
              className="palette-group"
              key={group.section}
              role="group"
            >
              <div
                className="palette-group-title"
                id={`${listId}-${group.section}`}
                role="presentation"
              >
                {group.section === "item" && itemTitle
                  ? `Actions for ${itemTitle}`
                  : group.title}
              </div>
              {group.entries.map((row) => {
                const isActive = row === current;
                return (
                  <div
                    aria-checked={
                      row.checked === undefined ? undefined : row.checked
                    }
                    aria-disabled={row.disabled || undefined}
                    aria-selected={isActive}
                    className="palette-row"
                    data-active={isActive ? "true" : undefined}
                    id={optionId(row)}
                    key={row.key}
                    onClick={() => choose(row)}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => {
                      const index = rows.indexOf(row);
                      if (index !== active) {
                        setActive(index);
                        setArmed(undefined);
                      }
                    }}
                    role="option"
                  >
                    {row.status && (
                      <span
                        aria-hidden="true"
                        className="palette-dot"
                        data-attention={
                          row.status.attention ? "true" : undefined
                        }
                        data-tone={row.status.tone}
                      />
                    )}
                    <span className="palette-row-title">
                      {armed === row.key && row.confirm
                        ? `${row.title}: ${row.confirm} Press Enter again to confirm.`
                        : row.title}
                      {row.checked !== undefined && (
                        <span className="palette-row-state">
                          {row.checked ? " · on" : " · off"}
                        </span>
                      )}
                    </span>
                    {row.detail && (
                      <span className="palette-row-detail">{row.detail}</span>
                    )}
                    {row.shortcut && <KeyGlyphs glyphs={row.shortcut} />}
                  </div>
                );
              })}
            </div>
          ))}
          {rows.length === 0 && (
            <p className="palette-empty" role="status">
              Nothing matches.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
