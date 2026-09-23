/**
 * The inspector's history of one task: what happened, in order. Assembled by
 * the core on request (`taskTimeline`); this only lays it out.
 */
import type {
  TaskCostDto,
  TaskTimelineDto,
  TaskTimelineEventDto,
} from "@daedalus/protocol";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * "Sep 23 18:07" for a moment, "Sep 21" for a journal date, nothing for an
 * undated heading. Local time, because that is when the user was there.
 */
export function timelineWhen(at: string | null): string {
  if (!at) return "";
  if (at.length === 10) {
    const [, month, day] = at.split("-");
    return `${MONTHS[Number(month) - 1] ?? month} ${Number(day)}`;
  }
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${time}`;
}

const KIND_GLYPH: Record<TaskTimelineEventDto["kind"], string> = {
  created: "＋",
  brief_edited: "✎",
  session_spawned: "▶",
  worktree_created: "⑂",
  attention_raised: "?",
  attention_cleared: "✓",
  session_stopped: "■",
  session_archived: "▣",
  journal: "¶",
  done: "✔",
  cancelled: "✕",
};

export function TaskTimeline({
  loading,
  onOpenJournal,
  timeline,
}: {
  loading: boolean;
  onOpenJournal: (heading: string) => void;
  timeline?: TaskTimelineDto;
}) {
  return (
    <section aria-label="Timeline" className="task-timeline">
      <h3>Timeline</h3>
      {!timeline ? (
        <p className="task-timeline-empty">
          {loading ? "Loading…" : "No history to show."}
        </p>
      ) : (
        <ol>
          {timeline.events.map((event, index) => (
            <li
              className={`task-timeline-event kind-${event.kind}${event.open ? " open" : ""}`}
              key={`${event.kind}:${event.at ?? "undated"}:${index}`}
            >
              <span aria-hidden="true" className="task-timeline-glyph">
                {KIND_GLYPH[event.kind]}
              </span>
              <time dateTime={event.at ?? undefined}>
                {timelineWhen(event.at)}
              </time>
              <span className="task-timeline-text">
                {event.kind === "journal" && event.journalHeading ? (
                  <button
                    className="task-timeline-journal"
                    onClick={() => onOpenJournal(event.journalHeading!)}
                    title="Open this entry in the journal"
                    type="button"
                  >
                    {event.detail}
                  </button>
                ) : (
                  <>
                    <strong>{event.text}</strong>
                    {event.open && (
                      <span className="task-timeline-open">still open</span>
                    )}
                    {event.detail && (
                      <span className="task-timeline-detail">
                        {event.kind === "attention_raised"
                          ? `"${event.detail}"`
                          : event.detail}
                      </span>
                    )}
                  </>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const durationLabel = (milliseconds: number) => {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
};

/**
 * "2 sessions · 3h 12m · peak 64% ctx · opus 5.5, gpt-5". Wall time runs from
 * the first spawn to the last stop, and to now while anything is live.
 */
export function taskCostText(cost: TaskCostDto, now: number): string {
  if (cost.sessions === 0) return "No sessions yet";
  const parts = [`${cost.sessions} session${cost.sessions === 1 ? "" : "s"}`];
  if (cost.firstStartedAt) {
    const end = cost.lastEndedAt ? Date.parse(cost.lastEndedAt) : now;
    parts.push(
      `${durationLabel(end - Date.parse(cost.firstStartedAt))}${cost.running ? " so far" : ""}`,
    );
  }
  if (cost.peakContextPercent !== undefined)
    parts.push(`peak ${Math.round(cost.peakContextPercent)}% ctx`);
  if (cost.models.length > 0) parts.push(cost.models.join(", "));
  return parts.join(" · ");
}

export function TaskCostLine({
  cost,
  now,
}: {
  cost: TaskCostDto;
  now: number;
}) {
  return (
    <section aria-label="Cost" className="task-inspector-section task-cost">
      <h3>Cost</h3>
      <p>{taskCostText(cost, now)}</p>
    </section>
  );
}
