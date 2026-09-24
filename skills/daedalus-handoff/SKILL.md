---
name: daedalus-handoff
description: Move this session's work to a fresh agent with an empty context, in the same working directory and worktrees. Use when the user says to hand off, when Daedalus asks for a handoff, or when your own context is nearly full. Writes a handoff note, then runs daedal agent continue.
argument-hint: "[instructions for the next agent]"
---

# Handoff

Your work is moving to a fresh session that runs in this same working
directory with the same worktrees. Only you know what is in your context, so
you write the note and you start the successor. Nothing else is expected of
you after that.

Extra instructions from the user for the next agent, if any:

$ARGUMENTS

## Resolve the CLI once

Use `daedal` when `command -v daedal` succeeds. Otherwise use
`${DAEDALUS_HOME:-$HOME/.daedalus}/bin/daedal`. Use the same executable for
every command below.

## 1. Stop

Finish the edit you are in the middle of, or revert it, so the worktree is in a
state you can describe. Do not start anything new. Do not run the test suite or
a build only to report on it; say what was last verified and when.

## 2. Write the note

Write `HANDOFF.md` in your working directory (the directory you started in,
`$PWD` unless you changed it). Under 150 lines. Name files, commands, branches
and commits exactly; the next agent has none of your context and will act on
what you write.

Cover, in this order:

1. **Goal.** The task, by number and title, and what "done" means for it.
2. **Done.** Commits made (hash and subject), files changed, what each change
   does. What was verified, how, and when.
3. **In progress.** What is half-done, where it stands in the files, and what
   is broken because of it.
4. **Next.** The remaining steps in order. Each one concrete enough to start
   without asking.
5. **Decisions.** Choices made and why, especially ones that are not obvious
   from the code. Anything the user said that changes the plan.
6. **Unverified and failed.** Anything you did not check, and anything that
   failed with what the failure said.
7. **From the user.** The extra instructions above, verbatim, if there were any.

Do not restate the task brief; the next agent reads it. Do not paste output.

## 3. Continue

Run, as your last action:

```sh
daedal agent continue --handoff-file "$PWD/HANDOFF.md"
```

Pass the user's extra instructions with `--message "<text>"` as well, so they
reach the next agent in its launch prompt, not only in the note.

The command starts the new session on your task and archives this one as soon
as the command exits, so do nothing after it. If it fails, report the error and
stop; do not try to work around it by starting a session another way.

If the command reports `Unknown agent command 'continue'`, the `daedal` you
found is an older build. Use the one under `$DAEDALUS_HOME/bin` instead.
