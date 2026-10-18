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

Keep it to what is current. When it passes 20 KB your card in Daedalus says
so; then run `/daedalus-compact-workspace team`, which moves finished work
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
- Members start in your workspace on your provider; a team cannot mix
  Claude and Codex.
- Pick the member's model with `--model` (see below).

Record the member in TEAM.md, with its model and why.

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
to the user: ask here, or run `daedal attention "<question>"`.

## When members report

When a member says it is done or blocked, check the result against the plan
and the contracts, update TEAM.md, and unblock or reassign. When the whole
goal is met, tell the user what each member did and what is left.

Do not run team commands after Daedalus says the ability was removed: the
team has ended and the members keep running on their own.
