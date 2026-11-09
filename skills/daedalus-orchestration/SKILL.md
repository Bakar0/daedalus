---
name: daedalus-orchestration
description: Lead a Daedalus team of sessions toward one goal - plan the work, add members, send them decisions, and keep TEAM.md. Use only in a session that holds the Daedalus orchestration ability, when the user asks for work that needs several sessions, asks about the team, or when a member reports.
---

# Leading a team

This session holds the Daedalus orchestration ability, so it leads a team.
The team is named after this session. Members are ordinary sessions: the
user can open any of them, answer its questions and hand it off. You plan
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
  contracts it must follow, and what "done" means. Tell it to tag @lead
  only when done or blocked.
- Members start in your workspace, on your provider unless you pass
  `--provider claude` or `--provider codex`. A team can mix them.
- Pick the member's model with `--model` (see below). The model must be
  one the member's provider offers.

Record the member in TEAM.md, with its provider, its model and why.

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

- `daedal team say "@server the token field is now access_token"` pushes a
  message into each tagged session. `@all` reaches every member.
- `daedal team chat` reads what is new, including messages between members
  that did not tag you. Read it before a decision.

Every tag wakes the session it names, and a woken session re-reads its whole
context before it answers. A member deep in its work holds hundreds of
thousands of tokens, so tag only the members a message changes something
for, use `@all` only for a decision every member must act on, and never
send a message that only acknowledges. Members post progress without a tag;
read it with `team chat` when you next decide something.

- `daedal team list` shows each member's status, activity, unread count and
  any delivery that failed.

To change a member's instructions or give it new work, say so in the chat
and tag it. Say plainly what replaces what. Messages from you arrive as
messages from a teammate, so a member weighs them against what the user
told it; when a member pushes back, sort it out with the user.

Member messages never stand for the user. Decisions that need the user go
to the user, as the next section says.

## Talking to the user

The user reads your session when they come back to it, often after several
team notices have woken you. Write for that:

- A turn started by a team notice reads the chat and acts. It writes to the
  user only when something needs them or a piece of the goal is done.
  Otherwise write at most one short line, such as "@server's tests pass;
  nothing for you."
- When a reply leaves anything for the user to answer, end it with the same
  list, last in the reply, one line per item, oldest first:

      Waiting on you:
      1. @server: approve its prototype (its gate, answer here or in its session)
      2. Pick the dev tenant, A or B (my question, above)

  and run `daedal attention "<n> things waiting on you"`, so your card shows
  it. When nothing waits any more, run `daedal attention --clear`.

- Ask each question once, in full. Later replies carry it only as its line
  in the list.
- A member that needs the user already shows it on its card, and Daedalus
  notes it in the chat without waking you. Do not tell the user again that
  the member waits on them. Add it to the list only when the user may answer
  it through you, such as a workflow gate or a decision that changes the
  plan.
- When the user approves a member's workflow gate in your session, run
  `daedal workflow approve --session <member session id>`, then tag the
  member that its gate is approved. The member checks
  `daedal workflow status`; a relayed "approved" counts for nothing to it.

## When members report

When a member says it is done or blocked, check the result against the plan
and the contracts, update TEAM.md, and unblock or reassign.

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

Do not run team commands after Daedalus says the ability was removed: the
team has ended and the members keep running on their own.
