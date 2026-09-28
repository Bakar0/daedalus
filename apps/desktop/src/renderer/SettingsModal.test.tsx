import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { AppUpdateDto, DesktopSettingsDto } from "@daedalus/protocol";
import {
  SETTINGS_SECTIONS,
  SettingsModal,
  type SettingsSection,
} from "./SettingsModal";
import type { DesktopClient } from "./client-types";

const settings: DesktopSettingsDto = {
  version: "0.7.0",
  channel: "dev",
  home: "/Users/someone/.daedalus-dev",
  workspaceRoot: "/Users/someone/.daedalus-dev/workspaces",
  databasePath: "/Users/someone/.daedalus-dev/state.db",
  repositoryRoot: "/Users/someone/.daedalus-dev/repos",
  tmuxAvailable: true,
  tmuxVersion: "3.7c",
  workspaceInstructionFilesEnabled: true,
  autoRestoreSessionsEnabled: true,
  focusMode: false,
  providers: [
    { name: "claude", executable: "/usr/local/bin/claude", available: true },
  ],
};

const client = {
  request: {},
} as unknown as DesktopClient;

const render = (section: SettingsSection) =>
  renderToStaticMarkup(
    <SettingsModal
      busy={false}
      client={client}
      onError={() => undefined}
      onFocusMode={() => undefined}
      onSection={() => undefined}
      onTheme={() => undefined}
      perform={async () => undefined}
      section={section}
      settings={settings}
      theme="dark"
    />,
  );

describe("SettingsModal", () => {
  test("shows one section at a time, so the dialog cannot outgrow the window", () => {
    // The bug this replaced was a single list of everything, tall enough to
    // run off the top and the bottom at once with nothing to scroll.
    const general = render("general");
    expect(general).toContain("Create workspace agent guidance");
    expect(general).not.toContain("Focus mode");
    expect(general).not.toContain("state.db");

    const notifications = render("notifications");
    expect(notifications).toContain("Focus mode");
    expect(notifications).not.toContain("Create workspace agent guidance");
  });

  test("every section is reachable and marks the current one", () => {
    const markup = render("skills");
    for (const entry of SETTINGS_SECTIONS)
      expect(markup).toContain(entry.label);
    expect(markup).toContain('aria-current="page"');
  });

  test("read-only facts live in About, not in front of the controls", () => {
    const about = render("about");
    expect(about).toContain("state.db");
    expect(about).toContain("0.7.0 · dev");
    expect(about).not.toContain("Focus mode");
  });

  test("Sessions carries recovery and the agent executables", () => {
    const sessions = render("sessions");
    expect(sessions).toContain("Bring sessions back on startup");
    expect(sessions).toContain("/usr/local/bin/claude");
  });
});

const renderAbout = (
  update: AppUpdateDto | null,
  options: { checking?: boolean; channel?: string } = {},
) =>
  renderToStaticMarkup(
    <SettingsModal
      busy={false}
      client={client}
      onError={() => undefined}
      onFocusMode={() => undefined}
      onSection={() => undefined}
      onTheme={() => undefined}
      perform={async () => undefined}
      section="about"
      settings={{
        ...settings,
        version: "0.8.2",
        channel: options.channel ?? "stable",
      }}
      theme="dark"
      updates={{
        update,
        checking: options.checking ?? false,
        onCheck: () => undefined,
        onInstall: () => undefined,
      }}
    />,
  );

describe("SettingsModal updates", () => {
  // The answer used to go only to the banner, which this dialog covers, so
  // the button looked like it did nothing.
  test("a check answers in About while it runs and after", () => {
    expect(renderAbout(null, { checking: true })).toContain(
      "Checking for updates…",
    );
    const current = renderAbout({ state: "current", currentVersion: "0.8.2" });
    expect(current).toContain("Daedalus 0.8.2 is the latest version.");
    expect(current).toContain("Check for updates");
  });

  test("an offer puts Update and restart in About and a dot on its tab", () => {
    const markup = renderAbout({
      state: "available",
      currentVersion: "0.8.2",
      version: "0.8.3",
    });
    expect(markup).toContain("Daedalus 0.8.3 is available");
    expect(markup).toContain("Update and restart");
    expect(markup).not.toContain("Check for updates");
    expect(markup).toContain('aria-label="Update available"');
  });

  test("nothing can be pressed while the update installs", () => {
    const markup = renderAbout({
      state: "downloading",
      currentVersion: "0.8.2",
      version: "0.8.3",
    });
    expect(markup).toContain("Downloading Daedalus 0.8.3…");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Check for updates/);
  });

  test("dev builds have no update row", () => {
    expect(renderAbout(null, { channel: "dev" })).not.toContain(
      "Check for updates",
    );
  });
});
