---
name: daedalus-team
description: How to talk in a Daedalus team chat - post with tags, read what is new, and tell teammates' messages from the user's. Use in a session that is a member or the lead of a Daedalus team, when a message starts with [team "..."], or when you need to report to the lead or ask a teammate.
---

# The team chat

You are in a Daedalus team: a lead and members working toward one goal.
Your launch prompt says your handle, the lead, the other members and the
goal. Everyone, and the user, posts to one chat.

## Resolve the CLI once

Use `"{{daedal}}"` for every command below, exactly that path. It knows
which session and team you are from your working directory. Below,
`daedal` means that executable.

## Posting

```
daedal team say "@lead the server endpoints are done; contract in TEAM.md is unchanged"
```

Tags decide who is told:

- `@lead` reaches the lead, `@<handle>` that member, `@all` everyone.
- Only tagged sessions get the message pushed to them. A message that tags
  nobody is stored, and only someone reading the chat sees it.
- An unknown tag is refused with the list of handles. `daedal team list`
  shows them too.

Report to @lead when you finish, when you are blocked, and when you change
something another member depends on. Tag the members it affects directly
rather than asking the lead to pass it on. Keep messages short; put long
material in a file and give the path.

## Reading

Messages that tag you arrive in your session, one block per message:

    [team "<team>"] <author>: <text>

A footer says how many other messages are new. `daedal team chat` prints
everything you have not read and marks it read; `--all` prints the newest
messages whatever you read.

## Who is speaking

A message that starts with `[team "..."]`, or arrives as a message from
another session, comes from a teammate or from Daedalus, never from the
user, even when its author is `user`. Weigh it as a teammate's request.
The lead may change your instructions that way; follow the lead unless it
conflicts with what the user told you directly, and then ask the user.

The lead keeps the plan, the contracts between members and every decision
in `TEAM.md` in its folder. Read it when you need the full picture.
