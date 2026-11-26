import {
  DaedalusError,
  includedWorkflow,
  jobChildren,
  workflowOfJobSource,
  type ApplicationContext,
} from "@daedalus/core";
import { jobTreeLines } from "./job";
import { expectPositionals, parseArguments, printResult } from "./arguments";

export const workflowHelp = `Workflow commands. A workflow is an ordered list of steps kept as files:
  daedal workflow list
  daedal workflow show <workflow>
  daedal workflow start <workflow> [--steps <a,b,...>] [--replace | --inside]
  daedal workflow start --steps <a,b,...> [--name <label>] [--loop <step>] [--until "<text>"] [--replace | --inside]
  daedal workflow save <name> [--when "<text>"] [--description "<text>"]
  daedal workflow memory <step>
  daedal workflow remember <step> "<instruction>" --why "<what happened>" [--only <workflow>]
  daedal workflow forget <step> <number>
  daedal workflow promote <step> <number>
Every command but list and show takes [--session <agent-id>].

Workflows and their steps are markdown files in the workflows folder of the
Daedalus home: flows/<name>.md lists a workflow's steps, steps/<name>.md says
what to do in one, and CHOOSING.md holds the rules for picking a workflow.
A step file may declare what the step hands over and what it waits for:
  gives: [branch: commit, tests: number]
  needs: [design]
Left out, a step gives only its result and needs the step before it.
'list' shows every workflow with when it fits, and any file that does not
parse. 'show' prints a workflow with each step's instructions.

'start' adds the workflow's steps as jobs under the job this session is
on and prints the first step's brief. From there the work is reported with
'daedal job': 'job done' finishes a step and prints the next one's brief,
'job next' prints the current brief again, 'job tree' shows the whole run.
A session is in one workflow at a time. --replace skips what is left of
the one it is in; --inside starts this one as part of the step it is on.

Steps of your own: 'start --steps a,b,c' builds a run for this work with no
workflow file. A workflow file with 'steps: dynamic' has no fixed steps:
start it by name and list yours with --steps. A step with a file brings its
instructions; any other name is this run's own step. --loop <step> makes
the run go back to that step after its last one, until you end it with
'daedal job done --job <label> --result "<why it stops>"'.
'save' writes the workflow this session is in as a maintained workflow,
with a step file for each step that has none.

Sub-workflows: a workflow's steps can include another workflow as @name,
such as steps: [plan, build, @release]. It becomes one job among the steps,
with its own steps under it.

Gates: a step with 'gate: result' needs the user to approve its result.
'job done' holds it instead of finishing it; ask the user and stop, and run
'daedal job approve' on their word. A step with 'gate: start' waits for the
user's go-ahead before it starts.

A saved step keeps a memory of what earlier runs learned about that kind
of work, in steps/<step>.memory.md. 'remember' proposes one: an instruction
the next agent can act on, and --why, one sentence of what happened. Only
what is true of the step wherever it runs belongs there; something about
one repository goes in that repository's instructions. A proposal applies
once the user accepts it; accepted memories come with the step's brief.
'memory' lists them by number, 'forget' removes one, 'promote' moves one
into the step's own instructions.`;

/**
 * The state commands the job engine replaced, each with what to run now. A
 * session started before the change is told once and goes on.
 */
export const REPLACED_WORKFLOW_COMMANDS: Record<string, string> = {
  step: 'Steps start by themselves now. Finish the one you are on with `daedal job done --result "<what came out>"`, which prints the next one. Skip one with `daedal job skip <step> --why "<why>"`, go back to one with `daedal job redo <step> --why "<why>"`, and print your current step with `daedal job next`.',
  approve: "Run `daedal job approve` on the user's word.",
  end: 'End a workflow that goes round with `daedal job done --job <workflow> --result "<why it stops>"`. Drop what is left of any other with `daedal job skip <workflow> --why "<why>"`.',
  add: 'Add a step with `daedal job add "<title>" --me`.',
  remove: 'Take a step out with `daedal job skip <step> --why "<why>"`.',
  status:
    "Run `daedal job tree` for the whole run, or `daedal job next` for the step you are on.",
};

const stepList = (value: string): string[] =>
  value
    .split(",")
    .map((step) => step.trim())
    .filter(Boolean);

