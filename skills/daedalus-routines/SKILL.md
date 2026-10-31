---
name: daedalus-routines
description: Write, change, run and remove Daedalus routines, and read what their runs did. Use when the user asks for something on a schedule or a recurring check, asks about their routines or a run's result, or wants a routine's prompt improved.
---

# Routines

A routine is a time and a prompt. While the Daedalus app is open, each run
is a headless `claude -p` in the routine's workspace folder, or in the
workspaces root for a routine on all workspaces. Nobody watches a run and
nobody can answer it. Its last reply is its result, and the first line of
that reply is what the Routines page shows. The user reads runs on the
Routines page and can carry one on in a session.

Use `"{{daedal}}"` for every command below, exactly that path. Below,
`daedal` means that executable. Run `daedal routine --help` once for the
full command list.

## Write a routine

1. Ask only what you cannot work out: what to check or do, how often, and
   which workspace. Default to the workspace of this session.
2. Check the time reads as meant: `daedal routine when "<when>"`. It
   prints the schedule in words and the stored form. Plain words work:
   "every 30m", "weekdays 9:00", "sun to thu at 8, 10, 13, 16",
   "cron 0 9 * * 1-5", "at 2026-11-02 14:00" for once.
3. Write the prompt to a file, then add it:
   `daedal routine add --when "<when>" --prompt-file <file> --name <name>
[--workspace <workspace> | --all] [--model haiku|sonnet|opus]`.
4. Offer a first run so the user sees a result now: `daedal routine run
<name>`. It starts within a few seconds. Read it with `daedal routine
runs <name>` and `daedal routine log <run-id>`.

## A prompt that works headless

The run gets only the prompt, the workspace's files and a header with the
time and what the previous run said. Write the prompt for that reader:

- Say exactly what to check, with the commands, paths and queries to use.
  A run cannot ask which service or which environment.
- Say what counts as worth reporting and what is known noise to ignore.
- Say what to put first in the reply. "Start your reply with the one thing
  a person must act on, or 'All clear' when nothing needs anyone."
- Say what the run must never do, such as restart, deploy, merge or
  delete, when the routine only looks.
- Keep secrets out of the prompt. Use `daedal exec --secret <NAME> --
<command>` and name the secret.
- Use the previous run's result, which the header carries, to report only
  what changed when that is what the user wants.

A run has no Daedalus session, so it skips workflows, attention, team
messages and journal entries. Do not ask it to use them.

## Change, pause, remove

- `daedal routine get <name>` prints the prompt and settings.
- `daedal routine edit <name> [--when …] [--prompt-file <file>] [--name …]
[--workspace … | --all] [--model …|default]` changes only what you pass.
- `daedal routine pause|resume <name>`. A resumed routine counts from now.
- `daedal routine remove <name>` deletes the routine and its runs. Confirm
  with the user first.

## When a run went wrong

Read `daedal routine runs <name>` and `daedal routine log <run-id>`. A run
that failed says why in its result. A run stopped after 30 minutes was too
big: split it or narrow the prompt. A skipped run means the previous one was
still going. A weak or wrong result means the prompt needs work: fix the
prompt, run it again, and show the user the new result.
