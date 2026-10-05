# Session abilities

Every agent in Daedalus is an ordinary session. A session can be named,
pinned and colored, and it can hold abilities: things Daedalus adds to it on
top of being a session. Routines is the only ability so far.

## Name, pin and color

Any session, with or without abilities:

```
daedal session rename <session> <name>
daedal session pin|unpin <session>
daedal session color <session> <red|orange|gold|green|teal|blue|purple|pink|none>
```

`<session>` is a session id, or a session's name when exactly one live
session has it. Pinned sessions sit at the top of their workspace's list, in
the order they were pinned. The color marks the session's card on its left
edge, and the chip on tasks its routines file. A handoff successor keeps the
pin and the color, and a session that holds an ability also keeps its exact
name rather than gaining a ` · 2`.

`agent spawn` takes the same choices at creation: `--color <color>` and
`--pin`.

## Abilities

An ability is a definition in Daedalus's code. A session holds one through a
row in `session_abilities`. The ability's data, such as routines, hangs off
that row's id, so a handoff moves everything with one update.

```
daedal agent spawn --workspace <w> --provider claude --name Argus --ability routines
daedal session grant <session> routines
daedal session revoke <session> routines
daedal session abilities <session>
```

- **At creation**, the launch prompt gets one line saying what the session
  holds and which skill to follow.
- **To a running session**, Daedalus types one note into it under the
  delivery rule below. Until then `session abilities` shows the note as
  waiting.
- **Revoke** stops what the ability does and types a note saying so. The row
  and its data stay, so granting it again brings everything back. Tasks
  already filed stay on the board.
- **Archive** pauses what a session holds; **restore** resumes it.
- Abilities work on Claude and Codex sessions. A terminal or a custom command
  cannot hold one.

The skills an ability uses are Daedalus managed skills, installed for every
provider like the others and listed in Settings, Skills. Daedalus writes
nothing into a session's folder, which is usually a repository worktree.
Sessions without the ability can see the skills, but its commands refuse to
work for them.

## Routines

A session holding the routines ability runs routines: checks on a schedule
the desktop app keeps. The user creates them by talking to the session, which
follows the `daedalus-routines` skill and stores them with `daedal routine
add`. Daedalus ships none. A routine is a schedule and a prompt; everything
specific to the user is in the prompt and in the session's purpose.

Everything lives in SQLite under the ability's id: the routines, their runs,
their reports, and the purpose (`daedal routine purpose "<text>"`), which
every run prints.

### A routine

The session writes a routine as Markdown and Daedalus stores it parsed.
`daedal routine get <name> --text` prints it back in the same form.

```markdown
---
name: ci-health
schedule: every 30m
model: sonnet
timeout: 10m
output: task
enabled: true
---

Check CI for the repositories in the purpose ...
For each problem give a key, a title, a link and the evidence.
Return {"reports": []} when nothing needs attention.
```

| Field      | Meaning                                                                                                                      | Example                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `name`     | Unique within the session's routines, also the key prefix                                                                    | `ci-health`              |
| `schedule` | `every <n>m` or `every <n>h`, `cron "<5 fields>"` (local time), or `at <local datetime>` (one-shot)                          | `cron "50 8 * * 1-5"`    |
| `until`    | The routine deletes itself after this time                                                                                   | `2026-09-30T15:40`       |
| `model`    | Model for a Claude session's subagent                                                                                        | `sonnet`, `haiku`        |
| `timeout`  | A run with no result after this is marked failed                                                                             | `10m`                    |
| `output`   | `task`: each report becomes a tagged task and a notification. `notify`: notification only. `none`: the routine cannot report | `task`                   |
| `enabled`  | Pause one routine without deleting it                                                                                        | `true`                   |
| `vars`     | Values filled into `{{name}}` in the body                                                                                    | `pr: Bakar0/daedalus#57` |

