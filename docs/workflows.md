# Workflows

A workflow is the order an agent works in: a short list of steps such as plan,
build, prove, ship. When workflows are on, an agent picks one of yours before
the first command of a request, reports each step as it goes, and the
session's Workflow pane in the side panel shows the steps as a checklist. A
step marked `gate: result` waits for you to approve what came out of it, and
one marked `gate: start` waits for your go-ahead before it starts. The agent
asks in the conversation, and the pane tags the step REVIEW or START and says
what it waits for and that you answer in the session. `user` and `before`
are the old names for `result` and `start` and still work.

Workflows are off until you turn them on in Settings › Sessions › "Run work in
workflows". Edit them in the Workflows tab (the Workflow pane's "Open ↗"), or
ask an agent to change one.

## Where they live

Everything is markdown in the `workflows` folder of the Daedalus home
(`~/.daedalus/workflows`):

| File              | What it holds                                                 |
| ----------------- | ------------------------------------------------------------- |
| `flows/<name>.md` | one workflow: when it fits and its steps                      |
| `steps/<name>.md` | one step: what the agent does in it, shared by every workflow |
| `CHOOSING.md`     | your rules for picking a workflow, which agents read in order |

A new home starts with `CHOOSING.md` and empty `flows/` and `steps/` folders.
With no workflow of yours, an agent names its own steps for each piece of
work (a dynamic workflow) and offers to save one when the same kind of work
comes back.

### A workflow file

| Field         | Meaning                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| `name`        | the file's name, used by `daedal workflow start <name>`                                                     |
| `description` | one line on what it does                                                                                    |
| `when`        | the work it fits; agents read this when choosing                                                            |
| `steps`       | `[a, b, c]`, each a file in `steps/` or `@name` for another workflow, or `dynamic` for steps named each run |
| `loop`        | optional: the step to go back to after the last one, for work done in rounds                                |
| `until`       | optional, with `loop`: when to stop going round                                                             |

The body is optional and goes to the agent when the run starts.

### A step file

| Field         | Meaning                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | the file's name, used in a workflow's `steps` list                                                                                             |
| `description` | one line on what the step is for                                                                                                               |
| `gate`        | optional: `result` waits for you to approve the step's result (tagged REVIEW); `start` waits for your go-ahead before it starts (tagged START) |

The body is what the agent does in the step. It can be one line naming a
command or a skill.

A run copies its workflow when it starts, so editing a file changes the next
run, not one already going. The Workflows tab refuses to save a file a run
could not use and says why; `daedal workflow list` marks such files with `!`.

### Sub-workflows

A workflow's `steps` can include another workflow with `@name`. Write the
shared part once, such as release, and include it wherever it belongs:

```markdown
steps: [plan, prototype, build, @release, feedback]
```

Any workflow can be started on its own or included. When a run starts, each
`@name` is replaced by that workflow's steps, so the run is one list and its
progress counts every step. The Workflow pane shows the included workflow as
a heading with its steps under it.

- **Step ids.** An included step's id names its workflow: `release/review`,
  and `a/b/review` when `a` includes `b`. Agents report that id
  (`daedal workflow step release/review start`). A bare `review` works too
  while only one step in the run has that name; when two do, the command is
  refused and lists both.
- **Gates** work as they do anywhere: the included step waits for you.
- **Loops.** An included workflow's own `loop` goes round inside it only.
  When its last step finishes, it goes back to its loop step; the agent
  leaves the loop by starting the step after it. A `loop: @name` in the
  including workflow goes back to that workflow's first step.
- **Not allowed.** A workflow that includes itself, directly or through
  another, and nesting more than 3 workflows deep (`a/b/c/step` is the
  deepest). The Workflows tab refuses to save either and names the chain;
  `daedal workflow list` marks it with `!`. An `@name` with no workflow
  file, or naming a `steps: dynamic` workflow, is marked the same way and
  the run does not start: a dynamic workflow has no steps to include.
