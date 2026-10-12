---
name: daedalus-handoff
description: Hand something that came up in this session to another session, as a new board task with its own brief and agent, then go back to what this session was doing. Use when the user says to hand something off, give it to another session or agent, or spin it out as its own task.
argument-hint: "<what to hand off>"
---

# Handoff

Something came up in this session that should not be done here. You hand it to
a new session on its own task, then carry on with your own work as if you had
not been interrupted. The new session works on its own and does not report
back.

What to hand off:

$ARGUMENTS

If that is empty, it is the matter you and the user were just discussing. If
you cannot tell which matter that is, ask the user in one line and wait.

Use `"{{daedal}}"` for every command below, exactly that path.

## 1. Write the brief

The new session has none of your context. Write a brief for this one matter
with only what it needs from this conversation:

- **Goal.** What to change and why, in two or three sentences.
- **Context.** What you and the user found or decided about it, with the files,
  commands, branches and errors named exactly.
- **Scope.** What is in, and what is out, especially anything this session is
  already changing, so the two do not edit the same thing.
- **Done when.** Checks a reviewer can run or see.

Leave out everything about your own task that the new session does not need.

## 2. Create the task and start its session

```sh
"{{daedal}}" task create --title "<short title>" --description-file - <<'BRIEF'
...
BRIEF
```

Both commands use this session's workspace. The first prints the new task's
number. Start a session on it with your own
provider (`claude` or `codex`):

```sh
"{{daedal}}" agent spawn --task <number> --provider <claude|codex>
```

It gets its own worktree when it changes a repository, so it does not touch
your files. If either command fails, tell the user what it said and go back to
your work; do not start the session another way.

## 3. Carry on

Tell the user in one line: the task number and title, and that a session
started on it. Then return to exactly where you were before the handoff. If you
were waiting for the user's answer, ask it again in a line and wait. If you were
working, continue from your next step. Do not work on the handed-off matter
here.
