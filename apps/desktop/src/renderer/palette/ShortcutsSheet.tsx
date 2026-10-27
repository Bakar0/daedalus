/**
 * The ⌘/ sheet: every key the app has, searchable, grouped as the command
 * table groups them, with the keys elements answer to themselves after.
 * The sections for the area focus was in come first. A dialog with the
 * app's focus scope; Escape closes it and gives focus back.
 */
import type { CommandArea } from "@daedalus/protocol";
import { useMemo, useRef, useState } from "react";
import { allCommands } from "../commands";
import { KeyGlyphs } from "../keyboard-ui";
import { useFocusScope } from "../use-focus-scope";
import {
  commandSheetSections,
  ELEMENT_KEY_SECTIONS,
  filterSheetSections,
  orderSheetSections,
} from "./shortcut-sheet";

export function ShortcutsSheet({
  focusedAreas,
  onClose,
}: {
  /** Where focus was when the sheet opened, innermost first. */
  focusedAreas: readonly CommandArea[];
  onClose: () => void;
}) {
  const section = useRef<HTMLElement>(null);
  useFocusScope(section);
  const [query, setQuery] = useState("");
  const ordered = useMemo(
    () =>
      orderSheetSections(
        [...commandSheetSections(allCommands()), ...ELEMENT_KEY_SECTIONS],
        focusedAreas,
      ),
    [focusedAreas],
  );
  const shown = filterSheetSections(ordered, query);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <section
        aria-label="Keyboard shortcuts"
        aria-modal="true"
        className="modal modal-wide shortcuts-sheet"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
        ref={section}
        role="dialog"
        tabIndex={-1}
      >
        <div className="detail-title">
          <div>
            <span className="eyebrow">Daedalus</span>
            <h2>Keyboard shortcuts</h2>
          </div>
          <button className="quiet" onClick={onClose} type="button">
            Close
          </button>
        </div>
        <input
          aria-label="Search shortcuts"
          autoFocus
          className="shortcuts-search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name or key"
          type="search"
          value={query}
        />
        <div className="shortcuts-sections">
          {shown.map((group) => (
            <section
              aria-label={group.title}
              className="shortcuts-section"
              key={group.title}
            >
              <h3>{group.title}</h3>
              <dl>
                {group.rows.map((row) => (
                  <div className="shortcuts-row" key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>
                      {row.keys.map((glyphs, index) => (
                        <span key={`${glyphs}-${index}`}>
                          {index > 0 && (
                            <span className="shortcuts-or"> / </span>
                          )}
                          <KeyGlyphs glyphs={glyphs} />
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          {shown.length === 0 && (
            <p className="palette-empty" role="status">
              No key matches.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
