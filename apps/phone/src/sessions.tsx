/**
 * Sessions as the Mac's left column draws them: the same icons, status dot,
 * labels and precedence rules (`session-view.tsx`), and the same order with
 * team members under their lead (`session-order.ts`). Both come straight from
 * the desktop renderer, so the phone and the Mac cannot disagree about what
 * a session is doing.
 */
import type {
  AgentSessionDto,
  DesktopSnapshotDto,
  WorkspaceDto,
} from "@daedalus/protocol";
import {
  type SessionTeam,
  sessionDisplayOrder,
  teamLookup,
} from "../../desktop/src/renderer/session-order";
import {
  AgentStatusDot,
  type SessionStatusView,
  sessionName,
  sessionStatusLine,
  sessionStatusView,
  sessionTool,
  ToolIcon,
} from "../../desktop/src/renderer/session-view";

export interface SessionRow {
  session: AgentSessionDto;
  view: SessionStatusView;
  workspace: WorkspaceDto | undefined;
  task: string | undefined;
  team: SessionTeam | undefined;
  /** Drawn indented under its lead, as on the Mac. */
  member: boolean;
}

export interface WorkspaceGroup {
  workspace: WorkspaceDto;
  rows: SessionRow[];
  needsYou: number;
  live: number;
}

export function sessionGroups(snapshot: DesktopSnapshotDto): {
  groups: WorkspaceGroup[];
} {
  const activity = new Map(
    snapshot.sessionActivity.map((item) => [item.sessionId, item]),
  );
  const attention = new Map(
    snapshot.attention.map((item) => [item.sessionId, item]),
  );
  const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const teamOf = teamLookup(snapshot.teams);
  const sessions = snapshot.agents.filter((session) => !session.archivedAt);

  const rowFor = (session: AgentSessionDto, list: AgentSessionDto[]) => {
    const team = teamOf(session);
    const task = session.taskId ? tasks.get(session.taskId) : undefined;
    return {
      session,
      view: sessionStatusView(
        session,
        activity.get(session.id),
        attention.get(session.id),
      ),
      workspace: snapshot.workspaces.find(
        (item) => item.id === session.workspaceId,
      ),
      task: task?.title,
      team,
      member:
        team?.role === "member" &&
        list.some((item) => item.id === team.team.leadId),
    } satisfies SessionRow;
  };

  const groups = snapshot.workspaces
    .filter((workspace) => !workspace.archivedAt)
    .sort((left, right) => left.position - right.position)
    .flatMap((workspace): WorkspaceGroup[] => {
      const manual = sessions
        .filter((session) => session.workspaceId === workspace.id)
        .sort((left, right) => left.position - right.position);
      if (manual.length === 0) return [];
      const rows = sessionDisplayOrder(manual, snapshot.teams).map((session) =>
        rowFor(session, manual),
      );
      return [
        {
          workspace,
          rows,
          needsYou: rows.filter((row) => row.view.attention).length,
          live: rows.filter(
            (row) =>
              row.session.status === "running" ||
              row.session.status === "starting",
          ).length,
        },
      ];
    });
  return {
    groups,
  };
}

/** The workspace card's summary line, worded as the Mac words it. */
export function workspaceInsight(group: WorkspaceGroup): string {
  if (group.needsYou > 0)
    return `${group.needsYou} need${group.needsYou === 1 ? "s" : ""} you`;
  return `${group.live} live · ${group.rows.length} session${group.rows.length === 1 ? "" : "s"}`;
}

export const statusText = (view: SessionStatusView, now = Date.now()) =>
  sessionStatusLine(view, now);

export function FolderIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />
    </svg>
  );
}

/** One session, as a row of the Mac's left column. */
export function SessionRowView({
  row,
  onOpen,
}: {
  row: SessionRow;
  onOpen: (id: string) => void;
}) {
  const { session, view, team } = row;
  const tool = sessionTool(session);
  const second = row.task ?? "Workspace session";
  return (
    <li>
      <button
        className="session-row"
        data-color={session.color ?? undefined}
        data-session-id={session.id}
        data-team-member={row.member ? "true" : undefined}
        onClick={() => onOpen(session.id)}
      >
        <span className={`session-kind-icon tool-${tool}`}>
          <ToolIcon tool={tool} />
        </span>
        <span className="session-row-main">
          <strong>{sessionName(session)}</strong>
          <small>
            {team ? (
              <span className="session-team-badge">
                {team.role === "lead" ? "Team lead" : `@${team.handle}`}
              </span>
            ) : undefined}
            {second}
          </small>
          <em className="session-row-status" data-tone={view.tone}>
            <AgentStatusDot count={view.reasons.length} view={view} />
            <span>{statusText(view)}</span>
          </em>
        </span>
      </button>
    </li>
  );
}
