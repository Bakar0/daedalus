/**
 * A page for checking the session abilities UI in a browser: the card menu,
 * the New session fields, the routine bar and the Routines drawer. The stub
 * client keeps state, so a rename, a pin, a color, a grant, Pause and Run now
 * all come back through the snapshot the way the real adapter does it.
 * `window.routinesTest` moves the routine status on from a script.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentSessionDto,
  DesktopSnapshotDto,
  RoutineDto,
  RoutinesStatusDto,
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
  workspaceId: "routines-test-workspace",
  taskId: null,
  name,
  provider,
  kind: "agent",
  tmuxSession: id,
  command: provider,
  args: [],
  workingDirectory: "/tmp/routines-test",
  status: "running",
  exitCode: null,
  startedAt,
  endedAt: null,
  providerSessionId: null,
  account: null,
  teamId: null,
  teamHandle: null,
  archivedAt: null,
  resumeCount: 0,
  lostReason: null,
  handoffRequestedAt: null,
  position,
  pinnedAt: null,
  color: null,
  ...extra,
});

const routine = (
  name: string,
  schedule: string,
  extra: Partial<RoutineDto> = {},
): RoutineDto => ({
  name,
  prompt: `Check ${name} since {{last_run}}.\nReport anything broken; key: ${name}:<id>.`,
  schedule,
  until: null,
  model: null,
  timeoutMs: 600_000,
  output: "task",
  enabled: true,
  nextRunAt: iso(240),
  lastRunAt: iso(-900),
  consecutiveFailures: 0,
  lastRun: {
    id: 1,
    routine: name,
    status: "done",
    queuedAt: iso(-960),
    deliveredAt: iso(-950),
    startedAt: iso(-940),
    finishedAt: iso(-900),
    outcome: "quiet",
    summary: null,
    missedMs: 0,
  },
  ...extra,
});

let routines: RoutineDto[] = [
  routine("ci-health", "every 15m", { model: "haiku" }),
  routine("alerts-triage", "every 30m", {
    consecutiveFailures: 3,
    lastRun: {
      id: 2,
      routine: "alerts-triage",
      status: "failed",
      queuedAt: iso(-1900),
      deliveredAt: iso(-1890),
      startedAt: iso(-1880),
      finishedAt: iso(-1800),
      outcome: null,
      summary: "cx CLI asked for sign-in",
      missedMs: 0,
    },
  }),
  routine("weekly-digest", "0 9 * * 1", {
    enabled: false,
    nextRunAt: null,
    output: "notify",
  }),
];
let purpose: string | null =
  "Keep main green and catch production errors before customers do.";

let abilities: SessionAbilityDto[] = [
  {
    id: "ability-argus",
    sessionId: "argus",
    ability: "routines",
    enabled: true,
    paused: false,
    purpose,
    noteWaiting: false,
    grantedAt: startedAt,
  },
];

let status: RoutinesStatusDto = {
  abilityId: "ability-argus",
  sessionId: "argus",
  paused: false,
  waiting: [
    { runId: 11, routine: "ci-health", queuedAt: iso(-100) },
    { runId: 12, routine: "alerts-triage", queuedAt: iso(-45) },
  ],
  running: 0,
  hold: { reason: "typing", text: "you typed in this session", until: iso(80) },
  nextRun: { routine: "ci-health", at: iso(240) },
  lastKeystrokeAt: iso(-40),
  routines: 3,
  openReports: 1,
  openUrgentReports: 0,
  openReportTasks: 1,
};

let current: DesktopSnapshotDto = {
  workspaces: [
    {
      id: "routines-test-workspace",
      slug: "routines-test",
      name: "Routines test",
      path: "/tmp/routines-test",
      createdAt: startedAt,
      updatedAt: startedAt,
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
  routines: [status],
  routineReports: [],
  settings: {
    version: "0.3.0",
    channel: "stable",
    home: "/tmp/daedalus-routines-test",
    workspaceRoot: "/tmp/daedalus-routines-test/workspaces",
    databasePath: "/tmp/daedalus-routines-test/state.db",
    repositoryRoot: "/tmp/daedalus-routines-test/repos",
    tmuxAvailable: true,
    workspaceInstructionFilesEnabled: true,
    autoRestoreSessionsEnabled: true,
    focusMode: false,
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
    body: "@lead endpoints are done; the contract is in TEAM.md",
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
    routines: abilities.some((item) => item.enabled)
      ? current.routines.length
        ? [status]
        : []
      : [],
    ...changes,
  };
  for (const listener of [...listeners]) listener();
};
const setStatus = (next: Partial<RoutinesStatusDto>) => {
  status = { ...status, ...next };
  publish({ routines: [status] });
};

declare global {
  interface Window {
    routinesTest: {
      setStatus: (next: Partial<RoutinesStatusDto>) => void;
      hold: (reason: NonNullable<RoutinesStatusDto["hold"]>["reason"]) => void;
      spawns: unknown[];
      snapshot: () => DesktopSnapshotDto;
      /** Archives a session, such as a team's lead. */
      archive: (sessionId: string) => void;
    };
  }
}

