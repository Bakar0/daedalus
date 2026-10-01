import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type {
  DesktopSnapshotDto,
  FindingDto,
  ResidentOverviewDto,
  WorkspaceDto,
} from "@daedalus/protocol";
import { App } from "../App";
import type { DesktopClient } from "../client-types";
import { FindingDetails } from "./FindingDetails";
import { residentStatusLine, ResidentsNav } from "./ResidentsNav";
import { relativeTime } from "./time";

const now = Date.parse("2026-10-01T10:00:00Z");

const resident = (
  overrides: Partial<ResidentOverviewDto> = {},
): ResidentOverviewDto => ({
  id: "resident-argus",
  slug: "argus",
  name: "Argus",
  workspaceId: "argus",
  workspaceSlug: "argus",
  workspacePath: "/tmp/residents/argus",
  state: "on_duty",
  sessionId: "session-argus",
  sessionStatus: "running",
  lamp: "quiet",
  nextRunAt: "2026-10-01T10:07:00Z",
  runsInFlight: 0,
  runsQueued: 0,
  openFindings: 0,
  openFindingTasks: 0,
  routineErrors: 0,
  deliveryHold: null,
  autoHandoffPercent: 60,
  ...overrides,
});

const finding = (overrides: Partial<FindingDto> = {}): FindingDto => ({
  id: "finding-1",
  residentId: "resident-argus",
  routine: "ci-health",
  key: "ci-health:org/repo:main:CI:test",
  sameAs: null,
  severity: "warn",
  title: "main red",
  url: null,
  taskId: "task-1",
  state: "open",
  verdict: null,
  openedAt: "2026-10-01T09:00:00Z",
  lastSeenAt: "2026-10-01T09:30:00Z",
  clearedAt: null,
  closedAt: null,
  reopenCount: 0,
  ...overrides,
});

describe("residents in the sidebar", () => {
  test("says what the resident is doing in one line", () => {
    expect(residentStatusLine(resident(), now)).toBe("next in 7m");
    expect(
      residentStatusLine(
        resident({ runsInFlight: 2, openFindingTasks: 1 }),
        now,
      ),
    ).toBe("2 running · 1 open task");
    expect(residentStatusLine(resident({ state: "paused" }), now)).toBe(
      "Paused",
    );
    expect(residentStatusLine(resident({ sessionStatus: "lost" }), now)).toBe(
      "Session lost, reviving",
    );
  });

  test("lights the lantern for the most pressing state", () => {
    const html = renderToStaticMarkup(
      <ResidentsNav
        compact={false}
        now={now}
        onOpen={() => {}}
        residents={[
          resident({ lamp: "urgent", openFindingTasks: 2 }),
          resident({ id: "r2", name: "Hermes", state: "stopped" }),
        ]}
      />,
    );
    expect(html).toContain("lamp-urgent");
    expect(html).toContain("resident-count urgent");
    // A stopped resident's lantern is out, whatever it last showed.
    expect(html).toContain("lamp-off");
    expect(html).toContain(">Residents<");
  });

  test("renders nothing when there are no residents", () => {
    expect(
      renderToStaticMarkup(
        <ResidentsNav
          compact={false}
          now={now}
          onOpen={() => {}}
          residents={[]}
        />,
      ),
    ).toBe("");
  });

  test("lists a resident's workspace apart from the projects", () => {
    const workspace = (id: string, name: string): WorkspaceDto => ({
      id,
      slug: id,
      name,
      path: `/tmp/${id}`,
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
      archivedAt: null,
      available: true,
      position: id === "argus" ? 0 : 1,
      startSetsInProgress: true,
      autoHandoffPercent: null,
      defaultProvider: null,
      defaultModel: null,
    });
    const snapshot: DesktopSnapshotDto = {
      workspaces: [workspace("argus", "Argus"), workspace("atlas", "Atlas")],
      tasks: [],
      agents: [],
      terminals: [],
      repositories: [],
      providerUsage: [],
      sessionTelemetry: [],
      sessionActivity: [],
      attention: [],
      worktrees: [],
      shipped: [],
      toasts: [],
      residents: [resident()],
      findings: [],
      settings: {
        version: "0.9.1",
        channel: "dev",
        home: "/tmp/d",
        workspaceRoot: "/tmp/d/workspaces",
        databasePath: "/tmp/d/state.db",
        repositoryRoot: "/tmp/d/repos",
        tmuxAvailable: false,
        workspaceInstructionFilesEnabled: true,
        autoRestoreSessionsEnabled: true,
        focusMode: false,
        providers: [],
      },
    };
    const html = renderToStaticMarkup(
      <App
        injectedClient={
          { request: {}, subscribe: () => () => {} } as unknown as DesktopClient
        }
        initialSnapshot={snapshot}
        initialWorkspaceView="board"
      />,
    );
    const residentsNav = html.slice(
      html.indexOf('aria-label="Residents"'),
      html.indexOf('aria-label="Workspaces"'),
    );
    const workspacesNav = html.slice(html.indexOf('aria-label="Workspaces"'));
    expect(residentsNav).toContain("Argus");
    expect(workspacesNav).toContain("Atlas");
    expect(workspacesNav).not.toContain('workspace-card-name">Argus');
    expect(workspacesNav).not.toMatch(/<strong[^>]*>Argus<\/strong>/);
  });
});

describe("a finding on its card", () => {
  test("shows where it came from and offers the verdicts", () => {
    const html = renderToStaticMarkup(
      <FindingDetails
        busy={false}
        finding={finding({
          severity: "urgent",
          state: "cleared",
          reopenCount: 2,
        })}
        onOpenLink={() => {}}
        onVerdict={() => {}}
      />,
    );
    expect(html).toContain("severity-urgent");
    expect(html).toContain("ci-health");
    expect(html).toContain("Cleared");
    expect(html).toContain("back 2×");
    expect(html).toContain(">Useful<");
    expect(html).toContain(">Noise<");
  });

  test("a judged finding offers undo instead", () => {
    const html = renderToStaticMarkup(
      <FindingDetails
        busy={false}
        finding={finding({ verdict: "noise" })}
        onOpenLink={() => {}}
        onVerdict={() => {}}
      />,
    );
    expect(html).toContain("Marked noise");
    expect(html).toContain(">Undo<");
    expect(html).not.toContain(">Noise<");
  });
});

describe("relativeTime", () => {
  test("reads both ways", () => {
    expect(relativeTime("2026-10-01T10:07:00Z", now)).toBe("in 7m");
    expect(relativeTime("2026-10-01T08:30:00Z", now)).toBe("1h 30m ago");
    expect(relativeTime(null, now)).toBe("—");
  });
});
