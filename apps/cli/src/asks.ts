import {
  DaedalusError,
  type AgentSession,
  type ApplicationContext,
  type AskView,
} from "@daedalus/core";
import { parseArguments, printResult } from "./arguments";

export const activityHelp = `Activity commands — questions for the user, kept under Activity until answered:
  daedal activity ask "<question>" [--context "<text>" | --context-file <path>|-] [--why "<text>"] [--option "<text>"]... [--recommend <n>] [--plan <plan> ^<id>] [--session <session>]
  daedal activity list [--team | --all] [--session <session>]
  daedal activity show <n>
  daedal activity update <n> [--title "<question>"] [--context ...] [--why ...] [--option ...]... [--recommend <n>] [--plan <plan> ^<id>]
  daedal activity resolve <n> [--answer "<what the user said>"]
  daedal activity withdraw <n> ["<why>"]

Ask the user once. The app keeps the question as a card under Activity,
with its context, its options and the plan task it waits on, until the user
answers or dismisses it there. Do not repeat it in your replies: say "Asked
#<n>" and go on with other work. Every message Daedalus brings you ends with
a line naming your open asks.
--context says what it is about and --why what waits on the answer; write
them so the user can decide without scrolling back. --option may be given
any number of times, or not at all for a question answered in words;
--recommend is the number of the option you recommend. The user may pick
one, write their own answer, or both.
--plan and ^<id> pin the ask to a task of a plan in your workspace: the plan
shows that task as waiting on the user, and the ask closes when the task is
done or dropped. A task without an id gets one from its title.
Asking the same question again while it is open rewrites it.
When the user answers or dismisses it in the app, you are told, with the
question and its context. When they answer it in your session instead, run
'daedal activity resolve <n> --answer "<what they said>"' so the card closes.
'withdraw' closes an ask that is no longer needed. Archiving a session
closes its asks.
'list' shows your open asks and those ended in the last day; --team adds
every member you lead, down every level; --all shows every session's.
The session is the calling one unless --session names one.`;

/** `--option` may repeat, which `parseArguments` refuses; take them first. */
function takeRepeated(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length;) {
    if (args[index] !== `--${name}`) {
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined)
      throw new DaedalusError(
        "VALIDATION",
        `Option '--${name}' requires a value`,
      );
    out.push(value);
    args.splice(index, 2);
  }
  return out;
}

