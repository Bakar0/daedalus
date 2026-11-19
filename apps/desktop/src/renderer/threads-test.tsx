/**
 * The page `scripts/threads-ui-check.ts` drives: the Threads pane for one
 * session, over a fake host. Thread #12 is a question the agent bumped
 * (blocking), #13 a free-text question, #11 one already answered, #14 a
 * question from the team member `tests`. Every call
 * the pane makes is recorded in `window.requests`.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentSessionDto,
  AskDto,
  MainMessageDto,
} from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { ThreadsHome, ThreadsPane } from "./ThreadsPane";
import "./styles.css";

const style = document.createElement("style");
style.textContent = `.fake-terminal { background: #080c14; color: #c9d4e6; flex: 1; font: 12px/1.6 "SF Mono", Menlo, monospace; padding: 10px 12px; } .fake-terminal div { margin-bottom: 6px; }`;
document.head.append(style);

declare global {
  interface Window {
    requests: Array<Record<string, unknown>>;
  }
}
window.requests = [];
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const session = {
  id: "s-lead",
  kind: "agent",
  name: "webhook-retries",
  provider: "claude",
  workspaceId: "ws",
} as unknown as AgentSessionDto;

const base = {
  workspaceId: "ws",
  workspaceName: "Daedalus",
  sessionId: "s-lead",
  sessionName: "webhook-retries",
  context: null,
  why: null,
  options: [],
  recommended: null,
  planPath: null,
  taskKey: null,
  answer: null,
  note: null,
  closedReason: null,
  closedAt: null,
  undoable: false,
  snoozedUntil: null,
  bumpedAt: null,
  kind: "question" as const,
  forkSessionId: null,
} satisfies Partial<AskDto>;

let asks: AskDto[] = [
  {
    ...base,
    id: 12,
    title: "How many delivery tries before a webhook is dead-lettered?",
    why: "The retry config is the last piece before the migration.",
    context: "Load test: both pass. 5 tries adds about 5 minutes worst case.",
    options: ["3 tries (1s, 4s, 16s)", "5 tries (1s, 4s, 16s, 64s, 256s)"],
    recommended: 1,
    state: "open",
    createdAt: ago(38),
    bumpedAt: ago(4),
    anchorId: "a-3",
    anchorText:
      "Asked about the retry budget in a thread. Moving on to the dead-letter table while I wait.",
  },
  {
    ...base,
    id: 13,
    title: "Which Slack channel should failed webhooks alert?",
    state: "open",
    createdAt: ago(11),
    anchorId: "a-4",
    anchorText: "Dead-letter table is in. Asked where alerts should go.",
  },
  {
    ...base,
    id: 11,
    title: "Branch name: webhook-retries or fix/gateway-retries?",
    options: ["webhook-retries", "fix/gateway-retries"],
    state: "answered",
    answer: "webhook-retries",
    createdAt: ago(55),
    closedAt: ago(52),
    anchorId: "a-1",
    anchorText: "Starting on webhook retries. I need a branch name first.",
  },
  {
    ...base,
    id: 14,
    sessionId: "s-tests",
    // Another workspace, for Home's workspace filter.
    workspaceId: "ws-docs",
    workspaceName: "Docs",
    sessionName: "tests",
    title: "Use a real HTTP server in the flaky-delivery test?",
    options: ["Real server on a random port", "Mock fetch"],
    recommended: 0,
    state: "open",
    createdAt: ago(7),
    anchorId: "m-2",
    anchorText:
      "The flaky-server test is half written. Asked how real it should be.",
  },
];

const messages: MainMessageDto[] = [
  {
    id: "u-1",
    role: "user",
    text: "add retries with backoff to webhook delivery in the gateway",
    at: ago(60),
  },
  {
    id: "a-1",
    role: "agent",
    text: "Starting on webhook retries. I need a branch name first.",
    at: ago(56),
  },
  {
    id: "a-2",
    role: "agent",
    text: "Plan:\n  1. Exponential backoff in gateway/webhooks/deliver.ts\n  2. Retry budget from config\n  3. webhook_dead_letters table\n  4. Tests with a flaky server",
    at: ago(50),
  },
  {
    id: "a-3",
    role: "agent",
    text: "Asked about the retry budget in a thread. Moving on to the dead-letter table while I wait.",
    at: ago(38),
  },
  {
    id: "a-4",
    role: "agent",
    text: "Dead-letter table is in. Asked where alerts should go.",
    at: ago(11),
  },
  {
    id: "a-5",
    role: "agent",
    text: "Backoff and dead-letter table are done. Waiting on thread #12.",
    at: ago(4),
  },
];

const listeners = new Set<() => void>();
const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
const client = {
  request: {
    askList: (params: unknown) => {
      window.requests.push({ askList: params });
      return ok(asks);
    },
    askAnswer: (params: {
      id: number;
      option: number | null;
      note: string | null;
    }) => {
      window.requests.push({ askAnswer: params });
      asks = asks.map((ask) =>
        ask.id === params.id
          ? {
              ...ask,
              state: "answered",
              answer:
                params.option === null
                  ? null
                  : (ask.options[params.option] ?? null),
              note: params.note,
              closedAt: new Date().toISOString(),
            }
          : ask,
      );
      queueMicrotask(() => listeners.forEach((listener) => listener()));
      return ok(asks.find((ask) => ask.id === params.id)!);
    },
    threadOpenFork: (params: {
      sessionId: string;
      anchorId: string | null;
      threadId?: number;
    }) => {
      window.requests.push({ threadOpenFork: params });
      if (params.threadId !== undefined) {
        // A question's own fork: the question gets it, no new thread.
        asks = asks.map((ask) =>
          ask.id === params.threadId
            ? { ...ask, forkSessionId: "s-fork" }
            : ask,
        );
        queueMicrotask(() => listeners.forEach((listener) => listener()));
        return ok(asks.find((ask) => ask.id === params.threadId)!);
      }
      const anchor = messages.find((message) => message.id === params.anchorId);
      const fork: AskDto = {
        ...base,
        id: 20,
        kind: "fork",
        forkSessionId: "s-fork",
        title: anchor?.text.split("\n")[0] ?? "Thread",
        state: "open",
        createdAt: new Date().toISOString(),
        anchorId: params.anchorId,
        anchorText: anchor?.text ?? null,
      };
      asks = [...asks, fork];
      return ok(fork);
    },
    threadForkDraft: (params: { id: number }) => {
      window.requests.push({ threadForkDraft: params });
      return ok({
        text: "Keep custom backoff: the queue drops a job after 3 tries with no record.",
      });
    },
    threadClose: (params: { id: number }) => {
      window.requests.push({ threadClose: params });
      asks = asks.map((ask) =>
        ask.id === params.id
          ? {
              ...ask,
              state: ask.kind === "question" ? "dismissed" : "closed",
              closedAt: new Date().toISOString(),
            }
          : ask,
      );
      queueMicrotask(() => listeners.forEach((listener) => listener()));
      return ok(asks.find((ask) => ask.id === params.id)!);
    },
    threadReopen: (params: { id: number }) => {
      window.requests.push({ threadReopen: params });
      asks = asks.map((ask) =>
        ask.id === params.id
          ? { ...ask, state: "open", answer: null, note: null, closedAt: null }
          : ask,
      );
      queueMicrotask(() => listeners.forEach((listener) => listener()));
      return ok(asks.find((ask) => ask.id === params.id)!);
    },
    threadSendToMain: (params: { id: number; text: string }) => {
      window.requests.push({ threadSendToMain: params });
      const thread = asks.find((ask) => ask.id === params.id);
      if (thread?.kind === "question") {
        asks = asks.map((ask) =>
          ask.id === params.id
            ? {
                ...ask,
                state: "answered",
                note: params.text,
                closedAt: new Date().toISOString(),
              }
            : ask,
        );
        queueMicrotask(() => listeners.forEach((listener) => listener()));
      }
      return ok({ text: params.text });
    },
    askSnooze: (params: { id: number; until: string | null }) => {
      window.requests.push({ askSnooze: params });
      asks = asks.map((ask) =>
        ask.id === params.id ? { ...ask, snoozedUntil: params.until } : ask,
      );
      queueMicrotask(() => listeners.forEach((listener) => listener()));
      return ok(asks.find((ask) => ask.id === params.id)!);
    },
    sessionMessages: (params: unknown) => {
      window.requests.push({ sessionMessages: params });
      return ok(messages);
    },
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
} as unknown as DesktopClient;

const query = new URLSearchParams(window.location.search);
const home = query.has("home");
// `?thread=<id>`: the pane as a thread's own tab, with that thread's fork.
const tabThread = query.get("thread") ? Number(query.get("thread")) : undefined;
if (tabThread !== undefined)
  asks = asks.map((ask) =>
    ask.id === tabThread ? { ...ask, forkSessionId: "s-fork" } : ask,
  );
if (home)
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <div className="app" style={{ display: "block", height: "100vh" }}>
        <ThreadsHome
          client={client}
          onError={(message) => console.error(message)}
          onOpenThread={(thread, focus) =>
            window.requests.push({ openThread: thread.id, focus })
          }
        />
      </div>
    </StrictMode>,
  );
else
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <div className="app" style={{ display: "block" }}>
        <div
          className="side-panel-activity"
          style={{
            width: 380,
            height: "100vh",
            borderRight: "1px solid var(--line)",
          }}
        >
          <ThreadsPane
            client={client}
            onError={(message) => console.error(message)}
            renderTerminal={(id) => (
              <div className="fake-terminal" data-session={id}>
                <div>&gt; why not the queue&apos;s built-in retry?</div>
                <div>
                  ● The queue retries every 30s and drops the job after 3 tries,
                  with no record. Keep custom backoff.
                </div>
                <div style={{ color: "var(--muted)" }}>
                  ⏸ plan mode on (shift+tab to cycle)
                </div>
              </div>
            )}
            members={[{ id: "s-tests", name: "tests" }]}
            {...(tabThread === undefined ? {} : { startThreadId: tabThread })}
            session={session}
          />
        </div>
      </div>
    </StrictMode>,
  );
