/**
 * The task drawer's overflow menu, at the right end of its action bar (#34)
 * beside Edit. It holds the two actions that apply to every task whatever
 * its lane: drafting the brief with an agent, and deleting the task, last
 * and in the danger colour. When the bar itself offers Draft brief, because
 * the brief is empty, the menu leaves it out rather than say it twice.
 */
import { Menu } from "./Menu";

export function TaskActionsMenu({
  canDraftBrief,
  onDelete,
  onDraftBrief,
  showDraftBrief = true,
}: {
  /** False when tmux is missing, so no session can start. */
  canDraftBrief: boolean;
  onDelete: () => void;
  onDraftBrief: () => void;
  /** False when the action bar already offers Draft brief. */
  showDraftBrief?: boolean;
}) {
  return (
    <Menu
      align="end"
      className="task-actions-menu"
      label="More task actions"
      menuLabel="Task actions"
      summary={
        <svg aria-hidden="true" className="menu-more" viewBox="0 0 24 24">
          <circle cx="5.5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="18.5" cy="12" r="1.7" />
        </svg>
      }
      summaryClassName="task-actions-trigger"
      title="More actions"
    >
      {showDraftBrief && (
        <>
          <button
            className="quiet menu-item"
            disabled={!canDraftBrief}
            onClick={onDraftBrief}
            role="menuitem"
            title="Start a session that reads the workspace and writes this brief back. It does not start the task."
            type="button"
          >
            <span className="menu-item-label">Draft brief with agent</span>
          </button>
          <hr className="menu-separator" />
        </>
      )}
      <button
        className="quiet menu-item menu-item-danger"
        onClick={onDelete}
        role="menuitem"
        type="button"
      >
        <span className="menu-item-label">Delete task</span>
      </button>
    </Menu>
  );
}