Daedalus fills `{{last_run}}`, `{{run_id}}`, `{{now}}` and `{{missed}}` into
every body. A template (`routine add --file - --template`) never fires;
`routine add --from <template> --var k=v --until +60m` copies one into a live
routine.

### Delivery

The host tick, every 1.2 seconds while the app is open, queues due runs. At
most one run per routine waits: a slot that comes due while a run waits adds
nothing, and the run counts the wait in `{{missed}}`. A slot that comes due
while the routine's run is running is skipped.

Daedalus types the oldest waiting run into the session when all of these
hold:

1. The ability is enabled and not paused, and the session is running.
2. The session is idle. Activity comes from the provider's hooks; when it is
   unknown, the pane decides (an input box and no "esc to interrupt"). For
   Claude, a `needs_input` badge with the input box showing does not count as
   a question: Claude draws a real question or permission dialog in place of
   the box. Such a badge comes from the agent's own `daedal attention` or
   from one of the session's background agents. The badge stays on the card.
3. Its input box is empty. Daedalus reads the pane with its escape codes just
   before typing and ignores dim text, which is a placeholder: Claude's
   suggested next prompt, or Codex's "Ask Codex to do anything".
4. Nobody pressed a key in the session's terminal in the last 2 minutes.
   Scrolling and selecting are not keystrokes. The host keeps this in memory,
   so after an app restart nothing holds.
5. No handoff is pending.
6. The same routine has no run in flight.
7. Fewer runs are in flight than the provider takes: 3 for Claude, whose
   session hands each run to a background subagent, and 1 for Codex, which
   does each run itself.

The line is `/daedalus-routine <run-id>` for Claude and
`$daedalus-routine <run-id>` for Codex, followed by a second Enter that
Codex's skill popup needs. A dev build's skills carry its channel suffix. The
grant and revoke notes, and the handoff below, go in under the same rule.

Each change in why a session's runs are held is logged as a `routines` event
in the app log, such as "Argus: holding, you typed in this session".

The skills never take the session or the CLI from the environment, which
Claude can swap for another session's (see "The calling session" in
`docs/cli.md`). They call this home's `bin/daedal` by full path, and the CLI
finds the session from the working directory. The run commands also find it
from the run id.

The routine bar above the session's terminal shows what waits and
why: "2 waiting · you typed 0:40 ago · resumes in 1:20", or busy, the input
box has text, the runs in flight, a handoff, or paused. Run now
(`routineRunNow` over RPC) skips only the 2-minute wait for the next line.

### Reports and tasks

A report is what a run hands back: a key, a title, a body, an optional link,
and an urgent flag. Only the session calls `daedal routine report`.

- One task per key. While a task for a key is open, a new report adds an
  "Update <time>" section to it and sends no second notification. The check
  and the insert happen in one SQLite transaction.
- `--same-as <key>` adds a report with another key to that key's task.
- `daedal routine resolve <key>` adds "Resolved at <time>". If no agent was
  ever started on the task, Daedalus moves it to done 24 hours later.
- A key reported again within 14 days reopens its last task. After that it
  opens a new task that names the old one.
- An urgent report notifies even in Focus mode.
- Tagged task cards have Useful and Noise buttons. Noise on a key stops it
  from raising anything until the verdict is removed. A task the user moves
  to done counts as useful.

### Handoff, failures and missed runs

- A session holding routines hands off once its context passes the
  workspace's auto-handoff percent, or 60% when the workspace sets none. The
  generic handoff sweep leaves it alone. Delivery stops, runs in flight get up
  to 10 minutes to finish, and the handoff request goes in under the delivery
  rule. A handoff not completed in 15 minutes is finished by Daedalus without
  a note; the routines live outside the conversation.
- Nothing fires while the app is closed. On open, each overdue routine fires
  once, with `{{missed}}` set.
- A run with no `routine done` before its timeout fails. After 3 failures in
  a row the session's card gets an attention badge.
- A session holding routines ends each turn `idle`, not `done`.
