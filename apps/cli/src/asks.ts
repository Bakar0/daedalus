import {
  DaedalusError,
  type AgentSession,
  type ApplicationContext,
  type AskView,
} from "@daedalus/core";
import { parseArguments, printResult } from "./arguments";

export const threadHelp = `Thread commands — a question for the user on your last message in main, kept until answered:
  daedal thread start "<question>" [--context "<text>" | --context-file <path>|-] [--why "<text>"] [--option "<text>"]... [--recommend <n>] [--plan <plan> ^<id>] [--session <session>]
  daedal thread list [--team | --all] [--session <session>]
  daedal thread show <n>
  daedal thread update <n> [--title "<question>"] [--context ...] [--why ...] [--option ...]... [--recommend <n>] [--plan <plan> ^<id>]
  daedal thread bump <n>
  daedal thread resolve <n> [--answer "<what the user said>"]
  daedal thread close <n> ["<why>"]

Ask the user once, then keep working on something else. The thread hangs off
the last thing you wrote in main, so write one line there first that says
what you asked ("Asked about the retry budget in a thread; moving on to the
API"). The user answers in the thread and the answer comes back to you as a
message. Do not repeat the question in your replies: say "Thread #<n>" and go
on. Every message Daedalus brings you ends with a line naming your open
threads.
The thread shows the question, then --why, then the options; --context is
folded under "Details". So write the question as one short plain line the
user can answer ("How many delivery tries before a webhook is dead-lettered?"),
--why as one sentence on what stays stuck without the answer, and put ids,
dates, accounts and links in --context. --option may be given any number of
times, or not at all for a question answered in words; --recommend is the
number of the option you recommend.
'bump' says you are now blocked on it: the user is told once. Bump a thread
once, when you run out of other work; a second bump before the user replies
does nothing.
--plan and ^<id> pin the thread to a task of a plan in your workspace: the
plan shows that task as waiting on the user, and the thread closes when the
task is done or dropped.
Starting the same question again while it is open rewrites it.
When the user answers in your session instead, run
'daedal thread resolve <n> --answer "<what they said>"' so the thread closes.
'close' ends a thread that is no longer needed. Archiving a session closes
its threads.
'list' shows your open threads and those ended in the last day; --team adds
every member you lead, down every level; --all shows every session's.
The session is the calling one unless --session names one.
'daedal activity ask|withdraw|...' still works for now and means the same.`;

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

export const THREAD_ACTIONS = [
  "start",
  "list",
  "show",
  "update",
  "bump",
  "resolve",
  "close",
  "catch-up",
];

/** The names `daedal activity` had, as `daedal thread` calls them. */
const LEGACY_ACTIONS: Record<string, string> = {
  ask: "start",
  withdraw: "close",
};

/**
 * The CLI before threads: `daedal activity <sub>` and, before that,
 * `daedal ask`. Running sessions may still have them in their instructions,
 * so both stay as aliases of `daedal thread`, with `ask` as `start` and
 * `withdraw` as `close`.
 */
export function threadAlias(args: string[]): string[] {
  const [first, ...rest] = args;
  if (first !== "ask" && first !== "activity") return args;
  if (
    first === "ask" &&
    rest.length &&
    !LEGACY_ACTIONS[rest[0]!] &&
    !THREAD_ACTIONS.includes(rest[0]!) &&
    rest[0] !== "help"
  )
    return ["thread", "start", ...rest];
  if (!rest.length) return ["thread"];
  return ["thread", LEGACY_ACTIONS[rest[0]!] ?? rest[0]!, ...rest.slice(1)];
}

export async function threadCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
  caller: () => Promise<AgentSession | undefined>,
): Promise<number> {
  const first = args[0];
  if (!first || first === "help" || first === "--help") {
    console.log(threadHelp);
    return 0;
  }
  if (!THREAD_ACTIONS.includes(first))
    throw new DaedalusError(
      "VALIDATION",
      `Unknown thread command '${first}'; see 'daedal thread --help'`,
    );
  args.shift();
  const action = first === "start" ? "create" : first;
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
        `${updated ? "Updated" : "Started"} thread #${ask.id}${ask.anchorId ? " on your last message in main" : ""}. The user answers there; the answer comes back to you. Say "Thread #${ask.id}" and go on with other work.`,
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
          : "No threads open or ended in the last day.",
      ),
    );
    return 0;
  }
  const id = number(rest[0], `daedal thread ${action} <n>`);
  if (action === "show") {
    const ask = context.asks.get(id);
    const conversation = await context.asks.forkConversation(id);
    printResult({ ...ask, conversation }, json, () => {
      console.log(describe(ask));
      if (ask.kind === "fork") {
        if (ask.anchorText)
          console.log(`  On your message: ${ask.anchorText.split("\n")[0]}`);
        console.log(
          conversation.length
            ? `\nIn the fork (read-only, the user talking it through):\n${conversation
                .map(
                  (message) =>
                    `${message.role === "user" ? "> " : "● "}${message.text}`,
                )
                .join("\n\n")}`
            : "\nNothing said in the fork yet.",
        );
      }
    });
    return 0;
  }
  if (action === "bump") {
    const { ask, bumped } = context.asks.bump(id, await session());
    printResult({ ask, bumped }, json, () =>
      console.log(
        bumped
          ? `Thread #${ask.id} marked blocking; the user is told once.`
          : `Thread #${ask.id} was bumped already; wait for the user's reply.`,
      ),
    );
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
    ...(action === "close"
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
      `${action === "close" ? "Closed" : "Resolved"} thread #${ask.id}.`,
    ),
  );
  return 0;
}
