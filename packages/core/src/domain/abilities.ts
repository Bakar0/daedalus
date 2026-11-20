import type { UUID } from "./index";

/** The colors a session can be marked with. */
export const SESSION_COLORS = [
  "red",
  "orange",
  "gold",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
] as const;

/** One of the named colors, or any color picked as `#rrggbb`. */
export type SessionColor = (typeof SESSION_COLORS)[number] | `#${string}`;

/**
 * What a session can be granted on top of being a session: orchestration,
 * which makes the session the lead of a team.
 */
export type AbilityId = "orchestration";

/**
 * An ability a session holds. Its data hangs off `id`, which stays the same
 * when a rebirth moves the ability to the successor session.
 */
export interface SessionAbility {
  id: UUID;
  /** The current session; a rebirth moves it to the successor. */
  sessionId: UUID;
  ability: AbilityId;
  /** False after a revoke. The row and its data stay for a later grant. */
  enabled: boolean;
  /** The user's Pause: delivery stops, the ability stays granted. */
  paused: boolean;
  /** For orchestration: `goal`, what the team is working toward. */
  config: Record<string, string>;
  /** A line Daedalus still has to type into the session. */
  pendingNote: string | null;
  grantedAt: string;
  revokedAt: string | null;
}

/** A member's place in a team: the team, and its handle in its channel. */
export interface TeamMembership {
  teamId: UUID;
  handle: string;
}
