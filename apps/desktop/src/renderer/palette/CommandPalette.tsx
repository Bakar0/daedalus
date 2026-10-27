/**
 * The ⌘K palette, on Raycast's model: one field that searches everything
 * (sessions, tasks, workspaces, commands, views, the settings pages), each
 * row saying what it is. Enter runs a row's primary action; ⌘K or → opens
 * its Actions panel, a second list of everything that can be done to it,
 * which Escape or ← leaves. A footer names the highlighted row's kind, what
 * Enter does, and whether it has actions.
 *
 * A combobox on the ARIA pattern: focus stays in the field, the arrows move
 * the active row (`aria-activedescendant`), Escape closes and gives focus
 * back. It is a dialog with the app's focus scope, so the page behind is
 * inert while it is open.
 *
 * Built here rather than on cmdk: cmdk brings Radix's dialog and its own
 * focus trap, which would fight `useFocusScope`, and the ranking is the
 * palette's own anyway; see `palette-model.ts`.
 */
import { type KeyboardEvent, useId, useMemo, useRef, useState } from "react";
import { isComposingKey } from "../commands";
import type { ItemAction } from "../item-actions";
import { KeyGlyphs } from "../keyboard-ui";
import { useFocusScope } from "../use-focus-scope";
import {
  filterActions,
  flattenGroups,
  KIND_LABELS,
  type PaletteEntry,
  rankPalette,
} from "./palette-model";

export interface PaletteRow extends PaletteEntry {
  /** What Enter does, as the footer says it: `Open Session`, `Run`. */
  primary: string;
  /** The primary action. */
  run(): void;
  /** Its Actions panel; omitted, the row has none. */
  actions?: () => ItemAction[];
  disabled?: boolean;
  /** Ask for a second Enter first; says what confirming does. */
  confirm?: string;
  /** A session's status, drawn as a dot: its tone, and whether it needs you. */
  status?: { tone: string; attention: boolean };
}

/** The Actions panel's own first row, Enter's action on the row. */
const PRIMARY_ID = "primary";

/** A row's actions as its panel lists them: the primary one first. */
export function panelActions(row: PaletteRow): ItemAction[] {
  const own = row.actions?.() ?? [];
  return [
    {
      id: PRIMARY_ID,
      label: row.primary,
      run: row.run,
      ...(row.disabled ? { disabled: true } : {}),
      ...(row.confirm ? { confirm: row.confirm } : {}),
    },
    // The item's own "open" is the primary action already.
    ...own.filter((action) => action.id !== "open"),
  ];
}

const optionKey = (value: string) => value.replace(/[^\w-]/g, "_");

