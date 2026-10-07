# Daedalus CLI reference

Add `--json` anywhere on a non-interactive command for a compact result envelope.

## Workspaces

```text
daedal workspace create <name> [--slug <slug>] [--path <path>]
daedal workspace list [--archived]
daedal workspace get <workspace>
daedal workspace update <workspace> [--name <name>] [--slug <slug>] [--start-sets-in-progress on|off] [--default-provider claude|codex|none] [--default-model <model>|none] [--default-claude-account <account>|default] [--default-codex-account <account>|default] [--auto-handoff <percent>|off]
daedal workspace archive <workspace>
daedal workspace restore <workspace>
daedal workspace remove <workspace> [--delete-files] --force
```

## Tasks and board status

```text
daedal task create --workspace <workspace> --title <title> [--description <text> | --description-file <path|->] [--priority <priority>]
daedal task list [--workspace <workspace>] [--status <status>]
daedal task get <task-ref> [--workspace <workspace>]
daedal task current
daedal task update <task-ref> [--workspace <workspace>] [--title <title>] [--description <text> | --description-file <path|->] [--priority <priority>]
daedal task status <task-ref> <status> [--workspace <workspace>]
daedal task timeline <task-ref> [--workspace <workspace>]
daedal task remove <task-ref> [--workspace <workspace>] --force
```

`--description-file -` reads the brief from standard input, which is the way to
hand over a long Markdown brief without shell quoting. A brief that says
`depends on #N`, `after #N` or `blocked by #N` makes the board warn before
Start while #N is not done; any other `#N` is a plain link. The board's lanes
are derived, never stored, so there is no status to set for "ready for review".

## Repository library, attachments, and worktrees

```text
daedal repo library list
daedal repo library add <url-or-absolute-path> [--name <name>]
daedal repo list --workspace <workspace>
daedal repo attach --workspace <workspace> --repository <library-id>
daedal repo sync <attachment-id>
daedal repo detach <attachment-id>
daedal repo worktree create --session <session-id> --repository <name-or-id>
```

`repo detach` refuses when session worktrees depend on the attachment. Library
entries are shared bare clones across workspaces and adding an existing remote
refreshes it. `repo library add` accepts a full Git URL or absolute local Git
path and uses Git; unlike the UI's GitHub picker, it does not accept a bare
`owner/repository` name through authenticated `gh`. Adding to the library does
not attach to a workspace, so run `repo attach` separately with the returned
library ID.

## Agents and sessions

```text
daedal agent models <codex|claude> [--account <account>]
daedal agent spawn --workspace <workspace> (--provider <codex|claude> | --command <configured-name>) [--task <task-ref>] [--name <name>] [--model <model>] [--account <account>] [--message <text>] [--draft-brief] [--ability routines] [--color <color>] [--pin]
daedal agent list [--workspace <workspace>] [--running|--archived]
daedal agent get <agent-id>
daedal agent attach <agent-id>
daedal agent send <agent-id> <text>
daedal agent archive <agent-id> [--force]
daedal agent handoff <agent-id>
daedal agent continue [<agent-id>] [--handoff-file <path|->] [--provider <codex|claude>] [--model <model>] [--account <account>] [--message <text>]
daedal agent restore <agent-id>
daedal agent stop <agent-id> [--force]
daedal agent remove <agent-id>
daedal session rename <session> <name>
daedal session pin|unpin <session>
daedal session color <session> <red|orange|gold|green|teal|blue|purple|pink|none>
daedal session abilities <session>
daedal session grant|revoke <session> <ability>
```

`<session>` is a session id, or its name when only one live session has it.
An ability adds something to a session; `routines` is the only one. A session
that holds it runs routines on a schedule while the app is open; the
`daedalus-routines` skill and `daedal routine --help` describe them. A
handoff moves a session's abilities, name, pin and color to the successor.

`agent spawn --task` moves a `todo` or `blocked` task to `in_progress` when the
workspace's `--start-sets-in-progress` setting is on (the default); do not set
it again yourself. `--draft-brief` links the session to the task but asks it to
write the brief rather than do the work, and leaves the status alone.

`agent continue` moves a session's work to a fresh one with an empty context:
the same task, working directory and worktrees, and the same provider and model
unless you pass others. The note from `--handoff-file` is written to
`HANDOFF.md` in that directory and the new session reads it first. With no id
it continues the session it runs in, and archives that session just after the
command exits. `agent handoff` asks a running agent to write the note and run
`agent continue` itself; it is what the app's "Continue in new agent" sends.
With `workspace update --auto-handoff <percent>`, the app sends the same
request on its own once a session's context passes that share of its window.

`agent models` does not require a workspace. With `--json`, pass an exact
`data.models[].id` to `agent spawn --model`; omit `--model` to use the
workspace's `defaultModel` when `--provider` is its `defaultProvider`, and
`data.defaultModel` otherwise. A workspace default the provider no longer
lists fails the spawn with exit code 2; fix it with `workspace update
--default-model`. Display labels are descriptive and are not model IDs.

## Accounts

```text
daedal account list
daedal account status [<claude|codex> [<account>]]
daedal account add <claude|codex> <name> [--api-key]
daedal account login|logout <claude|codex> [<account>] [--sso | --console]
daedal account rename <claude|codex> <account> <name>
daedal account remove <claude|codex> <account> --force
```

Each provider can have several accounts; `default` is the provider's own. A
session runs on one account for its whole life: `agent spawn --account`, else
the workspace's `--default-claude-account` / `--default-codex-account`, else
`default`. A spawn on an account its provider reports as signed out fails with
exit code 5; `account login` is interactive and is for the user to run, so ask
them rather than running it yourself.

## Attention and notifications

```text
daedal attention "<reason>" [--session <agent-id>]
daedal attention --clear [--session <agent-id>]
daedal notify "<message>" [--level info|success|error] [--desktop] [--session <agent-id>]
daedal ui state [--json]
daedal focus <agent-id> | --task <task-id>
```

`--session` defaults to the session the command is run from, found by its
working directory. Raising attention accumulates
reasons on one badge — identical text collapses, the newest five are kept — so
repeated calls never produce repeated alerts. `--clear` drops all reasons at
once and is never suppressed. `notify` picks its channel from `ui state`;
its JSON result reports `delivered`, `suppressed`, and a human-readable
`reason`, so a suppressed alert is distinguishable from a failed one.

## Diagnostics and exit codes

```text
daedal doctor [--json]
```

- `0`: success
- `1`: unexpected/internal failure
- `2`: usage or validation error
- `3`: object not found
- `4`: conflict
- `5`: missing or incompatible dependency
