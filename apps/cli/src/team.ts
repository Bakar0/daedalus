import { MESSAGING_CHANGED_IN } from "./thread";
import {
  DaedalusError,
  LEAD_HANDLE,
  TEAM_MAX_DEPTH,
  TEAM_MAX_MEMBERS,
  teamChannelName,
  parseTags,
  type AgentSession,
  type ApplicationContext,
  type Team,
  type TeamTreeNode,
} from "@daedalus/core";
import { callerSession } from "./caller";
import { parseArguments, printResult } from "./arguments";
import { deliveryLine } from "./channel";
import { shellLine } from "./shell-words";

export const teamHelp = `Team commands:
  daedal team list [--team <lead>]
  daedal team tree [--team <lead>]
  daedal team goal [<text>] [--team <lead>]
  daedal team pause|resume [--team <lead>]
  daedal team move <session> --to <lead> | --out [--user]
  daedal agent spawn --team [<lead>] [--message <instructions>] [--name <name>]
      [--workspace <workspace>] [--task <task-ref>] [--provider claude|codex]
      [--model <model>] [--account <account>]

A team is a lead and the members it or the user adds. Any Claude or Codex
session on this Mac can lead: the first 'agent spawn --team' run inside a
session makes it a lead, and '--team <session>' from the user makes that
session one. The team is named after the lead's session. Ending a team
(the lead's "End team", or 'daedal session revoke <lead> orchestration')
leaves its members running as plain sessions. A team talks in its channel,
"#<lead's name>": see 'daedal channel --help'.

'agent spawn --team' with no value, run inside a session, adds a member to
the team that session leads, and needs --message. '--team <lead>' adds one to
that lead's team for the user, who may leave out --message and instruct the
member in its own session; the lead is told in the channel either way.
Members start in the lead's workspace unless --workspace names another, on
the lead's provider unless --provider picks the other one. A team can mix
Claude and Codex, with either as the lead. Each member has a handle, made
from --name or the task's title, that the channel uses.

Teams nest: a member can lead a team of its own. A session is a member of
at most one team and leads at most one. A tree goes at most ${TEAM_MAX_DEPTH} levels
below its top lead, and a lead has at most ${TEAM_MAX_MEMBERS} members that are not
archived; past either, the spawn is refused and says where to add instead.
'team tree' prints the whole tree the team is in, or every tree.

Inside the lead or a member, --team defaults to its own team. 'team list'
shows each member with what it has not read in the channel and the last
delivery that failed. 'team goal' sets the shared goal that members are
told at launch.

'team pause' holds every message to the team's members and refuses new
members, for the teams its members lead too; 'team resume' sends what waited.
Archiving a lead pauses its team the same way, and archives the members below
it; stopping a lead stops them. Restoring the lead resumes its team.

'team move <session> --to <lead>' moves a running session, with the team it
leads, into <lead>'s team, without restarting it: it keeps its conversation
and keeps its handle unless the new team has one like it. <lead> becomes a
lead if it leads no team yet. The session, its old lead and its new lead are
told in the channel. The depth and member caps apply to the moved subtree, and
a session cannot move under itself or a session below it. '--out' takes it
out of its team and leaves it a plain session, or the top lead of the team
it leads. The user can move any session. Inside a session, a lead can move a
session below it into its own team or a team below it; only the user (no
session, or --user) uses --out or brings in a session that is in no team.`;

/** The team a command is about: --team, else the caller's own. */
async function teamFor(
  context: ApplicationContext,
  values: Record<string, string>,
  caller: AgentSession | undefined,
): Promise<Team> {
  if (values.team !== undefined) {
    const lead = context.agents.resolve(values.team);
    return context.teams.get(lead.id);
  }
  const place = caller && context.teams.memberships(caller.id)[0];
  if (place) return place.team;
  const teams = context.teams.list();
  if (teams.length === 1) return teams[0]!;
  throw new DaedalusError(
    "VALIDATION",
    teams.length
      ? `There are ${teams.length} teams (${teams.map((team) => `'${team.name}' ${team.lead.id}`).join(", ")}); pass --team <lead>`
      : "There is no team; 'daedal agent spawn --team <session>' makes one",
  );
}

/**
 * `team say` and `team chat` moved to `channel say` and `channel read`. An
 * agent started before the move still runs them, so they write nothing and
 * fail with the command to run instead, built from the caller's own words.
 */
