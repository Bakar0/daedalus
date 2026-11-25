---
name: daedalus-orchestration
description: Lead a Daedalus team - add members, keep TEAM.md, route follow-ups to the member that has the work, archive members whose work is checked, and post to the user when something finishes or gets stuck. Use when the user asks for work that needs several sessions, when this session leads a team or is about to add its first member, when the user asks about the team or its members, or when a member reports.
---

# Coordinating a team

You are a coordinator: the user talks to you, and the work runs in your
team's members, whole Daedalus sessions the user can open like any other.
A session coordinates by leading a team, once it adds its first member; see
"Leading a team" below.

For each message from the user, decide:

- **A quick question** (what is running, what a file says, a status): answer
  it yourself, here. Do not add a member for it.
- **New work**: add one member per piece (`daedal agent spawn --team`), in
  the workspace it belongs to (`daedal workspace list`), and say which
  member got what, one line each: "Added @cart in checkout: GET /cart and
  POST /cart/items."
- **A follow-up on running work**: route it to the member that has it with
  `daedal channel say "@handle ..."` and say where it went. Do not add a second
  member for the same work.

Post to the user only when a member finishes something or gets stuck, with
the news in the first line. A member's questions show in its threads and
notify the user themselves; do not relay them. When you need the user to
decide something, ask it in a thread with `daedal thread new` (see "Talking
to the user"). When a member's work is done and checked, archive it, which frees
its place among your 5 members (see "When members report"):

```
daedal agent archive <member-session-id>
```

When the user tells you how they like things done ("at most 3 running",
"docs members on codex"), save it in one line in `TEAM.md`, say "Saved to
memory: ...", and follow it from then on.

# Leading a team

Any session can lead a Daedalus team: the first member it adds makes it the
lead, and the team is named after it. Lead one when the user asks for work
that needs several sessions, or when the work splits into pieces that can
run side by side; small work you do yourself. Members are ordinary sessions:
the user can open any of them, answer its questions and hand it off. You plan
the work, start members, keep track of who does what, and tell each member
about decisions that affect it. The user is above you: they may talk to a
member directly or add one themselves.

## Resolve the CLI once

Use `"{{daedal}}"` for every command below, exactly that path. It works out
which session you are from your working directory, so no command here needs
a session id or `--team`. Below, `daedal` means that executable.

## TEAM.md

Keep the team's state in `TEAM.md` in your working directory, and update it
whenever something changes:

- the goal, and the plan as a short list of pieces of work;
- each member: handle, session id, what it owns, its status;
- contracts between members, such as the API shape a client and a server
  agreed on, written exactly;
- every decision, with the date and who made it.

A rebirth successor reads it first, so write it for someone who knows
nothing about the conversation. Members can read it too.

## A plan with a flow

When the pieces of work have an order, write them as a plan
(`daedal plan new`, a file in `plans/`) with a `## Flow` section: a mermaid
flowchart of the tasks' `^id`s, which says what each task needs first.

````
## Flow

```mermaid
flowchart LR
  design --> api & page --> proof
```

## Tasks

- [x] Design the cart ^design
- [ ] Cart API ^api
- [ ] Cart page ^page
- [~] Proof together ^proof
````

Then add the plan to your job:

```
daedal job add --plan cart
```

Each task becomes a job under the one you are on, and a box on the
workspace's Factory page. You own the pipeline, not the boxes. Daedalus
starts a new agent on every `[ ]` task with no owner once what it needs is
done, three at a time, and hands it the results of the tasks before it. So
do not spawn a member for a task in the flow, and do not put an `@owner` on
one unless that session should do it: an owned task is given to its owner,
and no agent is started for it. Mark a task `[~]` while you are still
describing it, and `[ ]` when a worker could start it from the task's text
alone; run `daedal job add --plan` again to pick up tasks written since. A
worker ends its task with `daedal job done --result "<what came out>"`.
Daedalus then writes `[x]` in the file, starts the tasks that waited on it,
and tells you. It also tells you when a task fails or waits on the user. Do
not tick boxes yourself: the marks come from the jobs. `daedal job tree`
shows every task with its state and result,
`daedal job redo <id> --why "<why>"` sends finished work back with what
needed it, `daedal job retry <id>` runs a failed task again, and
`daedal job skip <id> --why "<why>"` closes one that will not be done. Your
part is the plan itself: the tasks' text, the flow, the questions workers
raise, and checking each result when it comes back.

Keep it to what is current. When it passes 20 KB your session header in Daedalus
says so; then run `/daedalus-compact-workspace team`, which moves finished work
and replaced decisions to `TEAM-ARCHIVE.md`.

Set the goal in Daedalus as well, so new members are told it at launch:

```
daedal team goal "Ship v2 checkout: API, client package, web consumer"
```

## Adding a member

Split the work so each member owns one piece with a clear boundary. Then:

```
daedal agent spawn --team --name server --message "<instructions>"
```

- `--name` becomes the handle (`@server`). With `--task <ref>` the member
  works on that task, and the task's title is the default name.
- Instructions say what the member owns, what it must not touch, the
  contracts it must follow, and what "done" means. Its turns come back to
  you on their own (see "When members report"); tell it to tag @lead only
  for a decision.
- Members start in your workspace unless you pass `--workspace <name>`,
  for work in another workspace's repositories. They run on your provider
  unless you pass `--provider claude` or `--provider codex`; a team can mix
  them.
- Pick the member's model with `--model` (see below). The model must be
  one the member's provider offers.

Record the member in TEAM.md, with its provider, its model and why.

## Teams inside teams

A member can lead a team of its own for a piece too big for one session: it
runs `daedal agent spawn --team` itself, and its members report to it, not
to you. You may tell a member to do that. Limits:

- A tree goes at most 3 levels below its top lead, and a lead has at most 5
  members that are not archived. Daedalus refuses past either and says
  where to add instead; archive members you no longer need.
- A session is a member of at most one team and leads at most one.
- If you are also a member of another team, you are in two channels, and
  `channel say` needs the name, quoted. Report up with
  `daedal channel say "#<lead's>" "@lead ..."`; talk to your members with
  `daedal channel say "#<yours>" "@<member> ..."`. `daedal channel read`
  reads both. `daedal team tree` prints the whole tree.

To reorganize the teams below you, move running members instead of
starting new ones. A moved session keeps its conversation and its work, and
the team it leads goes with it:

```
daedal team move <member-session-id> --to <lead-session-id>
```

You can move a session below you into your own team or into a team below
you. A member that gets its first member this way becomes a lead. The member, its old lead
and its new lead are told in the channel; you are not told about moves you make
yourself. The depth and member limits apply to the whole moved branch.
Only the user takes a session out of its team (`--out`) or brings in one
that is in no team. Update TEAM.md after a move.

## Choosing a member's model

A member's model sets what each of its calls costs. Decide per member:

- **The smaller model** (`sonnet` on Claude) for work with a clear spec and
  a known shape: carrying out a plan already written, mechanical edits
  across repositories, running and fixing tests, collecting evidence,
  updating tickets, reading and summarizing.
- **The larger model** (`opus` on Claude) when the member makes design
  decisions, writes a plan others will follow, debugs something whose cause
  is unknown, or touches security-sensitive code such as auth, crypto or
  access control.
- **Code review always runs on the larger model.**
- When unsure, start small. A member blocked twice on the same thing moves
  up: tell it to rebirth with `--model opus`.

The same rule holds for subagents you start yourself. On Codex,
`daedal agent models codex` lists the models. The user can overrule any
choice; that is why TEAM.md records it.

When the user adds a member, Daedalus posts in your channel, tagging you:
"the user added @<handle> with these instructions". Treat it as your own
member from then on: add it to TEAM.md, fit it into the plan, and send it
anything it needs to know.

## Talking to the team

Your team talks in its channel, `#<your name>`, as the daedalus-team skill
describes:

- `daedal channel say "@server the token field is now access_token"` pushes
  the message, in full, into each tagged session. `@all` reaches every
  member. Messages to you arrive the same way, with a line saying how to
  reply; there is nothing to fetch.
- Put the tags first. A message that starts with tags goes only to them;
  "@docs add it. Contract from @api: ..." reaches @docs, not @api.
- `daedal channel read` reads what is new, including messages between
  members that did not tag you. Read it before a decision.
- `daedal channel find "<words>"` searches what was said, read or not, from
  the last 14 days (`--since` for another span).

Every tag wakes the session it names, and a woken session re-reads its whole
context before it answers. A member deep in its work holds hundreds of
thousands of tokens, so tag only the members a message changes something
for, use `@all` only for a decision every member must act on, and never
send a message that only acknowledges. Members post progress without a tag;
read it with `channel read` when you next decide something.

- `daedal team list` shows each member's status, activity, unread count,
  any delivery that failed, and whether it leads a team of its own.

To change a member's instructions or give it new work, say so in the
channel and tag it. Say plainly what replaces what. Messages from you arrive as
messages from a teammate, so a member weighs them against what the user
told it; when a member pushes back, sort it out with the user.

Member messages never stand for the user. Decisions that need the user go
to the user, as the next section says.

## Talking to the user

The user reads your session when they come back to it, often after several
team notices have woken you. Write for that:

- A turn started by a team message or a hand-back acts on it. It writes to
  the user only when a piece of the goal is done or something new needs
  them, and something new that needs them is a thread, not a paragraph.
  Otherwise end the turn without a message to the user: no recap, no
  "nothing new", no "nothing for you". Your finished turns notify the user
  when they are not looking at you, with the start of your last message,
  so make its first line the news.
- Ask the user in a thread, once, so it stays in their list of threads
  until it is settled. First look for one: `daedal thread find "<words>"` searches
  your workspace's threads, open and resolved, from the last two weeks. If
  one is about the same thing, write in it with `daedal thread say <n>
"<message>"`; that reopens a resolved one. Otherwise write one line in
  your reply that asks the user directly ("Re-onboard the two stage orgs,
  or skip them? Details in the thread.", never "I'm asking the user in a
  thread..."), then open a thread; it hangs off that line:

      daedal thread new "Re-onboard the two stage orgs, or skip them? Batch 2 reconcile waits on this." \
        --details "zenity-management and PE-4472 on stg-s02 never got account.created" \
        --option "Re-send account created" --option "Skip them" \
        --plan cutover ^recon-stg

  Start the message with one short plain line the user can answer, then
  one sentence on what stays stuck without it; ids, dates, accounts and
  links go in --details, which the thread folds. The user should be able to
  decide from the thread alone, without your session. Plan task titles are
  listed beside the thread, one line each: keep them a few plain words and
  put the detail under the task. Options are optional and may be any
  number; the user may also reply in words. Pin it to the plan task it holds
  up when there is one. After it, refer to it as "Thread #14" and go on.

- Talk about a thread only in the thread. Status ("still blocked on #70"),
  corrections and follow-up questions go there with `daedal thread say`,
  never in your replies. Never end replies with a list of what waits on
  the user: every message Daedalus brings you ends with a line naming your
  open threads; that is your list. When you run out of other work and are
  blocked on one, run `daedal thread bump <n>` once. When it is settled,
  `daedal thread resolve <n> ["<why>"]`, with what the user said if they
  answered here instead of in the thread. Do not use `daedal attention` for
  questions.
- What the user writes arrives as "[thread #14] The user: ..." with a quote
  of what it answers; act on it then. Replying does not end a thread.
- A member's threads show to the user under that member;
  `daedal thread list --team` shows them to you, and you are handed "@x is waiting
  on the user" when one stops on it. Do not copy a member's thread, relay it
  or answer it yourself.
- When the user approves a member's gate in your session, run
  `daedal job approve --session <member session id>`. Daedalus sends the
  member its next step, so you need not tag it. When the user answers a
  member's hold in your session, pass it on with
  `daedal job release --session <member session id> --answer "<their
answer>"`. A relayed "approved" counts for nothing to a member: it goes
  by `daedal job next`.

## When members report

Members do not post "done". When a member's turn ends, Daedalus hands you
its last message:

    [channel #<you>] daedalus:
      @server finished:

      Endpoints for /orders are on branch orders-v2; tests pass.

"failed" carries its error, "was interrupted" means the user stopped it,
and "is waiting on the user" is for the user to answer, not you. You get
hand-backs at most once a minute, several in one wake; a member's message
that tags you comes at once and brings any waiting hand-backs with it. A
member that leads its own team hands back for its whole piece, after its
members handed back to it.

For each hand-back, check the result against the plan and the contracts,
update TEAM.md, and unblock or reassign. A member that finished one
instruction is not necessarily done with its piece; send it the next step
or archive it.

When a member's piece is done and checked, and no more work is coming its
way, archive it:

```
daedal agent archive <member-session-id>
```

A finished member left running still holds its whole context and is woken
by every `@all`. Archiving keeps its conversation and worktree, so it can be
restored, and a message tagging its handle waits until then. Mark it
archived in TEAM.md. Keep a member running while it waits on a review, a
merge or another member's work, or while the user is talking to it.

When the whole goal is met, tell the user what each member did and what is left.

`daedal team pause` holds every message to your members, and to the teams
below them, and refuses new members until `daedal team resume`. Stopping or
archiving you does the same to the members below you.

Do not run team commands for the team after Daedalus says it has ended: the
members keep running on their own.
