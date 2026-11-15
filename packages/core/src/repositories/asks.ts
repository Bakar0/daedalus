import type { Database } from "bun:sqlite";
import type { Ask, AskState } from "../domain";

interface AskRow {
  id: number;
  workspace_id: string;
  session_id: string;
  title: string;
  context: string | null;
  why: string | null;
  options: string;
  recommended: number | null;
  plan_path: string | null;
  task_key: string | null;
  state: AskState;
  answer: string | null;
  note: string | null;
  closed_reason: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  notice_delivered_at: string | null;
  notified_at: string | null;
}

const options = (text: string): string[] => {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};

const askFromRow = (row: AskRow): Ask => ({
  id: row.id,
  workspaceId: row.workspace_id,
  sessionId: row.session_id,
  title: row.title,
  context: row.context,
  why: row.why,
  options: options(row.options),
  recommended: row.recommended,
  planPath: row.plan_path,
  taskKey: row.task_key,
  state: row.state,
  answer: row.answer,
  note: row.note,
  closedReason: row.closed_reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  closedAt: row.closed_at,
  noticeDeliveredAt: row.notice_delivered_at,
});

/** What an asker writes; the rest is the ask's lifecycle. */
export type AskContent = Pick<
  Ask,
  | "title"
  | "context"
  | "why"
  | "options"
  | "recommended"
  | "planPath"
  | "taskKey"
>;

/** Questions for the user (046). */
export class AskRepository {
  constructor(private readonly database: Database) {}