const number = (text: string | undefined, usage: string): number => {
  const value = Number((text ?? "").replace(/^#/, ""));
  if (!Number.isInteger(value) || value < 1)
    throw new DaedalusError("VALIDATION", `Usage: ${usage}`);
  return value;
};

function describe(ask: AskView): string {
  const lines = [
    `#${ask.id} ${ask.state}  ${ask.title}`,
    `  ${ask.sessionName ?? ask.sessionId} · ${ask.workspaceName ?? ask.workspaceId} · asked ${ask.createdAt}`,
  ];
  if (ask.context) lines.push(`  Context: ${ask.context}`);
  if (ask.why) lines.push(`  Why: ${ask.why}`);
  ask.options.forEach((option, index) =>
    lines.push(
      `  ${index + 1}. ${option}${index === ask.recommended ? " (recommended)" : ""}`,
    ),
  );
  if (ask.planPath)
    lines.push(
      `  Plan: ${ask.planPath}${ask.taskKey ? ` ^${ask.taskKey}` : ""}`,
    );
  if (ask.answer || ask.note)
    lines.push(
      `  Answer: ${[ask.answer, ask.note ? `"${ask.note}"` : null].filter(Boolean).join(", ")}`,
    );
  if (ask.closedReason) lines.push(`  ${ask.closedReason}`);
  return lines.join("\n");
}

export const ACTIVITY_ACTIONS = [
  "list",
  "show",
  "update",
  "resolve",
  "withdraw",
];

/**
 * The CLI before Activity: `daedal ask "<question>"` and `daedal ask <sub>`.
 * Running sessions may still have it in their instructions, so it stays as a
 * hidden alias of `daedal activity ask` and `daedal activity <sub>`.
 */
export function activityAlias(args: string[]): string[] {
  if (args[0] !== "ask") return args;
  const rest = args.slice(1);
  if (rest.length === 0) return ["activity"];
  if (ACTIVITY_ACTIONS.includes(rest[0]!) || rest[0] === "help")
    return ["activity", ...rest];
  return ["activity", "ask", ...rest];
}

export async function activityCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
  caller: () => Promise<AgentSession | undefined>,
): Promise<number> {
  const first = args[0];
  if (!first || first === "help" || first === "--help") {
    console.log(activityHelp);
    return 0;
  }
  if (first !== "ask" && !ACTIVITY_ACTIONS.includes(first))
    throw new DaedalusError(
      "VALIDATION",
      `Unknown activity command '${first}'; see 'daedal activity --help'`,
    );
  args.shift();
  const action = first === "ask" ? "create" : first;
  const options = takeRepeated(args, "option");
  const parsed = parseArguments(
    args,
    [
      "context",
      "context-file",
      "why",
      "recommend",
      "plan",
      "session",
      "title",
      "answer",
    ],
    ["team", "all"],
  );
  const session = async (): Promise<string> => {
    if (parsed.values.session)
      return (await context.agents.get(parsed.values.session)).id;
    const found = await caller();
    if (!found)
      throw new DaedalusError(
        "VALIDATION",
        "No session: run it in the session that asks, or pass --session <session>",
      );
    return found.id;
  };
  const contextText = async (): Promise<string | undefined> => {
    const path = parsed.values["context-file"];
    if (path && parsed.values.context)
      throw new DaedalusError(
        "VALIDATION",
        "Pass --context or --context-file, not both",
      );
    if (!path) return parsed.values.context;
    return path === "-" ? Bun.stdin.text() : Bun.file(path).text();
  };
  const recommend =
    parsed.values.recommend === undefined
      ? undefined
      : Number(parsed.values.recommend);
  // The task follows --plan: `^id`, or `L<line>` when a plan is named.
  const task = parsed.positionals.find(
    (item) =>
      item.startsWith("^") ||
      (Boolean(parsed.values.plan) && /^L\d+$/.test(item)),
  );
  if (task && !parsed.values.plan)
    throw new DaedalusError(
      "VALIDATION",
      `Name the plan ${task} is in: --plan <plan> ${task}`,
    );
  const rest = parsed.positionals.filter((item) => item !== task);

  if (action === "create") {
    const title = rest.join(" ");
    const text = await contextText();
    const { ask, updated } = await context.asks.create({
      session: await session(),
      title,
      ...(options.length ? { options } : {}),
      ...(text !== undefined ? { context: text } : {}),
      ...(parsed.values.why ? { why: parsed.values.why } : {}),
      ...(recommend !== undefined ? { recommend } : {}),
      ...(parsed.values.plan ? { plan: parsed.values.plan } : {}),
      ...(task ? { task } : {}),
    });
    printResult({ ask, updated }, json, () =>
      console.log(
        `${updated ? "Updated" : "Asked"} #${ask.id}. It shows under Activity until the user answers; tell them "Asked #${ask.id}" and do not repeat it.`,
      ),
    );
    return 0;
  }
  if (action === "list") {
    const asks = parsed.flags.has("all")
      ? context.asks.list()
      : context.asks.list({
          session: await session(),
          team: parsed.flags.has("team"),
        });
    printResult(asks, json, () =>
      console.log(
        asks.length
          ? asks.map(describe).join("\n\n")
          : "No asks open or ended in the last day.",
      ),
    );
    return 0;
  }
  const id = number(rest[0], `daedal activity ${action} <n>`);
  if (action === "show") {
    const ask = context.asks.get(id);
    printResult(ask, json, () => console.log(describe(ask)));
    return 0;
  }
  if (action === "update") {
    const text = await contextText();
    const ask = await context.asks.update(id, {
      session: await session(),
      ...(parsed.values.title ? { title: parsed.values.title } : {}),
      ...(text !== undefined ? { context: text } : {}),
      ...(parsed.values.why ? { why: parsed.values.why } : {}),
      ...(options.length ? { options } : {}),
      ...(recommend !== undefined ? { recommend } : {}),
      ...(parsed.values.plan ? { plan: parsed.values.plan } : {}),
      ...(task ? { task } : {}),
    });
    printResult(ask, json, () => console.log(`Updated #${ask.id}.`));
    return 0;
  }
  const ask = await context.asks.resolve(id, {
    session: await session(),
    ...(action === "withdraw"
      ? {
          withdraw: true,
          ...(rest.slice(1).join(" ")
            ? { answer: rest.slice(1).join(" ") }
            : {}),
        }
      : parsed.values.answer
        ? { answer: parsed.values.answer }
        : {}),
  });
  printResult(ask, json, () =>
    console.log(
      `${action === "withdraw" ? "Withdrew" : "Resolved"} #${ask.id}; its card is closed.`,
    ),
  );
  return 0;
}
