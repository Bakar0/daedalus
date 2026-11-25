# Daedalus CLI reference

Add `--json` anywhere on a non-interactive command for a compact result envelope.

## Workspaces

```text
daedal workspace create <name> [--slug <slug>] [--path <path>]
daedal workspace list [--archived]
daedal workspace get <workspace>
daedal workspace update <workspace> [--name <name>] [--slug <slug>] [--start-sets-in-progress on|off] [--default-provider claude|codex|none] [--default-model <model>|none] [--default-claude-account <account>|default] [--default-codex-account <account>|default] [--auto-rebirth <percent>|off|default]
daedal workspace archive <workspace>
daedal workspace restore <workspace>
daedal workspace remove <workspace> [--delete-files] --force
```

## Tasks and board status

```text
daedal task create [--workspace <workspace>] --title <title> [--description <text> | --description-file <path|->] [--priority <priority>]
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
daedal repo worktree create --session <session-id> --repository <name-or-id> --branch <name>
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
daedal agent spawn [--workspace <workspace>] (--provider <codex|claude> | --command <configured-name>) [--task <task-ref>] [--name <name>] [--model <model>] [--account <account>] [--message <text>] [--refine] [--color <color>] [--pin]
daedal agent spawn --team [<lead>] --message <instructions> [--name <name>] [--workspace <workspace>] [--task <task-ref>] [--provider claude|codex] [--model <model>]
daedal agent list [--workspace <workspace>] [--running|--archived]
daedal agent get <agent-id>
daedal agent attach <agent-id>
daedal agent send <agent-id> <text>
daedal agent archive <agent-id> [--force]
daedal agent rebirth <agent-id>
daedal agent continue [<agent-id>] [--note-file <path|->] [--provider <codex|claude>] [--model <model>] [--account <account>] [--message <text>]
daedal agent restore <agent-id>
daedal agent stop <agent-id> [--force]
daedal agent remove <agent-id>
daedal session rename <session> <name>
daedal session pin|unpin <session>
daedal session color <session> <red|orange|gold|green|teal|blue|purple|pink|none>
daedal session rebirth-at <session> <percent>|off|default
daedal session abilities <session>
daedal session grant|revoke <session> <ability>
daedal team list [--team <lead>]
daedal team tree [--team <lead>]
daedal team goal [<text>] [--team <lead>]
daedal team pause|resume [--team <lead>]
daedal team move <session> --to <lead> | --out [--user]
daedal channel say ["#<name>"] "<text>" [--team <lead>] [--user]
daedal channel read ["#<name>"] [--tagged | --all] [--limit <n>] [--team <lead>] [--user]
daedal channel find "<words>" [--since <time>] [--team <lead>] [--user]
daedal channel list [--user]
```

`<session>` is a session id, or its name when only one live session has it.
Any session can lead a team: the first `agent spawn --team` run inside it
adds a member and makes it the lead, and it talks to members in the team's
channel with `daedal channel`. A member can lead a team of its own, up to 3 levels below the
top lead and 5 members a lead that are not archived; a lead frees a place by
archiving a member whose work is checked (`agent archive <member>`). Stopping
or archiving a lead does the same to the members below it. `team move
<session> --to <lead>` moves a running session, with the team it leads, into
another team without restarting it; a lead moves only sessions below it. The `daedalus-orchestration` and `daedalus-team` skills
and `daedal team --help` describe it. A rebirth moves a session's team, pin
and color to the successor, which gets ` · 2`.
Routines are not an ability: they run on a schedule in a workspace, from the
Routines page; `daedal routine --help` describes them.

Inside a session, `task create` and `agent spawn` default `--workspace` to
your own workspace.

`agent spawn --task` moves a `todo` or `blocked` task to `in_progress` when the
workspace's `--start-sets-in-progress` setting is on (the default); do not set
it again yourself. `--refine` links the session to the task but asks it to
question the user and write the brief rather than do the work, and leaves the status alone.

`agent continue` moves a session's work to a fresh one with an empty context:
the same task, working directory and worktrees, and the same provider and model
unless you pass others. The note from `--note-file` is written to
`REBIRTH.md` in that directory and the new session reads it first. With no id
it continues the session it runs in, and archives that session just after the
command exits. `agent rebirth` asks a running agent to write the note and run
`agent continue` itself; it is what the app's Rebirth button sends.
The app sends the same request on its own once a session's context passes
its rebirth threshold: the session's own (`session rebirth-at`), else its
workspace's (`workspace update --auto-rebirth`), else the global default in
Settings > Sessions, which is off until set. `off` at a level turns it off
whatever the level above says; `default` takes the level above.

`agent models` does not require a workspace. With `--json`, pass an exact
`data.models[].id` to `agent spawn --model`; omit `--model` to use the
workspace's `defaultModel` when `--provider` is its `defaultProvider`, and
`data.defaultModel` otherwise. A workspace default the provider no longer
lists fails the spawn with exit code 2; fix it with `workspace update
--default-model`. Display labels are descriptive and are not model IDs.

## Plans

```text
daedal plan new "<title>" [--workspace <workspace> | --home] [--owner <handle>] [--body-file <path|->]
daedal plan list [--workspace <workspace> | --home]
daedal plan show <plan>
daedal plan ask <plan> ^<id> "<question>"
```

