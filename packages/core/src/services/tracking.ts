import type {
  AgentSession,
  SessionTrack,
  TrackNote,
  TrackNoteKind,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import type { ActivityService, TurnEnd, TurnEndHandling } from "./activity";
import type { AgentService } from "./agents";
import { splitLines } from "./cloud-mark";
import type { TeamTransport } from "./team-transport";
import { HANDBACK_INTERVAL_MS } from "./teams";
import type { WorkspaceService } from "./workspaces";

/** The longest last message a report quotes. */
const MAX_REPORT_TEXT = 3_000;
/** The longest message `thread say` takes. */
const MAX_MESSAGE_TEXT = 20_000;
/** The most notes one delivery carries; older ones are counted. */
const MAX_NOTES_SHOWN = 10;

/** One session tracked by another, as `thread list` shows it. */
export interface TrackedSession {
  session: AgentSession;
  /** Whether the tracker tracks it; always true without `--all`. */
  tracked: boolean;
}

export interface TrackDeliveryResult {
  sessionId: string;
  messages: number;
  delivered: boolean;
  error: string | null;
  /** Held by the report rate until then. */
  heldUntil?: string;
}

/**
 * Tracking: a session keeping an eye on others without leading them. The
 * main agent at Home tracks the work it starts and the sessions the user
 * points it at; they stay ordinary sessions in their own workspaces, in no
 * team. When a tracked session's turn ends its tracker is told, as a team
 * lead is: reports go at most once a minute (`HANDBACK_INTERVAL_MS`), and a
 * session waiting on the user wakes no one alone. The tracker reaches a
 * tracked session with `say`, in full. A resolved or untracked session stops
 * reporting.
 */
export class TrackingService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly agents: Pick<
      AgentService,
      "spawn" | "wakeIfAsleep" | "recoverCodexThread" | "onSessionRunning"
    >,
    private readonly workspaces: Pick<WorkspaceService, "getActive">,
    private readonly transport: TeamTransport,
    private readonly now: () => Date = () => new Date(),
    activity?: Pick<ActivityService, "onTurnEnd">,
  ) {
    agents.onSessionRunning((session) => this.flushSession(session.id));
    activity?.onTurnEnd((session, end, text) =>
      this.report(session, end, text),
    );
  }

  /** Every track there is. */
  list(): SessionTrack[] {
    return this.repositories.tracks.list();
  }

  /**
   * What a tracker tracks, oldest first; with `all`, every session that is
   * not archived in every workspace but Home, marked when it is tracked.
   */
  sessions(trackerId: string, options: { all?: boolean } = {}) {
    const tracker = this.session(trackerId);
    const tracked = new Set(
      this.repositories.tracks
        .trackedBy(tracker.id)
        .map((track) => track.trackedSessionId),
    );
    if (!options.all)
      return [...tracked].flatMap((id): TrackedSession[] => {
        const session = this.repositories.findAgent(id);
        return session ? [{ session, tracked: true }] : [];
      });
    const home = this.repositories.findHomeWorkspace()?.id;
    return this.repositories
      .listAgents()
      .filter(
        (session) =>
          !session.archivedAt &&
          session.workspaceId !== home &&
          session.id !== tracker.id,
      )
      .map((session): TrackedSession => ({
        session,
        tracked: tracked.has(session.id),
      }));
  }

  /** Whether a session tracks another. */
  tracks(trackerId: string, trackedId: string): boolean {
    return Boolean(this.repositories.tracks.find(trackerId, trackedId));
  }

  /** Whether anything tracks a session. */
  isTracked(sessionId: string): boolean {
    return this.repositories.tracks.trackersOf(sessionId).length > 0;
  }

  /**
   * Starts tracking a session. Refused for the tracker itself and for a
   * session at Home. Says whether it was new.
   */
  track(
    trackerId: string,
    trackedId: string,
  ): { tracker: AgentSession; session: AgentSession; added: boolean } {
    const tracker = this.session(trackerId);
    const session = this.session(trackedId);
    if (session.id === tracker.id)
      throw new DaedalusError("VALIDATION", "A session cannot track itself");
    if (session.workspaceId === this.repositories.findHomeWorkspace()?.id)
      throw new DaedalusError(
        "VALIDATION",
        `'${session.name}' runs at Home; track sessions in your workspaces`,
      );
    const added = this.repositories.tracks.add(
      tracker.id,
      session.id,
      this.now().toISOString(),
    );
    return { tracker, session, added };
  }

  /**
   * Stops tracking a session; it keeps running. Reports about it not yet
   * delivered are dropped. Says whether it was tracked.
   */
  untrack(
    trackerId: string,
    trackedId: string,
  ): { session: AgentSession; removed: boolean } {
    const tracker = this.session(trackerId);
    const session = this.session(trackedId);
    return {
      session,
      removed: this.repositories.tracks.remove(tracker.id, session.id),
    };
  }

  /**
   * Starts an ordinary session in a workspace and tracks it. It is told
   * that its turn-end replies go to its tracker. `spawned_by` records who
   * started it.
   */
  async start(input: {
    tracker: string;
    workspace: string;
    message: string;
    name?: string;
    provider?: string;
    model?: string;
  }): Promise<AgentSession> {
    const tracker = this.session(input.tracker);
    const message = input.message.trim();
    if (!message)
      throw new DaedalusError(
        "VALIDATION",
        'A new thread needs instructions: --message "<instructions>"',
      );
    const workspace = await this.workspaces.getActive(input.workspace);
    if (workspace.kind === "home")
      throw new DaedalusError(
        "VALIDATION",
        "A thread runs in one of your workspaces, not at Home; pass --workspace <workspace>",
      );
    const session = await this.agents.spawn({
      workspace: workspace.id,
      message: [message, this.trackedLine(tracker)].join("\n\n"),
      spawnedBy: tracker.id,
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      // The tracker's provider unless one is asked for, as a team member.
      provider:
        input.provider ?? (tracker.provider === "codex" ? "codex" : "claude"),
      ...(input.model ? { model: input.model } : {}),
    });
    this.repositories.tracks.add(
      tracker.id,
      session.id,
      this.now().toISOString(),
    );
    return session;
  }

  /**
   * Delivers a message in full from a tracker to a session it tracks, with
   * a line saying its turn-end reply goes back. A session not running gets
   * it once it runs again.
   */
  async say(input: {
    tracker: string;
    session: string;
    body: string;
  }): Promise<{ session: AgentSession; delivery: TrackDeliveryResult }> {
    const tracker = this.session(input.tracker);
    const session = this.session(input.session);
    const body = input.body.trim();
    if (!body) throw new DaedalusError("VALIDATION", "The message is empty");
    if (body.length > MAX_MESSAGE_TEXT)
      throw new DaedalusError(
        "VALIDATION",
        `A message holds at most ${MAX_MESSAGE_TEXT} characters; put longer text in a file and point to it`,
      );
    if (!this.tracks(tracker.id, session.id))
      throw new DaedalusError(
        "VALIDATION",
        `'${tracker.name}' does not track '${session.name}'; run 'daedal thread track ${session.id}' first`,
      );
    this.repositories.tracks.addNote({
      recipientSessionId: session.id,
      peerSessionId: tracker.id,
      kind: "message",
      body,
      createdAt: this.now().toISOString(),
    });
    return { session, delivery: await this.deliver(session.id) };
  }

  /**
   * Tells every tracker of a session that its turn ended: "'cart docs'
   * finished: <its last message>". A resolved session reports nothing.
   * Never throws.
   */
  async report(
    session: AgentSession,
    end: TurnEnd,
    text: string | null,
  ): Promise<TurnEndHandling> {
    try {
      const current = this.repositories.findAgent(session.id) ?? session;
      if (current.resolvedAt) return undefined;
      const trackers = this.repositories.tracks.trackersOf(session.id);
      if (!trackers.length) return undefined;
      const said = text ? clip(text.trim(), MAX_REPORT_TEXT) : "";
      const body =
        end === "finished"
          ? said
            ? `finished:\n\n${said}`
            : "finished."
          : end === "failed"
            ? `failed${said ? `: ${said}` : "."}`
            : end === "stopped"
              ? "was interrupted by the user."
              : `is waiting on the user${said ? `: ${said}` : "."}\n\nThe user answers it in its own session; you need not pass it on.`;
      const kind: TrackNoteKind = end === "waiting" ? "waiting" : "report";
      for (const track of trackers) {
        this.repositories.tracks.addNote({
          recipientSessionId: track.trackerSessionId,
          peerSessionId: session.id,
          kind,
          body,
          createdAt: this.now().toISOString(),
        });
        await this.deliver(track.trackerSessionId).catch(() => undefined);
      }
      return "handed-back";
    } catch {
      return undefined;
    }
  }

  /**
   * Sends every tracker the reports held while a minute had not passed since
   * its last delivery. The desktop app calls this on its tick.
   */
  async flushDue(): Promise<TrackDeliveryResult[]> {
    const results: TrackDeliveryResult[] = [];
    for (const recipient of this.repositories.tracks.recipientsWithPending()) {
      if (!this.due(recipient)) continue;
      const session = this.repositories.findAgent(recipient);
      if (
        !session ||
        session.archivedAt ||
        (session.status !== "running" && session.status !== "starting")
      )
        continue;
      // One whose last delivery failed is tried again a minute later.
      const attempt = this.repositories.tracks.lastAttempt(recipient);
      if (
        attempt?.error &&
        this.now().getTime() - Date.parse(attempt.at) < HANDBACK_INTERVAL_MS
      )
        continue;
      try {
        const result = await this.deliver(recipient);
        if (result.messages) results.push(result);
      } catch {
        // The next tick tries again.
      }
    }
    return results;
  }

  /** Delivers what waits for a session once it runs. Never throws. */
  async flushSession(
    sessionId: string,
  ): Promise<TrackDeliveryResult | undefined> {
    try {
      return await this.deliver(sessionId);
    } catch {
      return undefined;
    }
  }

  /** Whether a session last given notes may be given more reports now. */
  private due(sessionId: string): boolean {
    const last = this.repositories.tracks.lastDelivered(sessionId);
    return (
      !last || this.now().getTime() - Date.parse(last) >= HANDBACK_INTERVAL_MS
    );
  }

  /**
   * Gives one session what waits for it, in full. Waiting notes alone wake
   * no one; reports alone go at most once a minute; a message goes now and
   * takes the rest along. The notes are claimed inside a write lock, so two
   * processes never send the same ones; a failed send puts them back.
   */
  private async deliver(sessionId: string): Promise<TrackDeliveryResult> {
    const at = this.now().toISOString();
    const claim = this.repositories.immediateTransaction(() => {
      const pending = this.repositories.tracks.pending(sessionId);
      const session = this.repositories.findAgent(sessionId);
      if (!pending.length || !session) return { pending: [] as TrackNote[] };
      if (pending.every((note) => note.kind === "waiting"))
        return { pending: [] as TrackNote[] };
      if (
        pending.every((note) => note.kind !== "message") &&
        !this.due(sessionId)
      )
        return {
          pending,
          heldUntil: new Date(
            Date.parse(this.repositories.tracks.lastDelivered(sessionId)!) +
              HANDBACK_INTERVAL_MS,
          ).toISOString(),
        };
      if (
        session.archivedAt ||
        (session.status !== "running" && session.status !== "starting")
      ) {
        const reason = `the session is ${session.archivedAt ? "archived" : session.status}; it gets them when it runs again`;
        this.repositories.tracks.markFailed(
          pending.map((note) => note.id),
          at,
          reason,
        );
        return { pending, session, skipped: reason };
      }
      this.repositories.tracks.markDelivered(
        pending.map((note) => note.id),
        at,
      );
      return { pending, session };
    });
    const base = { sessionId, messages: claim.pending.length };
    if (!claim.pending.length)
      return { ...base, delivered: false, error: null };
    if ("heldUntil" in claim)
      return {
        ...base,
        delivered: false,
        error: null,
        heldUntil: claim.heldUntil,
      };
    if ("skipped" in claim) {
      void this.agents.wakeIfAsleep(claim.session!).catch(() => undefined);
      return { ...base, delivered: false, error: claim.skipped ?? null };
    }
    const ids = claim.pending.map((note) => note.id);
    try {
      const { text, from } = this.deliveryText(claim.pending);
      await this.transport.deliver({
        session: await this.agents.recoverCodexThread(claim.session!),
        text,
        from,
      });
      return { ...base, delivered: true, error: null };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.repositories.tracks.markFailed(ids, at, reason);
      return { ...base, delivered: false, error: reason };
    }
  }

  /**
   * The notes in full, oldest first: each under a header naming the other
   * session, with every body line indented so no line of a body can pass
   * for a header, then how to reply.
   */
  private deliveryText(pending: TrackNote[]): { text: string; from: string } {
    const shown = pending.slice(-MAX_NOTES_SHOWN);
    const left = pending.length - shown.length;
    const peers = new Map<string, AgentSession>();
    const blocks: string[] = [];
    if (left)
      blocks.push(
        `[tracked] ${left} earlier ${left === 1 ? "report is" : "reports are"} not shown here; see 'daedal thread list'`,
      );
    for (const note of shown) {
      const peer = note.peerSessionId
        ? this.repositories.findAgent(note.peerSessionId)
        : undefined;
      if (peer) peers.set(peer.id, peer);
      const name = peer ? `'${peer.name}'` : "a session";
      const indent = (text: string) =>
        splitLines(text)
          .map((line) => (line ? `  ${line}` : ""))
          .join("\n");
      if (note.kind === "message")
        blocks.push(`[from ${name}, which tracks you]:\n${indent(note.body)}`);
      else {
        const where = peer
          ? this.repositories.findWorkspace(peer.workspaceId)?.name
          : undefined;
        const [first = "", ...rest] = splitLines(note.body);
        blocks.push(
          `[tracked ${name}${where ? ` in ${where}` : ""}] ${first}${rest.length ? `\n${indent(rest.join("\n"))}` : ""}`,
        );
      }
    }
    const messages = shown.filter((note) => note.kind === "message");
    const reports = shown.filter((note) => note.kind !== "message");
    const tail: string[] = [];
    if (messages.length) {
      const tracker = messages.at(-1)!.peerSessionId
        ? this.repositories.findAgent(messages.at(-1)!.peerSessionId!)
        : undefined;
      tail.push(this.replyLine(tracker));
    }
    const about = [
      ...new Set(reports.flatMap((note) => note.peerSessionId ?? [])),
    ];
    if (about.length)
      tail.push(
        `Reply with: ${about.map((id) => `daedal thread say ${id} "..."`).join(" or ")}`,
      );
    const names = [...new Set(shown.map((note) => note.peerSessionId))];
    const only = names.length === 1 && names[0] ? peers.get(names[0]) : null;
    return {
      text: [...blocks, ...tail].join("\n\n"),
      from: only ? `[tracked] ${only.name}` : "[tracked]",
    };
  }

  /** What a tracked session is told about where its replies go. */
  private replyLine(tracker: AgentSession | undefined): string {
    const who = this.trackerName(tracker);
    return `When this turn ends, your last message goes back to ${who}, so end with a reply that says what you did.`;
  }

  /** What a session started for a tracker is told at launch. */
  private trackedLine(tracker: AgentSession): string {
    const who = this.trackerName(tracker);
    return `${who[0]!.toUpperCase()}${who.slice(1)} started this session and tracks it: when each turn ends, your last message goes to it. End each piece of work with a reply that says what you did; you need not post "done" anywhere.`;
  }

  private trackerName(tracker: AgentSession | undefined): string {
    if (!tracker) return "the session tracking you";
    return tracker.workspaceId === this.repositories.findHomeWorkspace()?.id
      ? "the main agent"
      : `'${tracker.name}'`;
  }

  private session(reference: string): AgentSession {
    const session = this.repositories.findAgent(reference);
    if (!session)
      throw new DaedalusError("NOT_FOUND", `Session ${reference} not found`);
    return session;
  }
}

function clip(text: string, limit: number): string {
  return text.length > limit
    ? `${text.slice(0, limit).trimEnd()}… (cut; the rest is in its session)`
    : text;
}
