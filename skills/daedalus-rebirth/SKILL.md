---
name: daedalus-rebirth
description: Continue this session as a fresh agent with an empty context, in the same working directory and worktrees and in the same state, waiting on the user if you were, working if you were. Use when the user asks for a rebirth, when Daedalus asks for one, or when your own context is nearly full. Writes a note, then runs daedal agent continue.
argument-hint: "[how the next agent should continue]"
---

# Rebirth

You are being reborn: a fresh session with an empty context takes over in this
same working directory with the same worktrees. To the user it should feel like
the same conversation, only lighter. Only you know what is in your context, so
you write the note and you start the successor. Nothing else is expected of you
after that.

How the user wants the next agent to continue, if they said:

$ARGUMENTS

## Resolve the CLI once

Use `"{{daedal}}"` for every command below, exactly that path. It is this
Daedalus build's CLI, and it works out which session you are from your
working directory, so no command here needs a session id.

## 1. Stop

Finish the edit you are in the middle of, or revert it, so the worktree is in a
state you can describe. Do not start anything new. Do not run the test suite or
a build only to report on it; say what was last verified and when.

## 2. Write the note

Write `REBIRTH.md` in your working directory (the directory you started in,
`$PWD` unless you changed it). Be concise: every line should be something the
next agent needs to act on, and nothing it can read from the brief, the code or
git. Name files, commands, branches and commits exactly; the next agent has
none of your context and will act on what you write.

Cover, in this order:

1. **Where we stopped.** The state the next agent must resume in, first and
   exactly. Either:
   - **Waiting for the user.** You asked a question, showed a plan or options,
     or asked for approval, and the user has not answered. Copy what you showed
     them word for word, with your recommendation, so the next agent can show
     it again and wait.
   - **Working.** The step you were on and the next action, concrete enough to
     start without asking.
2. **Goal.** The task, by number and title, and what "done" means for it.
3. **Done.** Commits made (hash and subject), files changed, what each change
   does. What was verified, how, and when.
4. **In progress.** What is half-done, where it stands in the files, and what
   is broken because of it.
5. **Next.** The remaining steps in order.
6. **Decisions.** Choices made and why, especially ones that are not obvious
   from the code. Anything the user said that changes the plan, and how they
   like to work if they told you.
7. **Unverified and failed.** Anything you did not check, and anything that
   failed with what the failure said.
8. **From the user.** The instructions above, verbatim, if there were any. They
   override "Where we stopped": if the user said how to continue, that is what
   the next agent does.

Do not restate the task brief; the next agent reads it. Do not paste output.

## 3. Continue

Run, as your last action, from your working directory:

```sh
"{{daedal}}" agent continue --note-file "$PWD/REBIRTH.md"
```

Pass the user's instructions with `--message "<text>"` as well, so they reach
the next agent in its launch prompt, not only in the note.

If you were told to move to another model (by the user, or by your team's
lead), add `--model <model>`.

The command starts the new session on your task and archives this one as soon
as the command exits, so do nothing after it. If it fails, report the error and
stop; do not try to work around it by starting a session another way.
