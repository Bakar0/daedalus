import type { Database } from "bun:sqlite";
import type {
  Channel,
  ConversationKind,
  Cursor,
  Message,
  MessageKind,
  Participant,
  Resolver,
  Thread,
} from "../domain/conversations";

interface ConversationRow {
  id: number;
  kind: ConversationKind;
  workspace_id: string;
  team_id: string | null;
  number: number | null;
  owner_session_id: string | null;
  title: string | null;
  anchor_id: string | null;
  anchor_text: string | null;
  plan_path: string | null;
  task_key: string | null;
  fork_session_id: string | null;
  fork_started_at: string | null;
  fork_synced_at: string | null;
  blocked_at: string | null;
  snoozed_until: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  conversation_id: number;
  author: string;
  kind: MessageKind;
  body: string;
  details: string | null;
  options: string;
  picked: number | null;
  tags: string;
  created_at: string;
}

interface CursorRow {
  conversation_id: number;
  participant: string;
  read_through: number;
  tagged_read_through: number;
  delivered_through: number;
  delivered_at: string | null;
  last_error: string | null;
  last_attempt_at: string | null;
}

const channelFromRow = (row: ConversationRow): Channel => ({
  id: row.id,
  workspaceId: row.workspace_id,
  teamId: row.team_id!,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const threadFromRow = (row: ConversationRow): Thread => ({
  id: row.id,
  number: row.number!,
  workspaceId: row.workspace_id,
  ownerSessionId: row.owner_session_id!,
  title: row.title ?? "",
  anchorId: row.anchor_id,
  anchorText: row.anchor_text,
  planPath: row.plan_path,
  taskKey: row.task_key,
  forkSessionId: row.fork_session_id,
  blockedAt: row.blocked_at,
  snoozedUntil: row.snoozed_until,
  resolvedAt: row.resolved_at,
  resolvedBy: row.resolved_by as Resolver | null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const messageFromRow = (row: MessageRow): Message => ({
  id: row.id,
  conversationId: row.conversation_id,
  author: row.author,
  kind: row.kind,
  body: row.body,
  details: row.details,
  options: JSON.parse(row.options) as string[],
  picked: row.picked,
  tags: JSON.parse(row.tags) as string[],
  createdAt: row.created_at,
});

const cursorFromRow = (row: CursorRow): Cursor => ({
  conversationId: row.conversation_id,
  participant: row.participant,
  readThrough: row.read_through,
  taggedReadThrough: row.tagged_read_through,
  deliveredThrough: row.delivered_through,
  deliveredAt: row.delivered_at,
  lastError: row.last_error,
  lastAttemptAt: row.last_attempt_at,
});

/** What a new message carries; the store adds its id. */
export interface NewMessage {
  author: Participant;
  kind?: MessageKind;
  body: string;
  details?: string | null;
  options?: string[];
  picked?: number | null;
  tags?: string[];
  createdAt: string;
}

/** What a new thread carries; the store numbers it. */
export interface NewThread {
  workspaceId: string;
  ownerSessionId: string;
  title: string;
  anchorId: string | null;
  anchorText: string | null;
  planPath: string | null;
  taskKey: string | null;
  forkSessionId?: string | null;
  at: string;
}

/** The thread fields that change after it is created. */
export type ThreadChange = Partial<
  Pick<
    Thread,
    | "title"
    | "planPath"
    | "taskKey"
    | "forkSessionId"
    | "blockedAt"
    | "snoozedUntil"
    | "resolvedAt"
    | "resolvedBy"
  > & { forkStartedAt: string | null; forkSyncedAt: string | null }
>;

const THREAD_COLUMNS: Record<keyof ThreadChange, string> = {
  title: "title",
  planPath: "plan_path",
  taskKey: "task_key",
  forkSessionId: "fork_session_id",
  forkStartedAt: "fork_started_at",
  forkSyncedAt: "fork_synced_at",
  blockedAt: "blocked_at",
  snoozedUntil: "snoozed_until",
  resolvedAt: "resolved_at",
  resolvedBy: "resolved_by",
};

/** A search hit: the message and the conversation it is in. */
export interface SearchHit {
  message: Message;
  kind: ConversationKind;
}

/**
 * Channels, threads, their messages and every participant's cursor. Shares
 * the one connection `SqliteRepositories` opens, so its writes join that
 * class's transactions.
 */
export class ConversationRepository {
  constructor(private readonly database: Database) {}

  /** A team's channel, made the first time the team needs one. */
  channel(teamId: string, workspaceId: string, at: string): Channel {
    const found = this.findChannel(teamId);
    if (found) return found;
    // Two processes may make it at once; the second keeps the first's.
    this.database
      .query(
        `INSERT INTO conversations (kind, workspace_id, team_id, created_at, updated_at)
         VALUES ('channel', ?, ?, ?, ?) ON CONFLICT (team_id) DO NOTHING`,
      )
      .run(workspaceId, teamId, at, at);
    const channel = this.findChannel(teamId);
    if (!channel) throw new Error("The channel was not stored");
    return channel;
  }

  findChannel(teamId: string): Channel | undefined {
    const row = this.database
      .query<ConversationRow, [string]>(
        "SELECT * FROM conversations WHERE kind = 'channel' AND team_id = ?",
      )
      .get(teamId);
    return row ? channelFromRow(row) : undefined;
  }

  createThread(thread: NewThread): Thread {
    const row = this.database
      .query<ConversationRow, (string | null)[]>(
        `INSERT INTO conversations (kind, workspace_id, number, owner_session_id,
           title, anchor_id, anchor_text, plan_path, task_key, fork_session_id,
           fork_started_at, created_at, updated_at)
         VALUES ('thread', ?,
           (SELECT coalesce(MAX(number), 0) + 1 FROM conversations), ?,
           ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        thread.workspaceId,
        thread.ownerSessionId,
        thread.title,
        thread.anchorId,
        thread.anchorText,
        thread.planPath,
        thread.taskKey,
        thread.forkSessionId ?? null,
        thread.forkSessionId ? thread.at : null,
        thread.at,
        thread.at,
      );
    if (!row) throw new Error("The thread was not stored");
    return threadFromRow(row);
  }

  /** A thread by its user-facing number. */
  thread(number: number): Thread | undefined {
    const row = this.database
      .query<ConversationRow, [number]>(
        "SELECT * FROM conversations WHERE kind = 'thread' AND number = ?",
      )
      .get(number);
    return row ? threadFromRow(row) : undefined;
  }

  /** A thread by its conversation id. */
  threadById(id: number): Thread | undefined {
    const row = this.database
      .query<ConversationRow, [number]>(
        "SELECT * FROM conversations WHERE kind = 'thread' AND id = ?",
      )
      .get(id);
    return row ? threadFromRow(row) : undefined;
  }

  threadByFork(forkSessionId: string): Thread | undefined {
    const row = this.database
      .query<ConversationRow, [string]>(
        `SELECT * FROM conversations WHERE kind = 'thread'
         AND fork_session_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(forkSessionId);
    return row ? threadFromRow(row) : undefined;
  }

  /**
   * Threads, newest first. `owners` limits them to those sessions;
   * `open` to unresolved ones; `activeSince` to open ones and those with
   * a message or change since then.
   */
  threads(
    filter: {
      owners?: readonly string[];
      workspaceId?: string;
      open?: boolean;
      activeSince?: string;
    } = {},
  ): Thread[] {
    const where = ["kind = 'thread'"];
    const values: string[] = [];
    if (filter.owners) {
      if (!filter.owners.length) return [];
      where.push(
        `owner_session_id IN (${filter.owners.map(() => "?").join(", ")})`,
      );
      values.push(...filter.owners);
    }
    if (filter.workspaceId) {
      where.push("workspace_id = ?");
      values.push(filter.workspaceId);
    }
    if (filter.open) where.push("resolved_at IS NULL");
    if (filter.activeSince) {
      where.push("(resolved_at IS NULL OR updated_at >= ?)");
      values.push(filter.activeSince);
    }
    return this.database
      .query<ConversationRow, string[]>(
        `SELECT * FROM conversations WHERE ${where.join(" AND ")} ORDER BY number DESC`,
      )
      .all(...values)
      .map(threadFromRow);
  }

  /** Changes a thread's fields and returns it, or undefined when it is gone. */
  updateThread(
    id: number,
    change: ThreadChange,
    at: string,
  ): Thread | undefined {
    const keys = Object.keys(change) as (keyof ThreadChange)[];
    const row = this.database
      .query<ConversationRow, (string | number | null)[]>(
        `UPDATE conversations SET ${[
          ...keys.map((key) => `${THREAD_COLUMNS[key]} = ?`),
          "updated_at = ?",
        ].join(", ")} WHERE id = ? AND kind = 'thread' RETURNING *`,
      )
      .get(...keys.map((key) => change[key] ?? null), at, id);
    return row ? threadFromRow(row) : undefined;
  }

  /** A fork's own messages are the ones after this. */
  forkTimes(id: number): { startedAt: string | null; syncedAt: string | null } {
    const row = this.database
      .query<
        { fork_started_at: string | null; fork_synced_at: string | null },
        [number]
      >(
        "SELECT fork_started_at, fork_synced_at FROM conversations WHERE id = ?",
      )
      .get(id);
    return {
      startedAt: row?.fork_started_at ?? null,
      syncedAt: row?.fork_synced_at ?? null,
    };
  }

  /** Every fork session a thread has, for the processes that host them. */
  forkSessionIds(): string[] {
    return this.database
      .query<{ fork_session_id: string }, []>(
        `SELECT fork_session_id FROM conversations
         WHERE kind = 'thread' AND fork_session_id IS NOT NULL`,
      )
      .all()
      .map((row) => row.fork_session_id);
  }

  /**
   * A session that continues another one takes over its threads, with
   * whatever waits in them to be brought.
   */
  moveThreads(fromSessionId: string, toSessionId: string): void {
    this.database
      .query(
        `UPDATE conversations SET owner_session_id = ?
         WHERE kind = 'thread' AND owner_session_id = ?`,
      )
      .run(toSessionId, fromSessionId);
  }

  post(conversationId: number, message: NewMessage): Message {
    const row = this.database
      .query<MessageRow, (string | number | null)[]>(
        `INSERT INTO messages (conversation_id, author, kind, body, details, options, picked, tags, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        conversationId,
        message.author,
        message.kind ?? "message",
        message.body,
        message.details ?? null,
        JSON.stringify(message.options ?? []),
        message.picked ?? null,
        JSON.stringify(message.tags ?? []),
        message.createdAt,
      );
    if (!row) throw new Error("The message was not stored");
    this.database
      .query("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(message.createdAt, conversationId);
    return messageFromRow(row);
  }

  /** Messages after `afterId`, oldest first. */
  messages(conversationId: number, afterId = 0): Message[] {
    return this.database
      .query<MessageRow, [number, number]>(
        "SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id",
      )
      .all(conversationId, afterId)
      .map(messageFromRow);
  }

  /** The newest `limit` messages, oldest first. */
  recentMessages(conversationId: number, limit: number): Message[] {
    return this.database
      .query<MessageRow, [number, number]>(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(conversationId, limit)
      .map(messageFromRow)
      .reverse();
  }

  lastMessageId(conversationId: number): number {
    return (
      this.database
        .query<{ id: number | null }, [number]>(
          "SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?",
        )
        .get(conversationId)?.id ?? 0
    );
  }

  /**
   * Messages whose text matches `query`, best first. Trigram matching
   * needs three characters; shorter words are dropped from the query.
   */
  search(
    query: string,
    filter: {
      kind: ConversationKind;
      workspaceId?: string;
      /** Only these conversations. */
      conversationIds?: readonly number[];
      since?: string;
      limit: number;
    },
  ): SearchHit[] {
    const words = query
      .split(/\s+/)
      .map((word) => word.replace(/"/g, ""))
      .filter((word) => word.length >= 3);
    if (!words.length) return [];
    const where = ["messages_search MATCH ?", "conversations.kind = ?"];
    const values: (string | number)[] = [
      words.map((word) => `"${word}"`).join(" OR "),
      filter.kind,
    ];
    if (filter.workspaceId) {
      where.push("conversations.workspace_id = ?");
      values.push(filter.workspaceId);
    }
    if (filter.conversationIds) {
      if (!filter.conversationIds.length) return [];
      where.push(
        `conversations.id IN (${filter.conversationIds.map(() => "?").join(", ")})`,
      );
      values.push(...filter.conversationIds);
    }
    if (filter.since) {
      where.push("messages.created_at >= ?");
      values.push(filter.since);
    }
    return this.database
      .query<MessageRow, (string | number)[]>(
        `SELECT messages.* FROM messages_search
         JOIN messages ON messages.id = messages_search.rowid
         JOIN conversations ON conversations.id = messages.conversation_id
         WHERE ${where.join(" AND ")}
         ORDER BY bm25(messages_search) LIMIT ?`,
      )
      .all(...values, filter.limit)
      .map((row) => ({ message: messageFromRow(row), kind: filter.kind }));
  }

  /** A participant's cursor; one that never read starts at nothing read. */
  cursor(conversationId: number, participant: Participant): Cursor {
    const row = this.database
      .query<CursorRow, [number, string]>(
        "SELECT * FROM cursors WHERE conversation_id = ? AND participant = ?",
      )
      .get(conversationId, participant);
    return row
      ? cursorFromRow(row)
      : {
          conversationId,
          participant,
          readThrough: 0,
          taggedReadThrough: 0,
          deliveredThrough: 0,
          deliveredAt: null,
          lastError: null,
          lastAttemptAt: null,
        };
  }

  /**
   * Moves one marker forward, and only that column, so a read never undoes
   * a delivery another process saved meanwhile.
   */
  advance(
    conversationId: number,
    participant: Participant,
    marker: "read" | "tagged" | "delivered",
    through: number,
  ): void {
    const column = {
      read: "read_through",
      tagged: "tagged_read_through",
      delivered: "delivered_through",
    }[marker];
    this.database
      .query(
        `INSERT INTO cursors (conversation_id, participant, ${column}) VALUES (?, ?, ?)
         ON CONFLICT (conversation_id, participant) DO UPDATE SET
           ${column} = MAX(${column}, excluded.${column})`,
      )
      .run(conversationId, participant, through);
  }

  saveCursor(cursor: Cursor): void {
    this.database
      .query(
        `INSERT INTO cursors
         (conversation_id, participant, read_through, tagged_read_through, delivered_through, delivered_at, last_error, last_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (conversation_id, participant) DO UPDATE SET
           read_through = excluded.read_through,
           tagged_read_through = excluded.tagged_read_through,
           delivered_through = excluded.delivered_through,
           delivered_at = excluded.delivered_at,
           last_error = excluded.last_error,
           last_attempt_at = excluded.last_attempt_at`,
      )
      .run(
        cursor.conversationId,
        cursor.participant,
        cursor.readThrough,
        cursor.taggedReadThrough,
        cursor.deliveredThrough,
        cursor.deliveredAt,
        cursor.lastError,
        cursor.lastAttemptAt,
      );
  }

  /**
   * Threads with messages a participant was not brought yet, written by
   * someone else. Notices count only when `notices` names their author.
   */
  threadsWithNews(
    participant: Participant,
    filter: { owner?: string; noticesFrom?: readonly Participant[] } = {},
  ): Thread[] {
    const notices = filter.noticesFrom ?? [];
    const values: string[] = [participant, participant, ...notices];
    let owner = "";
    if (filter.owner) {
      owner = "AND conversations.owner_session_id = ?";
      values.push(filter.owner);
    }
    return this.database
      .query<ConversationRow, string[]>(
        `SELECT conversations.* FROM conversations
         LEFT JOIN cursors ON cursors.conversation_id = conversations.id
           AND cursors.participant = ?
         WHERE conversations.kind = 'thread' AND EXISTS (
           SELECT 1 FROM messages WHERE messages.conversation_id = conversations.id
           AND messages.id > coalesce(cursors.delivered_through, 0)
           AND messages.author <> ?
           AND (messages.kind = 'message'${
             notices.length
               ? ` OR (messages.kind = 'notice' AND messages.author IN (${notices.map(() => "?").join(", ")}))`
               : ""
           }))
         ${owner}
         ORDER BY conversations.number`,
      )
      .all(...values)
      .map(threadFromRow);
  }
}