- A workflow another one includes cannot be deleted until `@name` is taken
  out of it.

## Examples

Copy any of these into your `workflows` folder, or paste them into a new
workflow or step in the Workflows tab, and change them to fit how you work.
A step used by several workflows is shown once, under the first.

### do: small work with steps named each run

For a question, a check, or a change that will not be merged. The agent names
two to five steps when it starts.

`flows/do.md`

```markdown
---
name: do
description: Small work, with the steps you name for it.
when: A question, a check, or a change that will not be merged.
steps: dynamic
---

Name your steps when you start: two to five short verbs in the order you will do them, such as --steps find-print,change-it,run-test. Mark each one as you go so the user can follow. When the plan changes, add or remove steps with daedal workflow add and remove.
```

### change: build, prove, ship

For a small change that will be merged and has no design choice in it.

`flows/change.md`

```markdown
---
name: change
description: Build a small change, prove it, ship it.
when: A small change to a repository that will be merged, with no design choice to make.
steps: [build, proof, ship]
---
```

`steps/build.md`

```markdown
---
name: build
description: Build it properly.
---

Make the real change. Follow the repository's instructions, replace any prototype's shortcuts, and add tests for the new behavior. Run the full test and type checks, then run the code-review skill on the diff if it is installed and fix what it finds.
```

`steps/proof.md`

```markdown
---
name: proof
description: Show the user it works where they can try it.
gate: result
---

Put the change where the user can try it: relaunch the dev app, deploy to the dev environment, or run the command. Say in a few lines what to look at and what should happen. If the user asks for changes, start the step that makes them again and come back here. The step is done when the user says it works.
```

`steps/ship.md`

```markdown
---
name: ship
description: Get the change merged and out.
---

Commit, push and open a pull request, and give its full URL. Wait for CI. Read every review comment, fix or answer each one, and push again until CI is green and no thread is open. The user merges. Then release, or deploy and promote from dev to stage to prod, as the repository's instructions say, checking each environment before the next.
```

### release: review, prove, ship

The end of every change that ships, written once and included by feature
and bug with `@release`. It also runs on its own, for a branch that is
already built.

`flows/release.md`

```markdown
---
name: release
description: Review the change, prove it works, ship it.
when: A built change that is ready to review and ship.
steps: [review, proof, ship]
---
```

`steps/review.md`

```markdown
---
name: review
description: Review the diff before anyone else does.
---

Read the whole diff as a reviewer would. Run the code-review skill on it if it is installed, fix what it finds, and run the full test and type checks again.
```

### feature: plan, prototype, build, release, watch

For a new feature or a larger change. Prototype waits for your approval,
and release's proof step for your word that it works. A run of it lists
`release/review`, `release/proof` and `release/ship` under a release
heading.

`flows/feature.md`

```markdown
---
name: feature
description: Plan, prototype, build, release, then watch it in use.
when: A new feature or a larger change that ships.
steps: [plan, prototype, build, @release, feedback]
---
```

`steps/plan.md`

```markdown
---
name: plan
description: Agree what to build before building it.
---

Read the code, docs and history the work touches. Write the plan in a few lines: what changes, what stays, and how you will prove it works. Where a choice is open, give two or three options and recommend one. Finish with the plan as the step's note; the next step waits for the user's approval.
```

`steps/prototype.md`

```markdown
---
name: prototype
description: Build the smallest version that proves the approach.
gate: result
---

Build only the path that shows the approach works end to end, and mark its shortcuts. Show it to the user, by running it, a screenshot or a code snippet of how it is used, and adjust before building the rest.
```

`steps/feedback.md`

```markdown
---
name: feedback
description: Watch the shipped work in the form users get, and go back if it falls short.
---

Check the work where it runs: the installed app, the logs and metrics of the deployed service (with the CLI the workspace names, such as the Coralogix CLI), its errors, and what the user reports. Compare that with the goal. If it falls short, write down what you found and start the step that fixes it again, build or fix. If it holds, finish with a note of the evidence.
```

