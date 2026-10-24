/**
 * Settings.
 *
 * The old version was one `<dl>` that grew until it ran off the top and bottom
 * of the screen with no way to scroll, because the modal had no height cap and
 * the list had no container of its own. Adding the Skills panel is what made
 * that visible, but the shape was already wrong: a flat list of every setting
 * in the app, ordered by when each one happened to be written.
 *
 * The rebuild follows the usual advice for a settings surface with more than a
 * handful of entries. Categories in a fixed sidebar, one scrolling pane on the
 * right, the dialog sized to the viewport so it can never outgrow the window,
 * and settings grouped by the task they belong to rather than by type. Read-
 * only facts about the install are their own section instead of the first
 * thing between the user and every control.
 */
import React from "react";
import { PercentInput } from "./PercentInput";
import {
  DEFAULT_AUTO_REBIRTH_PERCENT,
  type AppUpdateDto,
  type DesktopSettingsDto,
  type GatewayInstallDto,
  type IntegratedTerminalDto,
  type RpcResult,
} from "@daedalus/protocol";
import { AccountsPanel } from "./AccountsPanel";
import { CloudPanel } from "./CloudPanel";
import type { DesktopClient } from "./client-types";
import { AccountPanel, showsPro, useRemoteState } from "./ProPlan";
import { RemotePanel } from "./RemotePanel";
import { SkillsPanel } from "./SkillsPanel";
import { updateMessage } from "./UpdateBanner";
import { APP_THEMES, type AppTheme } from "./theme";

