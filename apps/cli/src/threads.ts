import { DaedalusError, type ApplicationContext } from "@daedalus/core";
import { expectPositionals, parseArguments, printResult } from "./arguments";

export const threadHelp = `Thread commands — a lead marking a team member done:
  daedal thread done <session>
  daedal thread reopen <session>

'done' marks a member resolved: it folds under Resolved and stops counting
against its lead's 5 members. It keeps running until stopped or archived.
'reopen' takes the mark off.`;

export async function threadCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
): Promise<number> {
  const action = args.shift();
  if (!action || action === "help" || action === "--help") {
    console.log(threadHelp);
    return 0;
  }
  const parsed = parseArguments(args, [], []);

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
