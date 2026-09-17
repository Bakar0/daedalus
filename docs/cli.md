# CLI contract

`daedal` is the complete Phase 2–4 public interface. New workspace IDs are immutable readable slugs derived from their names, such as `my-project`; the mutable workspace slug is also accepted as an alias. Tasks have workspace-scoped numbers displayed as `#1`, `#2`, and so on, and deleted numbers are never reused. Use `my-project#1` outside a session, or pass `1 --workspace my-project`. Stable internal task IDs and legacy references remain valid for compatibility. Agent references use UUIDs.

## Output and exit codes

Human results go to stdout and actionable errors go to stderr. `--json` may appear anywhere and emits exactly one compact envelope. Success uses:

```json
{ "ok": true, "data": {} }
```

Failure uses:

```json
{
  "ok": false,
  "error": { "code": "NOT_FOUND", "message": "...", "details": {} }
}
```

The `details` property is omitted when no structured details exist.

| Code | Meaning                            |
| ---: | ---------------------------------- |
|    0 | Success                            |
|    1 | Unexpected/internal failure        |
|    2 | Usage or validation error          |
|    3 | Object not found                   |
|    4 | Conflict                           |
|    5 | Missing or incompatible dependency |

## Workspace

```text
daedal workspace create <name> [--slug <slug>] [--path <path>]
daedal workspace list [--json]
daedal workspace get <workspace> [--json]
daedal workspace update <workspace> [--name <name>] [--slug <slug>]
daedal workspace archive <workspace>
daedal workspace restore <workspace>
daedal workspace remove <workspace> [--delete-files] --force
```

Create makes a real directory and identity marker before committing metadata. Slugs contain lowercase ASCII letters, digits, and hyphens. Updating a slug changes the lookup alias, not the directory path.

Removal requires `--force`. Without `--delete-files`, it unregisters the workspace and preserves every file. With `--delete-files`, it only removes a canonical, non-root, non-symlink directory carrying the exact registered workspace ID marker. Live agents block removal.

## Task

```text
daedal task create --workspace <workspace> --title <title> [--description <text>] [--priority <priority>]
daedal task list [--workspace <workspace>] [--status <status>]
daedal task get <task-ref> [--workspace <workspace>]
daedal task current
daedal task update <task-ref> [--workspace <workspace>] [--title <title>] [--description <text>] [--priority <priority>]
daedal task status <task-ref> <status> [--workspace <workspace>]
daedal task remove <task-ref> [--workspace <workspace>] --force
```

Statuses are `todo`, `in_progress`, `blocked`, `done`, and `cancelled`. Priorities are `low`, `normal`, and `high`. Entering `done` sets `completedAt`; moving to any other status clears it. Agent lifecycle never changes task status. Task removal requires `--force` and refuses while a live agent references the task.

## Agent

```text
daedal agent models <codex|claude>
daedal agent spawn --workspace <workspace> --provider codex [--task <task-ref>] [--model <model>] [--message <text>]
daedal agent spawn --workspace <workspace> --provider claude [--task <task-ref>] [--model <model>] [--message <text>]
daedal agent spawn --workspace <workspace> --command <configured-name> [--task <task-ref>] [--message <text>]
daedal agent list [--workspace <workspace>] [--running]
daedal agent get <agent-id>
daedal agent wait [--session <agent-id>] [--workspace <workspace>] [--for attention|idle] [--timeout <seconds>]
daedal agent attach <agent-id>
daedal agent send <agent-id> <text>
daedal agent archive <agent-id> [--force]
daedal agent restore <agent-id>
daedal agent stop <agent-id> [--force]
daedal agent remove <agent-id>
```

Built-in provider definitions come from `config.json`. Named custom definitions use `--command`. Executables and arguments are always passed as arrays. A task-backed launch receives only `Execute task #<number>` plus optional `--message` guidance; the installed skill supplies the workflow, so task content and CLI instructions are not duplicated in the prompt. Claude and Codex receive the prompt through their native initial-prompt argument, while custom launches receive it in `DAEDALUS_TASK_PROMPT`. Daedalus never types the initial prompt into the terminal. Agent processes receive their current session, workspace, internal task ID, and task number through `DAEDALUS_SESSION_ID`, `DAEDALUS_WORKSPACE_ID`, `DAEDALUS_TASK_ID`, and `DAEDALUS_TASK_NUMBER`. These variables are restored when a session resumes.

