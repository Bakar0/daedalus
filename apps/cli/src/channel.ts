import {
  DaedalusError,
  FIND_SINCE_MS,
  LEAD_HANDLE,
  USER_HANDLE,
  channelMessageText,
  teamChannelName,
  type AgentSession,
  type ApplicationContext,
  type ChannelDeliveryResult,
  type ChannelSayResult,
  type Team,
} from "@daedalus/core";
import { callerSession } from "./caller";
import { parseArguments, printResult } from "./arguments";

export const channelHelp = `Channel commands:
  daedal channel say ["#<name>"] "<text>" [--team <lead>] [--user]
  daedal channel read ["#<name>"] [--tagged | --all] [--limit <n>] [--team <lead>] [--user]
  daedal channel find "<words>" [--since <time>] [--team <lead>] [--user]
  daedal channel list [--user]

A channel is where a team talks: its lead, its members and the user. Each
team has one, named after its lead's session ("#checkout-api"). Write the
name in quotes, since an unquoted # starts a comment in the shell. Inside a
session the name can be left out: it is the team's channel the session is in.
A session that leads a team and is a member of another is in two channels,
and 'channel say' then needs the name. Outside a session the post is from the
user, and the name is needed when there is more than one team; --user posts
as the user from inside a session's folder. --team <lead> picks a channel by
its lead when two teams share a name.

Tags decide who is told: @<handle> sends that member's session the message in
full, with who wrote it and how to reply, @lead the lead's, @all everyone's.
A message that tags nobody is stored and only read with 'channel read'. When a
member's turn ends, its lead is handed the member's last message ("@server
finished: ..."), at most once a minute, so members do not post "done". Claude
sessions get messages through their Daedalus inbox, which wakes an idle
session at once and a busy one when its turn ends, with every message in one
wake; Codex sessions through 'codex queue'. Nothing reaches the input box, so
the user's draft is never sent with it. A session that is not running, or a
send that fails, is tried again on the next post in the channel, on 'channel
read' and 'team list', and when the session starts or ends a turn. 'team
list' shows the last failure. Messages Daedalus brings start with
[channel #<name>].

'channel read' prints what the reader has not read yet and marks it read;
--all prints the newest messages whatever was read; --tagged prints only
unread messages that tag the reader and leaves the rest unread. Without a
name it reads every channel the session is in.

'channel find' searches the messages of the channels you are in (every
channel for the user) for any of the words, parts of words included, best
match first. --since limits it to messages newer than a time: 14d (the
default), 12h, 2w, or a date such as 2026-11-01.

'channel list' lists the channels you are in, with what you have not read.`;

/** `14d`, `12h`, `2w`, `30m` or a date: the ISO time that far back. */
export function sinceTime(value: string | undefined, now = new Date()): string {
  if (value === undefined)
    return new Date(now.getTime() - FIND_SINCE_MS).toISOString();
  const span = /^(\d+)\s*([mhdw])$/i.exec(value.trim());
  if (span) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[
      span[2]!.toLowerCase() as "m" | "h" | "d" | "w"
    ];
    return new Date(now.getTime() - Number(span[1]) * unit).toISOString();
  }
  const time = Date.parse(value);
  if (Number.isNaN(time))
    throw new DaedalusError(
      "VALIDATION",
      `--since takes a span such as 14d, 12h or 2w, or a date; not '${value}'`,
    );
  return new Date(time).toISOString();
}

/** The teams whose channels this caller is in: every team for the user. */
function channelsOf(
  context: ApplicationContext,
  caller: AgentSession | undefined,
): Team[] {
  return caller
    ? context.teams.memberships(caller.id).map((place) => place.team)
    : context.teams.list();
}

/**
 * The channel a command is about: `--team <lead>`, else `#name` among the
 * caller's channels, else the caller's only channel.
 */
function channelFor(
  context: ApplicationContext,
  options: { team?: string; name?: string },
  caller: AgentSession | undefined,
): Team {
  if (options.team !== undefined)
    return context.teams.get(context.agents.resolve(options.team).id);
  const teams = channelsOf(context, caller);
  if (options.name !== undefined)
    // A session names one of its own channels; the user, any.
    return context.channels.named(options.name, teams);
  if (teams.length === 1) return teams[0]!;
  const names = teams.map((team) => `"#${teamChannelName(team)}"`).join(", ");
  throw new DaedalusError(
    "VALIDATION",
    !teams.length
      ? caller
        ? `'${caller.name}' is in no team, so it has no channel; name one: ${context.teams
            .list()
            .map((team) => `"#${teamChannelName(team)}"`)
            .join(", ")}`
        : "There is no team, so there is no channel; 'daedal agent spawn --team <session>' makes one"
      : `${caller ? `'${caller.name}' is` : "You are"} in ${teams.length} channels; name one: ${names}`,
  );
}

