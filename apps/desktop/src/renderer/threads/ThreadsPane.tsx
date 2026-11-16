import { useState } from "react";
import type { AgentSessionDto } from "@daedalus/protocol";
import { relativeTime } from "../routines/time";
import {
  THREAD_GROUPS,
  type ThreadGroup,
  type ThreadRow,
} from "./thread-groups";

function StateDot({ row }: { row: ThreadRow }) {
  return (
    <span
      aria-hidden="true"
      className={`threads-state threads-state-${row.failed ? "failed" : row.group}`}
    />
  );
}

/**
 * A team lead's members, in a tab of their own, grouped by what they need.
 * Clicking a row opens that session as a normal session tab.
 */
export function ThreadsPane({
  lead,
  leadLabel,
  rows,
  now,
  onOpenThread,
}: {
  lead: AgentSessionDto;
  /** Whose threads these are, under the heading: the lead's team. */
  leadLabel?: string;
  rows: readonly ThreadRow[];
  now: number;
  /** Opens the thread's own session as a session tab. */
  onOpenThread: (session: AgentSessionDto) => void;
}) {
  const [folded, setFolded] = useState<ReadonlySet<ThreadGroup>>(
    () => new Set<ThreadGroup>(["resolved"]),
  );

  return (
    <section aria-label="Threads" className="threads-pane">
      <div className="threads-head">
        <h2>Threads</h2>
        <span className="threads-count">
          {rows.filter((row) => row.group !== "resolved").length} open
        </span>
      </div>
      {leadLabel && (
        <div className="threads-subhead">
          <span className="threads-where">{leadLabel}</span>
        </div>
      )}
      <div className="threads-list">
        {rows.length === 0 && (
          <p className="threads-empty">
            No threads yet. Ask {lead.name} for work, and it starts a thread for
            each piece.
          </p>
        )}
        {THREAD_GROUPS.map(({ group, label }) => {
          const members = rows.filter((row) => row.group === group);
          if (!members.length) return null;
          const isFolded = folded.has(group);
          return (
            <section className="threads-group" key={group}>
              <h3>
                <button
                  aria-expanded={!isFolded}
                  className="threads-group-toggle"
                  onClick={() =>
                    setFolded((current) => {
                      const next = new Set(current);
                      if (next.has(group)) next.delete(group);
                      else next.add(group);
                      return next;
                    })
                  }
                  type="button"
                >
                  <span aria-hidden="true">{isFolded ? "▸" : "▾"}</span>
                  {label}
                  <span className="threads-group-count">{members.length}</span>
                </button>
              </h3>
              {!isFolded &&
                members.map((row) => (
                  <div className="threads-row-item" key={row.session.id}>
                    <button
                      className="threads-row"
                      onClick={() => onOpenThread(row.session)}
                      title={`Open ${row.title}`}
                      type="button"
                    >
                      <StateDot row={row} />
                      <span className="threads-row-title">
                        <span className="threads-row-name">{row.title}</span>
                      </span>
                      <span className="threads-where">
                        {row.workspaceName} · {relativeTime(row.at, now)}
                      </span>
                      <span className="threads-row-detail">{row.detail}</span>
                    </button>
                  </div>
                ))}
            </section>
          );
        })}
      </div>
    </section>
  );
}
