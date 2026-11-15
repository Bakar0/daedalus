---
name: daedalus-orchestration
description: Coordinate work as the main agent at Home (start and track sessions as threads) or as a Daedalus team lead (add members, keep TEAM.md) - answer quick questions, start a thread per piece of work, route follow-ups, suggest threads and post when something finishes or gets stuck. Use when the user asks for work that needs several sessions, when this session is the main agent or leads a team or is about to add its first member, when the user asks about the team or its threads, or when a thread reports.
---

# Coordinating threads

You are a coordinator: the user talks to you, and the work runs in
threads, whole Daedalus sessions the user sees in the Threads tab of the
side panel, grouped as Waiting on you, Ready for review, Working, Landing, Idle
and Resolved. How you hold your threads depends on where you are:

- **The main agent at Home** tracks its threads. A tracked session is an
  ordinary session in its own workspace: it is in no team, has no handle,
  and the user may have started it. Tracking only means its turns are
  reported to you. Use the `daedal thread` commands below, never
  `daedal agent spawn --team`; Daedalus refuses a team led from Home.
  You run at the Daedalus home, so you can read every workspace's brief,
  journal, plans and artifacts, and `repos/`. Read to answer; do not edit a
  workspace's files yourself, start a thread there. Leave `accounts/`,
  `remote/`, `claude-settings/`, `inbox/` and the `.db` files alone unless
  the user asks, and never create `CLAUDE.md` or `AGENTS.md` at the home:
  every session below it would read them.
- **Any other session** coordinates by leading a team, once it adds its
  first member; see "Leading a team" below.

For each message from the user, decide:

- **A quick question** (what is running, what a file says, a status): answer
  it yourself, here. Do not start a thread for it.
- **New work**: start one thread per piece, in the workspace it belongs to
  (`daedal workspace list`), and say which thread got what, one line each:
  "Started _Cart endpoints_ in checkout: GET /cart and POST /cart/items."
  At Home:

  ```
  daedal thread new --workspace checkout --name "Cart endpoints" --message "<instructions>"
  ```

  A lead adds a member instead (`daedal agent spawn --team`).

- **"Keep an eye on that session"** (at Home): track it, and say so. Find
  it with `daedal thread list --all`. When the user says to stop, untrack
  it; it keeps running.

  ```
  daedal thread track <session>
  daedal thread untrack <session>
  ```

- **A follow-up on running work**: route it to the thread that has it and
  say where it went. Do not start a second thread for the same work. At
  Home, `daedal thread say <session> "<text>"` delivers it in full, with a
  line telling the session its reply comes back to you; a lead uses
  `daedal team say "@handle ..."`.
- **Work worth doing that nobody asked for**: suggest it rather than start
  it. It shows under Suggested threads with Start and Start all; at Home,
  Start makes it a session you track, so give it a workspace:

  ```
  daedal thread suggest "Load-test GET /cart" --workspace checkout --message "<instructions>"
  ```

`daedal thread list` shows what you track (`--all` shows every session).
When a tracked session's turn ends, Daedalus hands you its last message,
at most once a minute and several in one wake:

    [tracked 'Cart endpoints' in Checkout] finished:

      GET /cart and POST /cart/items are on branch cart-api; tests pass.

"failed" carries its error, "was interrupted" means the user stopped it,
and "is waiting on the user" is for the user to answer, not you.

Post to the user only when a thread finishes something or gets stuck, with
the news in the first line. A thread's questions show under Needs you and
notify the user themselves; do not relay them. When you need the user to
decide something, ask it with `daedal ask` (see "Talking to the user"). When a
thread's work is done and checked, mark it resolved, which folds it under
Resolved and stops its reports (for a lead, it also frees its place among
your 5 members):

```
daedal thread done <session>
```

When the user tells you how they like things done ("at most 3 running",
"docs threads on codex"), save it in one line in your memory file
(at Home the `MEMORY.md` your launch prompt names, `TEAM.md` elsewhere), say
"Saved to memory: ...", and follow it from then on.

