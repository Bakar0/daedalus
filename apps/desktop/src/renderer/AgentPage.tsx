import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  AgentSessionDto,
  TeamDto,
  WorkflowRunDto,
  WorkspaceDto,
} from "@daedalus/protocol";
import { agentTree, flattenAgents } from "./agent-tree";
import type { DesktopClient } from "./client-types";
import {
  type ChatTabId,
  openThreads,
  threadName,
  useConversationNames,
  useWorkspaceThreads,
} from "./FactoryChats";
import {
  StartPrompt,
  type StartChoice,
  type StartOptions,
} from "./FactoryPage";
import { sessionName, type SessionStatusView } from "./session-view";
import "./factory.css";
import "./agent-page.css";

/** What the center asks the chat to show; a new `nonce` asks again. */
export interface AgentChatRequest {
  tab: ChatTabId;
  view: "thread" | "terminal";
  nonce: number;
}

type RightTab = "agents" | "files" | "git";

const SELECTED_KEY = "daedalus.agent-page.selected";

const remembered = (): string | undefined => {
  try {
    return window.localStorage.getItem(SELECTED_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

/** What an agent is called in a list: its team handle, or its name. */
const agentLabel = (session: AgentSessionDto) =>
  session.teamHandle ? `@${session.teamHandle}` : sessionName(session);

/** The step a run is on, as `build · 3 of 5`, or nothing when it has none. */
function stepLine(run: WorkflowRunDto | undefined): string | undefined {
  if (!run) return undefined;
  const at = run.steps.findIndex(
    (step) => step.state === "active" || step.state === "waiting",
  );
  return at < 0
    ? undefined
    : `${run.steps[at]!.name.split("/").at(-1)} · ${at + 1} of ${run.steps.length}`;
}

/**
 * One agent, one page. The left list has the agents the user started, the
 * center is the selected agent's conversation, and the right column has
 * the agents it created with the selected agent's workflow steps.
 */
export function AgentPage({
  agents,
  client,
  metaOf,
  onFactory,
  onHome,
  onSettings,
  onStart,
  onWorkspace,
  renderChat,
  runOf,
  selectedId,
  startOptionsOf,
  statusOf,
  teams,
  workspaces,
}: {
  /** Every listed agent of every workspace, in the user's order. */
  agents: readonly AgentSessionDto[];
  client: DesktopClient;
  /** `Claude · Opus 5.5 · 34% of context used`. */
  metaOf: (session: AgentSessionDto) => string;
  onFactory: (session: AgentSessionDto) => void;
  onHome: (page: "routines" | "methods" | "instructions") => void;
  onSettings: () => void;
  onStart: (
    workspace: WorkspaceDto,
    text: string,
    choice?: StartChoice,
  ) => Promise<boolean>;
  /** The workspace of the agent on screen changed. */
  onWorkspace: (workspaceId: string) => void;
  renderChat: (
    session: AgentSessionDto,
    request: AgentChatRequest,
    onTabChange: (tab: ChatTabId) => void,
  ) => ReactNode;
  runOf: (sessionId: string) => WorkflowRunDto | undefined;
  /** The agent the rest of the app last showed, to start on. */
  selectedId?: string | undefined;
  startOptionsOf: (workspace: WorkspaceDto) => StartOptions;
  statusOf: (session: AgentSessionDto) => SessionStatusView;
  teams: readonly TeamDto[];
  workspaces: readonly WorkspaceDto[];
}) {
  const tree = useMemo(() => agentTree(agents, teams), [agents, teams]);
  const [picked, setPicked] = useState<string | undefined>(
    () => selectedId ?? remembered(),
  );
  /** The workspace whose start box shows instead of an agent. */
  const [starting, setStarting] = useState<string>();
  const [rightTab, setRightTab] = useState<RightTab>("agents");
  const [request, setRequest] = useState<AgentChatRequest>({
    tab: "agent",
    view: "thread",
    nonce: 0,
  });
  const selected =
    (picked ? tree.nodeOf(picked)?.session : undefined) ??
    tree.roots[0]?.session;
  const rootId = selected ? tree.rootOf(selected.id) : undefined;
  const root = rootId ? tree.nodeOf(rootId) : undefined;
  const startWorkspace = starting
    ? workspaces.find((item) => item.id === starting)
    : !selected
      ? workspaces[0]
      : undefined;

  const select = (session: AgentSessionDto) => {
    setStarting(undefined);
    setPicked(session.id);
    setRequest({ tab: "agent", view: "thread", nonce: Date.now() });
    try {
      window.localStorage.setItem(SELECTED_KEY, session.id);
    } catch {
      // Remembering the agent is a convenience.
    }
  };
  const selectedWorkspaceId = selected?.workspaceId;
  useEffect(() => {
    if (selectedWorkspaceId) onWorkspace(selectedWorkspaceId);
    // Only a change of workspace is worth telling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkspaceId]);

  const { threads } = useWorkspaceThreads(client, selectedWorkspaceId ?? "");
  const { names } = useConversationNames();
  const forks = selected ? openThreads(threads, selected.id) : [];
  const show = (tab: ChatTabId) =>
    setRequest((before) => ({ tab, view: "thread", nonce: before.nonce + 1 }));

  const dot = (session: AgentSessionDto) => (
    <span
      aria-hidden="true"
      className={`agent-dot tone-${statusOf(session).tone}`}
    />
  );
  const stateOf = (session: AgentSessionDto) => {
    const status = statusOf(session);
    return status.attention
      ? "waits for you"
      : (stepLine(runOf(session.id)) ?? status.label);
  };
  const row = (
    session: AgentSessionDto,
    options: { depth?: number; pinned?: boolean } = {},
  ) => (
    <button
      aria-current={
        selected?.id === session.id && !starting ? "true" : undefined
      }
      className="agent-row"
      key={session.id}
      onClick={() => select(session)}
      style={{ paddingLeft: 10 + (options.depth ?? 0) * 16 }}
      title={statusOf(session).detail ?? undefined}
      type="button"
    >
      {dot(session)}
      <span className="agent-row-name">{agentLabel(session)}</span>
      {options.pinned && <span className="agent-row-tag">pinned</span>}
      <span className="agent-row-state">{stateOf(session)}</span>
    </button>
  );

  const run = selected ? runOf(selected.id) : undefined;
  return (
    <div className="agent-page">
      <aside aria-label="Agents you started" className="agent-left">
        <div className="agent-brand">
          <img alt="" aria-hidden="true" src="/daedalus-app-icon.png" />
          <strong>Daedalus</strong>
        </div>
        <div className="agent-left-list">
          {workspaces.map((workspace) => {
            const mine = (session: AgentSessionDto) =>
              session.workspaceId === workspace.id;
            const roots = tree.roots.filter((node) => mine(node.session));
            const pinned = tree.pinned.filter(mine);
            return (
              <section key={workspace.id}>
                <header className="agent-left-head">
                  <span>{workspace.name}</span>
                  <button
                    onClick={() => setStarting(workspace.id)}
                    title={`Start an agent in ${workspace.name}`}
                    type="button"
                  >
                    + new
                  </button>
                </header>
                {pinned.map((session) => row(session, { pinned: true }))}
                {roots.map((node) => row(node.session))}
                {roots.length === 0 && (
                  <p className="agent-left-empty">No agents yet</p>
                )}
              </section>
            );
          })}
        </div>
        <footer className="agent-left-foot">
          <button onClick={() => onHome("routines")} type="button">
            Routines
          </button>
          <button onClick={() => onHome("methods")} type="button">
            Workflows
          </button>
          <button onClick={() => onHome("instructions")} type="button">
            Instructions
          </button>
          <button onClick={onSettings} type="button">
            Settings
          </button>
        </footer>
      </aside>

      <main aria-label="Conversation" className="agent-center">
        {startWorkspace ? (
          <div className="agent-start factory-shell">
            <StartPrompt
              client={client}
              onStart={async (text, choice) => {
                const started = await onStart(startWorkspace, text, choice);
                if (started) setStarting(undefined);
                return started;
              }}
              options={startOptionsOf(startWorkspace)}
              workspaceName={startWorkspace.name}
            />
          </div>
        ) : selected ? (
          <>
            <header className="agent-top">
              <strong className="agent-top-name">{agentLabel(selected)}</strong>
              <div aria-label="Threads" className="agent-forks" role="tablist">
                <button
                  aria-selected={request.tab === "agent"}
                  onClick={() => show("agent")}
                  role="tab"
                  type="button"
                >
                  Main
                </button>
                {forks.map((thread) => (
                  <button
                    aria-selected={request.tab === thread.id}
                    key={thread.id}
                    onClick={() => show(thread.id)}
                    role="tab"
                    title={threadName(thread, names)}
                    type="button"
                  >
                    <span aria-hidden="true">⑂</span>
                    {threadName(thread, names)}
                  </button>
                ))}
              </div>
              <span className="agent-top-meta">{metaOf(selected)}</span>
              <button
                aria-pressed={request.view === "terminal"}
                className="agent-top-button"
                onClick={() =>
                  setRequest((before) => ({
                    tab: "agent",
                    view: before.view === "terminal" ? "thread" : "terminal",
                    nonce: before.nonce + 1,
                  }))
                }
                type="button"
              >
                Terminal
              </button>
            </header>
            <div className="agent-chat">
              {renderChat(selected, request, (tab) =>
                setRequest((before) =>
                  before.tab === tab ? before : { ...before, tab },
                ),
              )}
            </div>
          </>
        ) : (
          <div className="empty large">
            <strong>No workspace yet</strong>
          </div>
        )}
      </main>

      <aside aria-label="Its agents" className="agent-right">
        <header className="agent-right-tabs">
          <div role="tablist">
            {(["agents", "files", "git"] as const).map((tab) => (
              <button
                aria-selected={rightTab === tab}
                key={tab}
                onClick={() => setRightTab(tab)}
                role="tab"
                type="button"
              >
                {tab === "agents"
                  ? "Agents"
                  : tab === "files"
                    ? "Files"
                    : "Git"}
                {tab === "agents" && root && (
                  <small>{flattenAgents(root).length}</small>
                )}
              </button>
            ))}
          </div>
          <button
            className="agent-top-button"
            disabled={!root}
            onClick={() => root && onFactory(root.session)}
            type="button"
          >
            Factory
          </button>
        </header>
        {rightTab === "agents" ? (
          <div className="agent-right-body">
            {root &&
              flattenAgents(root).map(({ session, depth }) =>
                row(session, {
                  depth,
                  pinned: Boolean(session.pinnedAt) && depth > 0,
                }),
              )}
            {selected && (
              <section className="agent-steps">
                <h3>Workflow of {agentLabel(selected)}</h3>
                {run ? (
                  <ol>
                    {run.steps.map((step) => (
                      <li className={`is-${step.state}`} key={step.name}>
                        <span aria-hidden="true" className="agent-step-mark">
                          {step.state === "done"
                            ? "✓"
                            : step.state === "skipped"
                              ? "–"
                              : step.state === "pending"
                                ? "·"
                                : "●"}
                        </span>
                        <span>
                          {step.name}
                          {step.state === "waiting" && (
                            <small>waits for your approval</small>
                          )}
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="agent-left-empty">Not in a workflow</p>
                )}
              </section>
            )}
          </div>
        ) : (
          <div className="agent-right-body">
            <p className="agent-left-empty">
              {rightTab === "files"
                ? "The selected agent's files come here."
                : "The selected agent's branch, changes and pull request come here."}
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}
