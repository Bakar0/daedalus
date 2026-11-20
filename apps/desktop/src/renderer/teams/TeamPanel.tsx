import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  RpcResult,
  SessionColorDto,
  TeamDetailDto,
  TeamDto,
  TeamMemberDto,
  ChannelMessageDto,
} from "@daedalus/protocol";
import type { DesktopClient } from "../client-types";
import { relativeTime } from "../routines/time";
import { DOCS_URL, Group, TabIntro } from "../FileEditorParts";
import { sessionColorStyle } from "../session-color-style";
import { SplitList } from "../SplitList";

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
  actions,
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
  /** More buttons before Team. */
  actions?: ReactNode;
}) {
  return (
    <section
      aria-label="Team"
      className="notice-bar team-bar"
      data-color={color ?? undefined}
      style={sessionColorStyle(color)}
    >
      <div className="notice-bar-row">
        <span className="notice-bar-text">
          {role === "lead"
            ? `Leads ${team.name} · ${members} ${members === 1 ? "member" : "members"}`
            : leadArchived
              ? `@${handle} in ${team.name} · lead archived, restore it to continue`
              : `@${handle} in ${team.name}`}
        </span>
        <span className="notice-bar-actions">
          {actions}
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

/** How often the open tab reads the channel; it moves without the snapshot. */
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

/** One channel message; a long body folds after a few lines. */
function ChannelMessage({
  message,
  now,
}: {
  message: ChannelMessageDto;
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
  /** Whether the tab is in front; it reads the channel only then. */
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
      onReadMore={() =>
        void client.request.openExternal({
          url: `${DOCS_URL}/abilities.md#orchestration-and-teams`,
        })
      }
      onPost={async (body) => {
        const said = await run(client.request.channelSay({ teamId, body }));
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
 * What the Team tab shows: the goal, who is in the team, and its channel.
 * The user posts as `user`; tags decide whose session is told.
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
  onReadMore,
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
  /** Opens the teams docs. */
  onReadMore: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [goal, setGoal] = useState(detail?.team.goal ?? "");
  useEffect(() => setGoal(detail?.team.goal ?? ""), [detail?.team.goal]);
  const goalChanged = goal.trim() !== (detail?.team.goal ?? "").trim();
  const channelEnd = useRef<HTMLDivElement>(null);
  const newest = detail?.messages.at(-1)?.id;
  useEffect(() => {
    channelEnd.current?.scrollIntoView({ block: "end" });
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
    <div className="workflows-tab team-tab">
      <TabIntro onReadMore={onReadMore}>
        A team is a lead session and the members it adds, working toward one
        goal, talking in the team's channel. Tag a member to send its session
        the message; it replies with daedal channel say.
      </TabIntro>
      <SplitList
        id="team"
        label="Members"
        list={
          <Group title="Members">
            {detail.members.map((member) => {
              const state = memberState(member);
              return (
                <MemberRow
                  key={member.sessionId}
                  member={member}
                  onOpen={() => onOpenSession(member.sessionId)}
                  state={state}
                />
              );
            })}
          </Group>
        }
      >
        <section aria-label="Channel" className="team-detail">
          <header className="team-detail-heading">
            <h2>#{detail.channel} · team channel</h2>
            <small>
              {memberCount === 0
                ? "Only the lead"
                : `Lead and ${memberCount} ${memberCount === 1 ? "member" : "members"}`}
              {" · "}
              {detail.messages.length}{" "}
              {detail.messages.length === 1 ? "message" : "messages"}
            </small>
          </header>
          {error && <p className="ability-page-error">{error}</p>}
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
              rows={1}
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
          <div className="team-channel" role="log">
            {detail.messages.length === 0 && (
              <p className="ability-page-empty">
                No messages yet. Tag a member to tell its session.
              </p>
            )}
            {detail.messages.map((message) => (
              <ChannelMessage key={message.id} message={message} now={now} />
            ))}
            <div ref={channelEnd} />
          </div>
          <form
            className="team-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void post();
            }}
          >
            <textarea
              aria-label="Message to the channel"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void post();
                }
              }}
              placeholder={`Message #${detail.channel}. Tag who should get it: ${[...handles, "@all"].join(", ")}`}
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
      </SplitList>
    </div>
  );
}

/**
 * A member in the list, laid out like a file in the Workflows tab: its
 * handle and unread count on one line, its session and state under it.
 * Clicking it opens the session.
 */
function MemberRow({
  member,
  state,
  onOpen,
}: {
  member: TeamMemberDto;
  state: ReturnType<typeof memberState>;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        className="workflows-file team-member-row"
        data-tone={state.tone}
        onClick={onOpen}
        title={`Open ${member.name}`}
        type="button"
      >
        <span className="workflows-file-line">
          <span className="workflows-file-name">
            <span aria-hidden="true" className="team-member-dot" />@
            {member.handle}
            {member.role === "lead" && (
              <span className="workflow-gate">lead</span>
            )}
          </span>
          {member.unread > 0 && (
            <span
              className="workflows-file-meta"
              title={`${member.unread} unread`}
            >
              {member.unread} unread
            </span>
          )}
        </span>
        <small>
          {member.name} · {state.text}
        </small>
      </button>
    </li>
  );
}
