import {
  DaedalusError,
  type AgentSession,
  type ApplicationContext,
} from "@daedalus/core";
import { expectPositionals, parseArguments, printResult } from "./arguments";

export const threadHelp = `Thread commands — the sessions the main agent tracks, and suggested work:
  daedal thread new --workspace <workspace> [--name "<name>"] --message "<instructions>" [--provider <claude|codex>] [--model <model>] [--tracker <session>]
  daedal thread track <session> [--tracker <session>]
  daedal thread untrack <session> [--tracker <session>]
  daedal thread list [--all] [--tracker <session>]
  daedal thread say <session> "<text>" [--tracker <session>]
  daedal thread suggest "<title>" [--workspace <workspace>] [--message "<instructions>"] [--lead <session>]
  daedal thread suggestions [--lead <session>]
  daedal thread start <suggestion-id>
  daedal thread dismiss <suggestion-id>
  daedal thread done <session>
  daedal thread reopen <session>

A thread is an ordinary session in one of your workspaces. Tracking it puts
it in no team and gives it no handle: when its turn ends (finished, failed,
interrupted, or waiting on the user) the tracker is told, with its last
message, at most once a minute. A note that it waits on the user wakes no
one alone.
'new' starts a session in --workspace with --message as its instructions
and tracks it. 'track' and 'untrack' start and stop tracking a session that
is already running; an untracked session keeps running.
'list' shows what the tracker tracks; --all shows every session in every
workspace that is not archived, with the tracked ones marked.
'say' delivers the text in full to a tracked session, with a line saying its
turn-end reply comes back to the tracker.
The tracker is the calling session unless --tracker names one.
'suggest' lists work under Suggested threads in the Threads pane, with Start
and Start all; nothing runs until the user starts it. The main agent's
suggestion starts as a session it tracks, so it needs --workspace; another
lead's joins its team, in --workspace or the lead's own. --message is the
instructions (the title when left out). The lead is the calling session
unless --lead names one.
'start' and 'dismiss' do what the pane's buttons do.
'done' marks a thread resolved: it folds under Resolved, stops reporting to
its tracker and stops counting against a lead's 5 members. It keeps running
until stopped or archived. 'reopen' takes the mark off.`;

