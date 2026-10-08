/**
 * The page `scripts/settings-ui-check.ts` drives.
 *
 * Settings is opened on load, and the discovered-skill list is deliberately
 * long. The bug this check exists for was a dialog with no height cap: it grew
 * past the top and the bottom of the window at once, with nothing to scroll
 * and no way to reach the controls. A short list would not reproduce it.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type {
  DesktopSnapshotDto,
  DiscoveredSkillDto,
  SkillListingDto,
} from "@daedalus/protocol";
import { App } from "./App";
import type { DesktopClient } from "./client-types";
import "./styles.css";

const snapshot = {
  workspaces: [
    {
      id: "settings-test-workspace",
      slug: "settings-test",
      name: "Settings test",
      path: "/tmp/settings-test",
      createdAt: "2026-09-14T00:00:00.000Z",
      kind: "login",
      updatedAt: "2026-09-14T00:00:00.000Z",
      archivedAt: null,
      available: true,
      position: 1,
      startSetsInProgress: true,
      autoHandoffPercent: null,
      defaultProvider: null,
      defaultModel: null,
      defaultClaudeAccount: null,
      defaultCodexAccount: null,
    },
  ],
  tasks: [],
  agents: [],
  terminals: [],
  repositories: [],
  worktrees: [],
  sessionTelemetry: [],
  providerUsage: [],
  sessionActivity: [],
  attention: [],
  toasts: [],
  abilities: [],
  teams: [],
  routines: [],
  routineReports: [],
  settings: {
    version: "0.7.0",
    channel: "stable",
    home: "/Users/someone/.daedalus-dev",
    workspaceRoot: "/Users/someone/.daedalus-dev/workspaces",
    databasePath: "/Users/someone/.daedalus-dev/state.db",
    repositoryRoot: "/Users/someone/.daedalus-dev/repos",
    tmuxAvailable: true,
    tmuxVersion: "3.7c",
    workspaceInstructionFilesEnabled: true,
    autoRestoreSessionsEnabled: true,
    focusMode: false,
    accounts: [
      {
        provider: "claude",
        account: "default",
        name: "Default",
        directory: "/Users/someone/.claude",
        createdAt: null,
        kind: "login",
      },
      {
        provider: "claude",
        account: "personal-1a2b",
        name: "Personal",
        directory: "/Users/someone/.daedalus-dev/accounts/claude/personal-1a2b",
        createdAt: "2026-10-06T00:00:00.000Z",
        kind: "login",
      },
      {
        provider: "claude",
        account: "work-api-9c1d",
        name: "Work API",
        directory: "/Users/someone/.daedalus-dev/accounts/claude/work-api-9c1d",
        createdAt: "2026-10-07T00:00:00.000Z",
        kind: "api-key",
      },
      {
        provider: "codex",
        account: "default",
        name: "Default",
        directory: "/Users/someone/.codex",
        createdAt: null,
        kind: "login",
      },
    ],
    providers: [
      { name: "claude", executable: "/usr/local/bin/claude", available: true },
      { name: "codex", executable: "codex", available: false },
    ],
  },
} as unknown as DesktopSnapshotDto;

/** Spread across sources, so the grouping and the collapsing are exercised. */
const SOURCES = [
  {
    source: "claude-personal" as const,
    sourcePath: "/Users/someone/.claude/skills",
    providers: ["claude"] as const,
    origin: "user" as const,
    count: 8,
  },
  {
    source: "agents-personal" as const,
    sourcePath: "/Users/someone/.agents/skills",
    providers: ["codex", "cursor"] as const,
    origin: "user" as const,
    count: 5,
  },
  {
    source: "claude-plugin" as const,
    sourcePath: "/Users/someone/.claude/plugins/pstack/skills",
    sourceName: "pstack",
    providers: ["claude"] as const,
    origin: "plugin" as const,
    count: 3,
  },
  // Cursor-only, where no provider offers a switch and the control has to say
  // so rather than pretend.
  {
    source: "cursor-personal" as const,
    sourcePath: "/Users/someone/.cursor/skills",
    providers: ["cursor"] as const,
    origin: "user" as const,
    count: 2,
  },
  // A second plugin, because one "Claude plugin" heading covering several
  // different plugins is the thing this grouping replaced.
  {
    source: "claude-plugin" as const,
    sourcePath: "/Users/someone/.claude/plugins/marketplace/toolkit/skills",
    sourceName: "toolkit",
    providers: ["claude"] as const,
    origin: "plugin" as const,
    count: 2,
  },
];