Each launch gets a durable `daedalus_<uuid>` tmux session on a Daedalus server isolated by `DAEDALUS_HOME`. `attach` hands the terminal to tmux and therefore rejects `--json`; every non-interactive command supports the JSON envelope. `send` sends literal text followed by Enter. `stop` first sends Ctrl-C unless `--force` is used, then closes the session. A running session must be stopped before its history row can be removed.

`archive` is the preferred lifecycle action. It stops a live session and preserves its provider conversation locator. `restore` starts a new tmux runtime using Codex or Claude's native resume command; terminal sessions reopen as fresh login shells. `workspace archive` cascades to all sessions in that workspace, while `workspace restore` does not automatically restore them. Add `--archived` to workspace or agent lists to inspect archived records.

Startup reconciliation compares SQLite with tmux. Missing live sessions become `lost`; existing starting sessions become `running`. If tmux itself is unavailable, reconciliation leaves persisted state unchanged and agent lifecycle commands report exit code 5 where applicable.

## Activity

Lifecycle status answers "does the process exist". Activity is a second,
orthogonal axis answering "is the agent working, done, or waiting for me". An
idle session and one blocked on a permission dialog are both `running`, and
only the second one should pull a person out of what they are doing.

`agent list --json` and `agent get --json` carry an `activity` block on every
session:

```json
{
  "activity": {
    "sessionId": "…",
    "activity": "needs_permission",
    "detail": "Bash(git push)",
    "since": "2026-09-17T09:41:02.118Z",
    "observedAt": "2026-09-17T09:41:02.118Z",
    "source": "hook"
  },
  "attention": [
    {
      "id": "…",
      "text": "Claude needs permission: Bash(git push)",
      "raisedAt": "…",
      "source": "hook"
    }
  ]
}
```

`activity` is one of `unknown`, `working`, `needs_permission`, `needs_input`,
`idle`, `done`, `error`. `since` is when the state began and drives "waiting
4m"; `observedAt` is when it was last seen and drives staleness. A session with
no observation reports `unknown` from source `none` rather than omitting the
key, so a consumer never has to tell "not observed" from "field missing".

### Sources, and why they are on the wire

`source` ranks `agent` > `hook` > `transcript` > `pane`. Provider fidelity is
wildly asymmetric, so the field is not decoration: a weaker source is refused
outright while a stronger reading is still fresh, which is what stops the
display quietly degrading to the confidence of its worst detector. Surfaces
render a `pane` reading as a guess, never as a fact.

`agent` is the session reporting on itself through `daedal attention`. It has no
equivalent in either provider's hook vocabulary and is the only tier that works
for a `custom` session.

### Per-provider capability

| Provider                             | `working` | `idle` | `needs_permission` | `needs_input` | `done` | `error` | Source       |
| ------------------------------------ | --------- | ------ | ------------------ | ------------- | ------ | ------- | ------------ |
| Claude, hooks                        | yes       | yes    | yes                | yes           | yes    | yes     | `hook`       |
| Codex 0.145+, hooks approved         | yes       | yes    | yes                | yes           | no     | no      | `hook`       |
| Codex, rollout fallback              | yes       | yes    | **no**             | **no**        | no     | no      | `transcript` |
| `custom`                             | no        | no     | no                 | no            | no     | no      | —            |
| Any provider, via `daedal attention` | no        | no     | no                 | yes           | no     | no      | `agent`      |

Read the gaps as limitations, not bugs. Codex approvals never reach the rollout
JSONL, so that tier genuinely cannot report `needs_permission` — which is
exactly why hooks are the primary path and the rollout is only the floor. Codex
has no `agent_completed` or turn-failure event, so `done` and `error` are
Claude-only. A `custom` session has no structured signal at all and reports a
permanent `unknown`; `daedal attention` is how such a session says anything.

The rollout tier is weaker on current Codex than the floor it was designed as.
Measured on codex-cli 0.154.0, a session writes `task_started` and
`task_complete` to `~/.codex/sessions/**.jsonl` for its first turn and then
stops: later turns go to `~/.codex/thread_history_1.sqlite` instead, which has
no documented schema and is not read here. So on 0.154 the fallback reports the
opening turn and afterwards goes quiet, and Codex activity depends on hooks in
practice — which is why the hooks are installed rather than skipped whenever
another tool is present.

