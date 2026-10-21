/**
 * The menu on a session card: rename, pin, color, rebirth and abilities.
 * Every session has the first three; rebirth and abilities are offered on
 * Claude and Codex agents. A workspace card has a shorter one: rename,
 * the rebirth its sessions default to, and its cloud workspace once this Mac
 * is signed in to a gateway.
 */
import {
  customSessionColor,
  DEFAULT_AUTO_REBIRTH_PERCENT,
  type AutoRebirthDto,
  type CloudWorkspaceDto,
  type NamedSessionColorDto,
  type SessionColorDto,
} from "@daedalus/protocol";
import { useState } from "react";
import { ConfirmButton } from "./ConfirmButton";
import { Menu, MenuDots } from "./Menu";
import { PercentInput } from "./PercentInput";
import { sessionColorStyle } from "./session-color-style";

export const SESSION_COLORS: readonly NamedSessionColorDto[] = [
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

/** `hsl()` as the `#rrggbb` a session color is kept in. */
function hslHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    const value =
      l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/**
 * The grid the rainbow swatch opens: ten hues from dark to light, and a row
 * of greys. Ten across, so it lines up under the swatch row.
 */
export const COLOR_GRID: readonly string[] = [
  ...[34, 46, 58, 72].flatMap((lightness) =>
    Array.from({ length: 10 }, (_, index) => hslHex(index * 36, 62, lightness)),
  ),
  ...Array.from({ length: 10 }, (_, index) => hslHex(0, 0, 18 + index * 8)),
];

/**
 * One swatch per color plus None, as a radio row, and last a rainbow swatch
 * that opens a grid of more colors under the row. Picking from the grid works
 * like picking a swatch: in a menu, it closes the menu.
 */
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
  const [gridOpen, setGridOpen] = useState(false);
  const custom = customSessionColor(value) ?? null;
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
      <button
        aria-checked={custom !== null}
        aria-expanded={gridOpen}
        aria-label="More colors"
        className="color-swatch color-swatch-more"
        onClick={(event) => {
          // Opening the grid keeps the menu open.
          event.stopPropagation();
          setGridOpen(!gridOpen);
        }}
        role={role}
        title={custom ? `Color ${custom}. More colors` : "More colors"}
        type="button"
      />
      {gridOpen && (
        <span aria-label="More colors" className="color-grid" role="group">
          {COLOR_GRID.map((hex) => (
            <button
              aria-checked={custom === hex}
              aria-label={hex}
              className="color-swatch"
              data-color={hex}
              key={hex}
              onClick={() => {
                setGridOpen(false);
                if (value !== hex) onChange(hex as SessionColorDto);
              }}
              role={role}
              style={sessionColorStyle(hex as SessionColorDto)}
              title={hex}
              type="button"
            />
          ))}
        </span>
      )}
    </span>
  );
}

const REBIRTH_WORDS = {
  session: {
    source: "the workspace's setting",
    off: "Never rebirth this session on its own",
    on: "Rebirth this session at a context percent of its own",
    percent: "Context percent that triggers this session's rebirth",
  },
  workspace: {
    source: "the global setting",
    off: "Never rebirth this workspace's sessions on their own",
    on: "Rebirth this workspace's sessions at a context percent of its own",
    percent: "Context percent that triggers a rebirth in this workspace",
  },
};

/**
 * A session's or workspace's own rebirth threshold: Default (the workspace's
 * or the global one, named in the heading), Off, or On at a percent of its
 * own, typed in the field that On shows.
 */
