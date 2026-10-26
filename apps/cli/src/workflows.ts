import {
  currentStepIndex,
  DaedalusError,
  describePosition,
  type ApplicationContext,
  type WorkflowRun,
  type WorkflowStepState,
} from "@daedalus/core";
import { expectPositionals, parseArguments, printResult } from "./arguments";

export const workflowHelp = `Workflow commands — the agent's place in its workflow:
  daedal workflow list
  daedal workflow show <workflow>
  daedal workflow start <workflow> [--steps <a,b,...>] [--replace]
  daedal workflow start --steps <a,b,...> [--name <label>] [--loop <step>] [--until "<text>"] [--replace]
  daedal workflow step <step> start|done|skip --note "<line>"
  daedal workflow add <step> [--after <step>] [--description "<text>"] [--gate]
  daedal workflow remove <step>
  daedal workflow approve [--note "<text>"]
  daedal workflow end [--note "<text>"]
  daedal workflow save <name> [--when "<text>"] [--description "<text>"]
  daedal workflow status
Every command but list and show takes [--session <agent-id>].

Workflows and their steps are markdown files in the workflows folder of the
Daedalus home: flows/<name>.md lists a workflow's steps, steps/<name>.md says
what to do in one, and CHOOSING.md holds the rules for picking a workflow.
'list' shows every workflow with when it fits, and any file that does not
parse. 'show' prints a workflow with each step's instructions.

A run belongs to the session doing the work, apart from any task, and a
rebirth hands it to the successor. 'start' fails while the session has an
open run; --replace ends it first.

Dynamic workflows: 'start --steps' assembles a run for this work, without
any workflow file; --steps "" starts it empty. A workflow file with
'steps: dynamic' has no fixed steps: start it by name and list yours with
--steps. A step with a file brings its instructions; any other name is this
run's own step, and its start note says what it is.
'add' puts a step into the open run only; --description gives a step with no
file its instructions. 'remove' takes out a step not yet started. None of this changes
a workflow file. 'save' writes the run as a maintained workflow, with a step
file for each step that has none.

Circular runs: a workflow with 'loop: <step>', or a dynamic workflow
started with --loop, goes back to that step when its last step finishes, and counts the
iterations. It runs until 'end'.

'step <step> start' marks the step you begin and finishes the one before.
It prints one line, so chain it onto the command the step runs anyway:
  daedal workflow step test start --note "Run the CLI tests" && bun test
A gated step that waits exits 4, so the chained command does not run.
Every step change takes --note, specific to this work: on start, what you
will do in the step; on done, what came out; on skip, why.
Starting a step that already ended goes back to it. A step with 'gate: user'
does not start: it waits for the user's approval and raises attention. Stop
and wait. The user approves in the session's Workflow pane, or tells you in
the conversation and you run 'approve'.`;

const STATE_MARK: Record<WorkflowStepState, string> = {
  pending: "·",
  waiting: "?",
  active: "▶",
  done: "✓",
  skipped: "–",
};

function runTitle(run: WorkflowRun): string {
  const tags = [
    run.dynamic ? "dynamic" : undefined,
    run.modified ? "changed for this run" : undefined,
    run.loopTo
      ? `loops to ${run.loopTo}, iteration ${run.iteration}`
      : undefined,
  ].filter(Boolean);
  const where = run.endedAt
    ? ` (ended${run.endNote ? `: ${run.endNote}` : ""})`
    : describePosition(run);
  return `${run.workflow}${tags.length ? ` [${tags.join("; ")}]` : ""}${where}`;
}