`daedal doctor` reports which tier a machine is actually on, and what to do
about it:

```text
✓ codex activity: hook
  hooks are installed and approved. They are installed alongside another
  tool's hooks; both run.
```

```text
✓ codex activity: transcript
  hooks are installed but not yet approved — choose "Trust all and continue"
  at Codex's one-time "Hooks need review" prompt to enable them. Until then
  activity falls back to the rollout.
```

That check is never a failure — the fallback is a working tier, not a broken
install — but it is the answer to "why does my Codex session never say
`needs_permission`", which is otherwise indistinguishable from a bug.

### Hook injection, and what it costs

Daedalus injects the hooks at launch and installs nothing globally.

For **Claude** they ride in the same `--settings` object that already carries
the status line. If you pass your own `--settings`, Daedalus now merges into it
rather than skipping injection entirely: your `statusLine` is never replaced,
your hook entries are kept and ordered first, and only Daedalus's own stale
entries are stripped on relaunch. A `--settings` value that is neither readable
JSON nor a readable file is left exactly as written, and activity degrades to
`unknown`.

For **Codex** there is no per-session equivalent, so they are installed into
`~/.codex/config.toml` inside a fenced block:

```toml
# >>> daedalus activity hooks (generated — do not edit) >>>
# Delete this block to turn off Daedalus agent activity for Codex.
...
# <<< daedalus activity hooks <<<
```

This is the only global change Daedalus makes, and it is designed to share the
file rather than own it:

- **Other tools keep working.** The block is _appended_, so hook groups
  belonging to anything else you have installed keep their position — and
  Codex keys a hook's approval to its position, so their existing approvals
  survive untouched. Both tools' hooks run on every event; neither replaces the
  other. A `-c` override could not do this, because it replaces the whole
  `hooks.<Event>` key and would silently disable whatever else was registered
  there.
- **Relaunching updates the block rather than accumulating copies**, and
  nothing is rewritten unless the content actually changes — every change to a
  hook definition invalidates its approval and makes Codex ask again.
- Everything outside the fence survives byte for byte, the first write leaves a
  `config.toml.daedalus-backup`, and the write is atomic because Codex writes
  to this file too.
- Deleting the block turns Codex activity off.

Builds older than 0.145 ignore hooks silently — no error, no log line — so the
version is probed rather than assumed, and nothing is installed for them.

Codex then gates hooks behind a one-time **"Hooks need review"** prompt, because
a trusted hook runs outside its sandbox. **Daedalus deliberately does not answer
that prompt.** Trusting code to run outside a sandbox is your decision, and
clicking through a security control on your behalf is not something a status
indicator has earned. Startup treats the prompt as finished rather than blocking
on it, so the session is live and usable either way; until you choose **"Trust
all and continue"**, Codex activity runs on the rollout tier. The approval
persists, so it is a once-per-machine step rather than a per-session one.

Every hook is asynchronous, carries an explicit timeout (5s, 3s for teardown),
swallows every error, and exits 0 even when the Daedalus app is not running. A
hook that fails because the control plane is down must never surface inside your
session. Subagent events are ignored on both providers so the parent session
does not flap to `working` while subagents churn.

### Staleness, and the three ways a status lies

- **Crash.** Lifecycle dominates. When a session becomes `exited` or `lost`,
  activity is cleared, not preserved — "working" is the most damaging thing to
  show for a session that is already gone.
- **Silence.** A `working` reading with a stale `observedAt` decays to
  `unknown` after ten minutes. Note the asymmetry: `idle`, `needs_input` and
  `needs_permission` never decay, because waiting on a person for an hour is a
  real state and is precisely what the badge exists to surface.
- **Restart.** Durable activity is a per-session file under
  `DAEDALUS_HOME/activity/`, written before the database is touched; SQLite is
  the index over it. Startup replays those records instead of resetting to
  defaults, so restarting the app mid-turn keeps the turn. Records belonging to
  sessions that are no longer live are discarded rather than replayed.

### Waiting on activity

```text
daedal agent wait --for attention --timeout 600
daedal agent wait --workspace my-workspace --for idle
```

`wait` blocks until a session reaches a state and exits 0, printing the same
JSON block as `agent get`. `--for attention` resolves on `needs_permission` or
`needs_input`; `--for idle` resolves on `idle` or `done`, and also when the
session ends — a caller waiting on a session that just died wants to be told,
not left hanging. `--session` defaults to `DAEDALUS_SESSION_ID`; `--workspace`
waits for the first matching session in that workspace. Exit code 3 means the
timeout elapsed, distinct from any real failure.

