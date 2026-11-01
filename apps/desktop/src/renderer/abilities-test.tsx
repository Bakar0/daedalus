/**
 * A page for checking the session abilities UI in a browser: the card menu,
 * the New session fields and the Team tab. The stub client keeps state, so a
 * rename, a pin, a color and a grant all come back through the snapshot the
 * way the real adapter does it.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentSessionDto,
  DesktopSnapshotDto,
  SessionAbilityDto,
  SessionColorDto,
  TeamDetailDto,
  TeamMessageDto,
} from "@daedalus/protocol";
import { App } from "./App";
import type { DesktopClient } from "./client-types";
import "./styles.css";

const startedAt = "2026-10-04T08:00:00.000Z";
const iso = (offsetSeconds: number) =>
  new Date(Date.now() + offsetSeconds * 1000).toISOString();

const agent = (
  id: string,
  name: string,
  provider: "claude" | "codex",
  position: number,
  extra: Partial<AgentSessionDto> = {},
): AgentSessionDto => ({
  id,
  workspaceId: "abilities-test-workspace",
  taskId: null,
  name,
  provider,
  kind: "agent",
  tmuxSession: id,
  command: provider,
  args: [],
  workingDirectory: "/tmp/abilities-test",
  status: "running",
  exitCode: null,
  startedAt,
  endedAt: null,
  providerSessionId: null,
  account: null,
  teamId: null,
  teamHandle: null,
  spawnedBy: null,
  archivedAt: null,
  resumeCount: 0,
  lostReason: null,
  rebirthRequestedAt: null,
  position,
  pinnedAt: null,
  color: null,
  autoRebirthPercent: null,
  ...extra,
});

let abilities: SessionAbilityDto[] = [
  {
    id: "team-1",
    sessionId: "reviewer",
    ability: "orchestration",
    enabled: true,
    paused: false,
    noteWaiting: false,
    grantedAt: startedAt,
  },
];

let current: DesktopSnapshotDto = {
  workspaces: [
    {
      id: "abilities-test-workspace",
      slug: "abilities-test",
      name: "Abilities test",
      path: "/tmp/abilities-test",
      createdAt: startedAt,
      updatedAt: startedAt,
      archivedAt: null,
      available: true,
      position: 1,
      startSetsInProgress: true,
      autoRebirthPercent: null,
      defaultProvider: null,
      defaultModel: null,
      defaultClaudeAccount: null,
      defaultCodexAccount: null,
      accountModels: {},
    },
  ],
  tasks: [],
  agents: [
    agent("builder", "Builder", "codex", 1),
    agent("argus", "Argus", "claude", 2, {
      color: "teal",
      pinnedAt: startedAt,
    }),
    agent("reviewer", "Reviewer", "claude", 3, { color: "purple" }),
    // A member of Reviewer's team, listed apart from it in stored order.
    agent("api-worker", "API worker", "claude", 0, {
      teamId: "team-1",
      teamHandle: "api",
      spawnedBy: null,
    }),
  ],
  terminals: [],
  repositories: [],
  providerUsage: [],
  sessionTelemetry: [],
  sessionActivity: [],
  attention: [],
  worktrees: [],
  shipped: [],
  toasts: [],
  abilities,
  teams: [
    {
      id: "team-1",
      leadId: "reviewer",
      name: "Reviewer",
      goal: "Ship v2 checkout",
    },
  ],
  // Argus is in a run: build done, deploy waiting on its result, and a
  // release step that waits for the go-ahead.
  workflowRuns: [
    {
      id: "run-1",
      workspaceId: "abilities-test-workspace",
      sessionId: "argus",
      workflow: "feature",
      steps: [
        {
          name: "build",
          description: "Make the change",
          gate: null,
          state: "done",
          startedAt: iso(-3600),
          endedAt: iso(-1800),
          approvedAt: null,
          plan: "Add the release notes page",
          note: "Page added; 12 tests pass",
          dynamic: false,
        },
        {
          name: "deploy",
          description: "Deploy to the beta feed",
          gate: "result",
          state: "waiting",
          startedAt: iso(-1700),
          endedAt: null,
          approvedAt: null,
          plan: "Publish 1.2 to the beta feed",
          note: "1.2 is on the beta feed; release run 4031 passed",
          dynamic: false,
        },
        {
          name: "release",
          description: "Promote to stable",
          gate: "start",
          state: "pending",
          startedAt: null,
          endedAt: null,
          approvedAt: null,
          plan: null,
          note: null,
          dynamic: false,
        },
      ],
      dynamic: false,
      modified: false,
      loopTo: null,
      until: "",
      iteration: 1,
      history: [],
      endNote: null,
      startedAt: iso(-3600),
      updatedAt: iso(-60),
      endedAt: null,
    },
  ],
  settings: {
    version: "0.3.0",
    channel: "stable",
    home: "/tmp/daedalus-abilities-test",
    workspaceRoot: "/tmp/daedalus-abilities-test/workspaces",
    databasePath: "/tmp/daedalus-abilities-test/state.db",
    repositoryRoot: "/tmp/daedalus-abilities-test/repos",
    tmuxAvailable: true,
    workspaceInstructionFilesEnabled: true,
    autoRestoreSessionsEnabled: true,
    trustSessionFoldersEnabled: true,
    autoRebirthPercent: null,
    focusMode: false,
    betaUpdatesEnabled: false,
    accounts: [],
    providers: [
      { name: "claude", executable: "claude", available: true },
      { name: "codex", executable: "codex", available: true },
    ],
  },
};

/** Every spawn the dialog asked for, for a script to read back. */
const spawns: unknown[] = [];

