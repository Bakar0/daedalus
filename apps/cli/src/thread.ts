import { shellWord } from "./shell-words";
import {
  DaedalusError,
  firstLine,
  noticeEvent,
  THREAD_FIND_DAYS,
  type AgentSession,
  type ApplicationContext,
  type Message,
  type ThreadView,
} from "@daedalus/core";
import { parseArguments, printResult } from "./arguments";

export const threadHelp = `Thread commands — a conversation with the user that hangs off a line in your main:
  daedal thread new "<message>" [--option "<text>"]... [--details "<text>" | --details-file <path>|-] [--plan <plan> ^<id>] [--session <session>]
  daedal thread say <n> "<message>" [--option "<text>"]... [--details ...]
  daedal thread read <n>
  daedal thread find "<words>" [--since <14d|48h|ISO time>] [--all]
  daedal thread list [--team | --all] [--session <session>]
  daedal thread bump <n>
  daedal thread resolve <n> ["<why>"]

Before you open a thread, look for one: 'find' searches the threads of your
workspace, open and resolved, from the last ${THREAD_FIND_DAYS} days ('--since' looks
further back, '--all' in every workspace). If one is about the same thing,
'say' in it, even if it is resolved: that reopens it. 'new' also prints the
closest threads it finds.
'new' opens a thread on the last thing you wrote in main, so write one line
there first that says what you are asking ("Asked about the retry budget in
a thread; moving on to the API"). Write the message as one short plain line
the user can answer, and put ids, logs, dates and links in --details, which
the user sees folded. --option may be given any number of times, or not at
all for a reply in words.
Talk about a thread only in the thread: status, corrections and follow-ups
go there with 'say', never in main. Do not repeat a thread in your replies:
say "Thread #<n>" and go on. What the user writes in a thread comes back to
you as a message, and every message Daedalus brings you ends with a line
naming your open threads.
'bump' says you are now blocked on it: the user is told once. Bump a thread
once, when you run out of other work; a second bump before the user replies
does nothing.
--plan and ^<id> pin the thread to a task of a plan in your workspace: the
plan shows that task as waiting on the user, and the thread resolves when
the task is done or dropped.
'resolve' ends a thread that is settled, with a reason if you give one;
when the user answers in your session instead, resolve it with what they
said. Archiving a session resolves its threads.
'read' prints the whole thread and marks it read.
'list' shows your open threads and those resolved in the last day; --team
adds every member you lead, down every level; --all shows every session's.
The session is the calling one unless --session names one; your lead may
'say' in your threads too.`;

/** The release that changed the messaging commands, named in old-command errors. */
export const MESSAGING_CHANGED_IN = "0.40.0-beta.7";

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

/**
 * Commands and flags the thread commands had before 0.40.0-beta.7. A
 * session started earlier still has them in its instructions; each fails,
 * writes nothing, and prints the command to run instead, built from the
 * caller's own arguments.
 */
