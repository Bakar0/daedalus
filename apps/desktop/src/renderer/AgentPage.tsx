import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentSessionDto, WorkflowRunDto } from "@daedalus/protocol";
import { type AgentNode, flattenAgents } from "./agent-tree";
import type { DesktopClient } from "./client-types";
import {
  type ChatTabId,
  openThreads,
  threadName,
  useConversationNames,
  useWorkspaceThreads,
} from "./FactoryChats";
import { sessionName, type SessionStatusView } from "./session-view";
import "./factory.css";
import "./agent-page.css";

/** What the center asks the chat to show; a new `nonce` asks again. */
export interface AgentChatRequest {
  tab: ChatTabId;
  view: "thread" | "terminal";
  nonce: number;
}

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
 * One agent's conversation in the session's place: a top line with its
 * threads as tabs and its harness, model and context use, then the chat.
 * Mount it with the session's id as `key`.
 */
export function AgentConversation({
  ask,
  client,
  meta,
  renderChat,
  session,
}: {
  /** A thread to show, asked for outside the page; a new `nonce` asks again. */
  ask?: { tab: ChatTabId; nonce: number } | undefined;
  client: DesktopClient;
  /** `Claude · Opus 5.5 · 34% of context used`. */
  meta: string;
  renderChat: (
    request: AgentChatRequest,
    onTabChange: (tab: ChatTabId) => void,
  ) => ReactNode;
  session: AgentSessionDto;
}) {
  const [request, setRequest] = useState<AgentChatRequest>({
    tab: ask?.tab ?? "agent",
    view: "thread",
    nonce: 0,
  });
  const asked = useRef(ask?.nonce);
  useEffect(() => {
    if (!ask || asked.current === ask.nonce) return;
    asked.current = ask.nonce;
    setRequest((before) => ({
      tab: ask.tab,
      view: "thread",
      nonce: before.nonce + 1,
    }));
  }, [ask]);
  const { threads } = useWorkspaceThreads(client, session.workspaceId);
  const { names } = useConversationNames();
  const forks = openThreads(threads, session.id);
  const show = (tab: ChatTabId) =>
    setRequest((before) => ({ tab, view: "thread", nonce: before.nonce + 1 }));
  return (
    <div className="agent-page agent-conversation">
      <header className="agent-top">
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
          {request.tab === "history" && (
            <button aria-selected role="tab" type="button">
              History
            </button>
          )}
          <button
            aria-label="Ask a fork, without interrupting"
            aria-selected={request.tab === "new"}
            onClick={() => show("new")}
            role="tab"
            title="Ask a fork of this agent, without interrupting it"
            type="button"
          >
            +
          </button>
        </div>
        <span className="agent-top-meta">{meta}</span>
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
        {renderChat(request, (tab) =>
          setRequest((before) =>
            before.tab === tab ? before : { ...before, tab },
          ),
        )}
      </div>
    </div>
  );
}

/**
 * The side panel's Agents tab: the agents one started agent created, as a
 * tree. The panel's workflow dock below it has the steps of the one shown.
 */
export function AgentTreePane({
  onSelect,
  root,
  runOf,
  selected,
  statusOf,
}: {
  onSelect: (session: AgentSessionDto) => void;
  /** The started agent the one on screen sits under, itself included. */
  root: AgentNode | undefined;
  runOf: (sessionId: string) => WorkflowRunDto | undefined;
  /** The agent on screen. */
  selected: AgentSessionDto | undefined;
  statusOf: (session: AgentSessionDto) => SessionStatusView;
}) {
  if (!root || !selected)
    return (
      <div className="agent-page agent-tree-pane">
        <p className="agent-tree-empty">
          Open an agent to see the agents it created.
        </p>
      </div>
    );
  return (
    <div className="agent-page agent-tree-pane">
      {flattenAgents(root).map(({ session, depth }) => {
        const status = statusOf(session);
        return (
          <button
            aria-current={selected.id === session.id ? "true" : undefined}
            className="agent-row"
            key={session.id}
            onClick={() => onSelect(session)}
            style={{ paddingLeft: 10 + depth * 16 }}
            title={status.detail ?? undefined}
            type="button"
          >
            <span
              aria-hidden="true"
              className={`agent-dot tone-${status.tone}`}
            />
            <span className="agent-row-name">{agentLabel(session)}</span>
            {session.pinnedAt && depth > 0 && (
              <span className="agent-row-tag">pinned</span>
            )}
            <span className="agent-row-state">
              {status.attention
                ? "waits for you"
                : (stepLine(runOf(session.id)) ?? status.label)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
