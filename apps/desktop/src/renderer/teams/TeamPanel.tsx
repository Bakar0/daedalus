import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RpcResult,
  SessionColorDto,
  TeamDetailDto,
  TeamDto,
  TeamMemberDto,
  TeamMessageDto,
} from "@daedalus/protocol";
import type { DesktopClient } from "../client-types";
import { relativeTime } from "../routines/time";
import { sessionColorStyle } from "../session-color-style";

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
      style={sessionColorStyle(color)}
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

/** How often the open tab reads the chat; it moves without the snapshot. */
const REFRESH_MS = 4_000;
/** A message longer than this many lines folds until asked for. */
const FOLD_LINES = 4;

/** The dot and words for a member's state. */
function memberState(member: TeamMemberDto): {
  tone: "live" | "idle" | "off" | "failing";
  text: string;
} {
  if (member.undelivered > 0)
    return {
      tone: "failing",
      text: `${member.undelivered} not delivered${member.lastError ? `: ${member.lastError}` : ""}`,
    };
  if (member.status === "archived") return { tone: "off", text: "archived" };
  if (member.status === "running") return { tone: "live", text: "running" };
  return { tone: "idle", text: member.status };
}

/** One chat message; a long body folds after a few lines. */
function TeamMessage({
  message,
  now,
}: {
  message: TeamMessageDto;
  now: number;
}) {
  const long = message.body.split("\n").length > FOLD_LINES;
  const [open, setOpen] = useState(false);
  return (
    <article
      className="team-message"
      data-author={message.author}
      data-folded={long && !open ? "true" : undefined}
    >
      <header className="team-message-head">
        <strong>{message.author === "user" ? "you" : message.author}</strong>
        {message.cloud && (
          <span className="team-message-cloud">{message.cloud}</span>
        )}
        {message.tags.map((tag) => (
          <span className="team-tag" key={tag}>
            @{tag}
          </span>
        ))}
        <time dateTime={message.createdAt}>
          {relativeTime(message.createdAt, now)}
        </time>
      </header>
      <p>{message.body}</p>
      {long && (
        <button
          className="team-message-more"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </article>
  );
}

/** The Team tab. It reads the team itself while in front, every few seconds. */
export function TeamPage({
  client,
  teamId,
  visible,
  busy,
  now,
  run,
  onOpenSession,
}: {
  client: DesktopClient;
  teamId: string;
  /** Whether the tab is in front; it reads the chat only then. */
  visible: boolean;
  busy: boolean;
  now: number;
  /** Sends a request the way the app's other actions do, with its errors. */
  run: <T>(operation: Promise<RpcResult<T>>) => Promise<T | undefined>;
  onOpenSession: (sessionId: string) => void;
}) {
  const [detail, setDetail] = useState<TeamDetailDto>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      const response = await client.request.teamDetail({ teamId });
      if (response.ok) {
        setDetail(response.data);
        setError(undefined);
      } else setError(response.error.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client, teamId]);
  useEffect(() => {
    if (!visible) return;
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, visible]);

  return (
    <TeamView
      busy={busy}
      detail={detail}
      error={error}
      now={now}
      onOpenSession={onOpenSession}
      onPost={async (body) => {
        const said = await run(client.request.teamSay({ teamId, body }));
        await load();
        return said?.warnings;
      }}
      onSetGoal={async (goal) => {
        await run(client.request.teamGoal({ teamId, goal }));
        await load();
      }}
      teamId={teamId}
    />
  );
}

/**
 * What the Team tab shows: the goal, who is in the team, and the chat. The
 * user posts as `user`; tags decide whose session is told.
 */
export function TeamView({
  teamId,
  detail,
  error,
  busy,
  now,
  onPost,
  onSetGoal,
  onOpenSession,
}: {
  teamId: string;
  detail: TeamDetailDto | undefined;
  error: string | undefined;
  busy: boolean;
  now: number;
  /** Resolves to the post's warnings, or undefined when it failed. */
  onPost: (body: string) => Promise<string[] | undefined>;
  onSetGoal: (goal: string) => Promise<void>;
  onOpenSession: (sessionId: string) => void;
}) {
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

  if (!detail)
    return (
      <div className="ability-page">
        <p className={error ? "ability-page-error" : "ability-page-empty"}>
          {error ?? "Loading team…"}
        </p>
      </div>
    );

  const handles = detail.members
    .filter((member) => member.status !== "archived")
    .map((member) => `@${member.handle}`);
  const memberCount = detail.members.length - 1;
  const post = async () => {
    const body = draft.trim();
    if (!body) return;
    const said = await onPost(body);
    if (!said) return;
    setDraft("");
    setWarnings(said);
  };
  const saveGoal = async () => {
    if (!goalChanged) return;
    await onSetGoal(goal.trim());
  };

  return (
    <div className="ability-page team-page">
      <header className="ability-page-header">
        <div className="ability-page-title">
          <span className="eyebrow">Team</span>
          <h2>{detail.team.name}</h2>
          <small>
            {memberCount === 0
              ? "Only the lead"
              : `Lead and ${memberCount} ${memberCount === 1 ? "member" : "members"}`}
            {" · "}
            {detail.messages.length}{" "}
            {detail.messages.length === 1 ? "message" : "messages"}
          </small>
        </div>
        {error && <p className="ability-page-error">{error}</p>}
      </header>
      <form
        className="ability-page-field"
        onSubmit={(event) => {
          event.preventDefault();
          void saveGoal();
        }}
      >
        <label htmlFor={`team-goal-${teamId}`}>Goal</label>
        <textarea
          id={`team-goal-${teamId}`}
          maxLength={2000}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="What the team is working toward. Members are told it when they start."
          rows={2}
          value={goal}
        />
        {goalChanged && (
          <div className="ability-page-field-actions">
            <button
              className="quiet"
              onClick={() => setGoal(detail.team.goal ?? "")}
              type="button"
            >
              Cancel
            </button>
            <button disabled={busy} type="submit">
              Save goal
            </button>
          </div>
        )}
      </form>
      <div className="team-page-body">
        <nav aria-label="Members" className="team-page-members">
          <h3>Members</h3>
          <ul>
            {detail.members.map((member) => {
              const state = memberState(member);
              return (
                <li key={member.sessionId}>
                  <button
                    className="team-member-card"
                    data-tone={state.tone}
                    onClick={() => onOpenSession(member.sessionId)}
                    title={`Open ${member.name}`}
                    type="button"
                  >
                    <span className="team-member-line">
                      <span aria-hidden="true" className="team-member-dot" />
                      <strong>@{member.handle}</strong>
                      {member.role === "lead" && (
                        <span className="team-tag">lead</span>
                      )}
                      {member.unread > 0 && (
                        <span
                          className="team-member-unread"
                          title={`${member.unread} unread`}
                        >
                          {member.unread}
                        </span>
                      )}
                    </span>
                    <small>{member.name}</small>
                    <small className="team-member-state">{state.text}</small>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <section aria-label="Chat" className="team-page-chat">
          <div className="team-chat" role="log">
            {detail.messages.length === 0 && (
              <p className="ability-page-empty">
                No messages yet. Tag a member to tell its session.
              </p>
            )}
            {detail.messages.map((message) => (
              <TeamMessage key={message.id} message={message} now={now} />
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
              placeholder={`Message the team. Tag who should get it: ${[...handles, "@all"].join(", ")}`}
              rows={2}
              value={draft}
            />
            <div className="team-composer-row">
              {warnings.map((warning) => (
                <small className="team-composer-warning" key={warning}>
                  {warning}
                </small>
              ))}
              <small className="team-composer-hint">⌘↵ to send</small>
              <button disabled={busy || !draft.trim()} type="submit">
                Send
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