/** The leading `#name` of a command's words, and the words after it. */
function takeName(positionals: string[]): {
  name?: string;
  rest: string[];
} {
  const first = positionals[0];
  return first?.startsWith("#") && /^#[a-z0-9-]+$/i.test(first)
    ? { name: first, rest: positionals.slice(1) }
    : { rest: positionals };
}

/** Whose read marker a read moves: the caller's handle in that channel. */
function readerHandle(
  context: ApplicationContext,
  team: Team,
  caller: AgentSession | undefined,
): string {
  if (!caller) return USER_HANDLE;
  const place = context.teams
    .memberships(caller.id)
    .find((each) => each.team.id === team.id);
  return place?.reader.handle ?? USER_HANDLE;
}

const teamSummary = (context: ApplicationContext, team: Team) => ({
  channel: teamChannelName(team),
  teamId: team.id,
  name: team.name,
  leadId: team.lead.id,
  paused: team.paused,
  goal: team.goal,
});

/** One delivery of a post, as a line under it. */
export const deliveryLine = (delivery: ChannelDeliveryResult) =>
  delivery.delivered
    ? `  @${delivery.handle}: delivered`
    : `  @${delivery.handle}: not delivered yet (${delivery.error ?? "unknown"})`;

/** What a post prints: where it went, who got it, and any warning. */
export function printSay(
  team: Team,
  result: ChannelSayResult,
  json: boolean,
): void {
  printResult(result, json, () => {
    console.log(`Posted #${result.message.id} to #${teamChannelName(team)}`);
    for (const delivery of result.deliveries)
      console.log(deliveryLine(delivery));
    for (const warning of result.warnings) console.log(`Warning: ${warning}`);
  });
}

/** One channel read for a reader: what to print, and the JSON. */
function readOne(
  context: ApplicationContext,
  team: Team,
  reader: string,
  options: { all?: boolean; tagged?: boolean; limit?: number },
): { team: Team; data: unknown; print: (tagged: boolean) => void } {
  const result = context.channels.read(team.id, reader, options);
  const label = context.teams.authorLabels(team);
  const messages = result.messages.map((message) => ({
    ...message,
    from: label(message.author),
  }));
  const name = teamChannelName(team);
  return {
    team,
    data: { ...result, team: teamSummary(context, team), messages },
    print: (tagged) => {
      if (result.skipped)
        console.log(
          `(${result.skipped} older unread messages not shown; use --limit)`,
        );
      if (!result.messages.length)
        console.log(
          tagged
            ? `Nothing new for you in #${name}.`
            : `Nothing new in #${name}.`,
        );
      for (const message of messages)
        console.log(channelMessageText(message, message.from));
      if (result.others)
        console.log(
          `(${result.others} other unread ${result.others === 1 ? "message" : "messages"} in #${name}; 'daedal channel read "#${name}"' reads ${result.others === 1 ? "it" : "them"}.)`,
        );
    },
  };
}