export function oldThreadCommand(
  args: string[],
  /** Threads on the same subject, for an old command that opened one. */
  related: (message: string) => { number: number; title: string }[] = () => [],
): string | undefined {
  const [action, ...rest] = args;
  const flags = new Set(rest.filter((item) => item.startsWith("--")));
  const old =
    action === "start" ||
    action === "update" ||
    action === "show" ||
    action === "close" ||
    (action === "resolve" && flags.has("--answer")) ||
    ((action === "new" || action === "say") &&
      (flags.has("--why") ||
        flags.has("--recommend") ||
        flags.has("--context") ||
        flags.has("--context-file")));
  if (!old) return undefined;
  const words = [...rest];
  const take = (name: string): string | undefined => {
    const at = words.indexOf(`--${name}`);
    if (at < 0) return undefined;
    const [, value] = words.splice(at, 2);
    return value;
  };
  const options: string[] = [];
  for (let value = take("option"); value !== undefined; value = take("option"))
    options.push(value);
  const why = take("why");
  const context = take("context");
  const contextFile = take("context-file");
  const answer = take("answer");
  const title = take("title");
  take("recommend");
  const session = take("session");
  const plan = take("plan");
  const task = words.find((word) => word.startsWith("^"));
  const positionals = words.filter(
    (word) => word !== task && !word.startsWith("--"),
  );
  const tail = [
    ...options.flatMap((option) => ["--option", option]),
    ...(context ? ["--details", context] : []),
    ...(contextFile ? ["--details-file", contextFile] : []),
    ...(plan ? ["--plan", plan, ...(task ? [task] : [])] : []),
    ...(session ? ["--session", session] : []),
  ];
  let instead: string[];
  let same: { number: number; title: string }[] = [];
  if (action === "start" || action === "new") {
    const message = [positionals.join(" "), why].filter(Boolean).join(" ");
    instead = ["new", message || "<message>", ...tail];
    if (message) same = related(message);
  } else if (action === "say") {
    const [n, ...text] = positionals;
    const message = [text.join(" "), why].filter(Boolean).join(" ");
    instead = ["say", n ?? "<n>", message || "<message>", ...tail];
  } else if (action === "update") {
    const message = [title, why].filter(Boolean).join(" ");
    instead = ["say", positionals[0] ?? "<n>", message || "<message>", ...tail];
  } else if (action === "show") instead = ["read", positionals[0] ?? "<n>"];
  else {
    const [n, ...why] = positionals;
    const reason = answer ? `the user answered: ${answer}` : why.join(" ");
    instead = ["resolve", n ?? "<n>", ...(reason ? [reason] : [])];
  }
  return [
    `Daedalus ${MESSAGING_CHANGED_IN} changed thread commands; your instructions are older.`,
    ...(same.length
      ? [
          "Nothing was written. These threads may be about the same thing:",
          ...same.map((item) => `  #${item.number} ${item.title}`),
          "If one is, write in it instead of opening another:",
          `  daedal thread ${["say", String(same[0]!.number), instead[1]!, ...tail.filter((word, index, all) => word === "--option" || all[index - 1] === "--option")].map(shellWord).join(" ")}`,
          "Otherwise run:",
        ]
      : ["Nothing was written. Run instead:"]),
    `  daedal thread ${instead.map(shellWord).join(" ")}`,
    "Run 'daedal thread --help' for the current commands.",
  ].join("\n");
}

/** `--since`: `14d`, `48h`, `90m`, or an ISO time. */
export function sinceTime(text: string, now = new Date()): string {
  const relative = /^(\d+)\s*([dhm])$/i.exec(text.trim());
  if (relative) {
    const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[
      relative[2]!.toLowerCase() as "d" | "h" | "m"
    ];
    return new Date(now.getTime() - Number(relative[1]) * unit).toISOString();
  }
  const time = Date.parse(text);
  if (Number.isNaN(time))
    throw new DaedalusError(
      "VALIDATION",
      `--since takes 14d, 48h, 90m or a time, not '${text}'`,
    );
  return new Date(time).toISOString();
}

const WHO: Record<string, string> = {
  agent: "agent",
  user: "user",
  lead: "lead",
  daedalus: "daedalus",
};

function line(message: Message): string {
  const notice = noticeEvent(message);
  const who = WHO[message.author] ?? message.author;
  if (notice)
    return `  · ${who} ${notice.event === "blocked" ? "is blocked on it" : notice.event}${notice.reason ? `: ${notice.reason}` : ""}`;
  const lines = [`  ${who}: ${message.body.split("\n").join("\n    ")}`];
  if (message.details)
    lines.push(`    details: ${message.details.split("\n").join("\n      ")}`);
  message.options.forEach((option, index) =>
    lines.push(`    ${index + 1}. ${option}`),
  );
  return lines.join("\n");
}

function state(thread: ThreadView): string {
  if (thread.resolvedAt) return "resolved";
  if (thread.status.blocking) return "blocking";
  if (thread.status.turn === "agent") return "your turn";
  if (thread.status.turn === "user") return "waiting on the user";
  return "open";
}