export const SETTINGS_SECTIONS = [
  { id: "account", label: "Account" },
  { id: "general", label: "General" },
  { id: "agents", label: "Agents" },
  { id: "skills", label: "Skills" },
  { id: "sessions", label: "Sessions" },
  { id: "notifications", label: "Notifications" },
  { id: "remote", label: "Remote" },
  { id: "cloud", label: "Cloud" },
  { id: "about", label: "About" },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

/** One switch with a title and the sentence that explains what it costs. */
export function SettingRow({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  description: React.ReactNode;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  title: string;
}) {
  return (
    <label className="settings-row">
      <input
        checked={checked}
        className="switch"
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}

/** A read-only fact about this install. */
export function SettingFact({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="settings-fact">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

/** What Settings → About needs to show and act on the update prompt. */
export interface SettingsUpdateControls {
  update: AppUpdateDto | null;
  checking: boolean;
  onCheck: () => void;
  onInstall: () => void;
}

/**
 * The update row in About. It answers where the button was pressed: the
 * banner under the top bar is behind this dialog, so a result shown only
 * there reads as a button that did nothing.
 */
export function SettingsUpdateRow({
  update,
  checking,
  onCheck,
  onInstall,
}: SettingsUpdateControls) {
  const working =
    checking ||
    update?.state === "downloading" ||
    update?.state === "restarting";
  const status = checking
    ? "Checking for updates…"
    : update
      ? updateMessage(update)
      : undefined;
  return (
    <div
      className={`settings-update${update?.state === "error" ? " is-error" : ""}`}
      data-update-state={checking ? "checking" : (update?.state ?? "idle")}
    >
      {status ? (
        <p aria-live="polite" className="settings-update-status">
          {status}
        </p>
      ) : undefined}
      {update?.state === "available" && !checking ? (
        <button className="settings-update-install" onClick={onInstall}>
          Update and restart
        </button>
      ) : (
        <button
          className="settings-update-check"
          disabled={working}
          onClick={onCheck}
        >
          Check for updates
        </button>
      )}
    </div>
  );
}

export function SettingsModal({
  settings,
  theme,
  busy,
  client,
  section,
  onSection,
  onTheme,
  onError,
  onFocusMode,
  renderTerminal,
  perform,
  updates,
  gatewayInstall,
}: {
  busy: boolean;
  client: DesktopClient;
  onError: (message: string | undefined) => void;
  onFocusMode: (enabled: boolean) => void;
  /** Draws a terminal Settings opened, such as a sign-in, in place. */
  renderTerminal: (terminal: IntegratedTerminalDto) => React.ReactNode;
  onSection: (section: SettingsSection) => void;
  onTheme: (theme: AppTheme) => void;
  perform: <T>(operation: Promise<RpcResult<T>>) => Promise<T | undefined>;
  section: SettingsSection;
  settings: DesktopSettingsDto;
  theme: AppTheme;
  updates?: SettingsUpdateControls;
  /** A gateway install in progress, for Settings › Cloud. */
  gatewayInstall?: GatewayInstallDto;
}) {
  const updateAvailable = updates?.update?.state === "available";
  // Remote is phone access, a Pro feature: hidden unless the account has Pro
  // or is an admin.
  const { data: remoteState } = useRemoteState(client, 5_000);
  const pro = showsPro(remoteState);
  return (
    <div className="settings">
      <nav aria-label="Settings sections" className="settings-nav">
        {SETTINGS_SECTIONS.filter((entry) => entry.id !== "remote" || pro).map(
          (entry) => (
            <button
              aria-current={entry.id === section ? "page" : undefined}
              className={entry.id === section ? "is-current" : ""}
              // A Pro feature: the tag is drawn by CSS, so the label stays
              // the button's text.
              data-pro={entry.id === "remote" ? "" : undefined}
              key={entry.id}
              onClick={() => onSection(entry.id)}
              type="button"
            >
              {entry.label}
              {entry.id === "about" && updateAvailable ? (
                <span
                  aria-label="Update available"
                  className="update-dot"
                  role="img"
                />
              ) : undefined}
            </button>
          ),
        )}
      </nav>

      <div className="settings-pane">
        {section === "account" ? (
          <section className="settings-section">
            <AccountPanel busy={busy} client={client} perform={perform} />
          </section>
        ) : undefined}

        {section === "general" ? (
          <section className="settings-section">
            <h3>Appearance</h3>
            <label className="settings-choice">
              <span>
                <strong>Theme</strong>
              </span>
              <select
                aria-label="Theme"
                onChange={(event) => onTheme(event.target.value as AppTheme)}
                value={theme}
              >
                {APP_THEMES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <h3>Workspaces</h3>
            <SettingRow
              checked={settings.workspaceInstructionFilesEnabled}
              disabled={busy}
              description="Keep Daedalus-managed AGENTS.md and CLAUDE.md in workspace roots, so an agent starting there knows where the brief, the journal and the repositories are."
              onChange={(enabled) =>
                void perform(
                  client.request.workspaceInstructionFilesSet({ enabled }),
                )
              }
              title="Create workspace agent guidance"
            />
          </section>
        ) : undefined}

        {section === "agents" ? (
          <section className="settings-section">
            <AccountsPanel
              busy={busy}
              client={client}
              renderTerminal={renderTerminal}
              perform={perform}
              settings={settings}
            />
          </section>
        ) : undefined}

        {section === "skills" ? (
          <section className="settings-section">
            <SkillsPanel busy={busy} client={client} onError={onError} />
          </section>
        ) : undefined}

        {section === "sessions" ? (
          <section className="settings-section">
            <h3>Recovery</h3>
            <SettingRow
              checked={settings.autoRestoreSessionsEnabled}
              disabled={busy}
              description="A reboot kills the tmux server every session lives in. Daedalus resumes each conversation when it next starts, so agents come back idle at their prompt with their history. Nothing is sent to them and no work restarts on its own."
              onChange={(enabled) =>
                void perform(client.request.autoRestoreSessionsSet({ enabled }))
              }
              title="Bring sessions back on startup"
            />
            <h3>Startup</h3>
            <SettingRow
              checked={settings.trustSessionFoldersEnabled}
              disabled={busy}
              description="Codex and Claude ask before they work in a folder they have not seen. With this on, Daedalus records that answer in their settings for each session folder it creates, so a session opens at its prompt. Turn it off to answer those prompts yourself in the session's terminal."
              onChange={(enabled) =>
                void perform(client.request.trustSessionFoldersSet({ enabled }))
              }
              title="Trust session folders"
            />
            <h3>Rebirth</h3>
            <SettingRow
              checked={settings.autoRebirthPercent !== null}
              disabled={busy}
              description="When a session's context fills to this point, it writes a rebirth note and a fresh agent with an empty context takes over its work. A workspace sets its own in its board settings, and a session in its card menu; both start on this default."
              onChange={(enabled) =>
                void perform(
                  client.request.autoRebirthSet({
                    percent: enabled ? DEFAULT_AUTO_REBIRTH_PERCENT : null,
                  }),
                )
              }
              title="Rebirth sessions automatically"
            />
            {settings.autoRebirthPercent !== null && (
              <div className="settings-percent-row">
                At
                <PercentInput
                  disabled={busy}
                  label="Context percent that triggers a rebirth"
                  onCommit={(percent) =>
                    void perform(client.request.autoRebirthSet({ percent }))
                  }
                  value={settings.autoRebirthPercent}
                />
                of the context window
              </div>
            )}
          </section>
        ) : undefined}

        {section === "notifications" ? (
          <section className="settings-section">
            <h3>Interruptions</h3>
            <SettingRow
              checked={settings.focusMode}
              disabled={busy}
              description="Stop toasts and desktop notifications. Indicators and attention badges keep updating, and a badge being cleared always goes through."
              onChange={onFocusMode}
              title="Focus mode"
            />
          </section>
        ) : undefined}

        {section === "remote" && pro ? (
          <section className="settings-section">
            <RemotePanel
              busy={busy}
              client={client}
              onOpenAccount={() => onSection("account")}
              perform={perform}
            />
          </section>
        ) : undefined}

        {section === "cloud" ? (
          <section className="settings-section">
            <CloudPanel
              busy={busy}
              client={client}
              install={gatewayInstall}
              perform={perform}
            />
          </section>
        ) : undefined}

        {section === "about" ? (
          <section className="settings-section">
            <h3>This build</h3>
            <div className="settings-facts">
              <SettingFact
                label="Version"
                value={
                  settings.channel === "stable"
                    ? settings.version
                    : `${settings.version} · ${settings.channel}`
                }
              />
              <SettingFact
                label="tmux"
                value={settings.tmuxVersion ?? "Not found"}
              />
              <SettingFact label="Daedalus home" value={settings.home} />
              <SettingFact
                label="Workspace root"
                value={settings.workspaceRoot}
              />
              <SettingFact label="Database" value={settings.databasePath} />
              <SettingFact
                label="Repositories"
                value={settings.repositoryRoot}
              />
            </div>
            {settings.channel !== "dev" && updates ? (
              <SettingsUpdateRow {...updates} />
            ) : undefined}
          </section>
        ) : undefined}
      </div>
    </div>
  );
}