export async function channelCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
): Promise<number> {
  const action = args.shift();
  if (!action || action === "help") {
    console.log(channelHelp);
    return 0;
  }
  if (!["say", "read", "find", "list"].includes(action))
    throw new DaedalusError(
      "VALIDATION",
      `Unknown channel command '${action}'; run 'daedal channel --help'`,
    );
  const parsed = parseArguments(
    args,
    ["team", "limit", "since"],
    ["user", "all", "tagged"],
  );
  const asUser = parsed.flags.has("user");
  const caller = asUser ? undefined : await callerSession(context);
  const team = parsed.values.team;

  if (action === "say") {
    const { name, rest } = takeName(parsed.positionals);
    const body = rest.join(" ");
    if (!body.trim())
      throw new DaedalusError(
        "VALIDATION",
        `Usage: daedal channel say ["#<name>"] "<text>" [--team <lead>] [--user]`,
      );
    const target = channelFor(
      context,
      {
        ...(team !== undefined ? { team } : {}),
        ...(name !== undefined ? { name } : {}),
      },
      caller,
    );
    const result = await context.channels.say({
      team: target.id,
      author: context.channels.author(target, caller),
      body,
    });
    printSay(target, result, json);
    return 0;
  }

  if (action === "read") {
    const { name, rest } = takeName(parsed.positionals);
    if (rest.length)
      throw new DaedalusError(
        "VALIDATION",
        `Usage: daedal channel read ["#<name>"] [--tagged | --all] [--limit <n>] [--team <lead>] [--user]`,
      );
    if (parsed.flags.has("all") && parsed.flags.has("tagged"))
      throw new DaedalusError(
        "VALIDATION",
        "--all and --tagged do not go together",
      );
    const limit =
      parsed.values.limit === undefined
        ? undefined
        : Number(parsed.values.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
      throw new DaedalusError(
        "VALIDATION",
        "--limit takes a whole number of messages",
      );
    // A lead that is also a member reads both of its channels.
    const own =
      team === undefined && name === undefined && caller
        ? channelsOf(context, caller)
        : [];
    const reads =
      own.length > 1
        ? own
        : [
            channelFor(
              context,
              {
                ...(team !== undefined ? { team } : {}),
                ...(name !== undefined ? { name } : {}),
              },
              caller,
            ),
          ];
    const results: ReturnType<typeof readOne>[] = [];
    for (const each of reads) {
      await context.channels.flush(each.id);
      results.push(
        readOne(context, each, readerHandle(context, each, caller), {
          ...(parsed.flags.has("all") ? { all: true } : {}),
          ...(parsed.flags.has("tagged") ? { tagged: true } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      );
    }
    if (results.length > 1) {
      printResult({ channels: results.map((each) => each.data) }, json, () => {
        for (const each of results) {
          console.log(`== #${teamChannelName(each.team)}`);
          each.print(parsed.flags.has("tagged"));
        }
      });
      return 0;
    }
    printResult(results[0]!.data, json, () =>
      results[0]!.print(parsed.flags.has("tagged")),
    );
    return 0;
  }

  if (action === "find") {
    const query = parsed.positionals.join(" ");
    if (!query.trim())
      throw new DaedalusError(
        "VALIDATION",
        `Usage: daedal channel find "<words>" [--since <time>] [--team <lead>] [--user]`,
      );
    const teams =
      team !== undefined
        ? [channelFor(context, { team }, caller)]
        : channelsOf(context, caller);
    const hits = context.channels.find(query, teams, {
      since: sinceTime(parsed.values.since),
    });
    printResult(
      {
        hits: hits.map((hit) => ({
          channel: teamChannelName(hit.team),
          teamId: hit.team.id,
          message: hit.message,
        })),
      },
      json,
      () => {
        if (!hits.length) console.log(`No message matches '${query}'.`);
        for (const hit of hits) {
          const label = context.teams.authorLabels(hit.team);
          console.log(
            `#${teamChannelName(hit.team)} ${channelMessageText(hit.message, label(hit.message.author))}`,
          );
        }
      },
    );
    return 0;
  }

  // list
  if (parsed.positionals.length)
    throw new DaedalusError(
      "VALIDATION",
      "Usage: daedal channel list [--user]",
    );
  const rows = channelsOf(context, caller).map((each) => {
    const reader = readerHandle(context, each, caller);
    const { members } = context.channels.status(each.id);
    const unread = context.channels.unread(each, reader);
    return {
      ...teamSummary(context, each),
      as: reader,
      members: members.filter(
        (member) => member.role === "member" && !member.session.archivedAt,
      ).length,
      unread,
    };
  });
  printResult({ channels: rows }, json, () => {
    if (!rows.length)
      console.log(
        caller
          ? `'${caller.name}' is in no team, so it is in no channel.`
          : "There is no team, so there is no channel.",
      );
    for (const row of rows)
      console.log(
        [
          `#${row.channel}`,
          `lead '${row.name}' ${row.leadId}`,
          `${row.members} ${row.members === 1 ? "member" : "members"}`,
          `${row.unread} unread`,
          row.as === LEAD_HANDLE || row.as === USER_HANDLE
            ? ""
            : `you are @${row.as}`,
          row.paused ? "paused" : "",
        ]
          .filter(Boolean)
          .join("\t"),
      );
  });
  return 0;
}