function RebirthChoices({
  value,
  inherited,
  subject = "session",
  onChange,
}: {
  value: AutoRebirthDto;
  /** What Default comes to: the workspace's or the global threshold. */
  inherited: number | null;
  /** Whose threshold this is; a workspace's Default is the global one. */
  subject?: "session" | "workspace";
  onChange: (value: AutoRebirthDto) => void;
}) {
  const mode = value === null ? "default" : value === "off" ? "off" : "on";
  const words = REBIRTH_WORDS[subject];
  const choices = [
    {
      mode: "default",
      label: "Default",
      title:
        inherited === null
          ? `Use ${words.source}, which is off`
          : `Use ${words.source}: rebirth at ${inherited}% context`,
      pick: () => onChange(null),
    },
    {
      mode: "off",
      label: "Off",
      title: words.off,
      pick: () => onChange("off"),
    },
    {
      mode: "on",
      label: "On",
      title: words.on,
      pick: () => onChange(inherited ?? DEFAULT_AUTO_REBIRTH_PERCENT),
    },
  ];
  return (
    <span
      aria-label="Automatic rebirth"
      className="rebirth-choices"
      role="group"
    >
      {choices.map((choice) => (
        <button
          aria-checked={mode === choice.mode}
          className="rebirth-choice"
          key={choice.mode}
          onClick={(event) => {
            // On keeps the menu open, for the percent field it shows.
            if (choice.mode === "on") event.stopPropagation();
            if (mode !== choice.mode) choice.pick();
          }}
          role="menuitemradio"
          title={choice.title}
          type="button"
        >
          {choice.label}
        </button>
      ))}
      {typeof value === "number" && (
        <PercentInput label={words.percent} onCommit={onChange} value={value} />
      )}
    </span>
  );
}

export function SessionMenu({
  name,
  pinned,
  color,
  autoRebirth,
  inheritedRebirth,
  routines,
  orchestration,
  offerAbilities,
  offerOrchestration,
  onRename,
  onPin,
  onColor,
  onAutoRebirth,
  onRoutines,
  onOrchestration,
}: {
  name: string;
  pinned: boolean;
  color: SessionColorDto | null;
  /** The session's own rebirth threshold; null takes its workspace's. */
  autoRebirth: AutoRebirthDto;
  /** The threshold Default comes to, or null for off. */
  inheritedRebirth: number | null;
  /** Whether the session holds the routines ability now. */
  routines: boolean;
  /** Whether the session leads a team. */
  orchestration: boolean;
  offerAbilities: boolean;
  /** False for a team's member, which cannot lead one. */
  offerOrchestration: boolean;
  onRename: () => void;
  onPin: (pinned: boolean) => void;
  onColor: (color: SessionColorDto | null) => void;
  onAutoRebirth: (value: AutoRebirthDto) => void;
  onRoutines: (granted: boolean) => void;
  onOrchestration: (granted: boolean) => void;
}) {
  return (
    <Menu
      align="end"
      className="session-card-menu"
      label={`More actions for ${name}`}
      menuLabel={`Actions for ${name}`}
      placement="left"
      summary={<MenuDots />}
      summaryClassName="session-card-action"
      title="Rename, pin, color, rebirth and abilities"
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
          <span className="menu-heading">
            Rebirth
            <span className="menu-heading-note">
              {autoRebirth === null
                ? inheritedRebirth === null
                  ? "workspace: off"
                  : `workspace: ${inheritedRebirth}%`
                : "own setting"}
            </span>
          </span>
          <RebirthChoices
            inherited={inheritedRebirth}
            onChange={onAutoRebirth}
            value={autoRebirth}
          />
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
                : "Grant routines. Ask the session for scheduled checks; nothing is sent to it."
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
          {offerOrchestration && (
            <button
              aria-checked={orchestration}
              className="quiet menu-item"
              onClick={() => onOrchestration(!orchestration)}
              role="menuitemcheckbox"
              title={
                orchestration
                  ? "End the team. Members keep running as ordinary sessions."
                  : "Lead a team: this session plans the work and adds members."
              }
              type="button"
            >
              <span className="menu-item-label">Orchestration</span>
              <span
                aria-hidden="true"
                className="menu-switch"
                data-on={orchestration ? "true" : undefined}
              />
            </button>
          )}
        </>
      )}
    </Menu>
  );
}

const CLOUD_STATUS_LABEL: Record<CloudWorkspaceDto["status"], string> = {
  starting: "starting",
  running: "running",
  sleeping: "sleeping",
  failed: "failed",
};

/** What the workspace menu offers for the workspace's cloud twin. */
export interface WorkspaceCloudControls {
  /** Its cloud workspace, or undefined when it has none yet. */
  workspace?: CloudWorkspaceDto;
  /** A create, sleep, wake or delete is on its way. */
  pending: boolean;
  onCreate: () => void;
  onSleep: () => void;
  onWake: () => void;
  onDelete: () => void;
}

