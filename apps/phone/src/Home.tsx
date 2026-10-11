import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { PairedMac } from "@daedalus/remote-protocol";
import {
  FolderIcon,
  sessionGroups,
  SessionRowView,
  workspaceInsight,
} from "./sessions";
import { Board, NewTaskScreen, TaskScreen } from "./Board";
import { PushControl } from "./PushControl";
import { Shell } from "./Shell";
import { useMac } from "./useMac";

// The terminal (xterm.js) loads only when a session is opened.
const SessionScreen = lazy(() =>
  import("./SessionScreen").then((module) => ({
    default: module.SessionScreen,
  })),
);

const BLOCKED = {
  signed_out: { title: "Signed out", body: "Sign in again to reach your Mac." },
  no_access: {
    title: "No active access",
    body: "Your account has no active access right now, or it used this month's allowance.",
  },
  removed: {
    title: "This phone was removed",
    body: "Your Mac or your account no longer knows this phone. Pair it again from Settings › Remote on your Mac.",
  },
  paused: {
    title: "Remote access is paused",
    body: "The relay reached its monthly budget. It starts again on the 1st.",
  },
} as const;

type Screen =
  | { kind: "session"; id: string }
  | { kind: "task"; id: string }
  | { kind: "new" };

const TAB_KEY = "daedalus.phone.home-tab";

function rememberedTab(): "sessions" | "board" {
  try {
    return localStorage.getItem(TAB_KEY) === "board" ? "board" : "sessions";
  } catch {
    return "sessions";
  }
}

function rememberTab(tab: "sessions" | "board"): void {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // A convenience only.
  }
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
  const { state, snapshot, macName } = useMac(mac, token);
  const [tab, setTab] = useState<"sessions" | "board">(rememberedTab);
  // Screens opened over the list, newest last: a task, then a session it
  // started, and so on. Each one is a history entry, so the phone's back
  // gesture closes the top one rather than leaving the app.
  const [screens, setScreens] = useState<Screen[]>([]);
  const rows = useMemo(
    () => (snapshot ? sessionGroups(snapshot) : undefined),
    [snapshot],
  );

  useEffect(() => {
    const back = () => setScreens((current) => current.slice(0, -1));
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  const push = (screen: Screen) => {
    history.pushState({ screen }, "");
    setScreens((current) => [...current, screen]);
  };
  const openSession = (id: string) => push({ kind: "session", id });
  const top = screens.at(-1);
  const open = top?.kind === "session" ? top.id : undefined;
  const connection = state.kind === "online" ? state.connection : undefined;

  useEffect(() => {
    if (state.kind === "blocked" && state.code === "signed_out") onSignOut();
  }, [state, onSignOut]);

  const all = rows ? rows.groups.flatMap((group) => group.rows) : [];
  const current = all.find((row) => row.session.id === open);
  const openTask =
    top?.kind === "task"
      ? snapshot?.tasks.find((task) => task.id === top.id)
      : undefined;
  if (openTask && snapshot)
    return (
      <Shell onBack={() => history.back()} title={`Task #${openTask.number}`}>
        <TaskScreen
          connection={connection}
          onOpenSession={openSession}
          sessionRows={all}
          snapshot={snapshot}
          task={openTask}
        />
      </Shell>
    );
  if (top?.kind === "new" && snapshot)
    return (
      <Shell onBack={() => history.back()} title="New task">
        <NewTaskScreen
          connection={connection}
          onCreated={(id) => {
            // The form's entry becomes the task's, so back goes to the board.
            history.replaceState({ screen: { kind: "task", id } }, "");
            setScreens((list) => [...list.slice(0, -1), { kind: "task", id }]);
          }}
          snapshot={snapshot}
        />
      </Shell>
    );
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
    <Shell
      onAccount={onAccount}
      subtitle={
        <span className="mac-state" data-state={state.kind}>
          <span aria-hidden="true" className="dot" />
          {state.kind === "online"
            ? "Connected"
            : state.kind === "connecting"
              ? "Connecting…"
              : state.kind === "offline"
                ? "Offline · retrying"
                : "Not connected"}
        </span>
      }
      title={macName}
    >
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
          <h2>{BLOCKED[state.code].title}</h2>
          <p>{BLOCKED[state.code].body}</p>
          {state.code === "removed" ? (
            <button className="button" onClick={onForget}>
              Forget {mac.macName}
            </button>
          ) : undefined}
        </section>
      ) : rows && snapshot ? (
        <>
          <PushControl compact token={token} />
          <div className="mac-picker view-tabs" role="tablist">
            {(["sessions", "board"] as const).map((item) => (
              <button
                aria-selected={tab === item}
                key={item}
                onClick={() => {
                  setTab(item);
                  rememberTab(item);
                }}
                role="tab"
              >
                {item === "sessions" ? "Sessions" : "Board"}
              </button>
            ))}
          </div>
          {tab === "board" ? (
            <Board
              connection={connection}
              onNewTask={() => push({ kind: "new" })}
              onOpenTask={(id) => push({ kind: "task", id })}
              snapshot={snapshot}
            />
          ) : null}
          {tab === "sessions"
            ? rows.groups.map((group) => (
                <section className="workspace-group" key={group.workspace.id}>
                  <header className="workspace-head">
                    <span className="workspace-folder-icon">
                      <FolderIcon />
                    </span>
                    <strong>{group.workspace.name}</strong>
                    <small
                      className={
                        group.needsYou > 0 ? "needs-attention" : undefined
                      }
                    >
                      {workspaceInsight(group)}
                    </small>
                  </header>
                  <ul className="session-rows workspace-sessions">
                    {group.rows.map((row) => (
                      <SessionRowView
                        key={row.session.id}
                        onOpen={openSession}
                        row={row}
                      />
                    ))}
                  </ul>
                </section>
              ))
            : null}
          {tab === "sessions" && all.length === 0 ? (
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
