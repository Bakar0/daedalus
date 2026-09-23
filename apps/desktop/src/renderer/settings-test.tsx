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
      updatedAt: "2026-09-14T00:00:00.000Z",
      archivedAt: null,
      available: true,
      position: 1,
    },
  ],
  tasks: [],
  agents: [],
  integratedTerminals: [],
  sessionTelemetry: [],
  providerUsage: [],
  sessionActivity: [],
  sessionAttention: [],
  toasts: [],
  settings: {
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
