/**
 * The pieces the Workflows and Custom instructions tabs share: the file list,
 * the line at the top linking to the docs, and the file on the right with its
 * Save, Revert and Delete.
 */
import type { ReactNode } from "react";
import { askConfirm } from "./dialogs";

/** The repository's docs, which the tabs' intro lines link to. */
export const DOCS_URL = "https://github.com/Bakar0/daedalus/blob/main/docs";

/** Asks before a file with unsaved changes is left. */
export const confirmDiscard = () =>
  askConfirm({
    title: "Discard changes?",
    message: "This file has changes that are not saved.",
    confirmLabel: "Discard",
    danger: true,
  });

export function Group({
  children,
  onNew,
  title,
}: {
  children: ReactNode;
  onNew?: () => void;
  title: string;
}) {
  return (
    <section>
      <header>
        <h3>{title}</h3>
        {onNew && (
          <button className="quiet" onClick={onNew} type="button">
            + New
          </button>
        )}
      </header>
      <ul>{children}</ul>
    </section>
  );
}

/** What the tab is for, in one line, and a link to the docs with examples. */
export function TabIntro({
  children,
  onReadMore,
}: {
  children: ReactNode;
  onReadMore: () => void;
}) {
  return (
    <p className="workflows-intro">
      {children}{" "}
      <button className="workflow-pane-link" onClick={onReadMore} type="button">
        Read more and examples <span aria-hidden="true">↗</span>
      </button>
    </p>
  );
}

/**
 * One file. It opens on `view`, the file read as the agent reads it, and
 * Edit turns it into its markdown; Save goes back to the view, and Cancel
 * drops the changes. A file with no view, such as a new one, is edited
 * straight away. Cmd-S saves.
 */
export function FileDetail({
  alert,
  children,
  dirty,
  draft,
  editing,
  hint,
  label,
  onCancel,
  onDelete,
  onDraft,
  onEdit,
  onSave,
  path,
  saving,
  title,
  view,
}: {
  /** Why the last save was refused, or what is wrong with the file. */
  alert?: string | null;
  /** Shown under the heading in both modes, such as a step's gate. */
  children?: ReactNode;
  dirty: boolean;
  draft: string;
  editing: boolean;
  hint: string;
  label: string;
  onCancel: () => void;
  /** Present when the file can be deleted. */
  onDelete?: () => void;
  onDraft: (text: string) => void;
  onEdit: () => void;
  onSave: () => void;
  path: string;
  saving: boolean;
  title: string;
  view?: ReactNode;
}) {
  const reading = !editing && view !== undefined;
  return (
    <section aria-label={label} className="workflows-detail">
      <header className="workflows-detail-heading">
        <div>
          <h2>{title}</h2>
          <small>{path}</small>
        </div>
        <div className="workflows-detail-actions">
          {onDelete && (
            <button className="danger-link" onClick={onDelete} type="button">
              Delete
            </button>
          )}
          {reading ? (
            <button className="quiet" onClick={onEdit} type="button">
              Edit
            </button>
          ) : (
            <>
              <button
                className="quiet"
                disabled={saving}
                onClick={onCancel}
                type="button"
              >
                Cancel
              </button>
              <button
                className="primary"
                disabled={!dirty || saving}
                onClick={onSave}
                type="button"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          )}
        </div>
      </header>
      {children}
      {alert && (
        <p className="workflows-refusal" role="alert">
          {alert}
        </p>
      )}
      {reading ? (
        <div className="file-view">{view}</div>
      ) : (
        <>
          <textarea
            aria-label="File text"
            autoFocus
            className="workflows-text"
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                event.preventDefault();
                if (dirty && !saving) onSave();
              }
            }}
            spellCheck={false}
            value={draft}
          />
          <p className="workflows-hint">{hint}</p>
        </>
      )}
    </section>
  );
}

/** A file in the list: its name and a count on one line, a summary under it. */
export function FileRow({
  badge,
  meta,
  name,
  onSelect,
  problem,
  selected,
  summary,
}: {
  /** A short tag after the name, such as "gate". */
  badge?: string;
  /** Counts on the right, such as "6 steps · 1 gate". */
  meta?: string;
  name: string;
  onSelect: () => void;
  problem?: string | null;
  selected: boolean;
  summary?: string;
}) {
  return (
    <li>
      <button
        aria-current={selected ? "true" : undefined}
        className={`workflows-file${selected ? " selected" : ""}`}
        onClick={onSelect}
        type="button"
      >
        <span className="workflows-file-line">
          <span className="workflows-file-name">
            {name}
            {badge && <span className="workflow-gate">{badge}</span>}
            {problem && (
              <span className="workflows-problem-mark" title={problem}>
                !
              </span>
            )}
          </span>
          {meta && <span className="workflows-file-meta">{meta}</span>}
        </span>
        {summary && <small>{summary}</small>}
      </button>
    </li>
  );
}
