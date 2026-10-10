import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type {
  AgentActivity,
  AgentSessionDto,
  DesktopSnapshotDto,
} from "@daedalus/protocol";
import type { PairedMac } from "@daedalus/remote-protocol";
import { Shell } from "./Shell";
import { useMac } from "./useMac";

// The terminal (xterm.js) loads only when a session is opened.
const SessionScreen = lazy(() =>
  import("./SessionScreen").then((module) => ({
    default: module.SessionScreen,
  })),
);

export const ACTIVITY_LABEL: Record<AgentActivity, string> = {
  unknown: "Running",
  working: "Working",
  needs_permission: "Needs permission",
  needs_input: "Needs input",
  idle: "Idle",
  done: "Done",
  error: "Error",
};

export interface SessionRow {
  session: AgentSessionDto;
  activity: AgentActivity;
  workspace: string;
  task?: string;
  /** Why it needs the user, when it does. */
  reason?: string;
}

/** Live sessions, the ones that need the user first. */
export function sessionRows(snapshot: DesktopSnapshotDto): {
  needsMe: SessionRow[];
  byWorkspace: Array<{ workspace: string; rows: SessionRow[] }>;
} {
  const workspaces = new Map(
    snapshot.workspaces.map((item) => [item.id, item]),
  );
  const tasks = new Map(snapshot.tasks.map((item) => [item.id, item]));
  const activity = new Map(
    snapshot.sessionActivity.map((item) => [item.sessionId, item]),
  );
  const attention = new Map(
    snapshot.attention.map((item) => [item.sessionId, item]),
  );
  const rows = snapshot.agents
    .filter(
      (session) =>
        !session.archivedAt &&
        (session.status === "running" || session.status === "starting"),
    )
    .map((session): SessionRow => {
      const observed = activity.get(session.id);
      const raised = attention.get(session.id);
      const task = session.taskId ? tasks.get(session.taskId) : undefined;
      const workspace = workspaces.get(session.workspaceId);
      return {
        session,
        activity: observed?.activity ?? "unknown",
        workspace: workspace?.name ?? "Workspace",
        ...(task ? { task: `#${task.number} ${task.title}` } : {}),
        ...(raised?.reasons.length
          ? { reason: raised.reasons[raised.reasons.length - 1]!.text }
          : observed?.detail &&
              (observed.activity === "needs_permission" ||
                observed.activity === "needs_input")
            ? { reason: observed.detail }
            : {}),
      };
    });
  const needs = (row: SessionRow) =>
    row.reason !== undefined ||
    row.activity === "needs_permission" ||
    row.activity === "needs_input";
  const groups = new Map<string, SessionRow[]>();
  for (const row of rows.filter((item) => !needs(item)))
    groups.set(row.workspace, [...(groups.get(row.workspace) ?? []), row]);
  return {
    needsMe: rows.filter(needs),
    byWorkspace: [...groups].map(([workspace, items]) => ({
      workspace,
      rows: items,
    })),
  };
}

export function Home({
  mac,
  macs,
  token,
  onAccount,
  onForget,
  onSelectMac,
  onSignOut,
}: {
  mac: PairedMac;
  macs: PairedMac[];
  token: string;
  onAccount: () => void;
  onForget: () => void;
  onSelectMac: (macId: string) => void;
  onSignOut: () => void;
}) {
  const { state, snapshot } = useMac(mac, token);
  const [open, setOpen] = useState<string>();
  const rows = useMemo(
    () => (snapshot ? sessionRows(snapshot) : undefined),
    [snapshot],
  );

  // The phone's back gesture closes a session rather than leaving the app.
  useEffect(() => {
    const back = () => setOpen(undefined);
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  const openSession = (id: string) => {
    history.pushState({ session: id }, "");
    setOpen(id);
  };

  useEffect(() => {
    if (state.kind === "blocked" && state.code === "signed_out") onSignOut();
  }, [state, onSignOut]);

  const all = rows
    ? [...rows.needsMe, ...rows.byWorkspace.flatMap((g) => g.rows)]
    : [];
  const current = all.find((row) => row.session.id === open);
  if (open && state.kind === "online" && current)
    return (
      <Suspense fallback={<div className="spinner centered" />}>
        <SessionScreen
          connection={state.connection}
          onBack={() => history.back()}
          row={current}
        />
      </Suspense>
    );

  return (
    <Shell onAccount={onAccount} title={mac.macName}>
      {macs.length > 1 ? (
        <div className="mac-picker" role="tablist">
          {macs.map((item) => (
            <button
              aria-selected={item.macId === mac.macId}
              key={item.macId}
              onClick={() => onSelectMac(item.macId)}
              role="tab"
            >
              {item.macName}
            </button>
          ))}
        </div>
      ) : undefined}

      <ConnectionLine state={state} />

      {state.kind === "blocked" ? (
        <section className="empty">
          <h2>
            {state.code === "no_access"
              ? "No active access"
              : "This phone was removed"}
          </h2>
          <p>
            {state.code === "no_access"
              ? "Your account has no active access right now."
              : "Your Mac or your account no longer knows this phone. Pair it again from Settings › Remote on your Mac."}
          </p>
          {state.code === "removed" ? (
            <button className="button" onClick={onForget}>
              Forget {mac.macName}
            </button>
          ) : undefined}
        </section>
      ) : rows ? (
        <>
          <section className="group">
            <h2 className="group-title">Needs me</h2>
            {rows.needsMe.length === 0 ? (
              <p className="quiet-line">Nothing is waiting on you.</p>
            ) : (
              <ul className="rows">
                {rows.needsMe.map((row) => (
                  <Row key={row.session.id} onOpen={openSession} row={row} />
                ))}
              </ul>
            )}
          </section>
          {rows.byWorkspace.map((group) => (
            <section className="group" key={group.workspace}>
              <h2 className="group-title">{group.workspace}</h2>
              <ul className="rows">
                {group.rows.map((row) => (
                  <Row key={row.session.id} onOpen={openSession} row={row} />
                ))}
              </ul>
            </section>
          ))}
          {all.length === 0 ? (
            <p className="quiet-line">No sessions are running on this Mac.</p>
          ) : undefined}
        </>
      ) : state.kind === "connecting" ? (
        <div className="spinner centered" />
      ) : undefined}
    </Shell>
  );
}

function ConnectionLine({
  state,
}: {
  state: ReturnType<typeof useMac>["state"];
}) {
  if (state.kind === "online" || state.kind === "blocked") return null;
  return (
    <p className="connection" data-state={state.kind}>
      <span aria-hidden="true" className="dot" />
      {state.kind === "connecting" ? "Connecting to your Mac…" : state.reason}
    </p>
  );
}

function Row({
  row,
  onOpen,
}: {
  row: SessionRow;
  onOpen: (id: string) => void;
}) {
  return (
    <li>
      <button className="row" onClick={() => onOpen(row.session.id)}>
        <span className="row-dot" data-activity={row.activity} />
        <span className="row-main">
          <strong>{row.session.name}</strong>
          <small>{row.reason ?? row.task ?? row.workspace}</small>
        </span>
        <span className="row-state">{ACTIVITY_LABEL[row.activity]}</span>
      </button>
    </li>
  );
}