function printRun(run: WorkflowRun): void {
  const index = currentStepIndex(run);
  console.log(runTitle(run));
  if (run.until && !run.endedAt) console.log(`  until: ${run.until}`);
  run.steps.forEach((step, position) => {
    const tags = [step.gate ? "gate: user" : "", step.dynamic ? "no file" : ""]
      .filter(Boolean)
      .map((tag) => ` [${tag}]`)
      .join("");
    const said = step.note ?? step.plan;
    const note = said ? ` — ${said}` : "";
    const here = position === index && !run.endedAt ? "  ←" : "";
    console.log(
      `  ${STATE_MARK[step.state]} ${step.name}${tags}${note}${here}`,
    );
    if (step.dynamic && !said && step.description)
      console.log(`      ${step.description}`);
  });
}

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
  const parsed = parseArguments(
    args,
    [
      "session",
      "note",
      "steps",
      "name",
      "loop",
      "until",
      "after",
      "description",
      "when",
    ],
    ["replace", "gate"],
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
        console.log(
          `\n## ${index + 1}. ${name}${step?.gate ? " [gate: user]" : ""}`,
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
        "Usage: daedal workflow start <workflow>, or start --steps <a,b,...> for a dynamic workflow",
      );
    expectPositionals(
      parsed.positionals,
      named ? 1 : 0,
      named
        ? "daedal workflow start <workflow> [--steps <a,b,...>] [--replace]"
        : "daedal workflow start --steps <a,b,...> [--name <label>] [--loop <step>] [--until <text>]",
    );
    const steps =
      parsed.values.steps === undefined
        ? {}
        : { steps: stepList(parsed.values.steps) };
    const run = await context.workflows.start({
      sessionId,
      ...steps,
      ...(named
        ? { workflow: parsed.positionals[0]! }
        : {
            ...(parsed.values.name ? { name: parsed.values.name } : {}),
            ...(parsed.values.loop ? { loop: parsed.values.loop } : {}),
            ...(parsed.values.until ? { until: parsed.values.until } : {}),
          }),
      replace: parsed.flags.has("replace"),
    });
    // Every step's instructions come back with the start, so no second call
    // is needed before the first step.
    const { notes, steps: bodies } = await context.workflows.instructions(run);
    printResult({ run }, json, () => {
      printRun(run);
      if (notes.trim()) console.log(`\n${notes.trim()}`);
      bodies.forEach((step, index) => {
        // A step the agent named itself has no instructions to repeat.
        if (!step.body.trim()) return;
        console.log(
          `\n## ${index + 1}. ${step.name}${step.gate ? " [gate: user]" : ""}\n${step.body}`,
        );
      });
    });
    return 0;
  }
  if (action === "step") {
    const usage = 'daedal workflow step <step> start|done|skip --note "<line>"';
    expectPositionals(parsed.positionals, 2, usage);
    const stepAction = parsed.positionals[1];
    if (
      stepAction !== "start" &&
      stepAction !== "done" &&
      stepAction !== "skip"
    )
      throw new DaedalusError("VALIDATION", `Usage: ${usage}`);
    const outcome = await context.workflows.step({
      sessionId,
      step: parsed.positionals[0]!,
      action: stepAction,
      ...(note ? { note } : {}),
    });
    // A waiting gate fails the command, so whatever was chained after it
    // with && does not run.
    if (outcome.waiting)
      throw new DaedalusError(
        "CONFLICT",
        `Step '${parsed.positionals[0]}' waits for the user's approval. Attention is raised; stop and wait for it.`,
        { runId: outcome.run.id },
      );
    printResult(outcome, json, () => {
      // One line: an update is usually chained onto another command.
      const index = currentStepIndex(outcome.run);
      const step = outcome.run.steps[index];
      console.log(
        outcome.run.endedAt
          ? `workflow ${outcome.run.workflow} finished`
          : `workflow ${outcome.run.workflow}: ${STATE_MARK[step?.state ?? "pending"]} ${step?.name ?? ""} (${index + 1}/${outcome.run.steps.length})`,
      );
      if (outcome.looped)
        console.log(
          `Back to '${outcome.run.loopTo}' for iteration ${outcome.run.iteration}; run 'daedal workflow end' when it should stop${outcome.run.until ? `: ${outcome.run.until}` : ""}.`,
        );
    });
    return 0;
  }
  if (action === "add") {
    expectPositionals(
      parsed.positionals,
      1,
      'daedal workflow add <step> [--after <step>] [--description "<text>"] [--gate]',
    );
    const run = await context.workflows.add({
      sessionId,
      step: parsed.positionals[0]!,
      ...(parsed.values.after ? { after: parsed.values.after } : {}),
      ...(description ? { description } : {}),
      gate: parsed.flags.has("gate"),
    });
    printResult({ run }, json, () => printRun(run));
    return 0;
  }
  if (action === "remove") {
    expectPositionals(parsed.positionals, 1, "daedal workflow remove <step>");
    const run = context.workflows.remove({
      sessionId,
      step: parsed.positionals[0]!,
    });
    printResult({ run }, json, () => printRun(run));
    return 0;
  }
  if (action === "approve") {
    expectPositionals(parsed.positionals, 0, "daedal workflow approve");
    const outcome = await context.workflows.approveFor(sessionId, note);
    printResult({ run: outcome.run }, json, () => printRun(outcome.run));
    return 0;
  }
  if (action === "end") {
    expectPositionals(
      parsed.positionals,
      0,
      'daedal workflow end [--note "<text>"]',
    );
    const run = context.workflows.end({ sessionId, ...(note ? { note } : {}) });
    printResult({ run }, json, () => printRun(run));
    return 0;
  }
  if (action === "save") {
    expectPositionals(
      parsed.positionals,
      1,
      'daedal workflow save <name> [--when "<text>"] [--description "<text>"]',
    );
    const saved = await context.workflows.saveAs({
      sessionId,
      name: parsed.positionals[0]!,
      ...(parsed.values.when ? { when: parsed.values.when } : {}),
      ...(description ? { description } : {}),
    });
    printResult(saved, json, () => {
      console.log(`Saved workflow '${saved.workflow}':`);
      for (const path of saved.written) console.log(`  ${path}`);
    });
    return 0;
  }
  if (action === "status") {
    expectPositionals(parsed.positionals, 0, "daedal workflow status");
    const run = context.workflows.current(sessionId) ?? null;
    printResult({ run }, json, () => {
      if (run) printRun(run);
      else console.log("No workflow run yet");
    });
    return 0;
  }
  throw new DaedalusError(
    "VALIDATION",
    `Unknown workflow command '${action}'. Run 'daedal workflow help'.`,
  );
}