export function WorkspaceMenu({
  name,
  autoRebirth,
  inheritedRebirth,
  onRename,
  onAutoRebirth,
  cloud,
}: {
  name: string;
  /** The workspace's own rebirth threshold; null takes the global one. */
  autoRebirth: AutoRebirthDto;
  /** The global threshold Default comes to, or null for off. */
  inheritedRebirth: number | null;
  onRename: () => void;
  onAutoRebirth: (value: AutoRebirthDto) => void;
  /** Absent while this Mac is not signed in to a cloud gateway. */
  cloud?: WorkspaceCloudControls;
}) {
  return (
    <Menu
      align="end"
      className="session-card-menu workspace-card-menu"
      label={`Settings of ${name}`}
      menuLabel={`Settings of ${name}`}
      placement="left"
      summary={<MenuDots />}
      summaryClassName="session-card-action"
      title="Rename and rebirth"
    >
      <button
        className="quiet menu-item"
        onClick={onRename}
        role="menuitem"
        type="button"
      >
        <span className="menu-item-label">Rename…</span>
      </button>
      <hr className="menu-separator" />
      <span className="menu-heading">
        Rebirth
        <span className="menu-heading-note">
          {autoRebirth === null
            ? inheritedRebirth === null
              ? "global: off"
              : `global: ${inheritedRebirth}%`
            : "own setting"}
        </span>
      </span>
      <RebirthChoices
        inherited={inheritedRebirth}
        onChange={onAutoRebirth}
        subject="workspace"
        value={autoRebirth}
      />
      {cloud && <WorkspaceCloudItems cloud={cloud} />}
    </Menu>
  );
}

export function WorkspaceCloudItems({
  cloud,
}: {
  cloud: WorkspaceCloudControls;
}) {
  const workspace = cloud.workspace;
  if (!workspace)
    return (
      <>
        <hr className="menu-separator" />
        <button
          className="quiet menu-item"
          data-testid="cloud-run"
          disabled={cloud.pending}
          onClick={cloud.onCreate}
          role="menuitem"
          title="Make a pod for this workspace on the cloud gateway, so new sessions can run there. The board and the journal stay on this Mac."
          type="button"
        >
          <span className="menu-item-label">
            {cloud.pending ? "Starting in cloud…" : "Run in cloud"}
          </span>
        </button>
      </>
    );
  const asleep = workspace.status === "sleeping";
  return (
    <>
      <hr className="menu-separator" />
      <span
        className="menu-heading"
        data-status={workspace.status}
        data-testid="cloud-status"
        title={workspace.reason ?? undefined}
      >
        Cloud
        <span className="menu-heading-note">
          {cloud.pending
            ? "working…"
            : `${CLOUD_STATUS_LABEL[workspace.status]}${
                workspace.status === "running" && !workspace.runnerOnline
                  ? ", runner offline"
                  : ""
              }`}
        </span>
      </span>
      {asleep ? (
        <button
          className="quiet menu-item"
          data-testid="cloud-wake"
          disabled={cloud.pending}
          onClick={cloud.onWake}
          role="menuitem"
          title="Start its pod again. Sessions that ended when it slept come back with Revive."
          type="button"
        >
          <span className="menu-item-label">Wake</span>
        </button>
      ) : (
        <button
          className="quiet menu-item"
          data-testid="cloud-sleep"
          disabled={cloud.pending || workspace.status === "failed"}
          onClick={cloud.onSleep}
          role="menuitem"
          title="Remove its pod and keep its volume. The sessions running there end; Wake and Revive bring them back."
          type="button"
        >
          <span className="menu-item-label">Sleep</span>
        </button>
      )}
      {/* Not a menuitem: choosing one closes the menu, and this needs its
          second click. */}
      <ConfirmButton
        armedLabel="Delete"
        armedTitle="Delete the cloud workspace: its pod, its volume and its token. This workspace stays on this Mac."
        className="quiet menu-item menu-item-danger"
        data-testid="cloud-delete"
        disabled={cloud.pending}
        onConfirm={cloud.onDelete}
        title="Delete the cloud workspace. Asks once more."
        type="button"
      >
        <span className="menu-item-label">Delete cloud workspace…</span>
      </ConfirmButton>
    </>
  );
}