window.routinesTest = {
  setStatus,
  archive: (sessionId) => {
    updateAgent(sessionId, {
      archivedAt: new Date().toISOString(),
      status: "exited",
    });
    publish();
  },
  hold: (reason) =>
    setStatus({
      hold:
        reason === "typing"
          ? { reason, text: "you typed", until: iso(80) }
          : { reason, text: reason },
      lastKeystrokeAt: reason === "typing" ? iso(-40) : null,
    }),
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
  request: {
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
            ability: "routines",
            enabled: granted,
            paused: false,
            purpose: null,
            noteWaiting: true,
            grantedAt: new Date().toISOString(),
          };
      abilities = [
        ...abilities.filter((item) => item.sessionId !== sessionId),
        row,
      ];
      const others = current.routines.filter(
        (item) => item.sessionId !== sessionId,
      );
      publish({
        routines: granted
          ? [
              ...others,
              {
                ...status,
                abilityId: row.id,
                sessionId,
                waiting: [],
                hold: null,
                nextRun: null,
                routines: 0,
              },
            ]
          : others,
      });
      return ok(row);
    },
    routinesDetail: async () =>
      ok({ purpose, routines, templates: [], runs: [] }),
    routinesControl: async ({ action }: { action: "pause" | "resume" }) => {
      const paused = action === "pause";
      abilities = abilities.map((item) => ({ ...item, paused }));
      setStatus({
        paused,
        hold: paused ? { reason: "paused", text: "routines are paused" } : null,
      });
      return ok(abilities[0]);
    },
    routinesPurpose: async ({ purpose: next }: { purpose: string }) => {
      purpose = next;
      return ok({ ...abilities[0], purpose });
    },
    routineSetEnabled: async ({
      name,
      enabled,
    }: {
      name: string;
      enabled: boolean;
    }) => {
      routines = routines.map((item) =>
        item.name === name
          ? { ...item, enabled, nextRunAt: enabled ? iso(600) : null }
          : item,
      );
      setStatus({ routines: routines.length });
      return ok({ name, enabled });
    },
    routineRunNow: async ({ name }: { name?: string }) => {
      const [first, ...rest] = status.waiting;
      if (!name && first && status.hold?.reason === "typing")
        setStatus({
          waiting: rest,
          running: status.running + 1,
          hold: null,
        });
      else if (name)
        setStatus({
          waiting: [
            ...status.waiting,
            { runId: 99, routine: name, queuedAt: new Date().toISOString() },
          ],
        });
      return ok({
        id: first?.runId ?? 99,
        routine: name ?? first?.routine ?? "ci-health",
        status: "queued",
        queuedAt: new Date().toISOString(),
        deliveredAt: null,
        startedAt: null,
        finishedAt: null,
        outcome: null,
        summary: null,
        missedMs: 0,
      });
    },
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
        workspaceId: "routines-test-workspace",
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
  },
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
