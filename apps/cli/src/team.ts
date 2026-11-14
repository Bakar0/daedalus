import {
  DaedalusError,
  LEAD_HANDLE,
  TEAM_MAX_DEPTH,
  TEAM_MAX_MEMBERS,
  USER_HANDLE,
  parseTags,
  teamChatText,
  type AgentSession,
  type ApplicationContext,
  type Team,
  type TeamDeliveryResult,
  type TeamMessage,
  type TeamSayResult,
  type TeamTreeNode,
} from "@daedalus/core";
import { callerSession } from "./caller";
import { parseArguments, printResult } from "./arguments";

export const teamHelp = `Team commands:
  daedal team say "<text>" [--team <lead>] [--user]
  daedal team chat [--tagged | --all] [--limit <n>] [--team <lead>] [--user]
  daedal team list [--team <lead>]
  daedal team tree [--team <lead>]
  daedal team goal [<text>] [--team <lead>]
  daedal team pause|resume [--team <lead>]
  daedal agent spawn --team [<lead>] [--message <instructions>] [--name <name>]
      [--workspace <workspace>] [--task <task-ref>] [--provider claude|codex]
      [--model <model>] [--account <account>]

A team is a lead and the members it or the user adds. Any Claude or Codex
session on this Mac can lead: the first 'agent spawn --team' run inside a
session makes it a lead, and '--team <session>' from the user makes that
session one. The team is named after the lead's session. Ending a team
(the lead's "End team", or 'daedal session revoke <lead> orchestration')
leaves its members running as plain sessions.

'agent spawn --team' with no value, run inside a session, adds a member to
the team that session leads, and needs --message. '--team <lead>' adds one to
that lead's team for the user, who may leave out --message and instruct the
member in its own session; the lead is told in the chat either way.
Members start in the lead's workspace unless --workspace names another, on
the lead's provider unless --provider picks the other one. A team can mix
Claude and Codex, with either as the lead. Each member has a handle, made
from --name or the task's title, that the chat uses.

Teams nest: a member can lead a team of its own. A session is a member of
at most one team and leads at most one. A tree goes at most ${TEAM_MAX_DEPTH} levels
below its top lead, and a lead has at most ${TEAM_MAX_MEMBERS} members that are not
archived; past either, the spawn is refused and says where to add instead.
'team tree' prints the whole tree the team is in, or every tree.

Everyone in the team, and the user, posts to one chat. Tags decide who is
told: @<handle> sends that member's session a one-line notice saying who
wrote and to run 'team chat --tagged', @lead the lead's, @all everyone's.
A message that tags nobody is stored and only read with 'team chat'. Claude
sessions get the notice through their Daedalus inbox, which wakes an idle
session at once and a busy one when its turn ends, with every notice in one wake;
Codex sessions through 'codex queue'. Nothing reaches the input box, so the
user's draft is never sent with it. A session that is not running, or a send
that fails, is tried again on the next post in the team, on 'team chat' and
'team list', and when the session starts or ends a turn. 'team list' shows
the last failure.

Inside the lead or a member, --team defaults to its own team, and posts are
signed with its handle. A session that leads a team and is a member of
another posts to its own lead when the message tags @lead, and to its own
team otherwise; 'team chat' reads both. Outside a session the post is from
the user, and --team is needed when there is more than one team. --user posts
as the user from inside a session's folder.

'team chat' prints what the reader has not read yet and marks it read; --all
prints the newest messages whatever was read; --tagged prints only unread
messages that tag the reader and leaves the rest unread. 'team goal' sets the shared
goal that members are told at launch.

'team pause' holds every message to the team's members and refuses new
members, for the teams its members lead too; 'team resume' sends what waited.
Archiving a lead pauses its team the same way, and archives the members below
it; stopping a lead stops them. Restoring the lead resumes its team.`;

/**
 * The team a command is about: --team, else the caller's own. A caller in
 * two teams, a lead that is also a member, posts to its own lead's team
 * when the message tags @lead, and to the team it leads otherwise.
 */
async function teamFor(
  context: ApplicationContext,
  values: Record<string, string>,
  caller: AgentSession | undefined,
  body?: string,
): Promise<Team> {
  if (values.team !== undefined) {
    const lead = context.agents.resolve(values.team);
    return context.teams.get(lead.id);
  }
  if (caller) {
    const places = context.teams.memberships(caller.id);
    const upward =
      body !== undefined && parseTags(body).includes(LEAD_HANDLE)
        ? places.find((place) => place.reader.role === "member")
        : undefined;
    const place = upward ?? places[0];
    if (place) return place.team;
  }
  const teams = context.teams.list();
  if (teams.length === 1) return teams[0]!;
  throw new DaedalusError(
    "VALIDATION",
    teams.length
      ? `There are ${teams.length} teams (${teams.map((team) => `'${team.name}' ${team.lead.id}`).join(", ")}); pass --team <lead>`
      : "There is no team; 'daedal agent spawn --team <session>' makes one",
  );
}

