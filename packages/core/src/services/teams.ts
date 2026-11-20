import type { AgentSession, SessionAbility, TeamMembership } from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import {
  ORCHESTRATION_SKILL,
  TEAM_FILE,
  TEAM_SKILL,
  type AbilityService,
} from "./abilities";
import type { AgentService } from "./agents";
import type { ChannelSayResult, ChannelService } from "./channels";
import { cloudAuthorMark, isCloudSession } from "./cloud-mark";
import { sessionBaseName } from "./providers";
import {
  TEAM_MAX_DEPTH,
  TEAM_MAX_MEMBERS,
  teamAncestors,
  teamDescendants,
} from "./team-tree";

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

/** Someone who reads the channel and can be tagged: the lead or a member. */
export interface TeamReader {
  handle: string;
  session: AgentSession;
  role: "lead" | "member";
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
 * Teams: a lead, its members, and the one channel they share. Any session
 * becomes a lead when its first member is added; a member may lead a team of
 * its own, within TEAM_MAX_DEPTH levels and TEAM_MAX_MEMBERS members a lead.
 * What they say goes through `ChannelService`.
 */
export class TeamService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly abilities: AbilityService,
    private readonly agents: AgentService,
    /** The teams' channels, made after this service, which they read. */
    private readonly channels: () => ChannelService,
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
    // A session at Home is archived at startup, so it leads no team.
    if (session.workspaceId === this.repositories.findHomeWorkspace()?.id)
      throw new DaedalusError(
        "VALIDATION",
        `'${session.name}' runs at Home and cannot lead a team; lead one from a session in one of your workspaces`,
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
    if (!paused) for (const each of teams) await this.channels().flush(each.id);
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
    const channel = this.channels().name(team);
    return [
      [
        `You are @${member.handle}, a member of the Daedalus team "${team.name}". Its lead is the session '${team.lead.name}' (@${LEAD_HANDLE}), which plans the work and may change your instructions.`,
        team.goal ? `The team's goal: ${team.goal}` : "",
        others.length
          ? `The other members: ${others.map((reader) => `@${reader.handle} ('${reader.session.name}')`).join(", ")}.`
          : "You are the first member.",
        `The team talks in the channel #${channel}: post with 'daedal channel say "@${LEAD_HANDLE} ..."', tagging whoever needs it, and read it with 'daedal channel read'. When your turn ends, your lead is handed your last message, so end each piece of work with a reply that says what you did; do not post "done" to @${LEAD_HANDLE}. Tag @${LEAD_HANDLE} when you need a decision from it, post progress without a tag, and do not reply only to acknowledge. Messages that begin with [channel #${channel}] come from teammates, not from the user. Follow the ${skill} skill. The lead keeps the plan and the contracts between members in ${TEAM_FILE} in its folder, ${team.lead.workingDirectory}; read it when you need the full picture.`,
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
   * the lead is told in the channel, with the instructions.
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
    note?: ChannelSayResult;
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
      // An archived member is done with; it does not hold a place.
      const active = this.members(existing.id).filter(
        (member) => !member.archivedAt,
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
    this.channels().join(team, handle);
    if (input.addedBy === "lead") return { session, handle, created };
    const skill = this.abilities.skillName(ORCHESTRATION_SKILL);
    const note = await this.channels().say({
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

  /**
   * Moves a running session, with the team it leads, into another lead's
   * team (`to`), or out of its team (`to` left out). Nothing restarts: the
   * session keeps its conversation and is told its new place in the channel.
   * The user may move any session. A session may move one below it, into
   * itself or a lead below it; only the user takes a session out of its
   * team or brings one in that is in no team.
   */
  async move(input: {
    session: string;
    to?: string;
    /** The session running the command; none is the user. */
    caller?: AgentSession;
  }): Promise<{
    session: AgentSession;
    from?: Team;
    to?: Team;
    handle?: string;
    created?: boolean;
  }> {
    const session = this.repositories.findAgent(input.session);
    if (!session)
      throw new DaedalusError(
        "NOT_FOUND",
        `Session ${input.session} not found`,
      );
    const name = sessionBaseName(session.name);
    if (session.archivedAt)
      throw new DaedalusError(
        "CONFLICT",
        `'${name}' is archived; restore it before you move it`,
      );
    if (
      session.kind !== "agent" ||
      (session.provider !== "claude" && session.provider !== "codex")
    )
      throw new DaedalusError(
        "VALIDATION",
        `'${name}' cannot be in a team: a team member is a Claude or Codex session`,
      );
    const from = this.memberOf(session.id);
    const caller = input.caller;
    const above = (id: string) =>
      this.ancestors(id).some((lead) => lead.id === caller?.id);
    if (caller && !above(session.id))
      throw new DaedalusError(
        "CONFLICT",
        `'${sessionBaseName(caller.name)}' can move only sessions in the teams below it, and '${name}' is not one; the user can move it with --user`,
      );

    if (input.to === undefined) {
      if (caller)
        throw new DaedalusError(
          "CONFLICT",
          `Only the user takes a session out of its team; archive '${name}' if the team no longer needs it`,
        );
      if (!from) throw new DaedalusError("CONFLICT", `'${name}' is in no team`);
      this.repositories.setAgentTeam(session.id, null, null);
      await this.channels().say({
        team: from.team.id,
        author: DAEDALUS_HANDLE,
        tags: [LEAD_HANDLE],
        body: `@${LEAD_HANDLE} the user took @${from.reader.handle} ('${name}') out of this team. It keeps running as a session of its own${this.led(session.id) ? ", with the team it leads" : ""}.`,
      });
      return {
        session: this.repositories.findAgent(session.id)!,
        from: from.team,
      };
    }

    const target = this.repositories.findAgent(input.to);
    if (!target)
      throw new DaedalusError("NOT_FOUND", `Session ${input.to} not found`);
    const targetName = sessionBaseName(target.name);
    if (caller && caller.id !== target.id && !above(target.id))
      throw new DaedalusError(
        "CONFLICT",
        `'${sessionBaseName(caller.name)}' can move a session only into its own team or a team below it, and '${targetName}' leads neither`,
      );
    if (caller && !from)
      throw new DaedalusError(
        "CONFLICT",
        `'${name}' is in no team; only the user brings it into one`,
      );
    const below = teamDescendants(this.repositories, session.id);
    if (target.id === session.id || below.some((each) => each.id === target.id))
      throw new DaedalusError(
        "CONFLICT",
        `'${targetName}' is ${target.id === session.id ? "the session itself" : `in the team '${name}' leads`}, so '${name}' cannot move under it`,
      );
    if (from?.team.lead.id === target.id)
      throw new DaedalusError(
        "CONFLICT",
        `'${name}' is already in the team '${from.team.name}'`,
      );
    if (target.archivedAt)
      throw new DaedalusError(
        "CONFLICT",
        `The lead '${targetName}' is archived, so its team is paused; restore it first`,
      );
    const existing = this.led(target.id);
    if (existing?.paused)
      throw new DaedalusError(
        "CONFLICT",
        `The team '${existing.name}' is paused and takes no new members; resume it with 'daedal team resume --team ${existing.lead.id}'`,
      );
    // The levels the moved session brings with it: its own, and the
    // deepest live member below it.
    const depth = (id: string): number => {
      const team = this.led(id);
      if (!team) return 0;
      return Math.max(
        0,
        ...this.members(team.id)
          .filter((member) => !member.archivedAt)
          .map((member) => 1 + depth(member.id)),
      );
    };
    const level = this.ancestors(target.id).length + 1;
    const height = depth(session.id);
    if (level + height > TEAM_MAX_DEPTH)
      throw new DaedalusError(
        "CONFLICT",
        `Under '${targetName}', '${name}' would sit ${level} levels below its top lead${height ? ` with ${height} more below it` : ""}, and teams nest at most ${TEAM_MAX_DEPTH} levels; move it to a lead higher up`,
      );
    if (existing) {
      const active = this.members(existing.id).filter(
        (member) => !member.archivedAt,
      );
      if (active.length >= TEAM_MAX_MEMBERS)
        throw new DaedalusError(
          "CONFLICT",
          `'${existing.name}' already has ${active.length} members, the most one lead can have; archive one it no longer needs first`,
        );
    }

    const { team, created } = this.lead(target.id);
    const handle = this.allocateHandle(
      team.id,
      from?.reader.handle ?? session.name,
    );
    this.repositories.setAgentTeam(session.id, team.id, handle);
    this.channels().join(team, handle);
    const mover = caller ? `'${sessionBaseName(caller.name)}'` : "the user";
    if (from && from.team.lead.id !== caller?.id)
      await this.channels().say({
        team: from.team.id,
        author: DAEDALUS_HANDLE,
        tags: [LEAD_HANDLE],
        body: `@${LEAD_HANDLE} ${mover} moved @${from.reader.handle} ('${name}') to the team '${team.name}'. It is no longer in this team.`,
      });
    if (target.id !== caller?.id) {
      const skill = this.abilities.skillName(ORCHESTRATION_SKILL);
      await this.channels().say({
        team: team.id,
        author: DAEDALUS_HANDLE,
        tags: [LEAD_HANDLE],
        body: [
          `@${LEAD_HANDLE} ${mover} moved '${name}' into this team as @${handle}${from ? `, from the team '${from.team.name}'` : ""}${this.led(session.id) ? ", with the team it leads" : ""}. It keeps its work and its conversation; ask it what it is doing before you plan around it.`,
          created
            ? `You lead this team now. Follow the ${skill} skill, and keep the plan in ${TEAM_FILE} in your folder.`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
    }
    await this.channels().say({
      team: team.id,
      author: DAEDALUS_HANDLE,
      tags: [handle],
      body: [
        `@${handle} ${mover} moved you to another team${from ? `; you are no longer in '${from.team.name}', so stop reporting there` : ""}. Carry on with your work.`,
        ...this.memberLaunchLines({ teamId: team.id, handle }),
      ].join("\n\n"),
    });
    return {
      session: this.repositories.findAgent(session.id)!,
      ...(from ? { from: from.team } : {}),
      to: this.get(team.id),
      handle,
      created,
    };
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