A plan is `plans/<slug>.plan.md` in a workspace (or at Home with `--home`):
frontmatter `plan:` and `owner:`, free markdown sections, and a nested
checklist under `## Tasks`, one task per line as `- [ ] Title @owner ^id`.
States are `[~]` draft, `[ ]` todo, `[/]` doing, `[x]` done, `[!]` blocked and `[-]`
dropped; markdown indented under a task is its details, and a `> ? ...` line
there is a question for the user. `<plan>` is the slug, a path, or the
absolute path an agent was given. `ask` adds the question under the task and starts a thread for
it, as `daedal thread new --plan` does. An `@owner` is a session's team handle or its name as a
handle (`Cart endpoints` is `@cart-endpoints`). The app opens a plan as an
interactive document: Start agent on a task, Open its owner, and Ask (⌘L) on
any selected text, which sends the owner the question, then `path:lines:` and
the quote. Edit the file directly for anything else, except the marks:
Daedalus writes them from the jobs' states.

## Jobs

```text
daedal job next
daedal job done --result "<what came out>" [--out <name>=<value> ...] [--job <name>]
daedal job hold --why "<what you need decided>"
daedal job add "<title>" [--name <name>] [--needs <a,b>] [--gives <x:kind,y>] [--instructions "<text>" | --file <path>] [--gate start|result] [--me | --to <session>] [--under <job>]
daedal job add --plan <plan>
daedal job skip|redo <job> --why "<why>"
daedal job retry <job>
daedal job fail --why "<why>"
daedal job tree
daedal job approve
daedal job release [<job>] [--answer "<the user's answer>"]
```

A job is one piece of work with an owner: a workflow step, a plan task, or
work one session handed another. Jobs form a tree and Daedalus hands a
session one at a time. `next` prints the current job's brief: what to do,
what the jobs before it handed over, and which outputs to hand on. `done`
finishes it and prints the next brief; a job with a result gate is held
(exit code 4) until `approve`, run only on the user's word. `add` puts a
job under the one you are on and starts a new agent for it, unless `--me`
keeps it in this session or `--to` gives it to a running one; `--needs`
names jobs beside it that must finish first. `add --plan` adds every task
of a plan, ordered by its `## Flow`. `hold` stops a job until the user
decides and `release` passes on their answer. `skip` closes a job with
everything under it, `redo` puts finished work back with what needed it,
and `retry` runs a failed job again. `<job>` is a name from `job tree` or
an id. Every command takes `--session <id>`, as a lead uses for a member.

## Threads

```text
daedal thread new "<message>" [--option "<text>"]... [--details "<text>" | --details-file <path|->] [--plan <plan> ^<id>] [--session <session>]
daedal thread say <n> "<message>" [--option "<text>"]... [--details ...]
daedal thread read <n>
daedal thread find "<words>" [--since <14d|48h|time>] [--all]
daedal thread list [--team | --all] [--session <session>]
daedal thread bump <n>
daedal thread resolve <n> ["<why>"]
```

A thread is a conversation with the user. Before opening one, `thread find`
it: if a thread (open or resolved) is about the same thing, `thread say` in
it, which reopens a resolved one. Otherwise write one line in your reply
that asks the user the question directly ("Which retry budget should
webhooks get? The options are in the thread.", never "I'm asking the user
in a thread..."), then `thread new`: the thread hangs off your
last message, and the user replies in the thread, in the app. What the user
writes comes back to you as a message. Talk about a thread only in the
thread: status, corrections and follow-ups go there with `thread say`, not
in main. Say "Thread #<n>" and do not repeat it. When you run out of other
work and are blocked on it, run `thread bump <n>` once. `thread resolve`
ends a settled thread, with what the user said if they answered in your
session. `thread read <n>` prints a thread, with the conversation of its
fork if it has one. See `daedal thread --help` for every flag. The old
`thread start/update/show/close`, `daedal activity` and `daedal ask` fail
and print the command to run instead.

## Accounts

```text
daedal account list
daedal account status [<claude|codex> [<account>]]
daedal account add <claude|codex> <name> [--api-key | --sso | --console]
daedal account add claude <name> --bedrock --aws-profile <profile> --aws-region <region>
daedal account aws claude <account> --aws-profile <profile> --aws-region <region>
daedal account method claude <account> <subscription|sso|console>
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

## Secrets

```bash
daedal secret list [--workspace <workspace> | --global]
daedal secret set <NAME> [--workspace <workspace> | --global]      # value on standard input
daedal secret remove <NAME> [--workspace <workspace> | --global]
daedal exec [--secret <NAME>]... [--workspace <workspace>] -- <command> [<args>...]
```

A secret is a value a tool needs, like an API key, that the user stored once,
globally or for one workspace. `secret list` shows the workspace's own and the
global ones (a workspace's wins over a global one of the same name). `exec`
starts the command with each named secret in its environment under its own
name, masks the values as `***` in output read through a pipe, and returns the
command's exit code. A secret set nowhere exits 3 before the command starts.
Everything after `--` belongs to the command, `--json` included.

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
