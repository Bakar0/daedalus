import { readFile } from "node:fs/promises";
import {
  DaedalusError,
  findPlanTask,
  planProgress,
  planQuestions,
  sessionPlanHandle,
  type ApplicationContext,
  type AgentSession,
  type PlanDocument,
  type PlanFile,
  type PlanOwnerView,
  type PlanScope,
  type PlanTaskBodyPart,
  type PlanTaskState,
} from "@daedalus/core";
import { expectPositionals, parseArguments, printResult } from "./arguments";

export const planHelp = `Plan commands — plans/<slug>.plan.md files people and agents both edit:
  daedal plan new "<title>" [--workspace <workspace> | --home] [--owner <handle>] [--body-file <path>|-]
  daedal plan list [--workspace <workspace> | --home]
  daedal plan show <plan> [--workspace <workspace> | --home]
  daedal plan start <plan> ^<id> [--owner <handle>]
  daedal plan done|block|drop <plan> ^<id>
  daedal plan ask <plan> ^<id> "<question>"

<plan> is a plan's slug (cart-api-v2), its path, or its absolute path. A
command run in a Daedalus session finds plans in that session's workspace;
--workspace names another, --home means Home's plans folder.

A plan file is markdown. Frontmatter names it and its owner:
  ---
  plan: Cart API v2
  owner: checkout-lead
  ---
Under '## Tasks' is a nested checklist. Each task is one line:
  - [ ] Title @owner ^id
States: [ ] todo, [/] doing, [x] done, [!] blocked, [-] dropped. Keep a
title short and plain, what the task is in a few words ("Entra scans
stopped on 11-14"); the app lists titles on one line each. Any
markdown indented under a task is its details, the place for ids, links
and numbers; a '> ? ...' line there is a
question for the user. Every other section is free markdown. Edit the file
directly for anything these commands do not cover.

'new' writes the file with a skeleton, or with the body read from
--body-file ('-' reads stdin). The owner is --owner, else the calling
session's handle.
'start' marks a task [/] and puts the owner on it: --owner, else you.
'done', 'block' and 'drop' set [x], [!] and [-]. 'ask' asks the user, pinned to
the task, as 'daedal activity ask --plan' does; the app shows it under Activity.
An @owner is a session's team handle, or its name made into a handle
(a session called "Cart endpoints" answers to @cart-endpoints).`;

const MARK: Record<PlanTaskState, string> = {
  todo: "[ ]",
  doing: "[/]",
  done: "[x]",
  blocked: "[!]",
  dropped: "[-]",
};

const STATE_OF_ACTION: Record<string, PlanTaskState> = {
  start: "doing",
  done: "done",
  block: "blocked",
  drop: "dropped",
};

export function printPlan(
  file: PlanFile,
  plan: PlanDocument,
  owners: PlanOwnerView[],
  asks: ReadonlyArray<{ id: number; taskKey: string | null }> = [],
): void {
  // Open asks pinned to a task: the task waits on the user.
  const waiting = new Map(
    asks.flatMap((ask) => (ask.taskKey ? [[ask.taskKey, ask.id]] : [])),
  );
  const state = new Map(owners.map((owner) => [owner.handle, owner]));
  const chip = (handle: string | null) => {
    if (!handle) return "";
    const owner = state.get(handle);
    return ` @${handle}${owner && owner.state !== "none" ? ` (${owner.state})` : owner ? " (no session)" : ""}`;
  };
  const { done, total } = planProgress(plan);
  console.log(`# ${plan.title ?? file.path}`);
  console.log(
    `${file.absolutePath}\nowner:${chip(plan.owner) || " none"} · ${done} of ${total} tasks done`,
  );
  const questions = planQuestions(plan);
  if (questions.length) {
    console.log(`\nActivity (${questions.length}):`);
    for (const question of questions)
      console.log(
        `  ? ${question.text}  — ${question.task.title}${question.owner ? `, @${question.owner}` : ""}`,
      );
  }
  if (!plan.hasTasksSection) {
    console.log("\nNo '## Tasks' section yet.");
    return;
  }
  console.log("");
  const walk = (parts: readonly PlanTaskBodyPart[]) => {
    for (const part of parts) {
      if (part.kind !== "task") continue;
      const { task } = part;
      console.log(
        `${"  ".repeat(task.depth)}${MARK[task.state]} ${task.title}${chip(task.owner)}${task.id ? ` ^${task.id}` : ` (line ${task.line})`}${task.id && waiting.has(task.id) ? `  <- #${waiting.get(task.id)} waits on the user` : ""}`,
      );
      walk(task.body);
    }
  };
  walk(plan.blocks);
}