export async function threadCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
  caller: () => Promise<AgentSession | undefined>,
): Promise<number> {
  const action = args.shift();
  if (!action || action === "help" || action === "--help") {
    console.log(threadHelp);
    return 0;
  }
  const parsed = parseArguments(
    args,
    ["workspace", "message", "lead", "tracker", "name", "provider", "model"],
    ["all"],
  );
  const tracker = async (): Promise<string> => {
    if (parsed.values.tracker)
      return (await context.agents.get(parsed.values.tracker)).id;
    const session = await caller();
    if (!session)
      throw new DaedalusError(
        "VALIDATION",
        "No tracker: run it in the session that tracks, such as the main agent, or pass --tracker <session>",
      );
    return session.id;
  };
  const target = async (usage: string): Promise<AgentSession> => {
    const reference = parsed.positionals[0];
    if (!reference) throw new DaedalusError("VALIDATION", `Usage: ${usage}`);
    return context.agents.get(reference);
  };
  const where = (session: AgentSession) =>
    context.repositories.findWorkspace(session.workspaceId)?.name ??
    session.workspaceId;

  if (action === "new") {
    expectPositionals(
      parsed.positionals,
      0,
      'daedal thread new --workspace <workspace> --message "<instructions>"',
    );
    if (!parsed.values.workspace || !parsed.values.message)
      throw new DaedalusError(
        "VALIDATION",
        'Usage: daedal thread new --workspace <workspace> [--name "<name>"] --message "<instructions>"',
      );
    const session = await context.tracking.start({
      tracker: await tracker(),
      workspace: parsed.values.workspace,
      message: parsed.values.message,
      ...(parsed.values.name ? { name: parsed.values.name } : {}),
      ...(parsed.values.provider ? { provider: parsed.values.provider } : {}),
      ...(parsed.values.model ? { model: parsed.values.model } : {}),
    });
    printResult(session, json, () =>
      console.log(
        `Started ${session.name} (${session.id}) in ${where(session)}, tracked`,
      ),
    );
    return 0;
  }

  if (action === "track" || action === "untrack") {
    expectPositionals(
      parsed.positionals,
      1,
      `daedal thread ${action} <session>`,
    );
    const session = await target(`daedal thread ${action} <session>`);
    const trackerId = await tracker();
    if (action === "track") {
      const result = context.tracking.track(trackerId, session.id);
      printResult(
        { session: result.session, tracked: true, added: result.added },
        json,
        () =>
          console.log(
            result.added
              ? `Tracking ${session.name} (${session.id}) in ${where(session)}`
              : `Already tracking ${session.name}`,
          ),
      );
    } else {
      const result = context.tracking.untrack(trackerId, session.id);
      printResult(
        { session: result.session, tracked: false, removed: result.removed },
        json,
        () =>
          console.log(
            result.removed
              ? `Stopped tracking ${session.name}; it keeps running`
              : `${session.name} was not tracked`,
          ),
      );
    }
    return 0;
  }

  if (action === "list") {
    expectPositionals(parsed.positionals, 0, "daedal thread list [--all]");
    const all = parsed.flags.has("all");
    const rows = context.tracking.sessions(await tracker(), { all });
    printResult(rows, json, () => {
      if (!rows.length)
        console.log(all ? "No sessions" : "Not tracking any session");
      for (const { session, tracked } of rows)
        console.log(
          [
            session.id,
            session.name,
            where(session),
            session.archivedAt
              ? "archived"
              : session.resolvedAt
                ? "resolved"
                : session.status,
            ...(all && tracked ? ["tracked"] : []),
          ].join("\t"),
        );
    });
    return 0;
  }

  if (action === "say") {
    const usage = 'daedal thread say <session> "<text>"';
    const session = await target(usage);
    const body = parsed.positionals.slice(1).join(" ");
    if (!body.trim()) throw new DaedalusError("VALIDATION", `Usage: ${usage}`);
    const result = await context.tracking.say({
      tracker: await tracker(),
      session: session.id,
      body,
    });
    printResult(result, json, () =>
      console.log(
        result.delivery.delivered
          ? `Delivered to ${session.name}`
          : `Saved for ${session.name}; ${result.delivery.error ?? "it gets it when it runs"}`,
      ),
    );
    return 0;
  }

  const lead = async (): Promise<string> => {
    if (parsed.values.lead)
      return (await context.agents.get(parsed.values.lead)).id;
    const session = await caller();
    if (!session)
      throw new DaedalusError(
        "VALIDATION",
        "No Daedalus session to suggest for; run it in the lead's session or pass --lead <session>",
      );
    return session.id;
  };

  if (action === "suggest") {
    if (!parsed.positionals.length)
      throw new DaedalusError(
        "VALIDATION",
        'Usage: daedal thread suggest "<title>" [--workspace <workspace>] [--message "<instructions>"]',
      );
    const suggestion = await context.threads.suggest({
      lead: await lead(),
      title: parsed.positionals.join(" "),
      ...(parsed.values.workspace
        ? { workspace: parsed.values.workspace }
        : {}),
      ...(parsed.values.message ? { message: parsed.values.message } : {}),
    });
    printResult(suggestion, json, () =>
      console.log(
        `Suggested thread ${suggestion.id}: ${suggestion.title}. The user starts it from the Threads pane.`,
      ),
    );
    return 0;
  }

  if (action === "suggestions") {
    expectPositionals(parsed.positionals, 0, "daedal thread suggestions");
    const suggestions = context.threads.suggestions(await lead());
    printResult(suggestions, json, () => {
      if (!suggestions.length) console.log("No suggested threads");
      for (const item of suggestions)
        console.log(
          `${item.id}\t${item.title}${item.workspaceId ? `\t${item.workspaceId}` : ""}`,
        );
    });
    return 0;
  }

  if (action === "start" || action === "dismiss") {
    expectPositionals(
      parsed.positionals,
      1,
      `daedal thread ${action} <suggestion-id>`,
    );
    const id = Number(parsed.positionals[0]);
    if (!Number.isInteger(id))
      throw new DaedalusError(
        "VALIDATION",
        "A suggestion id is a number; see 'daedal thread suggestions'",
      );
    if (action === "start") {
      const session = await context.threads.start(id);
      printResult(session, json, () =>
        console.log(`Started ${session.name} (${session.id})`),
      );
    } else {
      const dismissed = context.threads.dismiss(id);
      printResult(dismissed, json, () =>
        console.log(`Dismissed ${dismissed.title}`),
      );
    }
    return 0;
  }

  if (action === "done" || action === "reopen") {
    expectPositionals(
      parsed.positionals,
      1,
      `daedal thread ${action} <session>`,
    );
    const session = context.threads.resolve(
      (await context.agents.get(parsed.positionals[0]!)).id,
      action === "done",
    );
    printResult(session, json, () =>
      console.log(
        action === "done"
          ? `${session.name} is resolved`
          : `${session.name} is open again`,
      ),
    );
    return 0;
  }

  throw new DaedalusError(
    "VALIDATION",
    `Unknown thread command '${action}'; see 'daedal thread --help'`,
  );
}