/** Whose read marker `team chat` moves. */
function readerHandle(
  context: ApplicationContext,
  team: Team,
  caller: AgentSession | undefined,
  asUser: boolean,
): string {
  if (asUser || !caller) return USER_HANDLE;
  const place = context.teams
    .memberships(caller.id)
    .find((each) => each.team.id === team.id);
  return place?.reader.handle ?? USER_HANDLE;
}

/** One team's chat read for a reader: what to print, and the JSON. */
function chatRead(
  context: ApplicationContext,
  team: Team,
  reader: string,
  options: { all?: boolean; tagged?: boolean; limit?: number },
): { team: Team; data: unknown; print: (tagged: boolean) => void } {
  const result = context.teams.chat(team.id, reader, options);
  const label = context.teams.authorLabels(team);
  const messages = result.messages.map((message) => ({
    ...message,
    from: label(message.author),
  }));
  return {
    team,
    data: { ...result, messages, team: teamSummary(team) },
    print: (tagged) => {
      if (result.skipped)
        console.log(
          `(${result.skipped} older unread messages not shown; use --limit)`,
        );
      if (!result.messages.length)
        console.log(
          tagged
            ? `Nothing new for you in the team '${team.name}'.`
            : `Nothing new in the team '${team.name}'.`,
        );
      for (const message of messages)
        console.log(teamChatText(message, message.from));
      if (result.others)
        console.log(
          `(${result.others} other unread ${result.others === 1 ? "message" : "messages"} in the chat; 'daedal team chat' reads ${result.others === 1 ? "it" : "them"}.)`,
        );
    },
  };
}

/** `team tree`: the tree the team is in, or every tree. */
function printTree(
  context: ApplicationContext,
  parsed: { values: Record<string, string>; positionals: string[] },
  caller: AgentSession | undefined,
  json: boolean,
): number {
  if (parsed.positionals.length)
    throw new DaedalusError(
      "VALIDATION",
      "Usage: daedal team tree [--team <lead>]",
    );
  const from =
    parsed.values.team !== undefined
      ? context.agents.resolve(parsed.values.team).id
      : caller && context.teams.memberships(caller.id).length
        ? caller.id
        : undefined;
  const trees = context.teams.tree(from);
  const node = (item: TeamTreeNode): unknown => ({
    sessionId: item.session.id,
    name: item.session.name,
    handle: item.handle,
    status: item.session.archivedAt ? "archived" : item.session.status,
    workspaceId: item.session.workspaceId,
    team: item.team ? teamSummary(item.team) : null,
    members: item.members.map(node),
  });
  printResult({ trees: trees.map(node) }, json, () => {
    if (!trees.length) console.log("There is no team.");
    const print = (item: TeamTreeNode, depth: number) => {
      const workspace =
        depth > 0
          ? context.repositories.findWorkspace(item.session.workspaceId)
          : undefined;
      console.log(
        [
          `${"  ".repeat(depth)}${item.handle ? `@${item.handle}` : "lead"}`,
          item.session.id,
          item.session.archivedAt ? "archived" : item.session.status,
          context.activity.get(item.session.id)?.activity ?? "unknown",
          item.session.name,
          item.team?.paused ? "team paused" : "",
          workspace &&
          item.session.workspaceId !== trees[0]?.session.workspaceId
            ? `in ${workspace.name}`
            : "",
        ]
          .filter(Boolean)
          .join("\t"),
      );
      for (const member of item.members) print(member, depth + 1);
    };
    for (const tree of trees) print(tree, 0);
  });
  return 0;
}

const deliveryText = (delivery: TeamDeliveryResult) =>
  delivery.delivered
    ? `  @${delivery.handle}: delivered`
    : `  @${delivery.handle}: not delivered yet (${delivery.error ?? "unknown"})`;

export function printSay(
  team: Team,
  result: TeamSayResult,
  json: boolean,
): void {
  printResult(result, json, () => {
    console.log(`Posted #${result.message.id} to the team '${team.name}'`);
    for (const delivery of result.deliveries)
      console.log(deliveryText(delivery));
    for (const warning of result.warnings) console.log(`Warning: ${warning}`);
  });
}

