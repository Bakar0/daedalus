/**
 * The task drawer's overflow menu, at the right end of its action bar (#34)
 * beside Edit. It holds the one action that is never routine: deleting the
 * task, in the danger colour and behind its confirm. Everything a person
 * does often, drafting the brief included, is a button in the bar.
 */
import { Menu } from "./Menu";

export function TaskActionsMenu({ onDelete }: { onDelete: () => void }) {
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
