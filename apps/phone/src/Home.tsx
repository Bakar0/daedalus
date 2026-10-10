import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { PairedMac } from "@daedalus/remote-protocol";
import {
  FolderIcon,
  sessionGroups,
  SessionRowView,
  workspaceInsight,
} from "./sessions";
import { Shell } from "./Shell";
import { useMac } from "./useMac";

// The terminal (xterm.js) loads only when a session is opened.
const SessionScreen = lazy(() =>
  import("./SessionScreen").then((module) => ({
    default: module.SessionScreen,
  })),
);

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
    () => (snapshot ? sessionGroups(snapshot) : undefined),
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

  const all = rows ? rows.groups.flatMap((group) => group.rows) : [];
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
          {rows.needsMe.length > 0 ? (
            <section className="group">
              <h2 className="group-title">Needs me</h2>
              <ul className="session-rows">
                {rows.needsMe.map((row) => (
                  <SessionRowView
                    context="workspace"
                    key={row.session.id}
                    onOpen={openSession}
                    row={row}
                  />
                ))}
              </ul>
            </section>
          ) : undefined}
          {rows.groups.map((group) => (
            <section className="workspace-group" key={group.workspace.id}>
              <header className="workspace-head">
                <span className="workspace-folder-icon">
                  <FolderIcon />
                </span>
                <strong>{group.workspace.name}</strong>
                <small
                  className={group.needsYou > 0 ? "needs-attention" : undefined}
                >
                  {workspaceInsight(group)}
                </small>
              </header>
              <ul className="session-rows workspace-sessions">
                {group.rows.map((row) => (
                  <SessionRowView
                    context="task"
                    key={row.session.id}
                    onOpen={openSession}
                    row={row}
                  />
                ))}
              </ul>
            </section>
          ))}
          {all.length === 0 ? (
            <p className="quiet-line">No sessions on this Mac.</p>
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
