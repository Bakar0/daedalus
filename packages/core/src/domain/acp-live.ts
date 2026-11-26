import type { AcpLogEntry } from "../services/acp-host";

/**
 * What an ACP agent is doing now, read from its host's log: the turn it is
 * on, as far as it has come. The finished conversation is the provider's own
 * transcript; this is the part of it that is not written there yet.
 */
export interface AcpLive {
  /** A turn is running. */
  working: boolean;
  /** How many turns have ended since the host started. */
  turns: number;
  /** When the turn that is running, or ran last, started. */
  turnStartedAt: string | null;
  /** What the turn said and did so far, in order. */
  parts: AcpLivePart[];
  /** The permission the agent waits on, when it does. */
  permission: AcpLivePermission | null;
  /** Messages sent during the turn, which run after it. */
  queued: string[];
  /** How much of the model's context the conversation fills. */
  usage: { used: number; size: number } | null;
  /** The host exited: the agent is not running. */
  ended: boolean;
}

export type AcpLivePart =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      id: string;
      title: string;
      /** The protocol's kind: `read`, `edit`, `execute`, `search` and so on. */
      tool: string;
      status: AcpToolStatus;
    };

export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface AcpLivePermission {
  /** What the answer names. */
  requestId: number | string;
  title: string;
  options: Array<{
    id: string;
    name: string;
    /** `allow_once`, `allow_always`, `reject_once` or `reject_always`. */
    kind: string;
  }>;
}

export const emptyAcpLive = (): AcpLive => ({
  working: false,
  turns: 0,
  turnStartedAt: null,
  parts: [],
  permission: null,
  queued: [],
  usage: null,
  ended: false,
});

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : {};
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

const STATUSES = new Set(["pending", "in_progress", "completed", "failed"]);
const status = (value: unknown, fallback: AcpToolStatus) =>
  typeof value === "string" && STATUSES.has(value)
    ? (value as AcpToolStatus)
    : fallback;

function update(live: AcpLive, change: Fields): AcpLive {
  switch (change.sessionUpdate) {
    case "agent_message_chunk": {
      // Outside a turn the adapter is replaying a loaded conversation.
      if (!live.working) return live;
      const more = text(fields(change.content).text);
      const last = live.parts.at(-1);
      return {
        ...live,
        parts:
          last?.kind === "text"
            ? [...live.parts.slice(0, -1), { ...last, text: last.text + more }]
            : [...live.parts, { kind: "text", text: more }],
      };
    }
    case "tool_call": {
      if (!live.working) return live;
      const id = text(change.toolCallId);
      return {
        ...live,
        parts: [
          ...live.parts.filter(
            (part) => part.kind !== "tool" || part.id !== id,
          ),
          {
            kind: "tool",
            id,
            title: text(change.title) || text(change.name) || "Tool",
            tool: text(change.kind) || "other",
            status: status(change.status, "pending"),
          },
        ],
      };
    }
    case "tool_call_update": {
      const id = text(change.toolCallId);
      return {
        ...live,
        parts: live.parts.map((part) =>
          part.kind === "tool" && part.id === id
            ? {
                ...part,
                title: text(change.title) || part.title,
                tool: text(change.kind) || part.tool,
                status: status(change.status, part.status),
              }
            : part,
        ),
      };
    }
    case "usage_update":
      return typeof change.used === "number" && typeof change.size === "number"
        ? { ...live, usage: { used: change.used, size: change.size } }
        : live;
    default:
      return live;
  }
}

/** The state after one more line of the host's log. */
export function reduceAcpLive(live: AcpLive, entry: AcpLogEntry): AcpLive {
  if (entry.from === "host") {
    const event = entry.event;
    switch (event.type) {
      case "turn_start": {
        const at = live.queued.indexOf(event.text);
        return {
          ...live,
          working: true,
          turnStartedAt: entry.at,
          parts: [],
          permission: null,
          queued: at < 0 ? live.queued : live.queued.toSpliced(at, 1),
        };
      }
      case "turn_end":
        return {
          ...live,
          working: false,
          permission: null,
          turns: live.turns + 1,
        };
      case "queued":
        return { ...live, queued: [...live.queued, event.text] };
      case "exit":
        return {
          ...live,
          working: false,
          permission: null,
          queued: [],
          ended: true,
        };
      default:
        return live;
    }
  }
  const { message } = entry;
  if (entry.from === "client") {
    // The answer to the permission asked, or a cancel that withdrew it.
    if (
      live.permission &&
      message.method === undefined &&
      message.id === live.permission.requestId
    )
      return { ...live, permission: null };
    return live;
  }
  if (message.method === "session/update")
    return update(live, fields(fields(message.params).update));
  if (
    message.method === "session/request_permission" &&
    message.id !== undefined
  ) {
    const params = fields(message.params);
    const options = Array.isArray(params.options) ? params.options : [];
    return {
      ...live,
      permission: {
        requestId: message.id,
        title: text(fields(params.toolCall).title) || "Permission",
        options: options.map(fields).flatMap((option) =>
          typeof option.optionId === "string"
            ? [
                {
                  id: option.optionId,
                  name: text(option.name) || option.optionId,
                  kind: text(option.kind),
                },
              ]
            : [],
        ),
      },
    };
  }
  return live;
}