### bug: reproduce, find the cause, fix, release, watch

For something broken, failing, slow or behaving wrong.

`flows/bug.md`

```markdown
---
name: bug
description: Reproduce, find the cause, fix, release, then watch it stays fixed.
when: Something broken, failing, slow or behaving wrong.
steps: [reproduce, root-cause, fix, @release, feedback]
---
```

`steps/reproduce.md`

```markdown
---
name: reproduce
description: Make the bug happen, or find the evidence that it happened.
---

Gather the symptom first-hand: run the steps, read the app or service logs, query logs and metrics with the workspace's CLI tools, and look at any screenshot. Write down the exact symptom, when it started and what changed around then. Change no code yet.
```

`steps/root-cause.md`

```markdown
---
name: root-cause
description: Find why it happens, with evidence.
---

Trace the symptom to its cause in code, config or data, and show the evidence: the log line, the commit, the reproduction. Explain it to the user in a few lines. If no code change is needed, because it is a setting, the environment or already fixed, say so and end the run with daedal workflow end --note.
```

`steps/fix.md`

```markdown
---
name: fix
description: Fix the cause with the smallest change.
---

Change only what the cause needs. Add a test that fails without the fix and passes with it, then run the full test and type checks.
```

### research: settle a question before building

For a question to settle or a choice to make. The decide step waits for your
pick.

`flows/research.md`

```markdown
---
name: research
description: Settle a question with proven practice and the user's decision.
when: A question to settle or a choice to make before building.
steps: [frame, survey, options, decide, record]
---
```

`steps/frame.md`

```markdown
---
name: frame
description: Name the question and the decision it feeds.
---

Write the question in one sentence, the decision it will settle, and what is out of scope. Ask the user about anything unclear before searching.
```

`steps/survey.md`

```markdown
---
name: survey
description: Find how this is solved already.
---

Look for proven practice before inventing anything: primary documentation, standards, how well-known projects solve it, and the current code. Cite each source by link or path.
```

`steps/options.md`

```markdown
---
name: options
description: Lay out the choices and recommend one.
---

Give two or three options. For each, say what it costs, what it gives up and where it is used in practice, then recommend one. Answer the user's questions about them here.
```

`steps/decide.md`

```markdown
---
name: decide
description: The user picks an option.
gate: result
---

Write down the option the user chose and why, in one line.
```

`steps/record.md`

```markdown
---
name: record
description: Write the result down where it lasts.
---

Write the finding and the decision to the workspace's artifacts folder, or to an artifact if the user wants to share it, and link it from the journal. Offer to hand the build to a new session or task.
```

### Choosing rules

`CHOOSING.md` with rules for the examples above, most specific first:

```markdown
# Choosing a workflow

- Something broken, failing or slow: bug.
- A question to settle or a choice to make before building: research.
- A new feature or a change with a design choice in it: feature.
- A small change that will be merged: change.
- A question, a check, or a change that will not be merged: do.
- No workflow fits: build a dynamic workflow for this work with
  `daedal workflow start --steps <a,b,...>`.
```

## Commands

Agents run these through the daedalus-workflows skill; you can run them too.
`daedal workflow --help` lists every option.

| Command                                         | What it does                                     |
| ----------------------------------------------- | ------------------------------------------------ |
| `daedal workflow list`                          | the choosing rules and every workflow            |
| `daedal workflow start <name>`                  | starts a run of a workflow in this session       |
| `daedal workflow start --steps a,b --name <x>`  | starts a dynamic run with steps named for it     |
| `daedal workflow step <step> start\|done\|skip` | reports a step, with `--note` saying what or why |
| `daedal workflow approve [<step>]`              | records the user's approval of a gated step      |
| `daedal workflow end --note "<why>"`            | ends the run                                     |
| `daedal workflow save <name> --when "<work>"`   | saves this run as a workflow                     |