const discovered: DiscoveredSkillDto[] = SOURCES.flatMap((group, groupIndex) =>
  Array.from({ length: group.count }, (_unused, index) => {
    const name = `${group.source.split("-")[0]}-skill-${index + 1}`;
    return {
      name,
      description:
        "A skill that lives somewhere on this machine and is long enough in its description to wrap onto a second line.",
      skillPath: `${group.sourcePath}/${name}/SKILL.md`,
      providers: [...group.providers],
      origin: group.origin,
      source: group.source,
      sourcePath: group.sourcePath,
      ...("sourceName" in group ? { sourceName: group.sourceName } : {}),
      invocation: index % 3 === 0 ? "user-only" : "auto",
      visibility: index === 1 ? ("off" as const) : ("on" as const),
      ...(groupIndex === 2 && index === 0
        ? { problem: "unreadable-frontmatter" as const }
        : {}),
    };
  }),
);

const listing: SkillListingDto = {
  managed: [
    {
      id: "daedalus-control",
      title: "Daedalus control",
      summary: "Drives Daedalus through the daedal CLI.",
      supportsAlways: false,
      enabled: true,
      mode: "on-demand",
      artifacts: [
        {
          kind: "skill",
          path: "/Users/someone/.claude/skills/daedalus-control-dev",
          present: true,
          blocked: false,
        },
      ],
    },
    {
      id: "unslop",
      title: "Unslop",
      summary: "Cuts AI tells from writing.",
      supportsAlways: true,
      enabled: true,
      mode: "always",
      artifacts: [
        {
          kind: "skill",
          path: "/Users/someone/.claude/skills/unslop-dev",
          present: true,
          blocked: false,
        },
        {
          kind: "style",
          path: "/Users/someone/.claude/output-styles/Unslop-dev.md",
          present: true,
          blocked: false,
        },
        {
          kind: "instructions",
          path: "/Users/someone/.codex/AGENTS.md",
          present: true,
          blocked: false,
        },
      ],
    },
  ],
  discovered,
};

