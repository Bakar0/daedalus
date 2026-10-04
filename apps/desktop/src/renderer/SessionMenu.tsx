/**
 * The menu on a session card: rename, pin, color and abilities. Every session
 * has the first three; abilities are offered on Claude and Codex agents.
 */
import type { SessionColorDto } from "@daedalus/protocol";
import { Menu } from "./Menu";

export const SESSION_COLORS: readonly SessionColorDto[] = [
  "red",
  "orange",
  "gold",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
];

const capitalize = (text: string) =>
  text.slice(0, 1).toUpperCase() + text.slice(1);

/** One swatch per color plus None, as a radio row. */
export function ColorSwatches({
  value,
  onChange,
  role = "radio",
}: {
  value: SessionColorDto | null;
  onChange: (color: SessionColorDto | null) => void;
  /** `menuitemradio` inside a menu, `radio` in a form. */
  role?: "radio" | "menuitemradio";
}) {
  return (
    <span
      aria-label="Session color"
      className="color-swatches"
      role={role === "radio" ? "radiogroup" : "group"}
    >
      {[null, ...SESSION_COLORS].map((color) => (
        <button
          aria-checked={value === color}
          aria-label={color ? capitalize(color) : "No color"}
          className="color-swatch"
          data-color={color ?? undefined}
          key={color ?? "none"}
          onClick={() => {
            if (value !== color) onChange(color);
          }}
          role={role}
          title={color ? capitalize(color) : "No color"}
          type="button"
        />
      ))}
    </span>
  );
}

function MenuDots() {
  return (
    <svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24">
      <circle cx="5.5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="18.5" cy="12" r="1.7" />
    </svg>
  );
}

export function SessionMenu({
  name,
  pinned,
  color,
  routines,
  offerAbilities,
  onRename,
  onPin,
  onColor,
  onRoutines,
}: {
  name: string;
  pinned: boolean;
  color: SessionColorDto | null;
  /** Whether the session holds the routines ability now. */
  routines: boolean;
  offerAbilities: boolean;
  onRename: () => void;
  onPin: (pinned: boolean) => void;
  onColor: (color: SessionColorDto | null) => void;
  onRoutines: (granted: boolean) => void;
}) {
  return (
    <Menu
      align="end"
      className="session-card-menu"
      label={`More actions for ${name}`}
      menuLabel={`Actions for ${name}`}
      summary={<MenuDots />}
      summaryClassName="session-card-action"
      title="Rename, pin, color and abilities"
    >
      <button
        className="quiet menu-item"
        onClick={onRename}
        role="menuitem"
        type="button"
      >
        <span className="menu-item-label">Rename…</span>
      </button>
      <button
        className="quiet menu-item"
        onClick={() => onPin(!pinned)}
        role="menuitem"
        type="button"
      >
        <span className="menu-item-label">
          {pinned ? "Unpin" : "Pin to top"}
        </span>
      </button>
      <hr className="menu-separator" />
      <span className="menu-heading">Color</span>
      <ColorSwatches onChange={onColor} role="menuitemradio" value={color} />
      {offerAbilities && (
        <>
          <hr className="menu-separator" />
          <span className="menu-heading">Abilities</span>
          <button
            aria-checked={routines}
            className="quiet menu-item"
            onClick={() => onRoutines(!routines)}
            role="menuitemcheckbox"
            title={
              routines
                ? "Revoke routines. The routines are kept and come back on a new grant."
                : "Grant routines. The session gets a note and can run scheduled checks."
            }
            type="button"
          >
            <span className="menu-item-label">Routines</span>
            {/* The look of the skills switch; the item itself is the control. */}
            <span
              aria-hidden="true"
              className="menu-switch"
              data-on={routines ? "true" : undefined}
            />
          </button>
        </>
      )}
    </Menu>
  );
}
