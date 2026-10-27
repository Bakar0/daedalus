import {
  DaedalusError,
  LEAD_HANDLE,
  USER_HANDLE,
  teamChatText,
  type AgentSession,
  type ApplicationContext,
  type Team,
  type TeamDeliveryResult,
  type TeamMessage,
  type TeamSayResult,
} from "@daedalus/core";
import { callerSession } from "./caller";
import { parseArguments, printResult } from "./arguments";

export const teamHelp = `Team commands:
  daedal team say "<text>" [--team <lead>] [--user]
  daedal team chat [--tagged | --all] [--limit <n>] [--team <lead>] [--user]
  daedal team list [--team <lead>]
  daedal team goal [<text>] [--team <lead>]
  daedal agent spawn --team [<lead>] [--message <instructions>] [--name <name>]
      [--task <task-ref>] [--provider claude|codex] [--model <model>]
      [--account <account>]

A team is a lead, a session that holds the orchestration ability, and the
members it or the user adds. Grant the ability with
'daedal session grant <session> orchestration', or start a lead with
'daedal agent spawn --ability orchestration'. The team is named after the
lead's session.

'agent spawn --team' with no value, run by the lead, adds a member to its
team, and needs --message. '--team <lead>' adds one to that lead's team for
the user, who may leave out --message and instruct the member in its own
session; the lead is told in the chat either way.
Members start in the lead's workspace, on the lead's provider unless
--provider picks the other one. A team can mix Claude and Codex, with
either as the lead. Each member has a handle, made from --name or the
task's title, that the chat uses.

Everyone in the team, and the user, posts to one chat. Tags decide who is
told: @<handle> sends that member's session a one-line notice saying who
wrote and to run 'team chat --tagged', @lead the lead's, @all everyone's.
A message that tags nobody is stored and only read with 'team chat'. Claude
sessions get the notice through their inbox socket as a message from
another session; Codex sessions through 'codex queue'. A busy session gets it in or after its current turn, and
nothing is typed into its pane. A session that is not running, or a send
that fails, is tried again on the next post in the team, on 'team chat' and
'team list', and when the session starts or ends a turn. 'team list' shows
the last failure.

Inside the lead or a member, --team defaults to its own team, and posts are
signed with its handle. Outside a session the post is from the user, and
--team is needed when there is more than one team. --user posts as the user
from inside a session's folder.

'team chat' prints what the reader has not read yet and marks it read; --all
prints the newest messages whatever was read; --tagged prints only unread
messages that tag the reader and leaves the rest unread. 'team goal' sets the shared
goal that members are told at launch.`;

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
  if (caller) {
    const membership = context.teams.membership(caller.id);
    if (membership) return membership.team;
  }
  const teams = context.teams.list();
  if (teams.length === 1) return teams[0]!;
  throw new DaedalusError(
    "VALIDATION",
    teams.length
      ? `There are ${teams.length} teams (${teams.map((team) => `'${team.name}' ${team.lead.id}`).join(", ")}); pass --team <lead>`
      : "There is no team; grant a session the orchestration ability first",
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
  const membership = context.teams.membership(caller.id);
  return membership?.team.id === team.id
    ? membership.reader.handle
    : USER_HANDLE;
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
  if (!["say", "chat", "list", "goal"].includes(action))
    throw new DaedalusError("VALIDATION", `Unknown team command '${action}'`);
  const parsed = parseArguments(
    args,
    ["team", "limit"],
    ["user", "all", "tagged"],
  );
  const asUser = parsed.flags.has("user");
  const caller = await callerSession(context);
  const team = await teamFor(context, parsed.values, caller);

  if (action === "say") {
    const body = parsed.positionals.join(" ");
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
    await context.teams.flush(team.id);
    const result = context.teams.chat(
      team.id,
      readerHandle(context, team, caller, asUser),
      {
        ...(parsed.flags.has("all") ? { all: true } : {}),
        ...(parsed.flags.has("tagged") ? { tagged: true } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
    );
    const label = context.teams.authorLabels(team);
    const messages = result.messages.map((message) => ({
      ...message,
      from: label(message.author),
    }));
    printResult({ ...result, messages, team: teamSummary(team) }, json, () => {
      if (result.skipped)
        console.log(
          `(${result.skipped} older unread messages not shown; use --limit)`,
        );
      if (!result.messages.length)
        console.log(
          parsed.flags.has("tagged")
            ? `Nothing new for you in the team '${team.name}'.`
            : `Nothing new in the team '${team.name}'.`,
        );
      for (const message of messages)
        console.log(teamChatText(message, message.from));
      if (result.others)
        console.log(
          `(${result.others} other unread ${result.others === 1 ? "message" : "messages"} in the chat; 'daedal team chat' reads ${result.others === 1 ? "it" : "them"}.)`,
        );
    });
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
      unread: member.unread,
      undelivered: member.undelivered,
      lastError: member.lastError,
      lastAttemptAt: member.lastAttemptAt,
    }));
    printResult({ team: teamSummary(team), members: rows }, json, () => {
      console.log(`Team '${team.name}'${team.goal ? `: ${team.goal}` : ""}`);
      for (const row of rows)
        console.log(
          [
            `@${row.handle}`,
            row.sessionId,
            row.status,
            row.activity,
            row.name,
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
  let team: Team;
  if (input.lead === undefined) {
    const membership = caller && context.teams.membership(caller.id);
    if (!membership || membership.reader.role !== "lead")
      throw new DaedalusError(
        "VALIDATION",
        "'--team' without a lead works only inside a lead's session; pass --team <lead>",
      );
    team = membership.team;
  } else {
    team = context.teams.get(context.agents.resolve(input.lead).id);
  }
  const callerRole =
    caller && !input.asUser ? context.teams.membership(caller.id) : undefined;
  if (caller && !input.asUser && callerRole?.team.id !== team.id)
    throw new DaedalusError(
      "CONFLICT",
      `'${caller.name}' is not the lead of '${team.name}'; only the lead or the user adds members (--user, from a session's folder)`,
    );
  if (callerRole && callerRole.reader.role !== "lead")
    throw new DaedalusError(
      "CONFLICT",
      `@${callerRole.reader.handle} is a member of '${team.name}'; ask @${LEAD_HANDLE} to add a member`,
    );
  const workspace = input.values.workspace;
  if (
    workspace !== undefined &&
    (await context.workspaces.getActive(workspace)).id !== team.lead.workspaceId
  )
    throw new DaedalusError(
      "VALIDATION",
      `Members start in the lead's workspace; leave out --workspace`,
    );
  const instructions = input.values.message;
  if (callerRole && !instructions?.trim())
    throw new DaedalusError(
      "VALIDATION",
      "A member the lead adds needs instructions: pass --message <text>",
    );
  const taskId = input.values.task
    ? await input.resolveTask(input.values.task, team.lead.workspaceId)
    : undefined;
  const spawn = (message: string | undefined) =>
    context.teams.spawnMember({
      team: team.id,
      addedBy: callerRole ? "lead" : "user",
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