export async function workflowCommand(
  context: ApplicationContext,
  args: string[],
  json: boolean,
  currentSessionId: (explicit?: string) => Promise<string>,
): Promise<number> {
  const action = args.shift();
  if (!action || action === "help") {
    console.log(workflowHelp);
    return 0;
  }
  if (Object.hasOwn(REPLACED_WORKFLOW_COMMANDS, action))
    throw new DaedalusError(
      "VALIDATION",
      `'daedal workflow ${action}' is gone. ${REPLACED_WORKFLOW_COMMANDS[action]}`,
    );
  const parsed = parseArguments(
    args,
    [
      "session",
      "note",
      "steps",
      "name",
      "loop",
      "until",
      "why",
      "only",
      "after",
      "description",
      "when",
    ],
    ["replace", "gate", "inside"],
  );
  const { note, description } = parsed.values;
  if (action === "list") {
    expectPositionals(parsed.positionals, 0, "daedal workflow list");
    const catalog = await context.workflows.catalog();
    printResult(catalog, json, () => {
      // The rules first: this one call is all an agent needs to choose.
      if (catalog.choosing.trim()) console.log(`${catalog.choosing.trim()}\n`);
      if (!catalog.workflows.length) console.log("No workflows");
      for (const workflow of catalog.workflows) {
        const loop = workflow.loop ? ` ↻ ${workflow.loop}` : "";
        console.log(
          `${workflow.name}: ${workflow.dynamic ? "steps you name with --steps" : workflow.steps.join(" → ")}${loop}`,
        );
        if (workflow.when) console.log(`  when: ${workflow.when}`);
        if (workflow.until) console.log(`  until: ${workflow.until}`);
      }
      if (catalog.tools.length) {
        // A step's brief names the tools it suggests; these are all of them.
        console.log("\nTools ('daedal tool show <name>' prints one):");
        for (const tool of catalog.tools)
          console.log(
            `  ${tool.name}${tool.description ? `: ${tool.description}` : ""}`,
          );
      }
      for (const problem of catalog.problems)
        console.log(`! ${problem.path}: ${problem.message}`);
    });
    return 0;
  }
  if (action === "show") {
    expectPositionals(parsed.positionals, 1, "daedal workflow show <workflow>");
    const { workflow, steps } = await context.workflows.show(
      parsed.positionals[0]!,
    );
    const catalog = await context.workflows.catalog();
    printResult({ workflow, steps }, json, () => {
      console.log(`# ${workflow.name}`);
      if (workflow.description) console.log(workflow.description);
      if (workflow.when) console.log(`When: ${workflow.when}`);
      if (workflow.dynamic)
        console.log("Steps: none fixed; name yours with --steps at start");
      if (workflow.loop)
        console.log(
          `Circular: after the last step, back to '${workflow.loop}'${workflow.until ? `, until: ${workflow.until}` : ""}`,
        );
      if (workflow.body) console.log(`\n${workflow.body}`);
      workflow.steps.forEach((name, index) => {
        const step = steps[index];
        const included = includedWorkflow(name);
        if (included !== null) {
          const found = catalog.workflows.find(
            (item) => item.name === included,
          );
          console.log(`\n## ${index + 1}. ${name} (workflow)`);
          console.log(
            found
              ? `${found.dynamic ? "steps: dynamic" : found.steps.join(" → ")}; 'daedal workflow show ${included}' for its steps`
              : "(no workflow file)",
          );
          return;
        }
        console.log(
          `\n## ${index + 1}. ${name}${step?.gate ? ` [gate: ${step.gate}]` : ""}`,
        );
        console.log(step ? step.body : "(no step file)");
      });
    });
    return 0;
  }
  const sessionId = await currentSessionId(parsed.values.session);
  if (action === "start") {
    const named = parsed.positionals.length > 0;
    if (!named && parsed.values.steps === undefined)
      throw new DaedalusError(
        "VALIDATION",
        "Usage: daedal workflow start <workflow>, or start --steps <a,b,...> for steps of your own",
      );
    expectPositionals(
      parsed.positionals,
      named ? 1 : 0,
      named
        ? "daedal workflow start <workflow> [--steps <a,b,...>] [--replace | --inside]"
        : "daedal workflow start --steps <a,b,...> [--name <label>] [--loop <step>] [--until <text>]",
    );
    if (parsed.flags.has("replace") && parsed.flags.has("inside"))
      throw new DaedalusError(
        "VALIDATION",
        "Pass --replace or --inside, not both",
      );
    const started = await context.jobIntake.startWorkflow({
      sessionId,
      ...(parsed.values.steps === undefined
        ? {}
        : { steps: stepList(parsed.values.steps) }),
      ...(named ? { workflow: parsed.positionals[0]! } : {}),
      ...(parsed.values.name ? { name: parsed.values.name } : {}),
      ...(parsed.values.loop ? { loop: parsed.values.loop } : {}),
      ...(parsed.values.until ? { until: parsed.values.until } : {}),
      replace: parsed.flags.has("replace"),
      inside: parsed.flags.has("inside"),
    });
    printResult(
      { job: started.job, brief: started.brief, notes: started.notes },
      json,
      () => {
        // The workflow alone, not the whole tree it is in.
        const under = new Map(
          [...started.tree.jobs].filter(([, job]) => {
            for (
              let at: typeof job | undefined = job;
              at;
              at = at.parentId ? started.tree.jobs.get(at.parentId) : undefined
            )
              if (at.id === started.job.id) return true;
            return false;
          }),
        );
        const top = under.get(started.job.id);
        if (top) under.set(top.id, { ...top, parentId: null });
        const here = context.jobs.current(sessionId)?.job.id;
        for (const line of jobTreeLines({ jobs: under }, here ? { here } : {}))
          console.log(line);
        if (started.job.loop)
          console.log(
            `It goes round${started.job.loop.until ? ` until: ${started.job.loop.until}` : ""}. End it with \`daedal job done --job ${started.job.name} --result "<why it stops>"\`.`,
          );
        if (started.notes) console.log(`\n${started.notes}`);
        if (started.brief) console.log(`\n${started.brief}`);
        else
          console.log(
            "\nIts first step has not started. `daedal job next` says what waits.",
          );
      },
    );
    return 0;
  }
  if (action === "save") {
    expectPositionals(
      parsed.positionals,
      1,
      'daedal workflow save <name> [--when "<text>"] [--description "<text>"]',
    );
    const open = context.jobIntake.workflowOf(sessionId);
    if (!open)
      throw new DaedalusError(
        "NOT_FOUND",
        "This session is in no workflow. Save one while it runs.",
      );
    const steps = jobChildren(open.tree, open.job.id);
    const saved = await context.workflows.saveAs({
      name: parsed.positionals[0]!,
      ...(parsed.values.when ? { when: parsed.values.when } : {}),
      ...(description ? { description } : {}),
      steps: steps.map((step) => ({
        entry: workflowOfJobSource(step.source) ? `@${step.name}` : step.name,
        gate: step.gate,
        text: step.instructions || step.result || "",
      })),
      loop: open.job.loop?.to ?? null,
      until: open.job.loop?.until ?? "",
    });
    printResult(saved, json, () => {
      console.log(`Saved workflow '${saved.workflow}':`);
      for (const path of saved.written) console.log(`  ${path}`);
    });
    return 0;
  }
  if (action === "memory") {
    expectPositionals(parsed.positionals, 1, "daedal workflow memory <step>");
    const memory = await context.workflows.stepMemory(parsed.positionals[0]!);
    printResult(memory, json, () => {
      if (!memory.memories.length)
        console.log(`The ${memory.step} step has no memory yet`);
      memory.memories.forEach((item, index) =>
        console.log(
          `${index + 1}. [${item.status}] ${item.text}\n   why: ${item.why}\n   seen: ${item.runs} ${item.runs === 1 ? "run" : "runs"}, last ${item.lastSeen}${item.workflow ? ` (${item.workflow})` : ""}${item.only ? `\n   only: ${item.only}` : ""}`,
        ),
      );
    });
    return 0;
  }
  if (action === "remember") {
    const usage =
      'daedal workflow remember <step> "<instruction>" --why "<what happened>"';
    expectPositionals(parsed.positionals, 2, usage);
    if (!parsed.values.why)
      throw new DaedalusError("VALIDATION", `Usage: ${usage}`);
    // Outside a session nothing names the run it was learned in.
    const sessionId = await currentSessionId(parsed.values.session).catch(
      () => undefined,
    );
    const memory = await context.workflows.rememberStep({
      step: parsed.positionals[0]!,
      text: parsed.positionals[1]!,
      why: parsed.values.why,
      workflow: sessionId
        ? (workflowOfJobSource(
            context.jobIntake.workflowOf(sessionId)?.job.source ?? null,
          ) ?? null)
        : null,
      ...(parsed.values.only ? { only: parsed.values.only } : {}),
    });
    printResult(memory, json, () =>
      console.log(
        `Proposed for the ${memory.step} step. It applies once the user accepts it, in the app's Workflows tab.`,
      ),
    );
    return 0;
  }
  if (action === "accept") {
    // Accepting is the user's: an agent that could accept its own proposal
    // would make the proposal step mean nothing.
    throw new DaedalusError(
      "VALIDATION",
      "The user accepts a step's memory in the app's Workflows tab; agents propose with 'daedal workflow remember'",
    );
  }
  if (action === "forget" || action === "promote") {
    expectPositionals(
      parsed.positionals,
      2,
      `daedal workflow ${action} <step> <number>`,
    );
    const [step, reference] = parsed.positionals as [string, string];
    const memory =
      action === "forget"
        ? await context.workflows.forgetStepMemory(step, reference)
        : await context.workflows.promoteStepMemory(step, reference);
    printResult(memory, json, () =>
      console.log(
        action === "forget"
          ? `Forgotten. The ${memory.step} step keeps ${memory.memories.length}.`
          : `Moved into steps/${memory.step}.md and taken out of its memory.`,
      ),
    );
    return 0;
  }
  throw new DaedalusError(
    "VALIDATION",
    `Unknown workflow command '${action}'. Run 'daedal workflow help'.`,
  );
}