function summary(thread: ThreadView): string {
  return [
    `#${thread.number} ${state(thread)}  ${thread.title}`,
    `  ${thread.ownerName ?? thread.ownerSessionId} · ${thread.workspaceName ?? thread.workspaceId} · ${thread.messages.length} messages · ${thread.updatedAt}`,
  ].join("\n");
}

function describe(thread: ThreadView): string {
  const lines = [summary(thread)];
  if (thread.anchorText)
    lines.push(`  On your message: ${firstLine(thread.anchorText)}`);
  if (thread.planPath)
    lines.push(
      `  Plan: ${thread.planPath}${thread.taskKey ? ` ^${thread.taskKey}` : ""}`,
    );
  lines.push("", ...thread.messages.map(line));
  return lines.join("\n");
}

export const THREAD_ACTIONS = [
  "new",
  "say",
  "read",
  "find",
  "list",
  "bump",
  "resolve",
  "catch-up",
];

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
  if (oldThreadCommand(args)) {
    // An old command that opened a thread is pointed at threads the asking
    // session already has on the same subject.
    const at = args.indexOf("--session");
    const asker =
      at >= 0
        ? context.repositories.findAgent(args[at + 1] ?? "")
        : await caller().catch(() => undefined);
    throw new DaedalusError(
      "VALIDATION",
      oldThreadCommand(args, (message) =>
        asker ? context.threads.related(asker, message) : [],
      )!,
    );
  }
  if (!THREAD_ACTIONS.includes(first))
    throw new DaedalusError(
      "VALIDATION",
      `Unknown thread command '${first}'; see 'daedal thread --help'`,
    );
  args.shift();
  const action = first;
  const options = takeRepeated(args, "option");
  const parsed = parseArguments(
    args,
    ["details", "details-file", "plan", "session", "since"],
    ["team", "all"],
  );
  const session = async (): Promise<string> => {
    if (parsed.values.session)
      return (await context.agents.get(parsed.values.session)).id;
    const found = await caller();
    if (!found)
      throw new DaedalusError(
        "VALIDATION",
        "No session: run it in your session, or pass --session <session>",
      );
    return found.id;
  };
  const details = async (): Promise<string | undefined> => {
    const path = parsed.values["details-file"];
    if (path && parsed.values.details)
      throw new DaedalusError(
        "VALIDATION",
        "Pass --details or --details-file, not both",
      );
    if (!path) return parsed.values.details;
    return path === "-" ? Bun.stdin.text() : Bun.file(path).text();
  };
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

  if (action === "new") {
    const text = await details();
    const { thread, related } = await context.threads.new({
      session: await session(),
      body: rest.join(" "),
      ...(options.length ? { options } : {}),
      ...(text !== undefined ? { details: text } : {}),
      ...(parsed.values.plan ? { plan: parsed.values.plan } : {}),
      ...(task ? { task } : {}),
    });
    printResult({ thread, related }, json, () =>
      console.log(
        [
          `Opened thread #${thread.number}${thread.anchorId ? " on your last message in main" : ""}. The user replies there; the reply comes back to you. Say "Thread #${thread.number}" and go on with other work.`,
          // So the agent sees what the user sees the thread hang off.
          ...(thread.anchorText
            ? [`It hangs off: "${firstLine(thread.anchorText)}"`]
            : []),
          ...(related.length
            ? [
                "Related threads from the last two weeks; if one is the same subject, resolve this one and say there instead:",
                ...related.map(
                  (item) => `  #${item.number} ${state(item)}  ${item.title}`,
                ),
              ]
            : []),
        ].join("\n"),
      ),
    );
    return 0;
  }
  if (action === "find") {
    const words = rest.join(" ");
    if (!words.trim())
      throw new DaedalusError(
        "VALIDATION",
        'Usage: daedal thread find "<words>" [--since 14d] [--all]',
      );
    const all = parsed.flags.has("all");
    const hits = context.threads.find(words, {
      ...(all ? { all: true } : { session: await session() }),
      ...(parsed.values.since ? { since: sinceTime(parsed.values.since) } : {}),
    });
    printResult(hits, json, () =>
      console.log(
        hits.length
          ? hits
              .map(
                ({ thread, match }) =>
                  `${summary(thread)}\n  matched: ${firstLine(match.body)}`,
              )
              .join("\n\n")
          : `No thread matches '${words}'${parsed.values.since ? "" : ` in the last ${THREAD_FIND_DAYS} days; --since looks further back`}.`,
      ),
    );
    return 0;
  }
  if (action === "list") {
    const threads = parsed.flags.has("all")
      ? context.threads.list()
      : context.threads.list({
          session: await session(),
          team: parsed.flags.has("team"),
        });
    printResult(threads, json, () =>
      console.log(
        threads.length
          ? threads.map(summary).join("\n\n")
          : "No threads open or resolved in the last day.",
      ),
    );
    return 0;
  }
  const id = number(rest[0], `daedal thread ${action} <n>`);
  if (action === "read") {
    const reader = parsed.values.session
      ? parsed.values.session
      : (await caller().catch(() => undefined))?.id;
    const thread = context.threads.readAs(id, reader);
    const conversation = await context.threads.forkConversation(id);
    printResult({ ...thread, fork: conversation }, json, () => {
      console.log(describe(thread));
      if (thread.forkSessionId)
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
    });
    return 0;
  }
  if (action === "say") {
    const text = await details();
    const wasResolved = Boolean(context.threads.get(id).resolvedAt);
    const { thread } = await context.threads.say(id, {
      as: await session(),
      body: rest.slice(1).join(" "),
      ...(options.length ? { options } : {}),
      ...(text !== undefined ? { details: text } : {}),
    });
    printResult(thread, json, () =>
      console.log(
        `Wrote in thread #${thread.number}${wasResolved ? " and reopened it" : ""}.`,
      ),
    );
    return 0;
  }
  if (action === "bump") {
    const { thread, bumped } = context.threads.bump(id, await session());
    printResult({ thread, bumped }, json, () =>
      console.log(
        bumped
          ? `Thread #${thread.number} marked blocking; the user is told once.`
          : `Thread #${thread.number} is marked blocking already; wait for the user's reply.`,
      ),
    );
    return 0;
  }
  if (action === "resolve") {
    const reason = rest.slice(1).join(" ");
    const thread = await context.threads.resolve(id, {
      by: await session(),
      ...(reason ? { reason } : {}),
    });
    printResult(thread, json, () =>
      console.log(`Resolved thread #${thread.number}.`),
    );
    return 0;
  }
  throw new DaedalusError(
    "VALIDATION",
    `'daedal thread ${action}' runs from a fork's hook, not by hand`,
  );
}

/**
 * `daedal ask` and `daedal activity`, the names threads had before. Like
 * the old thread commands they fail, write nothing, and print what to run.
 */
export function oldThreadAlias(args: string[]): string | undefined {
  const [first, ...rest] = args;
  if (first !== "ask" && first !== "activity") return undefined;
  const renamed: Record<string, string> = {
    ask: "start",
    withdraw: "close",
    show: "show",
    update: "update",
    resolve: "resolve",
    close: "close",
  };
  const sub = rest[0];
  const thread =
    first === "ask" && sub && !renamed[sub] && sub !== "list" && sub !== "bump"
      ? ["start", ...rest]
      : sub && renamed[sub]
        ? [renamed[sub]!, ...rest.slice(1)]
        : undefined;
  const message = thread ? oldThreadCommand(thread) : undefined;
  return (
    message ??
    [
      `Daedalus ${MESSAGING_CHANGED_IN} changed thread commands; 'daedal ${first}' is gone and your instructions are older.`,
      `Nothing was written. Run instead: daedal thread ${sub ?? "--help"}${rest.length > 1 ? ` ${rest.slice(1).map(shellWord).join(" ")}` : ""}`,
      "Run 'daedal thread --help' for the current commands.",
    ].join("\n")
  );
}
