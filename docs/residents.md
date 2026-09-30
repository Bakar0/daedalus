# Residents

A resident is a named, long-lived agent that owns a workspace and runs
routines on a clock the desktop app keeps. The first one is Argus, an on-call
agent. Daedalus knows nothing about what a resident watches: a routine is a
schedule and a prompt, and everything specific to the user lives in the
resident's own files, written with the user during first-run setup.

## The workspace

`daedal resident create <slug>` creates a normal workspace with:

| Path                                                                  | Purpose                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------- |
| `CHARTER.md`                                                          | The resident's name and duties                                |
| `SERVICES.md`                                                         | What the user owns and wants watched, and rules from feedback |
| `TOOLS.md`                                                            | The resident's notes on how it reaches each source            |
| `routines/*.md`                                                       | One file per routine                                          |
| `routines/templates/*.md`                                             | Routines that never fire by themselves                        |
| `BRIEF.md`                                                            | Context for agents started from the resident's tasks          |
| `.claude/skills/daedalus-resident`, `.claude/skills/daedalus-routine` | The resident's skills, refreshed on every start               |

The skills live in the workspace rather than with the global skills, so
`/daedalus-routine` exists only in the resident's session. The resident's
session runs at the workspace root and never moves, so Claude's memory for
that directory carries across handoffs. It starts with `--permission-mode
default`; its allow and deny lists go in the workspace's
`.claude/settings.json`, which the resident proposes during setup and writes
once the user agrees.

Residents run on Claude only for now: the routine skill is a Claude slash
command in the workspace.

## Routine files

```markdown
---
name: ci-health
schedule: every 30m
model: sonnet
timeout: 10m
findings: task
enabled: true
---

The prompt for the subagent that does the run. {{last_run}} and {{missed}}
are filled in by Daedalus.
```

- `schedule`: `every <n>m|h` (at most once a minute), `cron "<5 fields>"` in
  local time, or `at <YYYY-MM-DDTHH:MM>` for one run, after which the file is
  removed.
- `until`: the routine removes itself after this time.
- `findings`: `task`, `notify` or `none`.
- `vars`: fill `{{name}}` in the body. Daedalus also fills `{{last_run}}`,
  `{{now}}`, `{{run_id}}` and `{{missed}}`.

The scheduler reads the folder on every tick and re-parses only changed
files, so an edit by hand, by the resident or by the app takes effect within
a couple of seconds. A file that does not parse is listed with its error by
`daedal routine list` and never runs.

## How a run happens

1. The host tick queues each due routine once, however late it is. A routine
   whose previous run has not ended gets a `skipped` run instead.
2. A queued run is typed into the resident's pane as `/daedalus-routine <id>`
   when all of these hold: the resident is on duty, its session is running and
   at its prompt (idle, or waiting on background agents), no handoff is
   pending, fewer than 3 runs are in flight, and the user has not typed into
   that terminal in the last minute. Lines are at least 15 seconds apart.
3. The resident runs `daedal routine start <id>`, hands the prompt to a
   background subagent, and ends its turn. When the result comes back it
   reports findings, clears what went away, and closes the run with
   `daedal routine done` or `daedal routine fail`.
4. A run with no end before its timeout fails. Three failures in a row raise
   a badge on the resident's session.

## Findings

`daedal finding report` is the only way a resident raises an issue. In one
immediate SQLite transaction it decides:

- the key is open: an update section on its task, no new task, no second
  notification;
- `--same-as <key>`: the finding joins that open finding's task;
- the key was cleared within 14 days: its task reopens (back to `todo` if it
  was closed) and the user is notified again;
- otherwise: a new task, which names the earlier one if there was one.

A partial unique index keeps at most one open finding per key, so two
processes reporting at once produce one task. A finding cleared for 24 hours
closes, and its task moves to done if no agent was ever started on it. That
is the one task status change a resident makes.

## Feedback and urgency

`daedal finding verdict <id> noise` closes a finding, and from then on its
key raises nothing: a report under it only records that it was seen. `verdict
<id> none` undoes that. A finding whose task the user moves to done is
recorded as useful. The resident learns patterns from these verdicts itself
and writes them into `SERVICES.md`; Daedalus only enforces the exact key.

An `urgent` finding gets through Focus mode. It is the one exception to Focus
mode, and it still says nothing about a session already on screen.

## Lifecycle

`start` spawns the session; `pause` stops delivery and keeps the session;
`resume` resumes; `stop` archives the session and keeps routines, tasks and
memory. The scheduler drains a resident when its context passes
`--auto-handoff` percent (60 by default) or at 04:00 each day: it stops
delivering, waits up to 10 minutes for runs in flight, then asks for a
handoff. When the resident runs `daedal agent continue`, the duty moves to
the successor, which starts at the same root with the same prompt. A handoff
the resident never finishes is completed without a note after 15 minutes. A
session that dies is revived or relaunched, at most once every 5 minutes.

Nothing fires while the app is closed. Workspace auto handoff skips resident
sessions, because the resident's own drain decides when it hands off.
