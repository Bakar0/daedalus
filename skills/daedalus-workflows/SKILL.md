---
name: daedalus-workflows
description: Run work in one of the user's Daedalus workflows, reporting each step by chaining `daedal workflow step <step> start --note "..." && <command>` onto commands you run anyway. Start with `daedal workflow list` (rules and workflows in one call), then `daedal workflow start <name>`. Use before the first command of a request when the user or their instructions say work runs in a workflow, when `daedal workflow status` shows a run already started for you, and when the user wants a workflow, a step or the choosing rules changed.
argument-hint: "[workflow name, or what to change]"
---

# Workflows

A workflow is an ordered list of steps (plan, build, ship). Its files
live in `{{workflows}}`: `flows/<name>.md` (frontmatter `name`, `description`,
`when`, `steps: [a, b]` or `steps: dynamic`, optional `loop: <step>` and
`until`), `steps/<name>.md`
(frontmatter `name`, `description`, optional `gate: start` or `gate: result`;
the body is what to do), and `CHOOSING.md` (the user's rules for picking one). A **run** is this
session's copy, shown as a checklist in its Workflow pane. Changing a run never
changes a file. The CLI is `{{daedal}}`, written `daedal` below.

$ARGUMENTS

## Start

1. `daedal workflow status`. A run already open (Daedalus may have started
   one for you, or a predecessor did) is yours: go to "Report".
2. `daedal workflow list` prints the choosing rules and every workflow.
   - One fits: `daedal workflow start <name>`.
   - It says `steps: dynamic`: name your own steps, two to
     five short verbs in order:
     `daedal workflow start do --steps find-print,change-it,run-test`.
     A name with no step file is this run's own; its start note says what it is.
   - It fits but needs a step more or less: start it, then
     `daedal workflow add <step> [--after <step>]` or
     `daedal workflow remove <step>`.
   - None fits, a one-off: a **dynamic workflow**:
     `daedal workflow start --steps survey,check --name <label>`.
     `--loop <step> --until "<...>"` for work done in rounds.
   - None fits and it will come back, or two fit equally: ask the user with
     `daedal attention`.
3. `start` prints every step's instructions. They are the user's and come
   before your habits; when one conflicts with the request, the request wins.

Start before you look into the request. One that turns out to need nothing
still gets its run, ended with `daedal workflow end --note "<what you found>"`.

## Report

Chain each update onto the command the step runs anyway, so it costs no turn:

```
daedal workflow step test start --note "Run the CLI tests" && bun test apps/cli
daedal workflow step test done --note "212 pass" && daedal workflow step ship start --note "Open the PR for the version fix"
```

`--note` is about this work, not the template: on `start` what you will do in
the step, on `done` what came out, on `skip` why. The user reads it in the
pane. Starting a step finishes the one before; starting an earlier step goes
back to it.

- **Gates.** A step with `gate: result` (old name `user`) needs the user to
  approve its result.
  Do the step, then `daedal workflow step <step> done --note "<what to
approve>"`: the step waits, attention is raised, the command exits 4, and no
  other step starts. Show the user what to approve, ask in the conversation,
  and end your turn. When they approve, run `daedal workflow approve`, which
  marks the step done, and go on. When they want changes, start the step again
  and do them. A step with `gate: start` (old name `before`) waits when it starts: say what you
  will do there, ask, and end your turn; after their yes, run
  `daedal workflow approve` and do the step. Never approve on the user's
  behalf.
- **Loops.** A circular run goes back to its loop step after the last one.
  Each time round, check `until`; when it holds or the user says stop,
  `daedal workflow end --note "<why>"`.

## Keep and improve

When a dynamic or changed run worked and the work will come back, ask the
user, then `daedal workflow save <name> --when "<what work it fits>"` and add
a rule for it to `CHOOSING.md`. When the user wants a workflow, a step or a
rule changed, edit the file it belongs in (reuse steps before writing new
ones), then run `daedal workflow list`: done when it shows no `!` lines. Open
runs keep their copy; changes apply from the next run.
