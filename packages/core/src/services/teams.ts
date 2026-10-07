import type {
  AgentSession,
  SessionAbility,
  TeamCursor,
  TeamMembership,
  TeamMessage,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import { TEAM_FILE, TEAM_SKILL, type AbilityService } from "./abilities";
import type { AgentService } from "./agents";
import type { TeamTransport } from "./team-transport";

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

/** A team: its lead's orchestration ability, and what the team is called. */
export interface Team {
  /** The lead's orchestration ability id. */
  id: string;
  lead: AgentSession;
  /** The lead's session title. */
  name: string;
  goal: string | null;
  ability: SessionAbility;
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
 * The handles a message tags. A tag is `@` and a handle, at the start or
 * after a character that cannot be part of an address, so `a@b.com` is not
 * a tag.
 */
export function parseTags(body: string): string[] {
  const tags = new Set<string>();
  for (const match of body.matchAll(/(?:^|[^\w.@-])@([a-z0-9][a-z0-9-]*)/gi))
    tags.add(match[1]!.toLowerCase().replace(/-+$/, ""));
  return [...tags];
}

/**
 * Teams: a lead holding the orchestration ability, its members, and the one
 * chat they share. Every message is stored; the ones that tag a session are
 * pushed into it through the provider's own inbox right away, from whichever
 * process posted them, so nothing waits on the desktop app.
 */
export class TeamService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly abilities: AbilityService,
    private readonly agents: AgentService,
    private readonly transport: TeamTransport,
    private readonly now: () => Date = () => new Date(),
  ) {
    agents.onTeamLaunch((member) => this.memberLaunchLines(member));
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
    const ability =
      this.abilities.held(reference, "orchestration") ??
      this.repositories.abilities
        .list("orchestration")
        .find((row) => row.id === reference && row.enabled);
    const team = ability && this.fromAbility(ability);
    if (!team) {
      const session = this.repositories.findAgent(reference);
      throw new DaedalusError(
        "NOT_FOUND",
        session
          ? `'${session.name}' does not lead a team; grant it the orchestration ability with 'daedal session grant ${session.id} orchestration'`
          : `No team led by ${reference}`,
      );
    }
    return team;
  }

  /** The team a session leads or belongs to, and its handle there. */
  membership(
    sessionId: string,
  ): { team: Team; reader: TeamReader } | undefined {
    const led = this.abilities.held(sessionId, "orchestration");
    if (led) {
      const team = this.fromAbility(led);
      if (team)
        return {
          team,
          reader: { handle: LEAD_HANDLE, session: team.lead, role: "lead" },
        };
    }
    const session = this.repositories.findAgent(sessionId);
    if (!session?.teamId || !session.teamHandle) return undefined;
    const ability = this.repositories.abilities
      .list("orchestration")
      .find((row) => row.id === session.teamId && row.enabled);
    const team = ability && this.fromAbility(ability);
    return team
      ? {
          team,
          reader: { handle: session.teamHandle, session, role: "member" },
        }
      : undefined;
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

  /** What a member is told at launch, and again after a handoff. */
  memberLaunchLines(member: TeamMembership): string[] {
    const ability = this.repositories.abilities
      .list("orchestration")
      .find((row) => row.id === member.teamId);
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
        `Talk to the team with 'daedal team say "@${LEAD_HANDLE} ..."', tagging whoever needs it, and read the chat with 'daedal team chat'. Report progress, blockers and when you are done to @${LEAD_HANDLE}. Messages that begin with [team "${team.name}"] come from teammates, not from the user. Follow the ${skill} skill. The lead keeps the plan and the contracts between members in ${TEAM_FILE} in its folder, ${team.lead.workingDirectory}; read it when you need the full picture.`,
      ]
        .filter(Boolean)
        .join(" "),
    ];
  }

  /**
   * Starts a member in the lead's workspace on the lead's provider. When the
   * user added it, the lead is told in the chat, with the instructions.
   */
  async spawnMember(input: {
    team: string;
    addedBy: "lead" | "user";
    instructions: string;
    name?: string;
    taskId?: string;
    provider?: string;
    model?: string;
    account?: string | null;
  }): Promise<{ session: AgentSession; handle: string; note?: TeamSayResult }> {
    const team = this.get(input.team);
    const instructions = input.instructions.trim();
    if (!instructions)
      throw new DaedalusError(
        "VALIDATION",
        "A member needs instructions; pass --message",
      );
    if (input.provider && input.provider !== team.lead.provider)
      throw new DaedalusError(
        "VALIDATION",
        `Every member of '${team.name}' runs on ${team.lead.provider}, the lead's provider`,
      );
    const task = input.taskId
      ? this.repositories.findTask(input.taskId)
      : undefined;
    const handle = this.allocateHandle(team.id, input.name ?? task?.title);
    // Messages from before it joined are history to read, not to deliver.
    const joinedAfter = this.repositories.teams.lastMessageId(team.id);
    const session = await this.agents.spawn({
      workspace: team.lead.workspaceId,
      provider: team.lead.provider,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.account !== undefined ? { account: input.account } : {}),
      message: instructions,
      team: { teamId: team.id, handle },
    });
    this.repositories.teams.saveCursor({
      teamId: team.id,
      handle,
      readThrough: 0,
      deliveredThrough: joinedAfter,
      lastError: null,
      lastAttemptAt: null,
    });
    if (input.addedBy === "lead") return { session, handle };
    const note = await this.say({
      team: team.id,
      author: DAEDALUS_HANDLE,
      // The new member has its instructions already; only the lead is told.
      tags: [LEAD_HANDLE],
      body: `@${LEAD_HANDLE} the user added @${handle} ('${session.name}') to the team with these instructions:\n\n${instructions}`,
    });
    return { session, handle, note };
  }

  /**
   * Who a post is from. A session in the team writes as its handle; any other
   * session is refused; no session, or `asUser`, is the user.
   */
  author(team: Team, caller: AgentSession | undefined, asUser = false): string {
    if (asUser || !caller) return USER_HANDLE;
    const membership = this.membership(caller.id);
    if (membership?.team.id === team.id) return membership.reader.handle;
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
  }): Promise<TeamSayResult> {
    const team = this.get(input.team);
    const body = input.body.trim();
    if (!body) throw new DaedalusError("VALIDATION", "The message is empty");
    if (body.length > 20_000)
      throw new DaedalusError(
        "VALIDATION",
        "A team message holds at most 20000 characters; put longer text in a file and point to it",
      );
    const readers = this.readers(team);
    const handles = new Set(readers.map((reader) => reader.handle));
    const tags = new Set<string>();
    const unknown: string[] = [];
    for (const tag of input.tags ?? parseTags(body)) {
      if (tag === ALL_TAG) for (const handle of handles) tags.add(handle);
      else if (handles.has(tag) || tag === USER_HANDLE) tags.add(tag);
      else unknown.push(tag);
    }
    if (unknown.length)
      throw new DaedalusError(
        "VALIDATION",
        `No one in '${team.name}' is called ${unknown.map((tag) => `@${tag}`).join(", ")}; tag ${[...handles, ALL_TAG, USER_HANDLE].map((handle) => `@${handle}`).join(", ")}`,
      );
    tags.delete(input.author);
    const warnings: string[] = [];
    if (![...tags].some((tag) => handles.has(tag)))
      warnings.push(
        "The message tags no session, so nobody was notified; it waits in the team chat",
      );
    const message = this.repositories.teams.addMessage({
      teamId: team.id,
      author: input.author,
      body,
      tags: [...tags],
      createdAt: this.now().toISOString(),
    });
    const deliveries = await this.flushTeam(team);
    return { message, warnings, deliveries };
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
      const membership = this.membership(sessionId);
      if (!membership) return undefined;
      return await this.deliver(membership.team, membership.reader);
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
   * Sends one reader everything that tags it since its last delivery, as one
   * message, with a count of what else is new in the chat. The cursor moves
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
    if ("skipped" in claim)
      return { ...base, delivered: false, error: claim.cursor.lastError };
    const claimed = claim.pending.at(-1)!.id;
    try {
      await this.transport.deliver({
        session: reader.session,
        text: this.deliveryText(team, reader, claim.pending),
        from: this.deliveryFrom(team, claim.pending),
      });
      this.repositories.teams.saveCursor({
        ...this.repositories.teams.cursor(team.id, reader.handle),
        lastError: null,
        lastAttemptAt: at,
      });
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

  private deliveryText(
    team: Team,
    reader: TeamReader,
    pending: TeamMessage[],
  ): string {
    const blocks = pending.map(
      (message) => `[team "${team.name}"] ${message.author}: ${message.body}`,
    );
    const delivered = new Set(pending.map((message) => message.id));
    const cursor = this.repositories.teams.cursor(team.id, reader.handle);
    const others = this.repositories.teams
      .messages(team.id, cursor.readThrough)
      .filter(
        (message) =>
          !delivered.has(message.id) &&
          !message.tags.includes(reader.handle) &&
          message.author !== reader.handle,
      ).length;
    if (others)
      blocks.push(
        `(${others} other new message${others === 1 ? "" : "s"} in the team chat; run 'daedal team chat' to read ${others === 1 ? "it" : "them"}.)`,
      );
    return blocks.join("\n\n");
  }

  private deliveryFrom(team: Team, pending: TeamMessage[]): string {
    const authors = [...new Set(pending.map((message) => message.author))];
    return authors.length === 1
      ? `[team "${team.name}"] ${authors[0]}`
      : `[team "${team.name}"]`;
  }

  /**
   * What a reader has not read yet, oldest first, and moves its read marker
   * to the newest message. `all` shows the newest messages whatever was read.
   */
  chat(
    reference: string,
    reader: string,
    options: { all?: boolean; limit?: number } = {},
  ): { team: Team; messages: TeamMessage[]; skipped: number } {
    const team = this.get(reference);
    const limit = Math.max(1, options.limit ?? CHAT_LIMIT);
    const cursor = this.repositories.teams.cursor(team.id, reader);
    const unread = options.all
      ? this.repositories.teams.recentMessages(team.id, limit)
      : this.repositories.teams.messages(team.id, cursor.readThrough);
    const messages = unread.slice(-limit);
    const last = this.repositories.teams.lastMessageId(team.id);
    if (last > cursor.readThrough)
      this.repositories.teams.saveCursor({ ...cursor, readThrough: last });
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
            message.id > cursor.readThrough && message.author !== reader.handle,
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
      name: lead.name,
      goal: ability.config.goal ?? null,
      ability,
    };
  }
}