export function movedToChannel(
  action: "say" | "chat",
  args: string[],
  /** The channel the old command meant, when the new one needs its name. */
  channel?: string,
): never {
  const words = ["daedal", "channel", action === "say" ? "say" : "read"];
  if (channel) words.push(`#${channel}`);
  const options: string[] = [];
  const text: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--team" && channel) index += 1;
    else if (argument === "--team" || argument === "--limit") {
      options.push(argument, args[index + 1] ?? "");
      index += 1;
    } else if (argument.startsWith("--")) options.push(argument);
    else text.push(argument);
  }
  if (action === "say" && text.length) words.push(text.join(" "));
  throw new DaedalusError(
    "VALIDATION",
    [
      `Daedalus ${MESSAGING_CHANGED_IN} moved team chat to channels; your instructions are older. Nothing was written. Run instead:`,
      `  ${shellLine([...words, ...options])}`,
      `Run 'daedal channel --help' for the current commands.`,
    ].join("\n"),
  );
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

async function moveSession(
  context: ApplicationContext,
  parsed: ReturnType<typeof parseArguments>,
  caller: AgentSession | undefined,
  json: boolean,
): Promise<number> {
  const usage =
    "Usage: daedal team move <session> --to <lead> | --out [--user]";
  const out = parsed.flags.has("out");
  const to = parsed.values.to;
  if (parsed.positionals.length !== 1 || out === (to !== undefined))
    throw new DaedalusError("VALIDATION", usage);
  const session = context.agents.resolve(parsed.positionals[0]!);
  const target = to === undefined ? undefined : context.agents.resolve(to);
  const result = await context.teams.move({
    session: session.id,
    ...(target ? { to: target.id } : {}),
    ...(caller ? { caller } : {}),
  });
  printResult(result, json, () => {
    if (result.to)
      console.log(
        `Moved '${session.name}' to the team '${result.to.name}' as @${result.handle}${result.from ? `, from '${result.from.name}'` : ""}`,
      );
    else
      console.log(
        `Took '${session.name}' out of the team '${result.from?.name ?? ""}'`,
      );
  });
  return 0;
}

/**
 * For an old `team say`: the channel it would have posted to, when the
 * caller is in two (a lead that is also a member), since `channel say` then
 * needs the name. The old command posted up to its own lead when the message
 * tagged @lead, and to the team it leads otherwise. Undefined when the new
 * command finds the channel on its own, or when it cannot be told.
 */
async function oldChannel(
  context: ApplicationContext,
  action: "say" | "chat",
  args: string[],
): Promise<string | undefined> {
  if (action !== "say" || args.includes("--team") || args.includes("--user"))
    return undefined;
  const caller = await callerSession(context).catch(() => undefined);
  const places = caller ? context.teams.memberships(caller.id) : [];
  if (places.length < 2) return undefined;
  const body = args.filter((argument) => !argument.startsWith("--")).join(" ");
  const upward = parseTags(body).includes(LEAD_HANDLE)
    ? places.find((place) => place.reader.role === "member")
    : undefined;
  return teamChannelName((upward ?? places[0]!).team);
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
  if (action === "say" || action === "chat")
    movedToChannel(action, args, await oldChannel(context, action, args));
  if (!["list", "tree", "goal", "pause", "resume", "move"].includes(action))
    throw new DaedalusError("VALIDATION", `Unknown team command '${action}'`);
  const parsed = parseArguments(args, ["team", "to"], ["user", "out"]);
  const asUser = parsed.flags.has("user");
  const caller = await callerSession(context);
  if (action === "tree") return printTree(context, parsed, caller, json);
  if (action === "move")
    return moveSession(context, parsed, asUser ? undefined : caller, json);
  const team = await teamFor(context, parsed.values, caller);

  if (action === "list") {
    if (parsed.positionals.length)
      throw new DaedalusError(
        "VALIDATION",
        "Usage: daedal team list [--team <lead>]",
      );
    await context.channels.flush(team.id);
    const { members } = context.channels.status(team.id);
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
    await context.jobIntake.spawnWith({
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
          `Told @${LEAD_HANDLE} in #${teamChannelName(team)} (#${result.note.message.id})`,
        );
        for (const delivery of result.note.deliveries)
          console.log(deliveryLine(delivery));
      }
    },
  );
  return 0;
}
