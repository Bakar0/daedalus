---
name: daedalus-workflows
description: Run work in one of the user's Daedalus workflows. Start with `daedal workflow list` (rules and workflows in one call), then `daedal workflow start <name>`; finish each step with `daedal job done --result "<what came out>"`, which prints the next step's brief. Use before the first command of a request when the user or their instructions say work runs in a workflow, when `daedal job tree` shows workflow steps already open for you, and when the user wants a workflow, a step or the choosing rules changed.
argument-hint: "[workflow name, or what to change]"
---

# Workflows

A workflow is an ordered list of steps (plan, build, ship). Its files
live in `{{workflows}}`: `flows/<name>.md` (frontmatter `name`, `description`,
`when`, `steps: [a, b]` or `steps: dynamic`, optional `loop: <step>` and
`until`; `@name` in `steps` includes another workflow), `steps/<name>.md`
(frontmatter `name`, `description`, optional `gate: start` or `gate: result`,
optional `gives: [branch: commit, tests: number]`, `needs: [design]` and
`tools: [aws-access]`; the body is what to do), `tools/<name>.md` (frontmatter
`name`, `description`; the body is how to use one thing, such as a login or a
CLI), and `CHOOSING.md` (the user's rules for picking one). A step's brief
names the tools it suggests: read one with `daedal tool show <name>` before
you need it. The list is a suggestion, so use any other tool the work needs;
`daedal tool list` shows them all.

Starting a workflow adds it to this session as a **job** with one job per
step under it. Daedalus hands you one step at a time, and the user sees the
steps as a checklist in the Workflow pane. Changing the jobs never changes a
file. The CLI is `{{daedal}}`, written `daedal` below.

$ARGUMENTS

## Start

1. `daedal job tree`. Steps listed under a workflow mean one is open
   (Daedalus may have started it for you, or a predecessor did): it is
   yours, so run `daedal job next` and go to "Do the steps". One line
   holding only the request is this session's own job, not a workflow:
   go on to 2 and start a workflow under it.
2. `daedal workflow list` prints the choosing rules and every workflow.
   - One fits: `daedal workflow start <name>`.
   - It says `steps: dynamic`: name your own steps, two to
     five short verbs in order:
     `daedal workflow start do --steps find-print,change-it,run-test`.
     A name with no step file is this run's own step.
   - It fits but needs a step more or less: start it, then
     `daedal job add "<title>" --me [--needs <step>]` or
     `daedal job skip <step> --why "<why>"`.
   - None fits, a one-off: a **dynamic workflow**:
     `daedal workflow start --steps survey,check --name <label>`.
     `--loop <step> --until "<...>"` for work done in rounds.
   - None fits and it will come back, or two fit equally: ask the user with
     `daedal attention`.
3. `start` prints the steps and the first step's brief. A brief is the
   user's and comes before your habits; when it conflicts with the request,
   the request wins.

A session is in one workflow at a time. When `start` refuses because one is
open, pass `--replace` to skip what is left of it, or `--inside` to run the
new one as part of the step you are on.

Start before you look into the request. One that turns out to need nothing
still gets its workflow, closed with
`daedal job skip <workflow> --why "<what you found>"`.

## Do the steps

A brief says what to do, what the steps before handed you, and which
outputs you hand over. Do the step, then finish it. Chain the command onto
one the work runs anyway, so it costs no turn:

```
bun test apps/cli && daedal job done --result "212 pass" --out tests=212
```

`--result` says in one line what came out of this work; the user reads it in
the pane. Every output the brief lists goes in an `--out <name>=<value>`,
and the command refuses a missing one. `done` prints the next step's brief,
so you never start a step yourself.

- `daedal job next` prints the current brief again.
- `daedal job tree` shows every step with its state and result. A step's
  name is in brackets there when it differs from its title.
- `daedal job skip <step> --why "<why>"` closes a step you will not do.
- `daedal job redo <step> --why "<why>"` goes back to a finished step. The
  steps that needed it are done again after it.
- `daedal job hold --why "<what you need decided>"` stops your step until
  the user decides. Ask them in the conversation and end your turn. On
  their answer, run `daedal job release --answer "<their answer>"`.

**Gates.** A step with `gate: result` needs the user to approve its result.
`daedal job done` holds it and does not finish it: attention is raised, the
command exits 4, and no other step starts. Show the user what to approve,
ask in the conversation, and end your turn. When they approve, run
`daedal job approve`, which finishes the step and prints the next brief.
When they want changes, run `daedal job redo <step> --why "<what to
change>"` and do them. A step with `gate: start` is held before it starts:
say what you will do there, ask, and end your turn; after their yes, run
`daedal job approve` and do the step. Never approve on the user's behalf.
The user approves in words: Daedalus shows the gate on your card but has no
approve button, so never ask them to approve it there.

In a team, a member's user talks to the lead, so a member tags `@lead` with
what to approve and stops. The lead runs
`daedal job approve --session <member id>` on the user's word, and Daedalus
then sends the member its next brief. Go by `daedal job next`, not by a
message saying it was approved.

**Loops.** A workflow that goes round reopens its steps from the loop step
after the last one. Each time round, check `until`; when it holds or the
user says stop, end it with
`daedal job done --job <workflow> --result "<why it stops>"`.

**Included workflows.** A workflow included as `@release` is one job among
the steps, with its own steps under it. You do them in order like any other
step, and the included workflow finishes when its last step does. When two
steps share a name and a command refuses the name as ambiguous, use the id
it lists.

## Step memory

A saved step keeps what earlier runs learned, and it comes with the step's
brief. When the work teaches a step something the next agent should do
differently, propose it before you finish the last step:

```
daedal workflow remember review "Check every delete path for an ownership test" --why "The delete call skipped the owner check and review missed it"
```

Write one instruction a later agent can act on, and in `--why` one sentence
of what happened. Add `--only <workflow>` when it holds in that workflow
alone. It applies after the user accepts it in the app's Workflows tab, so
never tell them it is in force. Propose only what belongs to the step in any
repository: a fact about one repository goes in that repository's
instructions, and a step made for one run has no memory. Most runs teach
nothing, and proposing nothing is then right.

## Keep and improve

When a dynamic or changed workflow worked and the work will come back, ask
the user, then `daedal workflow save <name> --when "<what work it fits>"`
while it still runs, and add a rule for it to `CHOOSING.md`. When the user
wants a workflow, a step or a rule changed, edit the file it belongs in
(reuse steps before writing new ones), then run `daedal workflow list`: done
when it shows no `!` lines. A workflow already started keeps its copy;
changes apply from the next start.
