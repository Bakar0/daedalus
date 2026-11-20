import type {
  AgentSession,
  Channel,
  Cursor,
  Message,
  MessageKind,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import type { ActivityService, TurnEnd, TurnEndHandling } from "./activity";
import type { AgentService } from "./agents";
import { splitLines } from "./cloud-mark";
import type { TeamTransport } from "./team-transport";
import {
  ALL_TAG,
  DAEDALUS_HANDLE,
  LEAD_HANDLE,
  USER_HANDLE,
  type Team,
  type TeamReader,
  type TeamService,
} from "./teams";

/** How many messages `channel read` prints when nothing limits it. */
const READ_LIMIT = 50;

/** How many messages `channel find` returns at most. */
const FIND_LIMIT = 20;

/** How far back `channel find` looks when no `--since` is given. */
export const FIND_SINCE_MS = 14 * 24 * 60 * 60_000;

/**
 * A lead gets hand-backs at most once in this long: members finishing one
 * after another wake it once, with all of them.
 */
export const HANDBACK_INTERVAL_MS = 60_000;

/** The most of a member's last message a hand-back quotes. */
const MAX_HANDBACK_TEXT = 3_000;

/**
 * The most text one delivery carries. Older messages past it are left for
 * `channel read --tagged`, and the delivery says how many.
 */
const MAX_DELIVERY_TEXT = 16_000;

/** The longest message a channel takes. */
const MAX_MESSAGE_TEXT = 20_000;

export interface ChannelDeliveryResult {
  handle: string;
  sessionId: string;
  /** How many messages it carried; zero when nothing was waiting. */
  messages: number;
  delivered: boolean;
  error: string | null;
  /** Hand-backs held for the lead's next delivery, due then. */
  heldUntil?: string;
}

export interface ChannelSayResult {
  message: Message;
  warnings: string[];
  deliveries: ChannelDeliveryResult[];
}

export interface ChannelMemberStatus extends TeamReader {
  /** Messages after its read marker that it did not write. */
  unread: number;
  /** Messages that tag it and have not reached its session. */
  undelivered: number;
  lastError: string | null;
  lastAttemptAt: string | null;
}

/** A message `channel find` matched, with the channel it is in. */
export interface ChannelFindHit {
  team: Team;
  message: Message;
}

/**
 * A team's channel name: its lead's name as a slug, written `#name`. Two
 * teams can share one; `--team <lead>` tells them apart.
 */
export function teamChannelName(team: Team): string {
  const slug = team.name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "team";
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
const tagsReader = (message: Message, reader: string): boolean =>
  message.tags.includes(reader) && message.author !== reader;

/** A message's time as `channel read` prints it: `14:05`, local. */
const clockTime = (iso: string): string => {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/**
 * One message as `channel read` prints it: a header line, then every line of
 * the body indented under it, so no body line can pass for a header (N-1).
 */
export function channelMessageText(message: Message, author: string): string {
  const tags = message.tags.length
    ? ` → ${message.tags.map((tag) => `@${tag}`).join(" ")}`
    : "";
  const body = splitLines(message.body)
    .map((line) => `  ${line}`)
    .join("\n");
  return `#${message.id} ${clockTime(message.createdAt)} ${author}${tags}\n${body}`;
}

/**
 * Channels: the conversation a team's lead, its members and the user share.
 * Every message is stored; a session a message tags gets its full text, with
 * who wrote it and how to reply, through the provider's own inbox right
 * away, from whichever process posted it, so nothing waits on the desktop
 * app. When a member's turn ends its lead is handed its last message, at
 * most once a minute (`HANDBACK_INTERVAL_MS`).
 */
export class ChannelService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly teams: TeamService,
    private readonly agents: AgentService,
    private readonly transport: TeamTransport,
    private readonly now: () => Date = () => new Date(),
    activity?: ActivityService,
  ) {
    agents.onSessionRunning((session) => this.flushSession(session.id));
    activity?.onTurnEnd((session, end, text) =>
      this.handBack(session, end, text),
    );
  }

  /** A team's channel, made the first time it is needed. */
  channel(team: Team): Channel {
    return this.repositories.conversations.channel(
      team.id,
      team.lead.workspaceId,
      this.now().toISOString(),
    );
  }

  /** A team's channel name, without the `#`. */
  name(team: Team): string {
    return teamChannelName(team);
  }

  private conversation(team: Team): number {
    return this.channel(team).id;
  }

  /**
   * A reader that joins now: messages from before are history to read, not
   * to deliver, and tags from before were for someone else with its handle.
   */
  join(team: Team, handle: string): void {
    const conversationId = this.conversation(team);
    const joinedAfter =
      this.repositories.conversations.lastMessageId(conversationId);
    this.repositories.conversations.saveCursor({
      conversationId,
      participant: handle,
      readThrough: 0,
      taggedReadThrough: joinedAfter,
      deliveredThrough: joinedAfter,
      deliveredAt: null,
      lastError: null,
      lastAttemptAt: null,
    });
  }

  /**
   * The team whose channel is `#name` among `teams`. Refused when none or
   * more than one has that name.
   */
  named(name: string, teams: readonly Team[]): Team {
    const wanted = name.replace(/^#/, "").toLowerCase();
    const found = teams.filter((team) => teamChannelName(team) === wanted);
    if (found.length === 1) return found[0]!;
    throw new DaedalusError(
      found.length ? "VALIDATION" : "NOT_FOUND",
      found.length
        ? `${found.length} channels are #${wanted} (${found.map((team) => `--team ${team.lead.id}`).join(", ")}); pass --team <lead>`
        : `No channel #${wanted}${teams.length ? `; channels: ${teams.map((team) => `#${teamChannelName(team)}`).join(", ")}` : ""}`,
    );
  }

  /**
   * Who a post is from. A session in the team writes as its handle; any other
   * session is refused; no session, or `asUser`, is the user.
   */
  author(team: Team, caller: AgentSession | undefined, asUser = false): string {
    if (asUser || !caller) return USER_HANDLE;
    const place = this.teams
      .memberships(caller.id)
      .find((each) => each.team.id === team.id);
    if (place) return place.reader.handle;
    throw new DaedalusError(
      "CONFLICT",
      `'${caller.name}' is not in #${teamChannelName(team)}; only its lead and members can post, or pass --user to post as the user`,
    );
  }

  /**
   * Posts to the channel and pushes it to every tagged session. A tag that
   * names nobody is refused; a message that tags nobody is stored with a
   * warning, since nobody will be told.
   */
  async say(input: {
    team: string;
    author: string;
    body: string;
    /** Who Daedalus's own posts reach, instead of the tags in the body. */
    tags?: string[];
    kind?: MessageKind;
  }): Promise<ChannelSayResult> {
    const team = this.teams.get(input.team);
    const body = input.body.trim();
    if (!body) throw new DaedalusError("VALIDATION", "The message is empty");
    if (body.length > MAX_MESSAGE_TEXT)
      throw new DaedalusError(
        "VALIDATION",
        `A channel message holds at most ${MAX_MESSAGE_TEXT} characters; put longer text in a file and point to it`,
      );
    const readers = this.teams.readers(team);
    const handles = new Set(readers.map((reader) => reader.handle));
    // An archived member can be tagged: the message waits until it is
    // restored. `@all` means the sessions that are live now.
    const archived = new Set(
      this.teams
        .members(team.id)
        .flatMap((member) =>
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
        `No one in #${teamChannelName(team)} is called ${unknown.map((tag) => `@${tag}`).join(", ")}; tag ${[...handles, ...archived, ALL_TAG, USER_HANDLE].map((handle) => `@${handle}`).join(", ")}`,
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
        "The message tags no session, so nobody was notified; it waits in the channel",
      );
    const message = this.repositories.conversations.post(
      this.conversation(team),
      {
        author: input.author,
        body,
        tags: [...tags],
        createdAt: this.now().toISOString(),
        ...(input.kind ? { kind: input.kind } : {}),
      },
    );
    const deliveries = await this.flushTeam(team);
    return { message, warnings, deliveries };
  }

  /**
   * Tells a member's lead, in the channel, that the member needs the user or
   * stopped. Only the lead is tagged, and only with `wakeLead`; otherwise the
   * note tags nobody and waits for the lead's next read. Nothing for a lead
   * or a non-member, nor when the lead's own process made the change.
   * Never throws.
   */
  async noteMemberStatus(
    sessionId: string,
    status: string,
    options: { wakeLead?: boolean } = {},
  ): Promise<ChannelSayResult | undefined> {
    try {
      const membership = this.teams.memberOf(sessionId);
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
   * Whether the member already told its lead what its turn ended with: its
   * last message tagging the lead says what the turn's last reply says, and
   * nothing came between them from the lead or a hand-back. A question it
   * asked the lead mid-turn does not count.
   */
  private toldLeadSinceHandBack(
    team: Team,
    handle: string,
    said: string,
  ): boolean {
    const gist = (text: string) =>
      text
        .replace(/@[\w-]+/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    const final = gist(said);
    if (final.length < 12) return false;
    const recent = this.repositories.conversations.recentMessages(
      this.conversation(team),
      50,
    );
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      const message = recent[index]!;
      if (message.author === LEAD_HANDLE) return false;
      if (
        message.author === DAEDALUS_HANDLE &&
        (message.kind === "handback" || message.kind === "waiting") &&
        message.body.startsWith(`@${handle} `)
      )
        return false;
      if (
        message.author === handle &&
        message.kind === "message" &&
        message.tags.includes(LEAD_HANDLE)
      ) {
        const told = gist(message.body);
        const head = (text: string) => text.slice(0, 80);
        return told.includes(head(final)) || final.includes(head(told));
      }
    }
    return false;
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
      const membership = this.teams.memberOf(session.id);
      if (!membership) return this.teams.led(session.id) ? "reply" : undefined;
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
        // with the lead's next delivery instead of waking it for nothing. So
        // does a finish the member already told the lead about this turn:
        // its message woke the lead, and a second wake made the lead recap.
        kind:
          end === "waiting" ||
          (end === "finished" &&
            this.toldLeadSinceHandBack(membership.team, handle, said))
            ? "waiting"
            : "handback",
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
  async flushDue(): Promise<ChannelDeliveryResult[]> {
    const results: ChannelDeliveryResult[] = [];
    for (const team of this.teams.list()) {
      const channel = this.repositories.conversations.findChannel(team.id);
      if (!channel) continue;
      const cursor = this.repositories.conversations.cursor(
        channel.id,
        LEAD_HANDLE,
      );
      if (!this.handBackDue(cursor)) continue;
      const waiting = this.repositories.conversations
        .messages(channel.id, cursor.deliveredThrough)
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
  private handBackDue(cursor: Cursor): boolean {
    return (
      !cursor.deliveredAt ||
      this.now().getTime() - Date.parse(cursor.deliveredAt) >=
        HANDBACK_INTERVAL_MS
    );
  }

  /** Pushes whatever is waiting to every reader of the team's channel. */
  async flush(reference: string): Promise<ChannelDeliveryResult[]> {
    return this.flushTeam(this.teams.get(reference));
  }

  /**
   * Pushes what is waiting for one session, if it is in a team. Called from
   * its own hooks, so a member that was not running yet when a message was
   * posted gets it once it starts. Never throws.
   */
  async flushSession(
    sessionId: string,
  ): Promise<ChannelDeliveryResult | undefined> {
    try {
      let own: ChannelDeliveryResult | undefined;
      for (const place of this.teams.memberships(sessionId)) {
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

  private async flushTeam(team: Team): Promise<ChannelDeliveryResult[]> {
    const results: ChannelDeliveryResult[] = [];
    for (const reader of this.teams.readers(team)) {
      const result = await this.deliver(team, reader);
      if (result.messages) results.push(result);
    }
    return results;
  }

  /**
   * Brings one reader what tags it since its last delivery. The cursor moves
   * before the send, inside a write lock, so two processes never send the
   * same messages; a failed send moves it back and records why.
   */
  private async deliver(
    team: Team,
    reader: TeamReader,
  ): Promise<ChannelDeliveryResult> {
    const at = this.now().toISOString();
    const conversations = this.repositories.conversations;
    const conversationId = this.conversation(team);
    const claim = this.repositories.immediateTransaction(() => {
      const cursor = conversations.cursor(conversationId, reader.handle);
      const pending = conversations
        .messages(conversationId, cursor.deliveredThrough)
        .filter((message) => tagsReader(message, reader.handle));
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
        const held: Cursor = {
          ...cursor,
          lastError: `the team is paused; it gets the messages when '${team.name}' resumes`,
          lastAttemptAt: at,
        };
        conversations.saveCursor(held);
        return { cursor: held, pending, held: true };
      }
      if (
        reader.session.archivedAt ||
        (reader.session.status !== "running" &&
          reader.session.status !== "starting")
      ) {
        const waiting: Cursor = {
          ...cursor,
          lastError: `the session is ${reader.session.archivedAt ? "archived" : reader.session.status}; it gets the messages when it runs again`,
          lastAttemptAt: at,
        };
        conversations.saveCursor(waiting);
        return { cursor: waiting, pending, skipped: true };
      }
      conversations.saveCursor({
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
      conversations.saveCursor({
        ...conversations.cursor(conversationId, reader.handle),
        lastError: null,
        lastAttemptAt: at,
        deliveredAt: at,
      });
      // It has read them in full; `channel read --tagged` does not print
      // them again.
      if (complete)
        conversations.advance(conversationId, reader.handle, "tagged", claimed);
      return { ...base, delivered: true, error: null };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.repositories.immediateTransaction(() => {
        const current = conversations.cursor(conversationId, reader.handle);
        conversations.saveCursor({
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
   * The messages in full, oldest first: each under a `[channel #name]
   * author:` header with every body line indented, so no line of a body can
   * pass for a header (N-1), then how to reply. Past MAX_DELIVERY_TEXT the
   * oldest are left out and counted; `complete` is false then, and they stay
   * unread for `channel read --tagged`.
   */
  private deliveryText(
    team: Team,
    pending: Message[],
    reader: TeamReader,
  ): { text: string; complete: boolean } {
    const label = this.teams.authorLabels(team);
    const name = teamChannelName(team);
    // A session in two channels, a lead and its lead's member, names which.
    const which =
      this.teams.memberships(reader.session.id).length > 1 ? ` "#${name}"` : "";
    const blocks: string[] = [];
    let size = 0;
    let shown = 0;
    for (const message of [...pending].reverse()) {
      const body = splitLines(message.body)
        .map((line) => (line ? `  ${line}` : ""))
        .join("\n");
      const block = `[channel #${name}] ${label(message.author)}:\n${body}`;
      if (shown && size + block.length > MAX_DELIVERY_TEXT) break;
      blocks.unshift(block);
      size += block.length;
      shown += 1;
    }
    const left = pending.length - shown;
    if (left)
      blocks.unshift(
        `[channel #${name}] ${left} earlier ${left === 1 ? "message is" : "messages are"} not shown here; read ${left === 1 ? "it" : "them"} with: daedal channel read${which} --tagged`,
      );
    const handles = new Set(
      this.teams.readers(team).map((each) => each.handle),
    );
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
      ? `Reply with: daedal channel say${which} "${[...replyTo].map((handle) => `@${handle}`).join(" ")} ..."`
      : `Read the whole channel with: daedal channel read${which}`;
    return { text: [...blocks, hint].join("\n\n"), complete: left === 0 };
  }

  private deliveryFrom(team: Team, pending: Message[]): string {
    const authors = [...new Set(pending.map((message) => message.author))];
    return authors.length === 1
      ? `[channel #${teamChannelName(team)}] ${this.teams.authorLabels(team)(authors[0]!)}`
      : `[channel #${teamChannelName(team)}]`;
  }

  /**
   * What a reader has not read yet, oldest first, and moves its read marker
   * to the newest message. `all` shows the newest messages whatever was read.
   * `tagged` shows only unread messages that tag the reader and moves only
   * their marker, so the rest of the channel stays unread for a full read.
   */
  read(
    reference: string,
    reader: string,
    options: { all?: boolean; tagged?: boolean; limit?: number } = {},
  ): {
    team: Team;
    messages: Message[];
    skipped: number;
    /** For `tagged`: unread messages that do not tag the reader. */
    others?: number;
  } {
    const team = this.teams.get(reference);
    const conversations = this.repositories.conversations;
    const conversationId = this.conversation(team);
    const limit = Math.max(1, options.limit ?? READ_LIMIT);
    const cursor = conversations.cursor(conversationId, reader);
    if (options.tagged) {
      const after = conversations.messages(conversationId, cursor.readThrough);
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
        conversations.advance(conversationId, reader, "tagged", last.id);
      return {
        team,
        messages,
        skipped: unread.length - messages.length,
        others,
      };
    }
    // A tagged message read with --tagged is not printed again.
    const unread = options.all
      ? conversations.recentMessages(conversationId, limit)
      : conversations
          .messages(conversationId, cursor.readThrough)
          .filter(
            (message) =>
              message.id > cursor.taggedReadThrough ||
              !tagsReader(message, reader),
          );
    const messages = unread.slice(-limit);
    const last = conversations.lastMessageId(conversationId);
    if (last > cursor.readThrough)
      conversations.advance(conversationId, reader, "read", last);
    return {
      team,
      messages,
      skipped: options.all ? 0 : unread.length - messages.length,
    };
  }

  /**
   * Messages in these teams' channels that match `query`, best first, from
   * the last `since` (14 days when left out). Matching is on parts of words.
   */
  find(
    query: string,
    teams: readonly Team[],
    options: { since?: string; limit?: number } = {},
  ): ChannelFindHit[] {
    if (query.trim().length < 3)
      throw new DaedalusError(
        "VALIDATION",
        "Search for at least one word of three letters or more",
      );
    const byConversation = new Map<number, Team>();
    for (const team of teams) {
      const channel = this.repositories.conversations.findChannel(team.id);
      if (channel) byConversation.set(channel.id, team);
    }
    if (!byConversation.size) return [];
    const since =
      options.since ??
      new Date(this.now().getTime() - FIND_SINCE_MS).toISOString();
    const limit = options.limit ?? FIND_LIMIT;
    return this.repositories.conversations
      .search(query, {
        kind: "channel",
        conversationIds: [...byConversation.keys()],
        since,
        limit,
      })
      .flatMap((hit) => {
        const team = byConversation.get(hit.message.conversationId);
        return team ? [{ team, message: hit.message }] : [];
      });
  }

  /** How many messages in a team's channel this participant has not read. */
  unread(team: Team, participant: string): number {
    const conversationId = this.conversation(team);
    const cursor = this.repositories.conversations.cursor(
      conversationId,
      participant,
    );
    return countUnread(
      this.repositories.conversations.messages(
        conversationId,
        cursor.readThrough,
      ),
      cursor,
    );
  }

  /** The lead and members, with what each has not read or been sent. */
  status(reference: string): {
    team: Team;
    members: ChannelMemberStatus[];
  } {
    const team = this.teams.get(reference);
    const conversationId = this.conversation(team);
    const messages = this.repositories.conversations.messages(conversationId);
    const members = [
      ...this.teams.readers(team),
      ...this.teams
        .members(team.id)
        .filter((member) => member.archivedAt && member.teamHandle)
        .map((member) => ({
          handle: member.teamHandle!,
          session: member,
          role: "member" as const,
        })),
    ].map((reader) => {
      const cursor = this.repositories.conversations.cursor(
        conversationId,
        reader.handle,
      );
      return {
        ...reader,
        unread: countUnread(messages, cursor),
        undelivered: messages.filter(
          (message) =>
            message.id > cursor.deliveredThrough &&
            tagsReader(message, reader.handle),
        ).length,
        lastError: cursor.lastError,
        lastAttemptAt: cursor.lastAttemptAt,
      };
    });
    return { team, members };
  }
}

/**
 * Messages after the read marker that the reader did not write, leaving out
 * tagged ones it read with `--tagged`.
 */
function countUnread(messages: readonly Message[], cursor: Cursor): number {
  const reader = cursor.participant;
  return messages.filter(
    (message) =>
      message.id > cursor.readThrough &&
      message.author !== reader &&
      !(message.id <= cursor.taggedReadThrough && tagsReader(message, reader)),
  ).length;
}

/** Text cut to `limit` characters, saying that it was. */
function clip(text: string, limit: number): string {
  return text.length > limit
    ? `${text.slice(0, limit).trimEnd()}… (cut; the rest is in its session)`
    : text;
}