export function CommandPalette({
  entries,
  selectedKey,
  startInActions = false,
  recent,
  suggestions,
  boost,
  onChoose,
  onChooseAction,
  onClose,
}: {
  entries: readonly PaletteRow[];
  /** The item that had focus: the first row, and highlighted. */
  selectedKey?: string;
  /** Open on the selected row's Actions panel (⇧F10 on a board card). */
  startInActions?: boolean;
  recent: readonly string[];
  suggestions: readonly string[];
  boost: readonly string[];
  /** Runs a row's primary action; the palette has closed by then. */
  onChoose: (row: PaletteRow) => void;
  /** Runs one of a row's actions; the palette has closed by then. */
  onChooseAction: (row: PaletteRow, action: ItemAction) => void;
  onClose: () => void;
}) {
  const section = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useFocusScope(section);
  const listId = useId();
  const [query, setQuery] = useState("");
  // The active row by its key, not its place: rows are rebuilt while the
  // palette is open (a session's status changes), and Enter must run the
  // row that is highlighted, wherever it moved.
  const [activeKey, setActiveKey] = useState<string | undefined>(selectedKey);
  const [armed, setArmed] = useState<string>();
  // The Actions panel: whose, and what the results looked like before it.
  const [panel, setPanel] = useState<
    { rowKey: string; query: string; activeKey: string | undefined } | undefined
  >(() =>
    startInActions && selectedKey
      ? { rowKey: selectedKey, query: "", activeKey: selectedKey }
      : undefined,
  );
  const [activeAction, setActiveAction] = useState<string>();

  const groups = useMemo(
    () =>
      rankPalette(entries, panel ? panel.query : query, {
        recent,
        suggestions,
        boost,
        ...(selectedKey ? { selected: selectedKey } : {}),
      }),
    [entries, panel, query, recent, suggestions, boost, selectedKey],
  );
  const rows = flattenGroups(groups);
  const panelRow = panel
    ? entries.find((row) => row.key === panel.rowKey)
    : undefined;
  const actions = useMemo(
    () => (panelRow ? filterActions(panelActions(panelRow), query) : []),
    [panelRow, query],
  );

  const current = panel
    ? panelRow
    : (rows.find((row) => row.key === activeKey) ?? rows[0]);
  const currentAction = panel
    ? (actions.find((action) => action.id === activeAction) ?? actions[0])
    : undefined;
  const optionId = (key: string) =>
    `${listId}-${panel ? "action" : "row"}-${optionKey(key)}`;
  const activeOption = panel
    ? currentAction && optionId(currentAction.id)
    : current && optionId(current.key);

  const keys = panel
    ? actions.map((action) => action.id)
    : rows.map((row) => row.key);
  const activeIndex = Math.max(
    0,
    panel
      ? actions.indexOf(currentAction as ItemAction)
      : rows.indexOf(current as PaletteRow),
  );
  const move = (to: number) => {
    if (keys.length === 0) return;
    const key = keys[(to + keys.length) % keys.length];
    if (panel) setActiveAction(key);
    else setActiveKey(key);
    setArmed(undefined);
    if (key)
      document
        .getElementById(optionId(key))
        ?.scrollIntoView({ block: "nearest" });
  };

  const openActions = (row: PaletteRow | undefined) => {
    if (!row?.actions) return false;
    setPanel({ rowKey: row.key, query, activeKey: row.key });
    setQuery("");
    setActiveAction(undefined);
    setArmed(undefined);
    return true;
  };
  const closeActions = () => {
    if (!panel) return;
    setQuery(panel.query);
    setActiveKey(panel.activeKey);
    setPanel(undefined);
    setArmed(undefined);
  };
  const choose = (row: PaletteRow | undefined) => {
    if (!row || row.disabled) return;
    if (row.confirm && armed !== row.key) {
      setArmed(row.key);
      return;
    }
    onChoose(row);
  };
  const chooseAction = (action: ItemAction | undefined) => {
    if (!panelRow || !action || action.disabled) return;
    const armKey = `action:${action.id}`;
    if (action.confirm && armed !== armKey) {
      setArmed(armKey);
      return;
    }
    if (action.id === PRIMARY_ID) onChoose(panelRow);
    else onChooseAction(panelRow, action);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposingKey(event.nativeEvent)) return;
    const caretAtEnd =
      event.currentTarget.selectionStart === event.currentTarget.value.length &&
      event.currentTarget.selectionEnd === event.currentTarget.value.length;
    const commandK =
      event.metaKey &&
      !event.altKey &&
      !event.ctrlKey &&
      event.key.toLowerCase() === "k";
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === "ArrowDown") {
      handled();
      move(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      handled();
      move(activeIndex - 1);
    } else if (event.key === "PageDown") {
      handled();
      move(Math.min(activeIndex + 8, keys.length - 1));
    } else if (event.key === "PageUp") {
      handled();
      move(Math.max(activeIndex - 8, 0));
    } else if (event.key === "Enter") {
      handled();
      if (panel) chooseAction(currentAction);
      else choose(current);
    } else if (commandK) {
      handled();
      // ⌘K opens the row's actions and goes back from them; on a row with
      // none it closes the palette, as it opened it.
      if (panel) closeActions();
      else if (!openActions(current)) onClose();
    } else if (event.key === "ArrowRight" && !panel && caretAtEnd) {
      if (openActions(current)) handled();
    } else if (event.key === "ArrowLeft" && panel && query === "") {
      handled();
      closeActions();
    } else if (event.key === "Escape") {
      handled();
      if (panel) closeActions();
      else onClose();
    }
  };

  const kindLabel = current ? KIND_LABELS[current.kind] : "";
  const enterLabel = panel ? currentAction?.label : current?.primary;

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
        {panelRow && (
          <div className="palette-crumb">
            <span className="palette-crumb-kind">
              {KIND_LABELS[panelRow.kind]}
            </span>
            <span className="palette-crumb-title">{panelRow.title}</span>
          </div>
        )}
        <input
          aria-activedescendant={activeOption}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded="true"
          aria-label={
            panelRow
              ? `Search actions for ${panelRow.title}`
              : "Search sessions, tasks, workspaces and actions"
          }
          autoFocus
          className="palette-input"
          onChange={(event) => {
            setQuery(event.target.value);
            if (panel) setActiveAction(undefined);
            else setActiveKey(undefined);
            setArmed(undefined);
          }}
          onKeyDown={onKeyDown}
          placeholder={
            panelRow
              ? `Search actions for ${panelRow.title}…`
              : "Search sessions, tasks, workspaces and actions…"
          }
          ref={input}
          role="combobox"
          spellCheck={false}
          type="text"
          value={query}
        />
        <div
          aria-label={panelRow ? "Actions" : "Results"}
          className="palette-list"
          id={listId}
          role="listbox"
        >
          {panel
            ? actions.map((action) => {
                const isActive = action === currentAction;
                const armedHere = armed === `action:${action.id}`;
                return (
                  <div
                    aria-checked={action.checked}
                    aria-disabled={action.disabled || undefined}
                    aria-selected={isActive}
                    className="palette-row"
                    data-active={isActive ? "true" : undefined}
                    data-danger={action.danger ? "true" : undefined}
                    id={optionId(action.id)}
                    key={action.id}
                    onClick={() => chooseAction(action)}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => {
                      if (!isActive) {
                        setActiveAction(action.id);
                        setArmed(undefined);
                      }
                    }}
                    role="option"
                  >
                    <span className="palette-row-title">
                      {armedHere && action.confirm
                        ? `${action.label}: ${action.confirm} Press Enter again to confirm.`
                        : action.label}
                      {action.checked !== undefined && (
                        <span className="palette-row-state">
                          {action.checked ? " · on" : " · off"}
                        </span>
                      )}
                    </span>
                    {action.description && !armedHere && (
                      <span className="palette-row-detail">
                        {action.description}
                      </span>
                    )}
                    {action.keys && <KeyGlyphs glyphs={action.keys} />}
                  </div>
                );
              })
            : groups.map((group) => (
                <div
                  aria-labelledby={`${listId}-${group.id}`}
                  className="palette-group"
                  key={group.id}
                  role="group"
                >
                  <div
                    className="palette-group-title"
                    id={`${listId}-${group.id}`}
                    role="presentation"
                  >
                    {group.title}
                  </div>
                  {group.entries.map((row) => {
                    const isActive = row === current;
                    return (
                      <div
                        aria-disabled={row.disabled || undefined}
                        aria-selected={isActive}
                        className="palette-row"
                        data-active={isActive ? "true" : undefined}
                        id={optionId(row.key)}
                        key={row.key}
                        onClick={() => choose(row)}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseMove={() => {
                          if (!isActive) {
                            setActiveKey(row.key);
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
                        </span>
                        {row.subtitle && (
                          <span className="palette-row-detail">
                            {row.subtitle}
                          </span>
                        )}
                        {row.shortcut && <KeyGlyphs glyphs={row.shortcut} />}
                        <span className="palette-row-kind">
                          {KIND_LABELS[row.kind]}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
          {keys.length === 0 && (
            <p className="palette-empty" role="status">
              {panel
                ? "No action matches."
                : query.trim()
                  ? "Nothing matches."
                  : "Type to search sessions, tasks, workspaces and actions."}
            </p>
          )}
        </div>
        <footer aria-hidden="true" className="palette-footer">
          <span className="palette-footer-kind">
            {panelRow ? `Actions for ${panelRow.title}` : kindLabel}
          </span>
          {enterLabel && (
            <span className="palette-footer-hint">
              <KeyGlyphs glyphs="↩" /> {enterLabel}
            </span>
          )}
          {panel ? (
            <span className="palette-footer-hint">
              <KeyGlyphs glyphs="⎋" /> Back
            </span>
          ) : (
            current?.actions && (
              <span className="palette-footer-hint">
                <KeyGlyphs glyphs="⌘K" /> Actions
              </span>
            )
          )}
        </footer>
      </section>
    </div>
  );
}