  create(
    input: AskContent & { workspaceId: string; sessionId: string; at: string },
  ): Ask {
    const row = this.database
      .query<AskRow, (string | number | null)[]>(
        `INSERT INTO asks
         (workspace_id, session_id, title, context, why, options, recommended,
          plan_path, task_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        input.workspaceId,
        input.sessionId,
        input.title,
        input.context,
        input.why,
        JSON.stringify(input.options),
        input.recommended,
        input.planPath,
        input.taskKey,
        input.at,
        input.at,
      );
    if (!row) throw new Error("The ask was not saved");
    return askFromRow(row);
  }

  /** Rewrites what an open ask says. */
  update(id: number, content: AskContent, at: string): Ask {
    const row = this.database
      .query<AskRow, (string | number | null)[]>(
        `UPDATE asks SET title = ?, context = ?, why = ?, options = ?,
         recommended = ?, plan_path = ?, task_key = ?, updated_at = ?
         WHERE id = ? RETURNING *`,
      )
      .get(
        content.title,
        content.context,
        content.why,
        JSON.stringify(content.options),
        content.recommended,
        content.planPath,
        content.taskKey,
        at,
        id,
      );
    if (!row) throw new Error(`Ask #${id} was not found`);
    return askFromRow(row);
  }

  find(id: number): Ask | undefined {
    const row = this.database
      .query<AskRow, [number]>("SELECT * FROM asks WHERE id = ?")
      .get(id);
    return row ? askFromRow(row) : undefined;
  }

  /** A session's open ask with this title, if it has one. */
  findOpenByTitle(sessionId: string, title: string): Ask | undefined {
    const row = this.database
      .query<AskRow, [string, string]>(
        `SELECT * FROM asks WHERE session_id = ? AND state = 'open'
         AND lower(title) = lower(?) ORDER BY id LIMIT 1`,
      )
      .get(sessionId, title);
    return row ? askFromRow(row) : undefined;
  }

  /**
   * Asks, newest first: every open one, and those that ended at or after
   * `endedSince`. Narrowed to some sessions or one workspace when given.
   */
  list(
    filter: {
      sessionIds?: readonly string[];
      workspaceId?: string;
      endedSince?: string;
      openOnly?: boolean;
    } = {},
  ): Ask[] {
    const where: string[] = [];
    const values: string[] = [];
    if (filter.sessionIds) {
      if (filter.sessionIds.length === 0) return [];
      where.push(
        `session_id IN (${filter.sessionIds.map(() => "?").join(", ")})`,
      );
      values.push(...filter.sessionIds);
    }
    if (filter.workspaceId) {
      where.push("workspace_id = ?");
      values.push(filter.workspaceId);
    }
    if (filter.openOnly) where.push("state = 'open'");
    else if (filter.endedSince) {
      where.push("(state = 'open' OR closed_at >= ?)");
      values.push(filter.endedSince);
    }
    return this.database
      .query<AskRow, string[]>(
        `SELECT * FROM asks ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY id DESC`,
      )
      .all(...values)
      .map(askFromRow);
  }

  /** Open asks pinned to a plan, or to one of its tasks. */
  openOnPlan(workspaceId: string, planPath: string, taskKey?: string): Ask[] {
    return this.database
      .query<AskRow, string[]>(
        `SELECT * FROM asks WHERE state = 'open' AND workspace_id = ?
         AND plan_path = ? ${taskKey ? "AND task_key = ?" : ""} ORDER BY id`,
      )
      .all(...[workspaceId, planPath, ...(taskKey ? [taskKey] : [])])
      .map(askFromRow);
  }

  /**
   * Ends an open ask: answered, dismissed or closed. `notify` leaves a
   * notice for the owner to be delivered; without it the owner already
   * knows. Returns undefined when it was not open.
   */
  end(
    id: number,
    input: {
      state: Exclude<AskState, "open">;
      answer?: string | null;
      note?: string | null;
      reason?: string | null;
      notify: boolean;
      at: string;
    },
  ): Ask | undefined {
    const row = this.database
      .query<AskRow, (string | number | null)[]>(
        `UPDATE asks SET state = ?, answer = ?, note = ?, closed_reason = ?,
         closed_at = ?, updated_at = ?, notice_delivered_at = ?
         WHERE id = ? AND state = 'open' RETURNING *`,
      )
      .get(
        input.state,
        input.answer ?? null,
        input.note ?? null,
        input.reason ?? null,
        input.at,
        input.at,
        input.notify ? null : input.at,
        id,
      );
    return row ? askFromRow(row) : undefined;
  }

  /** Opens an ended ask again (Undo); a notice not yet sent is dropped. */
  reopen(id: number, at: string): Ask | undefined {
    const row = this.database
      .query<AskRow, [string, number]>(
        `UPDATE asks SET state = 'open', answer = NULL, note = NULL,
         closed_reason = NULL, closed_at = NULL, notice_delivered_at = NULL,
         updated_at = ? WHERE id = ? AND state != 'open' RETURNING *`,
      )
      .get(at, id);
    return row ? askFromRow(row) : undefined;
  }

  /**
   * Claims the open asks the user was not notified about yet, oldest
   * first; each is claimed once, whoever asks.
   */
  claimUnnotified(at: string): Ask[] {
    return this.database
      .query<AskRow, [string]>(
        `UPDATE asks SET notified_at = ? WHERE state = 'open'
         AND notified_at IS NULL RETURNING *`,
      )
      .all(at)
      .map(askFromRow)
      .sort((a, b) => a.id - b.id);
  }

  /** A session's ended asks whose notice was not delivered yet, oldest first. */
  pendingNotices(sessionId: string): Ask[] {
    return this.database
      .query<AskRow, [string]>(
        `SELECT * FROM asks WHERE session_id = ? AND state != 'open'
         AND notice_delivered_at IS NULL ORDER BY closed_at, id`,
      )
      .all(sessionId)
      .map(askFromRow);
  }

  /** Marks notices delivered, unless an Undo reopened them since. */
  markNoticesDelivered(ids: readonly number[], at: string): void {
    if (!ids.length) return;
    this.database
      .query(
        `UPDATE asks SET notice_delivered_at = ?
         WHERE id IN (${ids.map(() => "?").join(", ")}) AND state != 'open'`,
      )
      .run(at, ...ids);
  }
}
