/**
 * The page `scripts/threads-ui-check.ts` drives: the Threads page, every
 * agent's threads as one list, over a fake host. Thread #12 is one the
 * agent bumped (blocking), #13 a free-text question, #11 one the user
 * replied to and resolved, #14 one from the team member `tests`. Every call
 * the page makes is recorded in `window.requests`.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentSessionDto,
  MainMessageDto,
  ThreadDto,
  ThreadMessageDto,
} from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { ThreadsHome } from "./ThreadsPane";
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

let nextMessage = 100;
const message = (
  author: string,
  body: string,
  at: string,
  extra: Partial<ThreadMessageDto> = {},
): ThreadMessageDto => ({
  id: (nextMessage += 1),
  author,
  kind: "message",
  body,
  details: null,
  options: [],
  picked: null,
  createdAt: at,
  ...extra,
});

const base = {
  workspaceId: "ws",
  workspaceName: "Daedalus",
  sessionId: "s-lead",
  sessionName: "webhook-retries",
  planPath: null,
  taskKey: null,
  forkSessionId: null,
  forkAnsweredAt: null,
  closedAt: null,
  blockedAt: null,
  snoozedUntil: null,
  resolvedAt: null,
  resolvedBy: null,
  unread: false,
  turn: "user" as const,
  blocking: false,
  forkOpen: false,
} satisfies Partial<ThreadDto>;

let threads: ThreadDto[] = [
  {
    ...base,
    id: 12,
    title: "How many delivery tries before a webhook is dead-lettered?",
    messages: [
      message(
        "agent",
        "How many delivery tries before a webhook is dead-lettered?\n\nThe retry config is the last piece before the migration.",
        ago(38),
        {
          details:
            "Load test: both pass. 5 tries adds about 5 minutes worst case.",
          options: [
            "3 tries (1s, 4s, 16s)",
            "5 tries (1s, 4s, 16s, 64s, 256s)",
          ],
        },
      ),
      message("agent", "blocked", ago(4), { kind: "notice" }),
    ],
    createdAt: ago(38),
    updatedAt: ago(4),
    blockedAt: ago(4),
    blocking: true,
    unread: true,
    anchorId: "a-3",
    anchorText:
      "How many delivery tries should a webhook get before it is dead-lettered? The options are in the thread.",
  },
  {
    ...base,
    id: 13,
    title: "Which Slack channel should failed webhooks alert?",
    messages: [
      message(
        "agent",
        "Which Slack channel should failed webhooks alert?",
        ago(11),
      ),
    ],
    createdAt: ago(11),
    updatedAt: ago(11),
    anchorId: "a-4",
    anchorText:
      "Dead-letter table is in. Asked where alerts should go; runbook at https://example.com/runbook. @tests wrote the alert test, and @nobody is not a session.",
  },
  {
    ...base,
    id: 11,
    title: "Branch name: webhook-retries or fix/gateway-retries?",
    messages: [
      message(
        "agent",
        "Branch name: webhook-retries or fix/gateway-retries?",
        ago(55),
        { options: ["webhook-retries", "fix/gateway-retries"] },
      ),
      message("user", "webhook-retries", ago(52), { picked: 0 }),
      message("agent", "resolved", ago(52), { kind: "notice" }),
    ],
    turn: null,
    resolvedAt: ago(52),
    resolvedBy: "agent",
    createdAt: ago(55),
    updatedAt: ago(52),
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
    messages: [
      message(
        "agent",
        "Use a real HTTP server in the flaky-delivery test?",
        ago(7),
        { options: ["Real server on a random port", "Mock fetch"] },
      ),
    ],
    createdAt: ago(7),
    updatedAt: ago(7),
    anchorId: "m-2",
    anchorText:
      "The flaky-server test is half written. Asked how real it should be.",
  },
];

/** Changes one thread and tells the pane, as the host would. */
const change = (id: number, update: (thread: ThreadDto) => ThreadDto) => {
  threads = threads.map((thread) =>
    thread.id === id ? update(thread) : thread,
  );
  queueMicrotask(() => listeners.forEach((listener) => listener()));
  return ok(threads.find((thread) => thread.id === id)!);
};

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
    text: "How many delivery tries should a webhook get before it is dead-lettered? The options are in the thread.",
    at: ago(38),
  },
  {
    id: "a-4",
    role: "agent",
    text: "Dead-letter table is in ([PR 41](https://github.com/example/gateway/pull/41)). Asked where alerts should go.",
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
    threadList: (params: unknown) => {
      window.requests.push({ threadList: params });
      return ok(threads);
    },
    threadSay: (params: {
      id: number;
      body: string | null;
      option: number | null;
    }) => {
      window.requests.push({ threadSay: params });
      return change(params.id, (thread) => {
        const offer = thread.messages
          .filter((item) => item.kind === "message" && item.options.length)
          .at(-1);
        const picked =
          params.option === null ? null : offer?.options[params.option];
        return {
          ...thread,
          messages: [
            ...thread.messages,
            message(
              "user",
              [picked, params.body].filter(Boolean).join("\n"),
              new Date().toISOString(),
              { picked: params.option },
            ),
          ],
          turn: "agent",
          blocking: false,
          blockedAt: null,
          resolvedAt: null,
        };
      });
    },
    threadRead: (params: { id: number }) => {
      window.requests.push({ threadRead: params });
      return change(params.id, (thread) => ({ ...thread, unread: false }));
    },
    threadOpenFork: (params: {
      sessionId: string;
      anchorId: string | null;
      threadId?: number;
    }) => {
      window.requests.push({ threadOpenFork: params });
      if (params.threadId !== undefined)
        // A thread's own fork: the thread gets it, no new thread.
        return change(params.threadId, (thread) => ({
          ...thread,
          forkSessionId: "s-fork",
          forkAnsweredAt: null,
          closedAt: null,
          forkOpen: true,
        }));
      const anchor = messages.find((item) => item.id === params.anchorId);
      const fork: ThreadDto = {
        ...base,
        id: 20,
        forkSessionId: "s-fork",
        forkAnsweredAt: null,
        closedAt: null,
        forkOpen: true,
        title: anchor?.text.split("\n")[0] ?? "Thread",
        messages: [],
        turn: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        anchorId: params.anchorId,
        anchorText: anchor?.text ?? null,
      };
      threads = [...threads, fork];
      return ok(fork);
    },
    threadCloseFork: (params: { id: number }) => {
      window.requests.push({ threadCloseFork: params });
      return change(params.id, (thread) => ({ ...thread, forkOpen: false }));
    },
    threadForkDraft: (params: { id: number }) => {
      window.requests.push({ threadForkDraft: params });
      return ok({
        text: "Keep custom backoff: the queue drops a job after 3 tries with no record.",
      });
    },
    threadResolve: (params: { id: number }) => {
      window.requests.push({ threadResolve: params });
      return change(params.id, (thread) => ({
        ...thread,
        resolvedAt: new Date().toISOString(),
        resolvedBy: "user",
        turn: null,
        forkOpen: false,
        messages: [
          ...thread.messages,
          message("user", "resolved", new Date().toISOString(), {
            kind: "notice",
          }),
        ],
      }));
    },
    threadReopen: (params: { id: number }) => {
      window.requests.push({ threadReopen: params });
      return change(params.id, (thread) => ({
        ...thread,
        resolvedAt: null,
        resolvedBy: null,
        turn: "agent",
        messages: [
          ...thread.messages,
          message("user", "reopened", new Date().toISOString(), {
            kind: "notice",
          }),
        ],
      }));
    },
    threadSendToMain: (params: { id: number; text: string }) => {
      window.requests.push({ threadSendToMain: params });
      void change(params.id, (thread) => ({
        ...thread,
        turn: "agent",
        messages: [
          ...thread.messages,
          message("user", params.text, new Date().toISOString()),
        ],
      }));
      return ok({ text: params.text });
    },
    threadSnooze: (params: { id: number; until: string | null }) => {
      window.requests.push({ threadSnooze: params });
      return change(params.id, (thread) => ({
        ...thread,
        snoozedUntil: params.until,
      }));
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="app" style={{ display: "block", height: "100vh" }}>
      <ThreadsHome
        client={client}
        onError={(message) => console.error(message)}
        onOpenThread={(thread) =>
          window.requests.push({ openThread: thread.id })
        }
      />
    </div>
  </StrictMode>,
);