/** The team chat, as the stub keeps it. */
const teamMessages: TeamMessageDto[] = [
  {
    id: 1,
    author: "daedalus",
    body: "@lead the user added @api ('API worker') to the team with these instructions:\n\nBuild the v2 endpoints.",
    tags: ["lead"],
    createdAt: iso(-600),
  },
  {
    id: 2,
    author: "api",
    body: "@lead endpoints are done; the contract is in TEAM.md\n\n- POST /v2/tasks takes status as an enum\n- GET /v2/tasks pages with a cursor\n- errors follow RFC 9457\n- the old /v1 routes stay until the client moves",
    tags: ["lead"],
    createdAt: iso(-120),
  },
];
const teamDetail = (): TeamDetailDto => ({
  team: current.teams[0]!,
  members: [
    {
      handle: "lead",
      role: "lead",
      sessionId: "reviewer",
      name: "Reviewer",
      status: "running",
      unread: 0,
      undelivered: 0,
      lastError: null,
    },
    {
      handle: "api",
      role: "member",
      sessionId: "api-worker",
      name: "API worker",
      status: "running",
      unread: 1,
      undelivered: 1,
      lastError: "Claude has no live session api-worker",
    },
  ],
  messages: teamMessages,
});

const listeners = new Set<() => void>();
const publish = (changes: Partial<DesktopSnapshotDto> = {}) => {
  current = {
    ...current,
    abilities,
    ...changes,
  };
  for (const listener of [...listeners]) listener();
};
declare global {
  interface Window {
    abilitiesTest: {
      spawns: unknown[];
      snapshot: () => DesktopSnapshotDto;
      /** Archives a session, such as a team's lead. */
      archive: (sessionId: string) => void;
    };
  }
}

window.abilitiesTest = {
  archive: (sessionId) => {
    updateAgent(sessionId, {
      archivedAt: new Date().toISOString(),
      status: "exited",
    });
    publish();
  },
  spawns,
  snapshot: () => current,
};

const ok = <T,>(data: T) => ({ ok: true as const, data });
const updateAgent = (id: string, change: Partial<AgentSessionDto>) => {
  current = {
    ...current,
    agents: current.agents.map((item) =>
      item.id === id ? { ...item, ...change } : item,
    ),
  };
  return current.agents.find((item) => item.id === id)!;
};

