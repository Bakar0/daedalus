import {
  DaedalusError,
  type AgentSession,
  type ApplicationContext,
} from "@daedalus/core";
import { expectPositionals, parseArguments, printResult } from "./arguments";

export const threadHelp = `Thread commands — a lead's threads are its team's members:
  daedal thread suggest "<title>" [--workspace <workspace>] [--message "<instructions>"] [--lead <session>]
  daedal thread suggestions [--lead <session>]
  daedal thread start <suggestion-id>
  daedal thread dismiss <suggestion-id>
  daedal thread done <session>
  daedal thread reopen <session>

'suggest' lists work under Suggested threads in the lead's Threads pane,
with Start and Start all; nothing runs until the user starts it. It runs in
--workspace, else the lead's workspace, with --message as its instructions
(the title when left out). The lead is the calling session unless --lead
names one.
'start' and 'dismiss' do what the pane's buttons do.
'done' marks a thread resolved: it folds under Resolved and stops counting
against its lead's 5 members. It keeps running until stopped or archived.
'reopen' takes the mark off.`;

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
  const parsed = parseArguments(args, ["workspace", "message", "lead"]);
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
