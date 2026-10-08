import { useEffect, useRef, useState } from "react";
import type {
  SessionColorDto,
  TeamDetailDto,
  TeamDto,
  TeamMemberDto,
} from "@daedalus/protocol";
import { relativeTime } from "../routines/time";
import { useOutsideDismiss } from "../use-outside-dismiss";

/**
 * The bar above the terminal of a team's lead or member: which team, and a
 * way into its panel.
 */
export function TeamBar({
  team,
  role,
  handle,
  members,
  color,
  leadArchived = false,
  onOpenPanel,
}: {
  team: TeamDto;
  role: "lead" | "member";
  /** The member's own handle; the lead's is `lead`. */
  handle: string;
  /** Members, not counting the lead. */
  members: number;
  color: SessionColorDto | null;
  /** The team is paused until its lead is restored. */
  leadArchived?: boolean;
  onOpenPanel: () => void;
}) {
  return (
    <section
      aria-label="Team"
      className="routine-bar team-bar"
      data-color={color ?? undefined}
    >
      <div className="routine-bar-row">
        <span className="routine-bar-text">
          {role === "lead"
            ? `Leads ${team.name} · ${members} ${members === 1 ? "member" : "members"}`
            : leadArchived
              ? `@${handle} in ${team.name} · lead archived, restore it to continue`
              : `@${handle} in ${team.name}`}
        </span>
        <span className="routine-bar-actions">
          <button
            className="quiet"
            data-panel-toggle
            onClick={onOpenPanel}
            type="button"
          >
            Team
          </button>
        </span>
      </div>
    </section>
  );
}

function memberState(member: TeamMemberDto): string {
  const parts = [member.status];
  if (member.undelivered > 0)
    parts.push(
      `${member.undelivered} not delivered${member.lastError ? `: ${member.lastError}` : ""}`,
    );
  return parts.join(" · ");
}

/**
 * The drawer on a team: its goal, who is in it, and the chat. The user posts
 * as `user`; tags decide whose session is told.
 */
export function TeamPanel({
  detail,
  error,
  busy,
  now,
  onClose,
  onPost,
  onSetGoal,
  onOpenSession,
}: {
  detail: TeamDetailDto | undefined;
  error: string | undefined;
  busy: boolean;
  now: number;
  onClose: () => void;
  /** Resolves to the post's warnings, or undefined when it failed. */
  onPost: (body: string) => Promise<string[] | undefined>;
  onSetGoal: (goal: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useOutsideDismiss(panel, onClose);
  const [draft, setDraft] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [goal, setGoal] = useState(detail?.team.goal ?? "");
  useEffect(() => setGoal(detail?.team.goal ?? ""), [detail?.team.goal]);
  const goalChanged = goal.trim() !== (detail?.team.goal ?? "").trim();
  const chatEnd = useRef<HTMLDivElement>(null);
  const newest = detail?.messages.at(-1)?.id;
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "end" });
  }, [newest]);
  const handles = detail?.members
    .filter((member) => member.status !== "archived")
    .map((member) => `@${member.handle}`);

  const post = async () => {
    const body = draft.trim();
    if (!body) return;
    const result = await onPost(body);
    if (!result) return;
    setDraft("");
    setWarnings(result);
  };

  return (
    <aside
      aria-label={`Team ${detail?.team.name ?? ""}`}
      className="routines-panel team-panel"
      ref={panel}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
      role="dialog"
    >
      <div className="routines-panel-heading">
        <div>
          <span className="eyebrow">Team</span>
          <h2>{detail?.team.name ?? "Team"}</h2>
        </div>
        <button className="quiet" onClick={onClose} type="button">
          Close
        </button>
      </div>
      {error && <p className="routines-panel-error">{error}</p>}
      {!detail && !error && <p className="routines-panel-empty">Loading…</p>}
      {detail && (
        <>
          <form
            className="routines-panel-purpose"
            onSubmit={(event) => {
              event.preventDefault();
              if (goalChanged) onSetGoal(goal.trim());
            }}
          >
            <label>
              <strong>Goal</strong>
              <small>Members are told it when they start.</small>
              <textarea
                maxLength={2000}
                onChange={(event) => setGoal(event.target.value)}
                placeholder="What the team is working toward"
                rows={2}
                value={goal}
              />
            </label>
            {goalChanged && (
              <button disabled={busy} type="submit">
                Save goal
              </button>
            )}
          </form>
          <h3>
            {detail.members.length === 1
              ? "Only the lead"
              : `${detail.members.length - 1} ${detail.members.length === 2 ? "member" : "members"}`}
          </h3>
          <ul className="routines-panel-list team-members">
            {detail.members.map((member) => (
              <li
                data-enabled={member.status !== "archived" ? "true" : "false"}
                data-failing={member.undelivered > 0 ? "true" : undefined}
                key={member.sessionId}
              >
                <button
                  className="quiet team-member"
                  onClick={() => onOpenSession(member.sessionId)}
                  title={`Open ${member.name}`}
                  type="button"
                >
                  <span className="routine-row-head">
                    <strong>@{member.handle}</strong>
                    <code>{member.name}</code>
                  </span>
                  <small className="routine-row-meta">
                    {memberState(member)}
                  </small>
                </button>
              </li>
            ))}
          </ul>
          <h3>Chat</h3>
          <div className="team-chat" role="log">
            {detail.messages.length === 0 && (
              <p className="routines-panel-empty">No messages yet.</p>
            )}
            {detail.messages.map((message) => (
              <div
                className="team-message"
                data-author={message.author}
                key={message.id}
              >
                <span className="team-message-head">
                  <strong>{message.author}</strong>
                  {message.tags.length > 0 && (
                    <span>
                      {" → "}
                      {message.tags.map((tag) => `@${tag}`).join(" ")}
                    </span>
                  )}
                  <small>{relativeTime(message.createdAt, now)}</small>
                </span>
                <p>{message.body}</p>
              </div>
            ))}
            <div ref={chatEnd} />
          </div>
          <form
            className="team-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void post();
            }}
          >
            <textarea
              aria-label="Message to the team"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void post();
                }
              }}
              placeholder={`Tag who should get it: ${[...(handles ?? []), "@all"].join(", ")}`}
              rows={3}
              value={draft}
            />
            {warnings.map((warning) => (
              <small className="team-composer-warning" key={warning}>
                {warning}
              </small>
            ))}
            <button disabled={busy || !draft.trim()} type="submit">
              Post as you
            </button>
          </form>
        </>
      )}
    </aside>
  );
}