export async function teamCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
): Promise<number> {
  const action = args.shift();
  if (!action || action === "help") {
    console.log(teamHelp);
    return 0;
  }
  if (
    !["say", "chat", "list", "tree", "goal", "pause", "resume"].includes(action)
  )
    throw new DaedalusError("VALIDATION", `Unknown team command '${action}'`);
  const parsed = parseArguments(
    args,
    ["team", "limit"],
    ["user", "all", "tagged"],
  );
  const asUser = parsed.flags.has("user");
  const caller = await callerSession(context);
  if (action === "tree") return printTree(context, parsed, caller, json);
  const body = parsed.positionals.join(" ");
  const team = await teamFor(
    context,
    parsed.values,
    caller,
    action === "say" ? body : undefined,
  );

  if (action === "say") {
    if (!body.trim())
      throw new DaedalusError(
        "VALIDATION",
        `Usage: daedal team say "<text>" [--team <lead>] [--user]`,
      );
    const result = await context.teams.say({
      team: team.id,
      author: context.teams.author(team, caller, asUser),
      body,
    });
    printSay(team, result, json);
    return 0;
  }
  if (action === "chat") {
    if (parsed.positionals.length)
      throw new DaedalusError(
        "VALIDATION",
        "Usage: daedal team chat [--tagged | --all] [--limit <n>] [--team <lead>]",
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
    // A lead that is also a member reads both of its teams.
    const teams =
      parsed.values.team === undefined && caller && !asUser
        ? context.teams.memberships(caller.id).map((place) => place.team)
        : [];
    const reads = teams.length > 1 ? teams : [team];
    const results: ReturnType<typeof chatRead>[] = [];
    for (const each of reads) {
      await context.teams.flush(each.id);
      results.push(
        chatRead(context, each, readerHandle(context, each, caller, asUser), {
          ...(parsed.flags.has("all") ? { all: true } : {}),
          ...(parsed.flags.has("tagged") ? { tagged: true } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      );
    }
    if (results.length > 1) {
      printResult({ teams: results.map((each) => each.data) }, json, () => {
        for (const each of results) {
          console.log(
            `== Team '${each.team.name}' (--team ${each.team.lead.id})`,
          );
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
  if (action === "list") {
    if (parsed.positionals.length)
      throw new DaedalusError(
        "VALIDATION",
        "Usage: daedal team list [--team <lead>]",
      );
    await context.teams.flush(team.id);
    const { members } = context.teams.status(team.id);
    const rows = members.map((member) => ({
      handle: member.handle,
      role: member.role,
      sessionId: member.session.id,
      name: member.session.name,
      provider: member.session.provider,
      status: member.session.archivedAt ? "archived" : member.session.status,
      activity: context.activity.get(member.session.id)?.activity ?? "unknown",
      taskId: member.session.taskId,
      workspaceId: member.session.workspaceId,
      // A member that leads a team of its own, and how many it has.
      leads:
        member.role === "member"
          ? (context.teams.led(member.session.id)?.id ?? null)
          : null,
      unread: member.unread,
      undelivered: member.undelivered,
      lastError: member.lastError,
      lastAttemptAt: member.lastAttemptAt,
    }));
    printResult({ team: teamSummary(team), members: rows }, json, () => {
      console.log(
        `Team '${team.name}'${team.paused ? " (paused)" : ""}${team.goal ? `: ${team.goal}` : ""}`,
      );
      for (const row of rows)
        console.log(
          [
            `@${row.handle}`,
            row.sessionId,
            row.status,
            row.activity,
            row.name,
            row.workspaceId !== team.lead.workspaceId
              ? `in ${context.repositories.findWorkspace(row.workspaceId)?.name ?? row.workspaceId}`
              : "",
            row.leads
              ? `leads ${context.teams.members(row.leads).filter((each) => !each.archivedAt).length} (team tree)`
              : "",
            `${row.unread} unread`,
            row.undelivered
              ? `${row.undelivered} not delivered: ${row.lastError ?? "waiting"}`
              : "",
          ]
            .filter(Boolean)
            .join("\t"),
        );
    });
    return 0;
  }
  if (action === "pause" || action === "resume") {
    if (parsed.positionals.length)
      throw new DaedalusError(
        "VALIDATION",
        `Usage: daedal team ${action} [--team <lead>]`,
      );
    const teams = await context.teams.setPaused(team.id, action === "pause");
    printResult({ teams: teams.map(teamSummary) }, json, () =>
      console.log(
        `${action === "pause" ? "Paused" : "Resumed"} ${teams.map((each) => `'${each.name}'`).join(", ")}`,
      ),
    );
    return 0;
  }
  if (action === "goal") {
    const text = parsed.positionals.join(" ");
    const updated = text.trim() ? context.teams.setGoal(team.id, text) : team;
    printResult({ team: teamSummary(updated) }, json, () =>
      console.log(updated.goal ?? "The team has no goal yet."),
    );
    return 0;
  }
  throw new DaedalusError("VALIDATION", `Unknown team command '${action}'`);
}

const teamSummary = (team: Team) => ({
  id: team.id,
  name: team.name,
  goal: team.goal,
  paused: team.paused,
  leadId: team.lead.id,
});

/**
 * `agent spawn --team [<lead>]`. `--team` with no value is the caller's own
 * team, which the caller must lead; the shared parser wants a value, so it is
 * taken out first.
 */
export function takeTeamOption(args: string[]): {
  rest: string[];
  team: { lead?: string } | undefined;
} {
  const index = args.indexOf("--team");
  if (index < 0) return { rest: args, team: undefined };
  const next = args[index + 1];
  const bare = next === undefined || next.startsWith("--");
  const rest = [...args];
  rest.splice(index, bare ? 1 : 2);
  if (rest.includes("--team"))
    throw new DaedalusError(
      "VALIDATION",
      "Option '--team' was provided more than once",
    );
  return { rest, team: bare ? {} : { lead: next } };
}

/** Adds a member, for the lead or for the user. */
export async function spawnTeamMember(
  context: ApplicationContext,
  input: {
    lead?: string;
    asUser: boolean;
    values: Record<string, string>;
    flags: Set<string>;
    resolveTask: (reference: string, workspace: string) => Promise<string>;
  },
  json: boolean,
): Promise<number> {
  for (const option of ["command", "ability", "color"])
    if (input.values[option] !== undefined)
      throw new DaedalusError(
        "VALIDATION",
        `--${option} cannot be used with --team`,
      );
  for (const flag of ["refine", "pin"])
    if (input.flags.has(flag))
      throw new DaedalusError(
        "VALIDATION",
        `--${flag} cannot be used with --team`,
      );
  const caller = await callerSession(context);
  // The session whose team gets the member: with no lead, the caller, which
  // becomes a lead if it is not one yet.
  let leadId: string;
  if (input.lead === undefined) {
    if (!caller || input.asUser)
      throw new DaedalusError(
        "VALIDATION",
        "'--team' without a lead works only inside a session, which then leads the team; pass --team <lead>",
      );
    leadId = caller.id;
  } else {
    leadId = context.agents.resolve(input.lead).id;
  }
  const byLead = Boolean(caller && !input.asUser);
  if (byLead && caller!.id !== leadId) {
    const name = context.repositories.findAgent(leadId)?.name ?? leadId;
    const place = context.teams.memberOf(caller!.id);
    throw new DaedalusError(
      "CONFLICT",
      place?.team.lead.id === leadId
        ? `@${place.reader.handle} is a member of '${place.team.name}'; ask @${LEAD_HANDLE} to add a member, or add one to a team of your own with 'agent spawn --team' and no lead`
        : `'${caller!.name}' is not the lead of '${name}'; only its lead or the user adds members (--user, from a session's folder), or run 'agent spawn --team' with no lead to lead a team of your own`,
    );
  }
  const instructions = input.values.message;
  if (byLead && !instructions?.trim())
    throw new DaedalusError(
      "VALIDATION",
      "A member the lead adds needs instructions: pass --message <text>",
    );
  const lead = await context.agents.get(leadId);
  const workspace = input.values.workspace
    ? (await context.workspaces.getActive(input.values.workspace)).id
    : lead.workspaceId;
  const taskId = input.values.task
    ? await input.resolveTask(input.values.task, workspace)
    : undefined;
  const spawn = (message: string | undefined) =>
    context.teams.spawnMember({
      team: leadId,
      addedBy: byLead ? "lead" : "user",
      ...(workspace !== lead.workspaceId ? { workspace } : {}),
      ...(message ? { instructions: message } : {}),
      ...(input.values.name ? { name: input.values.name } : {}),
      ...(taskId ? { taskId } : {}),
      ...(input.values.provider ? { provider: input.values.provider } : {}),
      ...(input.values.model ? { model: input.values.model } : {}),
      ...(input.values.account !== undefined
        ? { account: input.values.account }
        : {}),
    });
  // A member can start in a workflow like any session.
  let spawned: Awaited<ReturnType<typeof spawn>> | undefined;
  const workflow = input.values.workflow;
  if (workflow)
    await context.workflows.spawnWith({
      workflow,
      ...(instructions ? { message: instructions } : {}),
      spawn: async (message) => (spawned = await spawn(message)).session,
    });
  else spawned = await spawn(instructions);
  if (!spawned) throw new DaedalusError("INTERNAL", "The member did not start");
  const result = spawned;
  const team = context.teams.get(leadId);
  printResult(
    {
      ...result.session,
      teamHandle: result.handle,
      note: result.note ?? null,
    },
    json,
    () => {
      console.log(
        `Spawned ${result.session.name} (${result.session.provider}) as @${result.handle} in the team '${team.name}'`,
      );
      if (result.created)
        console.log(
          `'${team.name}' leads the team now; 'daedal team list' shows it`,
        );
      if (result.note) {
        console.log(
          `Told @${LEAD_HANDLE} in the chat (#${result.note.message.id})`,
        );
        for (const delivery of result.note.deliveries)
          console.log(deliveryText(delivery));
      }
    },
  );
  return 0;
}