export async function planCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
  caller: () => Promise<AgentSession | undefined>,
): Promise<number> {
  const action = args.shift();
  if (!action || action === "help" || action === "--help") {
    console.log(planHelp);
    return 0;
  }
  const parsed = parseArguments(
    args,
    ["workspace", "owner", "body-file"],
    ["home"],
  );
  if (parsed.flags.has("home") && parsed.values.workspace)
    throw new DaedalusError(
      "VALIDATION",
      "Pass --workspace or --home, not both",
    );
  const scope = async (): Promise<PlanScope | undefined> => {
    if (parsed.flags.has("home")) return { home: true };
    if (parsed.values.workspace) return { workspace: parsed.values.workspace };
    const session = await caller();
    return session ? { workspace: session.workspaceId } : undefined;
  };
  const requireScope = async (): Promise<PlanScope> => {
    const found = await scope();
    if (!found)
      throw new DaedalusError(
        "VALIDATION",
        "--workspace or --home is required outside a Daedalus session",
      );
    return found;
  };

  if (action === "new") {
    expectPositionals(
      parsed.positionals,
      1,
      'daedal plan new "<title>" [--workspace <workspace> | --home]',
    );
    const bodyFile = parsed.values["body-file"];
    const body =
      bodyFile === undefined
        ? undefined
        : bodyFile === "-"
          ? await Bun.stdin.text()
          : await readFile(bodyFile, "utf8");
    const session = await caller();
    const owner =
      parsed.values.owner ?? (session ? sessionPlanHandle(session) : null);
    const file = await context.plans.create(await requireScope(), {
      title: parsed.positionals[0]!,
      owner,
      ...(body !== undefined ? { body } : {}),
    });
    printResult(file, json, () => console.log(`Wrote ${file.absolutePath}`));
    return 0;
  }

  if (action === "list") {
    expectPositionals(parsed.positionals, 0, "daedal plan list");
    const plans = await context.plans.list(await requireScope());
    printResult(plans, json, () => {
      if (!plans.length) console.log("No plans");
      for (const plan of plans)
        console.log(
          `${plan.path}\t${plan.title}\t${plan.done}/${plan.total} done${plan.questions ? `\t${plan.questions} for you` : ""}${plan.owner ? `\t@${plan.owner}` : ""}`,
        );
    });
    return 0;
  }

  const file = async (reference: string) =>
    context.plans.find(await scope(), reference);

  if (action === "show") {
    expectPositionals(parsed.positionals, 1, "daedal plan show <plan>");
    const found = await file(parsed.positionals[0]!);
    const { plan } = await context.plans.read(found);
    const owners = await context.plans.owners(found, plan);
    const asks = context.asks.onPlan(found.absolutePath);
    printResult({ file: found, plan, owners, asks }, json, () =>
      printPlan(found, plan, owners, asks),
    );
    return 0;
  }

  const state = STATE_OF_ACTION[action];
  if (state) {
    expectPositionals(
      parsed.positionals,
      2,
      `daedal plan ${action} <plan> ^<id>`,
    );
    const found = await file(parsed.positionals[0]!);
    let owner: string | undefined;
    if (action === "start") {
      owner = parsed.values.owner;
      if (!owner) {
        const session = await caller();
        if (session) owner = sessionPlanHandle(session);
      }
    } else if (parsed.values.owner)
      throw new DaedalusError("VALIDATION", "--owner goes with start");
    const plan = await context.plans.setState(
      found,
      parsed.positionals[1]!,
      state,
      owner,
    );
    const task = findPlanTask(plan, parsed.positionals[1]!);
    printResult({ file: found, task }, json, () =>
      console.log(
        `${MARK[task.state]} ${task.title}${task.owner ? ` @${task.owner}` : ""}`,
      ),
    );
    return 0;
  }

  if (action === "ask") {
    if (parsed.positionals.length < 3)
      throw new DaedalusError(
        "VALIDATION",
        'Usage: daedal plan ask <plan> ^<id> "<question>"',
      );
    const found = await file(parsed.positionals[0]!);
    const session = await caller();
    if (!session)
      throw new DaedalusError(
        "VALIDATION",
        'Ask from the session that waits on the answer, or use daedal activity ask "<question>" --session <session> --plan <plan> ^<id>',
      );
    const { ask } = await context.asks.create({
      session: session.id,
      title: parsed.positionals.slice(2).join(" "),
      plan: found.absolutePath,
      task: parsed.positionals[1]!,
    });
    printResult({ file: found, ask }, json, () =>
      console.log(
        `Asked #${ask.id}, pinned to ^${ask.taskKey}; the user sees it under Activity. Add context with 'daedal activity update ${ask.id} --context "..."'.`,
      ),
    );
    return 0;
  }

  throw new DaedalusError(
    "VALIDATION",
    `Unknown plan command '${action}'; see 'daedal plan --help'`,
  );
}