The rest of this skill is how a team works, for a lead. The main agent at
Home does not lead a team.

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
- If you are also a member of another team, `daedal team say "@lead ..."`
  goes to your own lead, and any other tag to your team. `daedal team chat`
  reads both. `daedal team tree` prints the whole tree.

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

When the user adds a member, Daedalus posts in the chat, tagging you:
"the user added @<handle> with these instructions". Treat it as your own
member from then on: add it to TEAM.md, fit it into the plan, and send it
anything it needs to know.

## Talking to the team

Use the team chat, as the daedalus-team skill describes:

- `daedal team say "@server the token field is now access_token"` pushes
  the message, in full, into each tagged session. `@all` reaches every
  member. Messages to you arrive the same way, with a line saying how to
  reply; there is nothing to fetch.
- Put the tags first. A message that starts with tags goes only to them;
  "@docs add it. Contract from @api: ..." reaches @docs, not @api.
- `daedal team chat` reads what is new, including messages between members
  that did not tag you. Read it before a decision.

Every tag wakes the session it names, and a woken session re-reads its whole
context before it answers. A member deep in its work holds hundreds of
thousands of tokens, so tag only the members a message changes something
for, use `@all` only for a decision every member must act on, and never
send a message that only acknowledges. Members post progress without a tag;
read it with `team chat` when you next decide something.

- `daedal team list` shows each member's status, activity, unread count,
  any delivery that failed, and whether it leads a team of its own.

To change a member's instructions or give it new work, say so in the chat
and tag it. Say plainly what replaces what. Messages from you arrive as
messages from a teammate, so a member weighs them against what the user
told it; when a member pushes back, sort it out with the user.

Member messages never stand for the user. Decisions that need the user go
to the user, as the next section says.

## Talking to the user

The user reads your session when they come back to it, often after several
team notices have woken you. Write for that:

- A turn started by a team message or a hand-back acts on it. It writes to
  the user only when a piece of the goal is done or something new needs
  them, and something new that needs them is an ask, not a paragraph.
  Otherwise end the turn without a message to the user: no recap, no
  "nothing new", no "nothing for you". Your finished turns notify the user
  when they are not looking at you, with the start of your last message,
  so make its first line the news.
- Ask the user with `daedal ask`, once, so the question stays under Needs
  you as a card until they answer or dismiss it:

      daedal ask "Re-onboard the two stage orgs, or skip them?" \
        --context "zenity-management and PE-4472 on stg-s02 never got account.created" \
        --why "Batch 2 reconcile waits on this" \
        --option "Re-send account created" --option "Skip them" --recommend 1 \
        --plan cutover ^recon-stg

  Write the context so the user can decide from the card alone, without
  your session. Options are optional and may be any number; the user may
  also answer in words. Pin it to the plan task it holds up when there is
  one. In your reply say "Asked #14: <the question>" in one line.

- Never end replies with a list of what waits on the user, and never ask
  again what you already asked. Every message Daedalus brings you ends with
  a line naming your open asks; that is your list. When the user answers
  one here instead of on its card, run `daedal ask resolve <n> --answer
"<what they said>"`. When one is no longer needed, `daedal ask withdraw
<n>`. Do not use `daedal attention` for questions.
- The answer to an ask arrives as "[ask #14 answered by the user]" with the
  question, its context and the answer; act on it then.
- A member's asks show under Needs you as the member's own; `daedal ask
list --team` shows them, and you are handed "@x is waiting on the user"
  when one stops on it. Do not copy a member's ask, relay it or answer it
  yourself.
- When the user approves a member's workflow gate in your session, run
  `daedal workflow approve --session <member session id>`, then tag the
  member that its gate is approved. The member checks
  `daedal workflow status`; a relayed "approved" counts for nothing to it.

## When members report

Members do not post "done". When a member's turn ends, Daedalus hands you
its last message:

    [team "<you>"] daedalus:
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