This is what makes the signal scriptable rather than only visible: a shell
notifier, a Slack ping or a tmux bell can wait on the same fact the badge draws,
with no desktop app running. The app's notification is one consumer of this
mechanism rather than the only way to find out.

## Attention, notifications, and presence

```text
daedal attention "<reason>" [--session <agent-id>]
daedal attention --clear [--session <agent-id>]
daedal notify "<message>" [--level info|success|error] [--desktop] [--session <agent-id>]
daedal ui state [--json]
daedal focus <agent-id>
```

These are how an agent reports on itself. Inference from hooks can tell you a
session is blocked; only the agent can tell you why, and this is the only path
that works for `custom` sessions and for providers with no hook support at all.
`--session` defaults to `DAEDALUS_SESSION_ID`, so inside a Daedalus session
these commands take no arguments beyond their text.

`attention` raises a badge with a human-readable reason. Reasons accumulate on
one badge rather than stacking alerts: identical text collapses, the newest five
are kept, and the sixth evicts the oldest. It is therefore safe to call
repeatedly — six raises leave one badge with five reasons and one alert, not six
alerts. `--clear` drops every reason at once; a clear is never queued and never
silenced, so it goes through while Focus mode is on and purges anything already
queued for that session.

`notify` sends one ephemeral alert, routed by where the user actually is:
nothing when they are already looking at that session, a toast when the app is
open elsewhere, a native notification when it is backgrounded, closed, or the
user has been idle for five minutes. `--desktop` forces the native channel.
A suppressed alert is reported (`suppressed`, and a `reason` such as
`focus mode is on`) rather than silently dropped, so a caller can always tell
suppression from failure.

`ui state` reports whether the app is running and in the foreground, which
workspace and session it is showing, how many seconds the user has been idle,
and whether Focus mode is on — enough for an agent to choose its own channel
before pinging. `focus` raises the app and selects a session; it is what a
clicked notification runs.

Discipline, and it matters more than the mechanism: ping when blocked, or when
something important finished or broke. Never ping for per-step progress,
routine tool calls, or anything already on screen.

## Repository worktrees

```text
daedal repo library list
daedal repo library add <url-or-absolute-path> [--name <name>]
daedal repo list --workspace <workspace>
daedal repo attach --workspace <workspace> --repository <library-id>
daedal repo sync <attachment-id>
daedal repo detach <attachment-id>
daedal repo worktree create --session <agent-id> --repository <name-or-id>
```

Library entries are bare clones shared across workspaces. `library add` accepts
a remote URL or full local path and refreshes an existing entry with the same
remote. `attach` fetches the library entry and creates a read-only planning
checkout under the workspace's `repos/` directory. `sync` refreshes that
checkout when it can advance safely. `detach` refuses while session worktrees
depend on the attachment.

Agent sessions receive `DAEDALUS_SESSION_ID`, `DAEDALUS_HOME`, and a PATH containing Daedalus's bundled CLI. They start in an isolated session folder without eagerly creating a worktree for every attached repository. The worktree command creates the selected repository's writable worktree from the attachment's pinned base commit and prints its path; repeating it returns the existing worktree.

## Configuration and isolation

```json
{
  "workspaceRoot": "~/.daedalus/workspaces",
  "agents": {
    "codex": { "executable": "codex", "args": [] },
    "claude": { "executable": "claude", "args": [] },
    "shell": { "executable": "/bin/sh", "args": ["-i"] }
  }
}
```

Set `DAEDALUS_HOME` to relocate the configuration, SQLite database, logs, workspace root, and tmux server identity. Automated tests always use temporary homes and isolated tmux servers.

The desktop app installs a `daedal` shim at `$DAEDALUS_HOME/bin/daedal`. The
shim runs the packaged CLI with the resolved Bun executable rather than the
desktop Cottontail runtime, so non-interactive commands terminate after
emitting their result. Daedalus-launched sessions put this directory first on
`PATH`.

`daedal doctor [--json]` checks the verified Bun version, tmux availability/minimum, resolved home, and migrated database.

`daedal --version --json` reports the version from the same package metadata
used by the desktop bundle, preventing the CLI and app version strings from
drifting apart.
