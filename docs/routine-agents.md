# Routine agents

A routine agent is a named Claude session in an ordinary workspace that runs
routines on a clock the desktop app keeps. The user creates it with a name and
gives it its purpose by asking it for routines. Daedalus knows nothing about
what an agent does: a routine is a schedule and a prompt, and everything
specific to the user lives in the agent's own files. An on-call agent that
watches CI and alerts is one example; a meeting reminder or a weekly digest
is another.

## Creating one

```
daedal agent spawn --workspace <workspace> --routine-agent --name <name>
```

Daedalus creates the agent's folder at
`<workspace>/worktrees/agents/<slug>`, where the slug comes from the name, and
starts Claude there. A workspace can have any number of routine agents, each
in its own folder. On first start the agent says what it is and asks what it
should do; it sets nothing up by itself.

| Path                                                                       | Purpose                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `AGENT.md`                                                                 | Its name, the purpose it writes from the conversation, notes |
| `routines/*.md`                                                            | One file per routine                                         |
| `routines/templates/*.md`                                                  | Routines that never fire by themselves                       |
| `.claude/skills/daedalus-routine-agent`, `.claude/skills/daedalus-routine` | Its skills, refreshed on every start                         |
| `.claude/settings.json`                                                    | Its permission lists                                         |

The skills live in the folder rather than with the global skills, so
`/daedalus-routine` exists only in the agent's session. The folder never
moves, so Claude's memory for that directory carries across handoffs. The
session starts in auto mode like every Daedalus session. The starting
settings allow the agent's own `daedal` commands and deny `AskUserQuestion`;
the agent adds the read-only commands its routines need, and a deny list for
writes, while the user is there.

Routine agents run on Claude only for now: the routine skill is a Claude
slash command, and runs go to background subagents.

## Routine files

```markdown
---
name: ci-health
schedule: every 30m
model: sonnet
timeout: 10m
output: task
enabled: true
---

The prompt for the subagent that does the run. {{last_run}} and {{missed}}
are filled in by Daedalus.
```

- `schedule`: `every <n>m|h` (at most once a minute), `cron "<5 fields>"` in
  local time, or `at <YYYY-MM-DDTHH:MM>` for one run, after which the file is
  removed.
- `until`: the routine removes itself after this time.
- `output`: `task` (a task and a notification per report), `notify` (a
  notification only) or `none` (the routine reports nothing itself).
- `vars`: fill `{{name}}` in the body. Daedalus also fills `{{last_run}}`,
  `{{now}}`, `{{run_id}}` and `{{missed}}`.

The user creates routines by talking to the agent, which writes them with
`daedal routine add` after the user agrees to the schedule and prompt. The
scheduler reads the folder on every tick and re-parses only changed files, so
an edit by hand, by the agent or by the app takes effect within a couple of
seconds. A file that does not parse is listed with its error by
`daedal routine list` and never runs.

## Manual and auto mode

An agent is in manual mode while the user talks to it, and in auto mode
while it runs routines with its input locked.

- With no enabled routine, or while paused, it stays in manual mode with no
  countdown.
- Once it has an enabled routine, it switches to auto 5 minutes after the
  user's last keystroke in its terminal. Scrolling and selecting do not count.
  The switch waits until the agent is idle at its prompt, so it never cuts
  off an answer.
- At the switch, unsent text in the input box is saved and cleared with
  Ctrl-C. The next unlock types it back.
- In auto mode the app drops keystrokes on the agent's terminal. Only
  terminal replies and mouse reports pass, so scrolling still works.
  `daedal agent send` is refused. Only Daedalus types there.
- `daedal routine-agent unlock` puts it back in manual mode, types the saved
  text back, and restarts the countdown. `daedal routine-agent auto` skips
  the countdown.
- Runs that come due in manual mode wait, at most one per routine, and go
  out once it is back in auto. Runs already in flight finish and report.
- The mode is stored, so it survives an app restart. A manual agent whose
  last keystroke is more than 5 minutes old locks on the first tick.

The mode, the countdown and the saved text are written with guarded updates,
so a keystroke that arrives while the scheduler is locking wins.

## How a run happens

1. The host tick queues each due routine once, however late it is. A routine
   whose previous run has not ended gets a `skipped` run instead.
2. A queued run is typed into the agent's pane as `/daedalus-routine <id>`
   when all of these hold: the agent is on duty and in auto mode, its session
   is running and at its prompt (idle, or waiting on background agents), no
   handoff is pending, and fewer than 3 runs are in flight. Lines are at
   least 15 seconds apart.
3. The agent runs `daedal routine start <id>`, hands the prompt to a
   background subagent, and ends its turn. When the result comes back it files
   reports, resolves what went away, and closes the run with
   `daedal routine done` or `daedal routine fail`.
4. A run with no end before its timeout fails. Three failures in a row raise
   a badge on the agent's session.

## Reports and tasks

`daedal routine report` is the only way a routine raises something. In one
immediate SQLite transaction it decides:

- the key is open: an update section on its task, no new task, no second
  notification;
- `--same-as <key>`: the report joins that open report's task;
- the key was resolved within 14 days: its task reopens (back to `todo` if it
  was closed) and the user is notified again;
- otherwise: a new task on the workspace's board, which names the earlier one
  if there was one.

A partial unique index keeps at most one open report per key, so two
processes reporting at once produce one task. A report resolved for 24 hours
closes, and its task moves to done if no agent was ever started on it. That
is the one task status change a routine agent makes.

## Feedback and urgency

`daedal routine feedback <task> noise` closes the reports filed on a task,
and from then on their keys raise nothing: a report under one only records
that it was seen. `feedback <task> none` undoes that. A task the user moves to
done is recorded as useful. The agent learns patterns from this feedback
itself and writes them into `AGENT.md`; Daedalus only enforces the exact key.

An `--urgent` report gets through Focus mode. It is the one exception to
Focus mode, and it still says nothing about a session already on screen.

## Lifecycle

`daedal routine-agent pause` stops delivery and keeps the session; `resume`
starts it again. Archiving the agent's session pauses it and keeps its
routines, tasks and memory; restoring the session, or `resume`, brings it
back. The scheduler drains an agent in auto mode when its context passes
`--auto-handoff` percent (60 by default), so a handoff never interrupts a
conversation: it stops delivering, waits up to 10 minutes for runs
in flight, then asks for a handoff. When the agent runs
`daedal agent continue`, the successor starts in the same folder with the same
name and prompt and takes over the routines. A handoff the agent never
finishes is completed without a note after 15 minutes. A session that dies is
revived or relaunched, at most once every 5 minutes. `routine-agent remove
--force` forgets the agent and archives its session; its folder and tasks
stay.

Nothing fires while the app is closed. Workspace auto handoff skips routine
agent sessions, because the agent's own drain decides when it hands off.

## In the app

A routine agent's session is pinned at the top of Sessions, with a gold edge
and a "Routine agent" label. Tasks its routines make are ordinary tasks on
the Board; their cards add a gold tag with the agent's name, the routine,
whether it resolved and how often it came back, with Useful and Noise.
