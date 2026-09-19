import type { TmuxClient } from "@daedalus/platform";
import type {
  AgentProviderName,
  AgentSession,
  AgentSessionStatus,
  SessionKind,
} from "../domain";
import type { SqliteRepositories } from "../repositories";
import type { AgentService } from "./agents";
import type { IntegratedTerminalService } from "./integrated-terminals";

/**
 * What a shutdown intends to do with one session.
 *
 * `archive` preserves the conversation and leaves a restorable row behind.
 * `stop` is for sessions that have no native conversation to preserve, and is
 * chosen up front so the sweep never dead-ends on one of them.
 */
export type ShutdownDisposition = "archive" | "stop";

export interface ShutdownSessionTarget {
  id: string;
  name: string;
  workspaceId: string;
  provider: AgentProviderName;
  kind: SessionKind;
  status: AgentSessionStatus;
  disposition: ShutdownDisposition;
}

export interface ShutdownTerminalTarget {
  id: string;
  name: string;
}

/** Everything a shutdown would end, without ending any of it. */
export interface ShutdownPlan {
  sessions: ShutdownSessionTarget[];
  terminals: ShutdownTerminalTarget[];
}

export type ShutdownSessionOutcome = "archived" | "stopped" | "failed";

export interface ShutdownSessionResult {
  id: string;
  name: string;
  provider: AgentProviderName;
  outcome: ShutdownSessionOutcome;
  /** Why the intended disposition was not the one that happened. */
  reason?: string;
}

export interface ShutdownTerminalResult {
  id: string;
  name: string;
  closed: boolean;
  reason?: string;
}

export interface ShutdownResult {
  sessions: ShutdownSessionResult[];
  terminals: ShutdownTerminalResult[];
  /**
   * True when no Daedalus tmux server is running on this home's socket any
   * more. Not "we killed one": tmux exits on its own once the last session in
   * it ends, so a sweep that stopped everything often finds it already gone,
   * and that is the same outcome rather than a lesser one.
   */
  serverStopped: boolean;
  /** Set when stopping the server was attempted and failed. */
  serverError?: string;
}

export interface ShutdownOptions {
  /**
   * Leaves integrated terminals open. It also leaves the tmux server alone by
   * construction: the server is where those terminals live, so a caller that
   * wants them kept cannot also have it killed.
   */
  keepTerminals?: boolean;
  /**
   * Ends the Daedalus tmux server once everything has been dealt with. This is
   * the difference between "quit and archive" and a real shutdown, and it is
   * never implicit — it takes every session on the socket with it, including
   * ones Daedalus did not start.
   */
  stopServer?: boolean;
}

const isLive = (status: AgentSessionStatus) =>
  status === "running" || status === "starting";

/**
 * A `custom` agent has no native resume, so `archive` would refuse it (see
 * `AgentService.prepareArchivable`). A `terminal` session is a shell rather
 * than a conversation and archives fine — there is simply nothing to resume.
 */
const dispositionFor = (session: AgentSession): ShutdownDisposition =>
  session.kind !== "terminal" && session.provider === "custom"
    ? "stop"
    : "archive";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * The one honest off switch: end every live session and terminal, then take
 * the tmux server with them.
 *
 * It exists in core rather than in either adapter because both need it — the
 * "Quit and Shut Down Sessions" menu item and `daedal shutdown` are the same
 * sweep — and because the interesting part is the policy, not the plumbing:
 * which sessions can be archived rather than merely stopped, and what a
 * partial failure leaves behind.
 *
 * Refusing while the desktop app is running is deliberately *not* here. It is
 * a rule about one caller (the CLI racing the app's poll), and the app itself
 * has to be able to run this sweep on its own way out.
 */
export class ShutdownService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly agents: AgentService,
    private readonly terminals: IntegratedTerminalService,
    private readonly tmux: TmuxClient,
  ) {}

  /**
   * What is live right now. Reconciles first, so a session whose tmux server
   * already died is not counted as something about to be stopped.
   */
  async plan(): Promise<ShutdownPlan> {
    await Promise.all([
      this.agents.reconcile(),
      this.terminals.reconcile(),
    ]).catch(() => undefined);
    return {
      sessions: this.repositories
        .listAgents()
        .filter((session) => isLive(session.status) && !session.archivedAt)
        .map((session) => ({
          id: session.id,
          name: session.name,
          workspaceId: session.workspaceId,
          provider: session.provider,
          kind: session.kind,
          status: session.status,
          disposition: dispositionFor(session),
        })),
      terminals: this.repositories
        .listIntegratedTerminals()
        .filter((terminal) => isLive(terminal.status))
        .map((terminal) => ({ id: terminal.id, name: terminal.name })),
    };
  }

  async run(options: ShutdownOptions = {}): Promise<ShutdownResult> {
    const plan = await this.plan();
    const sessions: ShutdownSessionResult[] = [];
    // Serial on purpose. Archiving a Codex session shells out to `codex
    // archive`, and a board of those at once is how a shutdown turns into a
    // thundering herd on the way out.
    for (const target of plan.sessions)
      sessions.push(await this.endSession(target));
    const terminals: ShutdownTerminalResult[] = [];
    if (!options.keepTerminals)
      for (const target of plan.terminals) {
        try {
          await this.terminals.close(target.id);
          terminals.push({ ...target, closed: true });
        } catch (error) {
          terminals.push({ ...target, closed: false, reason: message(error) });
        }
      }
    // Keeping the terminals means keeping the server they live in; there is no
    // coherent reading of `--keep-terminals` that also ends it.
    if (!options.stopServer || options.keepTerminals)
      return { sessions, terminals, serverStopped: false };
    try {
      await this.tmux.killServer();
      return { sessions, terminals, serverStopped: true };
    } catch (error) {
      return {
        sessions,
        terminals,
        serverStopped: false,
        serverError: message(error),
      };
    }
  }

  /**
   * Archives one session, and stops it instead if archiving is impossible.
   *
   * The fallback is what keeps one unarchivable session from ending the sweep,
   * and it is also what keeps a half-spawned `starting` session from being
   * left behind: whatever archiving could not do, the stop still does.
   */
  private async endSession(
    target: ShutdownSessionTarget,
  ): Promise<ShutdownSessionResult> {
    const identity = {
      id: target.id,
      name: target.name,
      provider: target.provider,
    };
    // Re-read rather than trust the plan: archiving a workspace cascades into
    // its sessions, so one of these may already be over by the time we reach
    // it, and archiving it twice is not the way to find that out.
    const current = this.repositories.findAgent(target.id);
    if (!current) return { ...identity, outcome: "stopped" };
    if (current.archivedAt) return { ...identity, outcome: "archived" };
    if (!isLive(current.status)) return { ...identity, outcome: "stopped" };
    if (target.disposition === "stop") {
      try {
        await this.agents.stop(target.id, true);
        return { ...identity, outcome: "stopped" };
      } catch (error) {
        return { ...identity, outcome: "failed", reason: message(error) };
      }
    }
    try {
      await this.agents.archive(target.id);
      return { ...identity, outcome: "archived" };
    } catch (error) {
      const reason = message(error);
      const after = this.repositories.findAgent(target.id);
      if (!after || !isLive(after.status))
        return { ...identity, outcome: "failed", reason };
      try {
        await this.agents.stop(target.id, false);
        return { ...identity, outcome: "stopped", reason };
      } catch (stopError) {
        return {
          ...identity,
          outcome: "failed",
          reason: `${reason}; ${message(stopError)}`,
        };
      }
    }
  }
}
