import type { DaedalusConfig } from "../config";
import type {
  AbilityId,
  AgentProviderName,
  AgentSession,
  SessionAbility,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import { channelArtifactName } from "./skills";

/** The managed skill a session follows to create and change its routines. */
export const ROUTINES_SKILL = "daedalus-routines";
/** The managed skill a session follows to carry out one delivered run. */
export const ROUTINE_RUN_SKILL = "daedalus-routine";
/** The lead's playbook. */
export const ORCHESTRATION_SKILL = "daedalus-orchestration";
/** How every member of a team, and its lead, talks in the team chat. */
export const TEAM_SKILL = "daedalus-team";
/** Where a lead keeps its team's state, in its own working directory. */
export const TEAM_FILE = "TEAM.md";

/**
 * What an ability is: a definition in code. Its data, if it has any, hangs
 * off the `session_abilities` row; its skills are Daedalus managed skills
 * every session can see; what it adds to a session is a line in the launch
 * prompt, or a typed note when it is granted to a session already running.
 */
export interface AbilityDefinition {
  id: AbilityId;
  label: string;
  providers: ReadonlyArray<Extract<AgentProviderName, "claude" | "codex">>;
  /** Added to the launch prompt of a session that holds it. */
  launchLine(skill: (id: string) => string): string;
  /** Typed into a running session the ability was just granted to. */
  grantNote(skill: (id: string) => string): string;
  /** Typed into a running session the ability was just taken from. */
  revokeNote(skill: (id: string) => string): string;
}

export const ABILITIES: Readonly<Record<AbilityId, AbilityDefinition>> = {
  routines: {
    id: "routines",
    label: "Routines",
    providers: ["claude", "codex"],
    launchLine: (skill) =>
      `You hold the Daedalus routines ability: the user can ask you for routines, checks that run on a schedule. Create and change them with the ${skill(ROUTINES_SKILL)} skill. When Daedalus types a ${skill(ROUTINE_RUN_SKILL)} line with a run id, carry out that run with the ${skill(ROUTINE_RUN_SKILL)} skill.`,
    grantNote: (skill) =>
      `Daedalus: this session now holds the routines ability. Read the ${skill(ROUTINES_SKILL)} skill now, then wait for the user. When Daedalus types a ${skill(ROUTINE_RUN_SKILL)} line with a run id, carry out that run with the ${skill(ROUTINE_RUN_SKILL)} skill.`,
    revokeNote: () =>
      "Daedalus: the routines ability was removed from this session. Daedalus will not deliver routine runs here any more; do not run routine commands.",
  },
  orchestration: {
    id: "orchestration",
    label: "Orchestration",
    providers: ["claude", "codex"],
    launchLine: (skill) =>
      `You hold the Daedalus orchestration ability: you lead a team of sessions toward one goal. You plan the work, add members with 'daedal agent spawn --team', and talk with them in the team chat ('daedal team say', 'daedal team chat', 'daedal team list'). Follow the ${skill(ORCHESTRATION_SKILL)} skill, and the ${skill(TEAM_SKILL)} skill for the chat. Keep the plan, the members, the contracts between them and every decision in ${TEAM_FILE} in your working directory; if it exists, read it before anything else.`,
    grantNote: (skill) =>
      `Daedalus: this session now holds the orchestration ability and leads a team. Read the ${skill(ORCHESTRATION_SKILL)} skill now, then wait for the user.`,
    revokeNote: () =>
      "Daedalus: the orchestration ability was removed from this session. Your team has ended and its members keep running as plain sessions; do not run team commands.",
  },
};

export const ABILITY_IDS = Object.keys(ABILITIES) as AbilityId[];

export function abilityDefinition(id: string): AbilityDefinition {
  const definition = ABILITIES[id as AbilityId];
  if (!definition)
    throw new DaedalusError(
      "VALIDATION",
      `Unknown ability '${id}'; the abilities are: ${ABILITY_IDS.join(", ")}`,
    );
  return definition;
}

/**
 * Grants, revokes and pauses abilities on sessions. A grant at creation adds
 * the ability's launch line; a grant to a running session leaves a note that
 * the delivery tick types in under the same rule as a routine run.
 */
export class AbilityService {
  private readonly revokeHooks = new Map<
    AbilityId,
    (ability: SessionAbility) => void
  >();

  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly config: DaedalusConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** A skill's name as this channel installs it. */
  skillName(id: string): string {
    return channelArtifactName(this.config, id);
  }

  /** Lets an ability clean up after a revoke, such as dropping queued runs. */
  onRevoke(ability: AbilityId, hook: (ability: SessionAbility) => void): void {
    this.revokeHooks.set(ability, hook);
  }

  /** Every ability row of a session, granted or revoked. */
  list(sessionId: string): SessionAbility[] {
    return this.repositories.abilities.listForSession(sessionId);
  }

  /** The ability if the session holds it now, else undefined. */
  held(sessionId: string, ability: AbilityId): SessionAbility | undefined {
    const row = this.repositories.abilities.findForSession(sessionId, ability);
    return row?.enabled ? row : undefined;
  }

  /** The ability the session holds, or a clear refusal. */
  require(sessionId: string, ability: AbilityId): SessionAbility {
    const row = this.held(sessionId, ability);
    if (!row) {
      const session = this.repositories.findAgent(sessionId);
      throw new DaedalusError(
        "CONFLICT",
        `${session ? `'${session.name}'` : `Session ${sessionId}`} does not hold the ${abilityDefinition(ability).label.toLowerCase()} ability; grant it with 'daedal session grant ${sessionId} ${ability}'`,
      );
    }
    return row;
  }

  /** Every session that holds an ability now. */
  holders(ability: AbilityId): SessionAbility[] {
    return this.repositories.abilities
      .list(ability)
      .filter((row) => row.enabled);
  }

  /** Refuses abilities a session of this kind and provider cannot hold. */
  validate(
    session: Pick<AgentSession, "kind" | "provider">,
    abilities: readonly string[],
  ): AbilityId[] {
    const ids = [...new Set(abilities)].map((id) => abilityDefinition(id).id);
    for (const id of ids) {
      const definition = ABILITIES[id];
      if (
        session.kind !== "agent" ||
        !(definition.providers as readonly string[]).includes(session.provider)
      )
        throw new DaedalusError(
          "VALIDATION",
          `The ${definition.label.toLowerCase()} ability needs a ${definition.providers.join(" or ")} session`,
        );
    }
    return ids;
  }

  /** What a session holding these abilities is told at launch. */
  launchLines(abilities: readonly AbilityId[]): string[] {
    return abilities.map((id) =>
      ABILITIES[id].launchLine((skill) => this.skillName(skill)),
    );
  }

  /**
   * Grants an ability. `live` says the session already exists, so it is told
   * with a note typed in once it is running and idle; a session about to
   * launch is told by its launch prompt instead. Granting again what was
   * revoked brings its data back.
   */
  grant(
    sessionId: string,
    abilityId: string,
    options: { live: boolean },
  ): SessionAbility {
    const session = this.repositories.findAgent(sessionId);
    if (!session)
      throw new DaedalusError("NOT_FOUND", `Session ${sessionId} not found`);
    if (session.archivedAt)
      throw new DaedalusError(
        "CONFLICT",
        "An archived session cannot be granted an ability; restore it first",
      );
    const [ability] = this.validate(session, [abilityId]) as [AbilityId];
    const definition = ABILITIES[ability];
    if (ability === "orchestration" && session.teamId)
      throw new DaedalusError(
        "CONFLICT",
        `'${session.name}' is a member of a team, and a member cannot lead one`,
      );
    const note = options.live
      ? definition.grantNote((skill) => this.skillName(skill))
      : null;
    const at = this.now().toISOString();
    const existing = this.repositories.abilities.findForSession(
      sessionId,
      ability,
    );
    if (existing?.enabled)
      throw new DaedalusError(
        "CONFLICT",
        `'${session.name}' already holds the ${definition.label.toLowerCase()} ability`,
      );
    if (existing) {
      const granted: SessionAbility = {
        ...existing,
        enabled: true,
        paused: false,
        pendingNote: note,
        grantedAt: at,
        revokedAt: null,
      };
      this.repositories.abilities.update(granted);
      return granted;
    }
    const granted: SessionAbility = {
      id: crypto.randomUUID(),
      sessionId,
      ability,
      enabled: true,
      paused: false,
      config: {},
      pendingNote: note,
      grantedAt: at,
      revokedAt: null,
    };
    this.repositories.abilities.create(granted);
    return granted;
  }

  /**
   * Takes an ability away. Its row and data stay, so a later grant restores
   * them; the session is told with a typed note once it is running.
   */
  revoke(sessionId: string, abilityId: string): SessionAbility {
    const ability = abilityDefinition(abilityId).id;
    const row = this.require(sessionId, ability);
    const session = this.repositories.findAgent(sessionId);
    const revoked: SessionAbility = {
      ...row,
      enabled: false,
      paused: false,
      pendingNote:
        session && !session.archivedAt
          ? ABILITIES[ability].revokeNote((skill) => this.skillName(skill))
          : null,
      revokedAt: this.now().toISOString(),
    };
    this.repositories.transaction(() => {
      this.repositories.abilities.update(revoked);
      this.revokeHooks.get(ability)?.(revoked);
    });
    return revoked;
  }

  setPaused(
    sessionId: string,
    abilityId: string,
    paused: boolean,
  ): SessionAbility {
    const row = this.require(sessionId, abilityDefinition(abilityId).id);
    const updated = { ...row, paused };
    this.repositories.abilities.update(updated);
    return updated;
  }

  /** Sets one config value, such as the routines ability's purpose. */
  configure(
    sessionId: string,
    abilityId: string,
    key: string,
    value: string,
  ): SessionAbility {
    const row = this.require(sessionId, abilityDefinition(abilityId).id);
    const config = { ...row.config };
    if (value.trim()) config[key] = value.trim().slice(0, 4_000);
    else delete config[key];
    const updated = { ...row, config };
    this.repositories.abilities.update(updated);
    return updated;
  }

  /** The note was typed in; it is not typed again. */
  noteDelivered(ability: SessionAbility, note: string): void {
    this.repositories.abilities.clearPendingNote(ability.id, note);
  }
}