const listeners = new Set<() => void>();
const client = {
  request: {
    snapshot: async () => ({ ok: true, data: snapshot }),
    skillList: async () => ({ ok: true, data: listing }),
    skillRead: async ({ path }: { path: string }) => ({
      ok: true,
      data: {
        path,
        content: `---\nname: example\ndescription: The file at ${path}\n---\n\n# Example\n\nBody text for the viewer.\n`,
        truncated: false,
      },
    }),
    workspaceContentGet: async () => ({
      ok: true,
      data: {
        workspaceId: "settings-test-workspace",
        brief: "# Brief",
        journal: "# Journal",
        files: [],
        repositories: [],
        worktrees: [],
      },
    }),
    // One of each state the Agents section draws: signed in with an email
    // and plan, signed out, and a provider that is not installed.
    // The add and sign-in requests are recorded, so the check can see what
    // a click sent.
    accountAdd: async (params: { provider: "claude"; name: string }) => {
      const host = window as unknown as { requests?: object[] };
      host.requests = [...(host.requests ?? []), { accountAdd: params }];
      return {
        ok: true,
        data: {
          provider: params.provider,
          account: "added-0001",
          name: params.name,
          directory: "/Users/someone/.daedalus-dev/accounts/claude/added-0001",
          createdAt: "2026-10-07T00:00:00.000Z",
          kind: "login",
        },
      };
    },
    accountSignIn: async (params: object) => {
      const host = window as unknown as { requests?: object[] };
      host.requests = [...(host.requests ?? []), { accountSignIn: params }];
      return {
        ok: true,
        data: {
          id: "sign-in-terminal",
          name: "Claude sign in",
          tmuxSession: "daedalus_terminal_signin",
          workingDirectory: "/Users/someone/.daedalus-dev",
          status: "running",
          startedAt: "2026-10-07T00:00:00.000Z",
          endedAt: null,
          revivedAt: null,
        },
      };
    },
    // Answers for one account when asked for one. Once a sign-in was
    // requested for Personal, it reports Personal signed in, the way the
    // provider does when the browser login finishes.
    accountStatus: async (filter: { account?: string } = {}) => {
      const host = window as unknown as {
        requests?: Array<Record<string, unknown>>;
      };
      const signedIn = (host.requests ?? []).some(
        (request) =>
          (request.accountSignIn as { account?: string } | undefined)
            ?.account === "personal-1a2b",
      );
      const all = [
        {
          ...snapshot.settings.accounts[0]!,
          state: "signed-in",
          method: "Claude subscription",
          email: "someone@example.com",
          plan: "max",
          executable: "/usr/local/bin/claude",
          checkedAt: "2026-10-06T00:00:00.000Z",
        },
        {
          ...snapshot.settings.accounts[1]!,
          state: "signed-out",
          executable: "/usr/local/bin/claude",
          checkedAt: "2026-10-06T00:00:00.000Z",
        },
        {
          ...snapshot.settings.accounts[2]!,
          state: "signed-out",
          executable: "/usr/local/bin/claude",
          checkedAt: "2026-10-06T00:00:00.000Z",
        },
        {
          ...snapshot.settings.accounts[3]!,
          state: "missing",
          executable: "codex",
          checkedAt: "2026-10-06T00:00:00.000Z",
          install: [
            { label: "Homebrew", command: "brew install --cask codex" },
            { label: "npm", command: "npm install -g @openai/codex" },
          ],
        },
      ].map((status) =>
        signedIn && status.account === "personal-1a2b"
          ? {
              ...status,
              state: "signed-in",
              email: "me@example.com",
              method: "Claude subscription",
            }
          : status,
      );
      return {
        ok: true,
        data: filter.account
          ? all.filter((status) => status.account === filter.account)
          : all,
      };
    },
    agentModels: async ({ provider }: { provider: "codex" | "claude" }) => ({
      ok: true,
      data: { provider, models: [], source: "aliases" },
    }),
    terminalEndpoint: async () => ({
      ok: true,
      data: { endpoint: "ws://127.0.0.1:1/settings-test" },
    }),
    presencePublish: async () => ({ ok: true, data: {} }),
    toastsAcknowledge: async () => ({ ok: true, data: { acknowledged: 0 } }),
    // Asked for on mount. Without it the request throws inside a passive
    // effect and React tears the whole tree down, leaving a blank page.
    workspaceWatchSet: async () => ({ ok: true, data: { watching: [] } }),
    // An offer, so the check can see it where Settings shows it: a dot on
    // the Settings button and on About, and the button in About.
    appUpdateGet: async () => ({
      ok: true,
      data: { state: "available", currentVersion: "0.8.2", version: "0.8.3" },
    }),
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  subscribeCommands: () => () => undefined,
  subscribeWindowResize: () => () => undefined,
  subscribeFocusSession: () => () => undefined,
  subscribeQuitRequest: () => () => undefined,
  subscribeWorkspaceFiles: () => () => undefined,
} as unknown as DesktopClient;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App
      injectedClient={client}
      initialModal="settings"
      initialSnapshot={snapshot}
    />
  </StrictMode>,
);