const client = {
  request: new Proxy(
    {
      snapshot: async () => ok(current),
      sessionUpdate: async ({
        sessionId,
        name,
        pinned,
        color,
      }: {
        sessionId: string;
        name?: string;
        pinned?: boolean;
        color?: SessionColorDto | null;
      }) => {
        const session = updateAgent(sessionId, {
          ...(name !== undefined ? { name } : {}),
          ...(pinned !== undefined
            ? { pinnedAt: pinned ? new Date().toISOString() : null }
            : {}),
          ...(color !== undefined ? { color } : {}),
        });
        publish();
        return ok(session);
      },
      sessionAbility: async ({
        sessionId,
        granted,
      }: {
        sessionId: string;
        granted: boolean;
      }) => {
        const existing = abilities.find((item) => item.sessionId === sessionId);
        const row: SessionAbilityDto = existing
          ? { ...existing, enabled: granted }
          : {
              id: `ability-${sessionId}`,
              sessionId,
              ability: "orchestration",
              enabled: granted,
              paused: false,
              noteWaiting: true,
              grantedAt: new Date().toISOString(),
            };
        abilities = [
          ...abilities.filter((item) => item.sessionId !== sessionId),
          row,
        ];
        publish();
        return ok(row);
      },
      // Workflows on, so the Workflow pane shows the run.
      skillList: async () =>
        ok({
          managed: [{ id: "daedalus-workflows", enabled: true }],
          user: [],
        }),
      workflowFiles: async () =>
        ok({
          root: "/tmp/daedalus-abilities-test/workflows",
          flows: [
            {
              name: "feature",
              path: "flows/feature.md",
              text: "---\nname: feature\ndescription: A feature that ships\nsteps: [plan, build]\n---\n",
              description: "A feature that ships",
              steps: ["plan", "build"],
              problem: null,
            },
          ],
          steps: [
            {
              name: "plan",
              gate: "start" as const,
              path: "steps/plan.md",
              text: "---\nname: plan\ndescription: Write the plan\n---\nRead the code, then write the plan.\n",
              description: "Write the plan",
              body: "Read the code, then write the plan.",
              problem: null,
            },
            {
              name: "build",
              gate: "result" as const,
              path: "steps/build.md",
              text: "---\nname: build\ndescription: Make the change\n---\nMake the change and test it.\n",
              description: "Make the change",
              body: "Make the change and test it.",
              problem: null,
            },
          ],
          choosing: { path: "CHOOSING.md", text: "# Choosing a workflow\n" },
        }),
      instructionFiles: async () =>
        ok({
          root: "/tmp/daedalus-abilities-test/instructions",
          index: { path: "INDEX.md", text: "# Custom instructions\n" },
          topics: [],
        }),
      teamDetail: async () => ok(teamDetail()),
      teamSay: async ({ body }: { body: string }) => {
        const message: TeamMessageDto = {
          id: teamMessages.length + 1,
          author: "user",
          body,
          tags: [...body.matchAll(/@([a-z0-9-]+)/g)].map((match) => match[1]!),
          createdAt: new Date().toISOString(),
        };
        teamMessages.push(message);
        return ok({
          message,
          warnings: message.tags.length
            ? []
            : [
                "The message tags no session, so nobody was notified; it waits in the team chat",
              ],
        });
      },
      teamGoal: async ({ goal }: { goal: string }) => {
        const team = { ...current.teams[0]!, goal };
        publish({ teams: [team] });
        return ok(team);
      },
      agentSpawn: async (params: Record<string, unknown>) => {
        spawns.push(params);
        const session = agent(
          `spawned-${spawns.length}`,
          String(params.name ?? "New"),
          (params.provider as "claude" | "codex") ?? "claude",
          10 + spawns.length,
          { color: (params.color as SessionColorDto | undefined) ?? null },
        );
        current = { ...current, agents: [...current.agents, session] };
        publish();
        return ok(session);
      },
      agentReorder: async () => ok(current.agents),
      workspaceReorder: async () => ok(current.workspaces),
      workspaceContentGet: async () =>
        ok({
          workspaceId: "abilities-test-workspace",
          brief: "# Brief",
          journal: "# Journal",
          files: [],
          repositories: [],
          worktrees: [],
        }),
      agentModels: async ({ provider }: { provider: "codex" | "claude" }) =>
        ok({ provider, models: [], source: "aliases" }),
      // Never answers. A socket that fails reconnects every few seconds, and
      // each reconnect rebuilds the terminal and takes the focus, which closes
      // any menu open at the time.
      terminalEndpoint: () => new Promise(() => {}),
      presencePublish: async () => ok({}),
      toastsAcknowledge: async () => ok({ acknowledged: 0 }),
      workspaceWatchSet: async () => ok({ watching: [] }),
    } as Record<string, (params: never) => Promise<unknown>>,
    {
      // A request this page has no stub for fails the way the host's does,
      // so a new request elsewhere in the app does not take the page down.
      get: (target, name: string) =>
        target[name] ??
        (async () => ({
          ok: false,
          error: { code: "NOT_FOUND", message: `No stub for ${name}` },
        })),
    },
  ),
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  subscribeCommands: () => () => undefined,
  subscribeWindowResize: () => () => undefined,
  subscribeFocusSession: () => () => undefined,
  subscribeWorkspaceFiles: () => () => undefined,
  subscribeQuitRequest: () => () => undefined,
} as unknown as DesktopClient;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App
      injectedClient={client}
      initialActiveAgentId="argus"
      initialSnapshot={current}
    />
  </StrictMode>,
);
