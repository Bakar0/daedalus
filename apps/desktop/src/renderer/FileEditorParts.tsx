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

export function PlainRow({
  label,
  note,
  onSelect,
  selected,
}: {
  label: string;
  note?: string;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <li>
      <button
        aria-current={selected ? "true" : undefined}
        className={`workflows-file${selected ? " selected" : ""}`}
        onClick={onSelect}
        type="button"
      >
        <span className="workflows-file-name">{label}</span>
        {note && <small>{note}</small>}
      </button>
    </li>
  );
}

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
 * One file, edited as the markdown it is. Save is on while the text differs
 * from what is saved, or the file is new; Cmd-S saves too.
 */
export function FileDetail({
  alert,
  children,
  dirty,
  draft,
  hint,
  label,
  onDelete,
  onDraft,
  onRevert,
  onSave,
  path,
  saved,
  saving,
  title,
}: {
  /** Why the last save was refused, or what is wrong with the file. */
  alert?: string | null;
  /** Shown between the heading and the text, such as a workflow's steps. */
  children?: ReactNode;
  dirty: boolean;
  draft: string;
  hint: string;
  label: string;
  /** Present when the file can be deleted. */
  onDelete?: () => void;
  onDraft: (text: string) => void;
  onRevert: () => void;
  onSave: () => void;
  path: string;
  saved: string;
  saving: boolean;
  title: string;
}) {
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
          <button
            className="quiet"
            disabled={draft === saved || saving}
            onClick={onRevert}
            type="button"
          >
            Revert
          </button>
          <button
            className="primary"
            disabled={!dirty || saving}
            onClick={onSave}
            type="button"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </header>
      {children}
      {alert && (
        <p className="workflows-refusal" role="alert">
          {alert}
        </p>
      )}
      <textarea
        aria-label="File text"
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
    </section>
  );
}
