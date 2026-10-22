/**
 * The whole window under a stream of `dataChanged`, for
 * `scripts/render-perf-check.ts`.
 *
 * The host announces a change whenever a session's activity or token count
 * moves, which while agents work is most ticks, and the window then reloads
 * the snapshot and renders again. This page does exactly that against a
 * snapshot the size of a real one (`?data=` points at it) and records how
 * long React spends on each commit, so the cost of one reload is a number.
 *
 * Each reload is a fresh parse of the snapshot, as the RPC bridge delivers
 * it: nothing keeps its identity from one reload to the next unless the
 * renderer makes it.
 */
import { Profiler, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { DesktopSnapshotDto } from "@daedalus/protocol";
import { App } from "./App";
import type { DesktopClient } from "./client-types";
import "./styles.css";

const params = new URLSearchParams(location.search);
const raw = await (await fetch(params.get("data")!)).text();
const view = (params.get("view") ?? "board") as "board" | "session";

let revision = 0;
const snapshotText = () => {
  const snapshot = JSON.parse(raw) as DesktopSnapshotDto;
  const now = new Date(Date.UTC(2026, 9, 22, 12, 0, revision)).toISOString();
  snapshot.sessionActivity = snapshot.agents
    .filter((agent) => agent.status === "running")
    .map((agent, index) => ({
      sessionId: agent.id,
      activity: "working",
      detail: index === revision % 30 ? `Bash ${revision}` : "Read",
      since: now,
      observedAt: now,
      source: "hook",
    })) as DesktopSnapshotDto["sessionActivity"];
  return JSON.stringify(snapshot);
};
const initial = JSON.parse(snapshotText()) as DesktopSnapshotDto;

const listeners = new Set<() => void>();
const commits: number[] = [];
declare global {
  interface Window {
    renderPerf: {
      commits: number[];
      reload(): Promise<void>;
    };
  }
}
window.renderPerf = {
  commits,
  reload: async () => {
    revision += 1;
    for (const listener of listeners) listener();
    // Two frames: the snapshot request resolves, then React commits.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  },
};

const ok = <T,>(data: T) => Promise.resolve({ ok: true, data });
const client = {
  request: new Proxy(
    {
      snapshot: () => ok(JSON.parse(snapshotText())),
      workspaceContentGet: ({ workspace }: { workspace: string }) =>
        ok({
          workspaceId: workspace,
          repositories: [],
          worktrees: [],
          files: [],
        }),
      terminalEndpoint: () => ok({ endpoint: "ws://127.0.0.1:1/perf" }),
      agentModels: ({ provider }: { provider: string }) =>
        ok({ provider, models: [], source: "aliases" }),
    } as Record<string, (params: never) => Promise<unknown>>,
    {
      // Anything else the window asks for answers empty, so a missing stub
      // costs nothing rather than throwing inside the measurement.
      get: (target, name: string) => target[name] ?? (() => ok({})),
    },
  ),
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  subscribeCommands: () => () => undefined,
  subscribeWindowResize: () => () => undefined,
  subscribeFocusSession: () => () => undefined,
  subscribeFocusTask: () => () => undefined,
  subscribeWorkspaceFiles: () => () => undefined,
  subscribeQuitRequest: () => () => undefined,
} as unknown as DesktopClient;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Profiler
      id="window"
      onRender={(_id, _phase, actualDuration) => commits.push(actualDuration)}
    >
      <App
        injectedClient={client}
        initialSnapshot={initial}
        initialWorkspaceView={view}
        {...(view === "session"
          ? { initialActiveAgentId: initial.agents[0]?.id }
          : {})}
      />
    </Profiler>
  </StrictMode>,
);
