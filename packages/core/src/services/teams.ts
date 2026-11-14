import type {
  AgentSession,
  SessionAbility,
  TeamCursor,
  TeamMembership,
  TeamMessage,
  TeamMessageKind,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import {
  ORCHESTRATION_SKILL,
  TEAM_FILE,
  TEAM_SKILL,
  type AbilityService,
} from "./abilities";
import type { ActivityService, TurnEnd, TurnEndHandling } from "./activity";
import type { AgentService } from "./agents";
import { cloudAuthorMark, isCloudSession, splitLines } from "./cloud-mark";
import { sessionBaseName } from "./providers";
import {
  TEAM_MAX_DEPTH,
  TEAM_MAX_MEMBERS,
  teamAncestors,
  teamDescendants,
} from "./team-tree";
import type { TeamTransport } from "./team-transport";

export { TEAM_MAX_DEPTH, TEAM_MAX_MEMBERS } from "./team-tree";

/** The lead's handle, and the tag that reaches it. */
export const LEAD_HANDLE = "lead";
/** The user's handle: what the user writes as. A tag on it reaches nobody. */
export const USER_HANDLE = "user";
/** Who Daedalus writes as, such as the note that the user added a member. */
export const DAEDALUS_HANDLE = "daedalus";
/** The tag that reaches the lead and every member. */
export const ALL_TAG = "all";

const RESERVED_HANDLES = new Set([
  LEAD_HANDLE,
  USER_HANDLE,
  DAEDALUS_HANDLE,
  ALL_TAG,
]);

/** How many messages `team chat` prints when nothing limits it. */
const CHAT_LIMIT = 50;

/**
 * A lead gets hand-backs at most once in this long: members finishing one
 * after another wake it once, with all of them.
 */
export const HANDBACK_INTERVAL_MS = 60_000;

/** The most of a member's last message a hand-back quotes. */
const MAX_HANDBACK_TEXT = 3_000;

/**
 * The most text one delivery carries. Older messages past it are left for
 * `team chat --tagged`, and the delivery says how many.
 */
const MAX_DELIVERY_TEXT = 16_000;

/**
 * A team: its lead, and what the team is called. Any session becomes a lead
 * when its first member is added. The team's record is the lead's
 * `orchestration` row in `session_abilities`, which a rebirth moves to the
 * successor; teams that existed before keep their id.
 */
export interface Team {
  /** The id of the lead's team record. */
  id: string;
  lead: AgentSession;
  /** The lead's session title. */
  name: string;
  goal: string | null;
  /** Paused by the user, or with its lead archived: members get nothing. */
  paused: boolean;
  ability: SessionAbility;
}

/** One session in a team tree, with the members it leads. */
export interface TeamTreeNode {
  session: AgentSession;
  /** Its handle in its own lead's team; null at the top. */
  handle: string | null;
  /** The team it leads, if any. */
  team: Team | null;
  members: TeamTreeNode[];
}

/** A session's place in one team, as its lead or as a member. */
export interface TeamPlace {
  team: Team;
  reader: TeamReader;
}

/** Someone who reads the chat and can be tagged: the lead or a member. */
export interface TeamReader {
  handle: string;
  session: AgentSession;
  role: "lead" | "member";
}

export interface TeamDeliveryResult {
  handle: string;
  sessionId: string;
  /** How many messages it carried; zero when nothing was waiting. */
  messages: number;
  delivered: boolean;
  error: string | null;
  /** Hand-backs held for the lead's next delivery, due then. */
  heldUntil?: string;
}

export interface TeamSayResult {
  message: TeamMessage;
  warnings: string[];
  deliveries: TeamDeliveryResult[];
}

export interface TeamMemberStatus extends TeamReader {
  /** Messages after its read marker that it did not write. */
  unread: number;
  /** Messages that tag it and have not reached its session. */
  undelivered: number;
  lastError: string | null;
  lastAttemptAt: string | null;
}

/** A slug fit for `@handle`: lowercase letters, digits and dashes. */
export function teamHandleBase(text: string | undefined): string {
  const slug = (text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug || "member";
}

/**
 * The handles a message tags. A message that starts with tags
 * (`@db @cache ...`) is addressed to those alone, so a handle named later in
 * the text ("the contract from @api") does not deliver it there. A message
 * with no leading tag is addressed to every handle it names. A tag is `@` and
 * a handle, at the start or after a character that cannot be part of an
 * address, so `a@b.com` is not a tag.
 */
export function parseTags(body: string): string[] {
  const leading = /^\s*((?:@[a-z0-9][a-z0-9-]*[\s,:;]*)+)/i.exec(body)?.[1];
  const tags = new Set<string>();
  for (const match of (leading ?? body).matchAll(
    /(?:^|[^\w.@-])@([a-z0-9][a-z0-9-]*)/gi,
  ))
    tags.add(match[1]!.toLowerCase().replace(/-+$/, ""));
  return [...tags];
}

/** Whether a message tags this reader, who did not write it. */
const tagsReader = (message: TeamMessage, reader: string): boolean =>
  message.tags.includes(reader) && message.author !== reader;

/** A message's time as `team chat` prints it: `14:05`, local. */
const clockTime = (iso: string): string => {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/**
 * One message as `team chat` prints it: a header line, then every line of
 * the body indented under it, so no body line can pass for a header (N-1).
 */
export function teamChatText(message: TeamMessage, author: string): string {
  const tags = message.tags.length
    ? ` → ${message.tags.map((tag) => `@${tag}`).join(" ")}`
    : "";
  const body = splitLines(message.body)
    .map((line) => `  ${line}`)
    .join("\n");
  return `#${message.id} ${clockTime(message.createdAt)} ${author}${tags}\n${body}`;
}

/**
 * Teams: a lead, its members, and the one chat they share. Any session
 * becomes a lead when its first member is added; a member may lead a team of
 * its own, within TEAM_MAX_DEPTH levels and TEAM_MAX_MEMBERS members a lead.
 * Every message is stored; a session a message tags gets its full text,
 * with who wrote it and how to reply, through the provider's own inbox
 * right away, from whichever process posted it, so nothing waits on the
 * desktop app. When a member's turn ends its lead is handed its last
 * message, at most once a minute (`HANDBACK_INTERVAL_MS`).
 */
export class TeamService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly abilities: AbilityService,
    private readonly agents: AgentService,
    private readonly transport: TeamTransport,
    private readonly now: () => Date = () => new Date(),
    activity?: ActivityService,
  ) {
    agents.onTeamLaunch((member) => this.memberLaunchLines(member));
    agents.onSessionRunning((session) => this.flushSession(session.id));
    activity?.onTurnEnd((session, end, text) =>
      this.handBack(session, end, text),
    );
    abilities.onRevoke("orchestration", (ability) =>
      this.repositories.clearTeam(ability.id),
    );
  }

  /** Every team there is now. */
  list(): Team[] {
    return this.abilities
      .holders("orchestration")
      .flatMap((ability) => this.fromAbility(ability) ?? []);
  }

  /** The team with this id, or the one this session leads. */
  get(reference: string): Team {
    const team = this.find(reference);
    if (!team) {
      const session = this.repositories.findAgent(reference);
      throw new DaedalusError(
        "NOT_FOUND",
        session
          ? `'${session.name}' does not lead a team; 'daedal agent spawn --team ${session.id}' adds its first member and makes it the lead`
          : `No team led by ${reference}`,
      );
    }
    return team;
  }

  /** The team with this id, or the one this session leads, if there is one. */
  find(reference: string): Team | undefined {
    const ability =
      this.abilities.held(reference, "orchestration") ??
      this.repositories.abilities.find(reference);
    return ability && this.fromAbility(ability);
  }

  /**
   * The team this session leads, made now if it leads none: how any session
   * becomes a lead. Refused for a session that cannot run team commands, and
   * for one so deep in a team tree that its members would pass the cap.
   */
  lead(sessionId: string): { team: Team; created: boolean } {
    const existing = this.led(sessionId);
    if (existing) return { team: existing, created: false };
    const session = this.repositories.findAgent(sessionId);
    if (!session)
      throw new DaedalusError("NOT_FOUND", `Session ${sessionId} not found`);
    if (session.archivedAt)
      throw new DaedalusError(
        "CONFLICT",
        `'${session.name}' is archived; restore it before it leads a team`,
      );
    if (
      session.kind !== "agent" ||
      (session.provider !== "claude" && session.provider !== "codex")
    )
      throw new DaedalusError(
        "VALIDATION",
        `'${session.name}' cannot lead a team: a lead is a Claude or Codex session`,
      );
    if (session.hostId)
      throw new DaedalusError(
        "VALIDATION",
        `'${session.name}' runs in the cloud and cannot lead a team yet; add the members to a session on this Mac`,
      );
    // Refuses past the depth cap, naming the lead to add to instead.
    this.abilities.grant(session.id, "orchestration", { live: false });
    return { team: this.get(session.id), created: true };
  }

  /** The team this session leads now, if any. */
  led(sessionId: string): Team | undefined {
    const ability = this.abilities.held(sessionId, "orchestration");
    return ability && this.fromAbility(ability);
  }

  /** The team this session is a member of, and its handle there. */
  memberOf(sessionId: string): TeamPlace | undefined {
    const session = this.repositories.findAgent(sessionId);
    if (!session?.teamId || !session.teamHandle) return undefined;
    const ability = this.repositories.abilities.find(session.teamId);
    const team = ability && this.fromAbility(ability);
    return team
      ? {
          team,
          reader: { handle: session.teamHandle, session, role: "member" },
        }
      : undefined;
  }

  /**
   * Every team a session is in: the one it leads first, then the one it is
   * a member of. A session leads at most one team and belongs to at most one.
   */
  memberships(sessionId: string): TeamPlace[] {
    const places: TeamPlace[] = [];
    const led = this.led(sessionId);
    if (led)
      places.push({
        team: led,
        reader: { handle: LEAD_HANDLE, session: led.lead, role: "lead" },
      });
    const member = this.memberOf(sessionId);
    if (member) places.push(member);
    return places;
  }

  /** The team a session leads, else the one it belongs to, and its handle. */
  membership(sessionId: string): TeamPlace | undefined {
    return this.memberships(sessionId)[0];
  }

  /** The leads above a session, nearest first. */
  ancestors(sessionId: string): AgentSession[] {
    return teamAncestors(this.repositories, sessionId);
  }

  /**
   * The tree a session is in, from its top lead down; every tree when no
   * session is given. Archived members are left out.
   */
  tree(sessionId?: string): TeamTreeNode[] {
    const build = (
      session: AgentSession,
      handle: string | null,
      seen: Set<string>,
    ): TeamTreeNode => {
      seen.add(session.id);
      const team = this.led(session.id) ?? null;
      const members = team
        ? this.members(team.id)
            .filter(
              (member) =>
                !member.archivedAt && member.teamHandle && !seen.has(member.id),
            )
            .map((member) => build(member, member.teamHandle, seen))
        : [];
      return { session, handle, team, members };
    };
    if (sessionId) {
      const top = this.ancestors(sessionId).at(-1);
      const root = top ?? this.repositories.findAgent(sessionId);
      return root ? [build(root, null, new Set())] : [];
    }
    return this.list()
      .filter((team) => !this.memberOf(team.lead.id))
      .map((team) => build(team.lead, null, new Set()));
  }

  /**
   * Pauses a team or lets it carry on: while paused its members get no
   * messages and it takes no new members. The teams its members lead pause
   * and resume with it. Resuming sends what waited.
   */
  async setPaused(reference: string, paused: boolean): Promise<Team[]> {
    const team = this.get(reference);
    const teams = [
      team,
      ...teamDescendants(this.repositories, team.lead.id).flatMap(
        (member) => this.led(member.id) ?? [],
      ),
    ];
    for (const each of teams)
      this.abilities.setPaused(each.lead.id, "orchestration", paused);
    if (!paused) for (const each of teams) await this.flush(each.id);
    return teams.map((each) => this.get(each.id));
  }

  /** Members in the order they joined, archived ones included. */
  members(teamId: string): AgentSession[] {
    return this.repositories.listTeamMembers(teamId);
  }

  /** The lead and every member that is not archived. */
  readers(team: Team): TeamReader[] {
    return [
      { handle: LEAD_HANDLE, session: team.lead, role: "lead" as const },
      ...this.members(team.id)
        .filter((member) => !member.archivedAt && member.teamHandle)
        .map((member) => ({
          handle: member.teamHandle!,
          session: member,
          role: "member" as const,
        })),
    ];
  }

  /**
   * The cloud mark of each author that is a session on a cloud host,
   * `[cloud final]`, so its text is never taken for a local session's (N-1).
   */
  cloudMarks(team: Team): (author: string) => string | undefined {
    const sessions = new Map<string, AgentSession>([
      [LEAD_HANDLE, team.lead],
      ...this.members(team.id).flatMap((member) =>
        member.teamHandle ? [[member.teamHandle, member] as const] : [],
      ),
    ]);
    return (author) => {
      const session = sessions.get(author);
      if (!session || !isCloudSession(session)) return undefined;
      const workspace = this.repositories.findWorkspace(session.workspaceId);
      return cloudAuthorMark(workspace?.name);
    };
  }

  /** How authors are named where their messages are shown: `api [cloud final]`. */
  authorLabels(team: Team): (author: string) => string {
    const mark = this.cloudMarks(team);
    return (author) => {
      const cloud = mark(author);
      return cloud ? `${author} ${cloud}` : author;
    };
  }

  /** A handle no other member of the team has: `api`, `api-2`, `api-3`. */
  allocateHandle(teamId: string, wanted: string | undefined): string {
    const base = teamHandleBase(wanted);
    const taken = new Set(
      this.members(teamId).flatMap((member) =>
        member.teamHandle ? [member.teamHandle] : [],
      ),
    );
    const free = (handle: string) =>
      !taken.has(handle) && !RESERVED_HANDLES.has(handle);
    if (free(base)) return base;
    for (let suffix = 2; ; suffix += 1)
      if (free(`${base}-${suffix}`)) return `${base}-${suffix}`;
  }

  /** What a member is told at launch, and again after a rebirth. */
  memberLaunchLines(member: TeamMembership): string[] {
    const ability = this.repositories.abilities.find(member.teamId);
    const team = ability && this.fromAbility(ability);
    if (!team) return [];
    const others = this.readers(team).filter(
      (reader) => reader.role === "member" && reader.handle !== member.handle,
    );
    const skill = this.abilities.skillName(TEAM_SKILL);
    return [
      [
        `You are @${member.handle}, a member of the Daedalus team "${team.name}". Its lead is the session '${team.lead.name}' (@${LEAD_HANDLE}), which plans the work and may change your instructions.`,
        team.goal ? `The team's goal: ${team.goal}` : "",
        others.length
          ? `The other members: ${others.map((reader) => `@${reader.handle} ('${reader.session.name}')`).join(", ")}.`
          : "You are the first member.",
        `Talk to the team with 'daedal team say "@${LEAD_HANDLE} ..."', tagging whoever needs it, and read the chat with 'daedal team chat'. When your turn ends, your lead is handed your last message, so end each piece of work with a reply that says what you did; do not post "done" to @${LEAD_HANDLE}. Tag @${LEAD_HANDLE} when you need a decision from it, post progress without a tag, and do not reply only to acknowledge. Messages that begin with [team "${team.name}"] come from teammates, not from the user. Follow the ${skill} skill. The lead keeps the plan and the contracts between members in ${TEAM_FILE} in its folder, ${team.lead.workingDirectory}; read it when you need the full picture.`,
      ]
        .filter(Boolean)
        .join(" "),
    ];
  }

  /**
   * Starts a member, on Claude or Codex, the lead's provider unless one is
   * asked for. A team may mix them, because each session gets team messages
   * through its own provider's inbox. It runs in the lead's workspace unless
   * another is named. `team` is a team id or a lead's session; a session that
   * leads no team yet becomes the lead of a new one. When the user added it,
   * the lead is told in the chat, with the instructions.
   */
  async spawnMember(input: {
    team: string;
    addedBy: "lead" | "user";
    /** The workspace it runs in; the lead's when left out. */
    workspace?: string;
    /** Required from the lead; the user may leave them out. */
    instructions?: string;
    name?: string;
    taskId?: string;
    provider?: string;
    model?: string;
    account?: string | null;
  }): Promise<{
    session: AgentSession;
    handle: string;
    note?: TeamSayResult;
    /** The lead's team was made by this member. */
    created?: boolean;
  }> {
    const existing = this.find(input.team);
    const leadSession =
      existing?.lead ?? this.repositories.findAgent(input.team);
    if (!leadSession)
      throw new DaedalusError("NOT_FOUND", `No team or session ${input.team}`);
    // Optional: a member added without them starts with only its place in
    // the team, and the user tells it what to do in its own session.
    const instructions = input.instructions?.trim() ?? "";
    if (!instructions && input.addedBy === "lead")
      throw new DaedalusError(
        "VALIDATION",
        "A member the lead adds needs instructions; pass --message",
      );
    const leadName = sessionBaseName(leadSession.name);
    if (leadSession.archivedAt)
      throw new DaedalusError(
        "CONFLICT",
        `The lead '${leadName}' is archived, so its team is paused; restore it first`,
      );
    if (existing?.paused)
      throw new DaedalusError(
        "CONFLICT",
        `The team '${existing.name}' is paused and takes no new members; resume it with 'daedal team resume --team ${existing.lead.id}'`,
      );
    const provider = input.provider ?? leadSession.provider;
    if (provider !== "claude" && provider !== "codex")
      throw new DaedalusError(
        "VALIDATION",
        `A team member runs on claude or codex, not ${provider}`,
      );
    const above = this.ancestors(leadSession.id);
    if (above.length + 1 > TEAM_MAX_DEPTH)
      throw new DaedalusError(
        "CONFLICT",
        `'${leadName}' is ${above.length} levels below its top lead '${sessionBaseName(above.at(-1)!.name)}', and teams nest at most ${TEAM_MAX_DEPTH} levels, so it cannot add members; add this one to '${sessionBaseName(above[0]!.name)}' instead ('daedal agent spawn --team ${above[0]!.id}')`,
      );
    if (existing) {
      // A resolved thread is done with; it does not hold a place.
      const active = this.members(existing.id).filter(
        (member) => !member.archivedAt && !member.resolvedAt,
      );
      if (active.length >= TEAM_MAX_MEMBERS)
        throw new DaedalusError(
          "CONFLICT",
          `'${existing.name}' already has ${active.length} members, the most one lead can have; archive one it no longer needs ('daedal agent archive <session>'), or have a member lead part of the work ('daedal agent spawn --team <member>')`,
        );
    }
    // A member may work in another workspace than its lead's.
    const workspace = input.workspace ?? leadSession.workspaceId;
    const task = input.taskId
      ? this.repositories.findTask(input.taskId)
      : undefined;
    const { team, created } = this.lead(leadSession.id);
    const handle = this.allocateHandle(team.id, input.name ?? task?.title);
    // Messages from before it joined are history to read, not to deliver.
    const joinedAfter = this.repositories.teams.lastMessageId(team.id);
    let session: AgentSession;
    try {
      session = await this.spawnSession(team, {
        workspace,
        provider,
        handle,
        instructions,
        input,
      });
    } catch (error) {
      // A team made for this member does not outlive its failed start.
      if (created) this.undoTeam(team);
      throw error;
    }
    this.repositories.teams.saveCursor({
      teamId: team.id,
      handle,
      readThrough: 0,
      // Tags from before it joined were for someone else with its handle.
      taggedReadThrough: joinedAfter,
      deliveredThrough: joinedAfter,
      lastError: null,
      lastAttemptAt: null,
      deliveredAt: null,
    });
    if (input.addedBy === "lead") return { session, handle, created };
    const skill = this.abilities.skillName(ORCHESTRATION_SKILL);
    const note = await this.say({
      team: team.id,
      author: DAEDALUS_HANDLE,
      // The new member has its instructions already; only the lead is told.
      tags: [LEAD_HANDLE],
      body: [
        instructions
          ? `@${LEAD_HANDLE} the user added @${handle} ('${session.name}') to the team with these instructions:\n\n${instructions}`
          : `@${LEAD_HANDLE} the user added @${handle} ('${session.name}') to the team and is giving it its instructions directly. Ask it, or the user, what it is working on before you plan around it.`,
        created
          ? `You lead this team now. Follow the ${skill} skill, and keep the plan in ${TEAM_FILE} in your folder.`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    return { session, handle, note, created };
  }

  /** Starts the member's session, told its place in the team. */
  private spawnSession(
    team: Team,
    member: {
      workspace: string;
      provider: string;
      handle: string;
      instructions: string;
      input: {
        name?: string;
        taskId?: string;
        model?: string;
        account?: string | null;
      };
    },
  ): Promise<AgentSession> {
    const { input } = member;
    return this.agents.spawn({
      workspace: member.workspace,
      provider: member.provider,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.account !== undefined ? { account: input.account } : {}),
      // A team reads as one color on the board.
      ...(team.lead.color ? { color: team.lead.color } : {}),
      message:
        member.instructions ||
        "The user gives you your work in this session. Say you are ready, then wait for them.",
      team: { teamId: team.id, handle: member.handle },
    });
  }

  /** Takes back a team that was made for a member that did not start. */
  private undoTeam(team: Team): void {
    if (this.members(team.id).length) return;
    this.repositories.abilities.update({
      ...team.ability,
      enabled: false,
      revokedAt: this.now().toISOString(),
    });
  }

  /**
   * Who a post is from. A session in the team writes as its handle; any other
   * session is refused; no session, or `asUser`, is the user.
   */
  author(team: Team, caller: AgentSession | undefined, asUser = false): string {
    if (asUser || !caller) return USER_HANDLE;
    const place = this.memberships(caller.id).find(
      (each) => each.team.id === team.id,
    );
    if (place) return place.reader.handle;
    throw new DaedalusError(
      "CONFLICT",
      `'${caller.name}' is not in the team '${team.name}'; only its lead and members can post, or pass --user to post as the user`,
    );
  }

  /**
   * Posts to the chat and pushes it to every tagged session. A tag that
   * names nobody is refused; a message that tags nobody is stored with a
   * warning, since nobody will be told.
   */
  async say(input: {
    team: string;
    author: string;
    body: string;
    /** Who Daedalus's own posts reach, instead of the tags in the body. */
    tags?: string[];
    kind?: TeamMessageKind;
  }): Promise<TeamSayResult> {
    const team = this.get(input.team);
    const body = input.body.trim();
    if (!body) throw new DaedalusError("VALIDATION", "The message is empty");
    if (body.length > 20_000)
      throw new DaedalusError(
        "VALIDATION",
        "A team message holds at most 20000 characters; put longer text in a file and point to it",
      );
    const handles = new Set(this.readers(team).map((reader) => reader.handle));
    // An archived member can be tagged: the message waits until it is
    // restored. `@all` means the sessions that are live now.
    const archived = new Set(
      this.members(team.id).flatMap((member) =>
        member.archivedAt && member.teamHandle ? [member.teamHandle] : [],
      ),
    );
    const tags = new Set<string>();
    const unknown: string[] = [];
    for (const tag of input.tags ?? parseTags(body)) {
      if (tag === ALL_TAG) for (const handle of handles) tags.add(handle);
      else if (handles.has(tag) || archived.has(tag) || tag === USER_HANDLE)
        tags.add(tag);
      else unknown.push(tag);
    }
    if (unknown.length)
      throw new DaedalusError(
        "VALIDATION",
        `No one in '${team.name}' is called ${unknown.map((tag) => `@${tag}`).join(", ")}; tag ${[...handles, ...archived, ALL_TAG, USER_HANDLE].map((handle) => `@${handle}`).join(", ")}`,
      );
    tags.delete(input.author);
    const warnings: string[] = [];
    for (const tag of tags)
      if (archived.has(tag))
        warnings.push(
          `@${tag} is archived; it gets the message when it is restored`,
        );
    if (![...tags].some((tag) => handles.has(tag) || archived.has(tag)))
      warnings.push(
        "The message tags no session, so nobody was notified; it waits in the team chat",
      );
    const message = this.repositories.teams.addMessage({
      teamId: team.id,
      author: input.author,
      body,
      tags: [...tags],
      createdAt: this.now().toISOString(),
      ...(input.kind ? { kind: input.kind } : {}),
    });
    const deliveries = await this.flushTeam(team);
    return { message, warnings, deliveries };
  }

  /**
   * Tells a member's lead, in the chat, that the member needs the user or
   * stopped. Only the lead is tagged, and only with `wakeLead`; otherwise the
   * note tags nobody and waits for the lead's next read. Nothing for a lead
   * or a non-member, nor when the lead's own process made the change.
   * Never throws.
   */
  async noteMemberStatus(
    sessionId: string,
    status: string,
    options: { wakeLead?: boolean } = {},
  ): Promise<TeamSayResult | undefined> {
    try {
      const membership = this.memberOf(sessionId);
      if (!membership) return undefined;
      // The lead archiving or stopping a member already knows: a note would
      // only wake it again, at its full context.
      if (process.env.DAEDALUS_SESSION_ID === membership.team.lead.id)
        return undefined;
      const wake = options.wakeLead ?? true;
      return await this.say({
        team: membership.team.id,
        author: DAEDALUS_HANDLE,
        tags: wake ? [LEAD_HANDLE] : [],
        body: `${wake ? `@${LEAD_HANDLE} ` : ""}@${membership.reader.handle} ${status}`,
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Hands a member's turn back to its lead: "@api finished: <its last
   * message>". A mid-level lead's turn goes to its own lead the same way. A
   * member waiting on the user is noted too, as the user's to answer, so the
   * lead knows why it is stopped and does not pass it on. Says how the turn
   * was handled, for the user's notification. Never throws.
   */
  async handBack(
    session: AgentSession,
    end: TurnEnd,
    text: string | null,
  ): Promise<TurnEndHandling> {
    try {
      const membership = this.memberOf(session.id);
      // The main agent at Home answers the user even before its first thread.
      if (!membership)
        return this.led(session.id) ||
          this.repositories.findHomeWorkspace()?.id === session.workspaceId
          ? "reply"
          : undefined;
      const handle = membership.reader.handle;
      const said = text ? clip(text.trim(), MAX_HANDBACK_TEXT) : "";
      const body =
        end === "finished"
          ? said
            ? `@${handle} finished:\n\n${said}`
            : `@${handle} finished.`
          : end === "failed"
            ? `@${handle} failed${said ? `: ${said}` : "."}`
            : end === "stopped"
              ? `@${handle} was interrupted by the user.`
              : `@${handle} is waiting on the user${said ? `: ${said}` : "."}\n\nThe user answers it in @${handle}'s own session; you need not pass it on.`;
      await this.say({
        team: membership.team.id,
        author: DAEDALUS_HANDLE,
        tags: [LEAD_HANDLE],
        body,
        // The user answers a member waiting on them, so the note rides along
        // with the lead's next delivery instead of waking it for nothing.
        kind: end === "waiting" ? "waiting" : "handback",
      });
      return "handed-back";
    } catch {
      return undefined;
    }
  }

  /**
   * Sends every lead the hand-backs it was held from while a minute had not
   * passed since its last delivery. The desktop app calls this on its tick;
   * without the app they go with the lead's next delivery or turn.
   */
  async flushDue(): Promise<TeamDeliveryResult[]> {
    const results: TeamDeliveryResult[] = [];
    for (const team of this.list()) {
      const cursor = this.repositories.teams.cursor(team.id, LEAD_HANDLE);
      if (!this.handBackDue(cursor)) continue;
      const waiting = this.repositories.teams
        .messages(team.id, cursor.deliveredThrough)
        .some(
          (message) =>
            tagsReader(message, LEAD_HANDLE) && message.kind !== "waiting",
        );
      if (!waiting) continue;
      // A lead that is not running gets them when it runs again; one whose
      // last delivery failed is tried again a minute later, not every tick.
      const { lead } = team;
      if (
        lead.archivedAt ||
        (lead.status !== "running" && lead.status !== "starting")
      )
        continue;
      if (
        cursor.lastError &&
        cursor.lastAttemptAt &&
        this.now().getTime() - Date.parse(cursor.lastAttemptAt) <
          HANDBACK_INTERVAL_MS
      )
        continue;
      try {
        const result = await this.deliver(team, {
          handle: LEAD_HANDLE,
          session: team.lead,
          role: "lead",
        });
        if (result.messages) results.push(result);
      } catch {
        // The next tick tries again.
      }
    }
    return results;
  }

  /** Whether a lead last given messages at this cursor may be given more. */
  private handBackDue(cursor: TeamCursor): boolean {
    return (
      !cursor.deliveredAt ||
      this.now().getTime() - Date.parse(cursor.deliveredAt) >=
        HANDBACK_INTERVAL_MS
    );
  }

  /** Pushes whatever is waiting to every reader of the team. */
  async flush(reference: string): Promise<TeamDeliveryResult[]> {
    return this.flushTeam(this.get(reference));
  }

  /**
   * Pushes what is waiting for one session, if it is in a team. Called from
   * its own hooks, so a member that was not running yet when a message was
   * posted gets it once it starts. Never throws.
   */
  async flushSession(
    sessionId: string,
  ): Promise<TeamDeliveryResult | undefined> {
    try {
      let own: TeamDeliveryResult | undefined;
      for (const place of this.memberships(sessionId)) {
        const result = await this.deliver(place.team, place.reader);
        if (!own || result.messages) own = result;
        // A lead back from the archive lets its members have what waited.
        if (place.reader.role === "lead") await this.flushTeam(place.team);
      }
      return own;
    } catch {
      return undefined;
    }
  }

  private async flushTeam(team: Team): Promise<TeamDeliveryResult[]> {
    const results: TeamDeliveryResult[] = [];
    for (const reader of this.readers(team)) {
      const result = await this.deliver(team, reader);
      if (result.messages) results.push(result);
    }
    return results;
  }

  /**
   * Tells one reader what tags it since its last delivery, as one line that
   * points it at the chat. The cursor moves
   * before the send, inside a write lock, so two processes never send the
   * same messages; a failed send moves it back and records why.
   */
  private async deliver(
    team: Team,
    reader: TeamReader,
  ): Promise<TeamDeliveryResult> {
    const at = this.now().toISOString();
    const claim = this.repositories.immediateTransaction(() => {
      const cursor = this.repositories.teams.cursor(team.id, reader.handle);
      const pending = this.repositories.teams
        .messages(team.id, cursor.deliveredThrough)
        .filter(
          (message) =>
            message.tags.includes(reader.handle) &&
            message.author !== reader.handle,
        );
      if (!pending.length) return { cursor, pending };
      // A note that a member waits on the user wakes no one; it goes with
      // the next delivery.
      if (pending.every((message) => message.kind === "waiting"))
        return { cursor, pending: [] };
      // Hand-backs alone reach a lead at most once a minute; anything else
      // goes now and takes them along.
      if (
        reader.role === "lead" &&
        pending.every((message) => message.kind !== "message") &&
        !this.handBackDue(cursor)
      )
        return {
          cursor,
          pending,
          coalesced: new Date(
            Date.parse(cursor.deliveredAt!) + HANDBACK_INTERVAL_MS,
          ).toISOString(),
        };
      // A paused team holds its members' messages; the lead still hears.
      if (reader.role === "member" && team.paused) {
        const held: TeamCursor = {
          ...cursor,
          lastError: `the team is paused; it gets the messages when '${team.name}' resumes`,
          lastAttemptAt: at,
        };
        this.repositories.teams.saveCursor(held);
        return { cursor: held, pending, held: true };
      }
      if (
        reader.session.archivedAt ||
        (reader.session.status !== "running" &&
          reader.session.status !== "starting")
      ) {
        const waiting: TeamCursor = {
          ...cursor,
          lastError: `the session is ${reader.session.archivedAt ? "archived" : reader.session.status}; it gets the messages when it runs again`,
          lastAttemptAt: at,
        };
        this.repositories.teams.saveCursor(waiting);
        return { cursor: waiting, pending, skipped: true };
      }
      this.repositories.teams.saveCursor({
        ...cursor,
        deliveredThrough: pending.at(-1)!.id,
        lastAttemptAt: at,
      });
      return { cursor, pending };
    });
    const base = {
      handle: reader.handle,
      sessionId: reader.session.id,
      messages: claim.pending.length,
    };
    if (!claim.pending.length)
      return { ...base, delivered: false, error: null };
    if ("coalesced" in claim)
      return {
        ...base,
        delivered: false,
        error: null,
        heldUntil: claim.coalesced,
      };
    if ("held" in claim)
      return { ...base, delivered: false, error: claim.cursor.lastError };
    if ("skipped" in claim) {
      // Asleep with its cloud workspace: woken and resumed, after which the
      // session running again delivers these.
      void this.agents.wakeIfAsleep(reader.session).catch(() => undefined);
      return { ...base, delivered: false, error: claim.cursor.lastError };
    }
    const claimed = claim.pending.at(-1)!.id;
    try {
      const { text, complete } = this.deliveryText(team, claim.pending, reader);
      await this.transport.deliver({
        session: await this.agents.recoverCodexThread(reader.session),
        text,
        from: this.deliveryFrom(team, claim.pending),
      });
      this.repositories.teams.saveCursor({
        ...this.repositories.teams.cursor(team.id, reader.handle),
        lastError: null,
        lastAttemptAt: at,
        deliveredAt: at,
      });
      // It has read them in full; `team chat --tagged` does not print them
      // again.
      if (complete)
        this.repositories.teams.markRead(
          team.id,
          reader.handle,
          "tagged",
          claimed,
        );
      return { ...base, delivered: true, error: null };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.repositories.immediateTransaction(() => {
        const current = this.repositories.teams.cursor(team.id, reader.handle);
        this.repositories.teams.saveCursor({
          ...current,
          // Only undone if no later delivery moved it on meanwhile.
          deliveredThrough:
            current.deliveredThrough === claimed
              ? claim.cursor.deliveredThrough
              : current.deliveredThrough,
          lastError: reason,
          lastAttemptAt: at,
        });
      });
      return { ...base, delivered: false, error: reason };
    }
  }

  /**
   * The messages in full, oldest first: each under a `[team "..."] author:`
   * header with every body line indented, so no line of a body can pass for
   * a header (N-1), then how to reply. Past MAX_DELIVERY_TEXT the oldest are
   * left out and counted; `complete` is false then, and they stay unread
   * for `team chat --tagged`.
   */
  private deliveryText(
    team: Team,
    pending: TeamMessage[],
    reader: TeamReader,
  ): { text: string; complete: boolean } {
    const label = this.authorLabels(team);
    // A session in two teams, a lead and its lead's member, names which.
    const which =
      this.memberships(reader.session.id).length > 1
        ? ` --team ${team.lead.id}`
        : "";
    const blocks: string[] = [];
    let size = 0;
    let shown = 0;
    for (const message of [...pending].reverse()) {
      const body = splitLines(message.body)
        .map((line) => (line ? `  ${line}` : ""))
        .join("\n");
      const block = `[team "${team.name}"] ${label(message.author)}:\n${body}`;
      if (shown && size + block.length > MAX_DELIVERY_TEXT) break;
      blocks.unshift(block);
      size += block.length;
      shown += 1;
    }
    const left = pending.length - shown;
    if (left)
      blocks.unshift(
        `[team "${team.name}"] ${left} earlier ${left === 1 ? "message is" : "messages are"} not shown here; read ${left === 1 ? "it" : "them"} with: daedal team chat --tagged${which}`,
      );
    const handles = new Set(this.readers(team).map((each) => each.handle));
    const replyTo = new Set<string>();
    for (const message of pending.slice(-shown)) {
      // A hand-back is about the member it names, not from Daedalus.
      const about =
        message.kind !== "message"
          ? parseTags(message.body)[0]
          : message.author;
      if (about && about !== reader.handle && handles.has(about))
        replyTo.add(about);
    }
    const hint = replyTo.size
      ? `Reply with: daedal team say${which} "${[...replyTo].map((handle) => `@${handle}`).join(" ")} ..."`
      : `Read the whole chat with: daedal team chat${which}`;
    return { text: [...blocks, hint].join("\n\n"), complete: left === 0 };
  }

  private deliveryFrom(team: Team, pending: TeamMessage[]): string {
    const authors = [...new Set(pending.map((message) => message.author))];
    return authors.length === 1
      ? `[team "${team.name}"] ${this.authorLabels(team)(authors[0]!)}`
      : `[team "${team.name}"]`;
  }

  /**
   * What a reader has not read yet, oldest first, and moves its read marker
   * to the newest message. `all` shows the newest messages whatever was read.
   * `tagged` shows only unread messages that tag the reader and moves only
   * their marker, so the rest of the chat stays unread for a full read.
   */
  chat(
    reference: string,
    reader: string,
    options: { all?: boolean; tagged?: boolean; limit?: number } = {},
  ): {
    team: Team;
    messages: TeamMessage[];
    skipped: number;
    /** For `tagged`: unread messages that do not tag the reader. */
    others?: number;
  } {
    const team = this.get(reference);
    const limit = Math.max(1, options.limit ?? CHAT_LIMIT);
    const cursor = this.repositories.teams.cursor(team.id, reader);
    if (options.tagged) {
      const after = this.repositories.teams.messages(
        team.id,
        cursor.readThrough,
      );
      const unread = after.filter(
        (message) =>
          message.id > cursor.taggedReadThrough && tagsReader(message, reader),
      );
      const others = after.filter(
        (message) => message.author !== reader && !tagsReader(message, reader),
      ).length;
      const messages = unread.slice(-limit);
      const last = unread.at(-1);
      if (last)
        this.repositories.teams.markRead(team.id, reader, "tagged", last.id);
      return {
        team,
        messages,
        skipped: unread.length - messages.length,
        others,
      };
    }
    // A tagged message read with --tagged is not printed again.
    const unread = options.all
      ? this.repositories.teams.recentMessages(team.id, limit)
      : this.repositories.teams
          .messages(team.id, cursor.readThrough)
          .filter(
            (message) =>
              message.id > cursor.taggedReadThrough ||
              !tagsReader(message, reader),
          );
    const messages = unread.slice(-limit);
    const last = this.repositories.teams.lastMessageId(team.id);
    if (last > cursor.readThrough)
      this.repositories.teams.markRead(team.id, reader, "read", last);
    return {
      team,
      messages,
      skipped: options.all ? 0 : unread.length - messages.length,
    };
  }

  /** The lead and members, with what each has not read or been sent. */
  status(reference: string): { team: Team; members: TeamMemberStatus[] } {
    const team = this.get(reference);
    const messages = this.repositories.teams.messages(team.id);
    const members = [
      ...this.readers(team),
      ...this.members(team.id)
        .filter((member) => member.archivedAt && member.teamHandle)
        .map((member) => ({
          handle: member.teamHandle!,
          session: member,
          role: "member" as const,
        })),
    ].map((reader) => {
      const cursor = this.repositories.teams.cursor(team.id, reader.handle);
      return {
        ...reader,
        unread: messages.filter(
          (message) =>
            message.id > cursor.readThrough &&
            message.author !== reader.handle &&
            !(
              message.id <= cursor.taggedReadThrough &&
              tagsReader(message, reader.handle)
            ),
        ).length,
        undelivered: messages.filter(
          (message) =>
            message.id > cursor.deliveredThrough &&
            message.tags.includes(reader.handle) &&
            message.author !== reader.handle,
        ).length,
        lastError: cursor.lastError,
        lastAttemptAt: cursor.lastAttemptAt,
      };
    });
    return { team, members };
  }

  /** Sets what the team is working toward; members are told at launch. */
  setGoal(reference: string, goal: string): Team {
    const team = this.get(reference);
    this.abilities.configure(team.lead.id, "orchestration", "goal", goal);
    return this.get(team.id);
  }

  private fromAbility(ability: SessionAbility): Team | undefined {
    if (ability.ability !== "orchestration" || !ability.enabled)
      return undefined;
    const lead = this.repositories.findAgent(ability.sessionId);
    if (!lead) return undefined;
    return {
      id: ability.id,
      lead,
      // The lead's rebirth counter is not part of the team's name.
      name: sessionBaseName(lead.name),
      goal: ability.config.goal ?? null,
      paused: ability.paused || Boolean(lead.archivedAt),
      ability,
    };
  }
}

/** Text cut to `limit` characters, saying that it was. */
function clip(text: string, limit: number): string {
  return text.length > limit
    ? `${text.slice(0, limit).trimEnd()}… (cut; the rest is in its session)`
    : text;
}
