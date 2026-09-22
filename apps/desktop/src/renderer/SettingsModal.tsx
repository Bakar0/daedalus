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
import type { DesktopSettingsDto, RpcResult } from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { SkillsPanel } from "./SkillsPanel";

export const SETTINGS_SECTIONS = [
  { id: "general", label: "General" },
  { id: "skills", label: "Skills" },
  { id: "sessions", label: "Sessions" },
  { id: "notifications", label: "Notifications" },
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
  perform,
}: {
  busy: boolean;
  client: DesktopClient;
  onError: (message: string | undefined) => void;
  onFocusMode: (enabled: boolean) => void;
  onSection: (section: SettingsSection) => void;
  onTheme: (theme: "dark" | "light") => void;
  perform: <T>(operation: Promise<RpcResult<T>>) => Promise<T | undefined>;
  section: SettingsSection;
  settings: DesktopSettingsDto;
  theme: "dark" | "light";
}) {
  return (
    <div className="settings">
      <nav aria-label="Settings sections" className="settings-nav">
        {SETTINGS_SECTIONS.map((entry) => (
          <button
            aria-current={entry.id === section ? "page" : undefined}
            className={entry.id === section ? "is-current" : ""}
            key={entry.id}
            onClick={() => onSection(entry.id)}
            type="button"
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <div className="settings-pane">
        {section === "general" ? (
          <section className="settings-section">
            <h3>Appearance</h3>
            <label className="settings-choice">
              <span>
                <strong>Theme</strong>
              </span>
              <select
                aria-label="Theme"
                onChange={(event) =>
                  onTheme(event.target.value as "dark" | "light")
                }
                value={theme}
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
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

            <h3>Agent executables</h3>
            <div className="provider-grid">
              {settings.providers.map((item) => (
                <div key={item.name}>
                  <span
                    className={`agent-dot tone-${item.available ? "idle" : "lost"}`}
                  />
                  <strong>{item.name}</strong>
                  <code>{item.executable}</code>
                  <small>
                    {item.available ? "Available" : "Not found on PATH"}
                  </small>
                </div>
              ))}
            </div>
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
          </section>
        ) : undefined}
      </div>
    </div>
  );
}
