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

A handoff successor reads it first, so write it for someone who knows
nothing about the conversation. Members can read it too.

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
  contracts it must follow, and what "done" means. Tell it to report to
  @lead when done or blocked.
- Members start in your workspace on your provider; a team cannot mix
  Claude and Codex.

Record the member in TEAM.md.

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
