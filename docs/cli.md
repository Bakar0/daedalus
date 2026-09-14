# CLI contract

`daedal` is the complete Phase 2–4 public interface. Workspace references accept an exact UUID or slug. Task and agent references accept UUIDs.

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
daedal task get <task-id>
daedal task update <task-id> [--title <title>] [--description <text>] [--priority <priority>]
daedal task status <task-id> <status>
daedal task remove <task-id> --force
```

Statuses are `todo`, `in_progress`, `blocked`, `done`, and `cancelled`. Priorities are `low`, `normal`, and `high`. Entering `done` sets `completedAt`; moving to any other status clears it. Agent lifecycle never changes task status. Task removal requires `--force` and refuses while a live agent references the task.

## Agent

```text
daedal agent models <codex|claude>
daedal agent spawn --workspace <workspace> --provider codex [--task <task-id>] [--model <model>]
daedal agent spawn --workspace <workspace> --provider claude [--task <task-id>] [--model <model>]
daedal agent spawn --workspace <workspace> --command <configured-name> [--task <task-id>]
daedal agent list [--workspace <workspace>] [--running]
daedal agent get <agent-id>
daedal agent attach <agent-id>
daedal agent send <agent-id> <text>
daedal agent archive <agent-id> [--force]
daedal agent restore <agent-id>
daedal agent stop <agent-id> [--force]
daedal agent remove <agent-id>
```

Built-in provider definitions come from `config.json`. Named custom definitions use `--command`. Executables and arguments are always passed as arrays. Task-backed Claude launches receive `title + blank line + description` as one prompt argument. Codex receives the same prompt through tmux after Daedalus assigns its immutable native session name. Custom launches receive the prompt in `DAEDALUS_TASK_PROMPT`; all task-backed launches also receive `DAEDALUS_TASK_ID`.

Each launch gets a durable `daedalus_<uuid>` tmux session on a Daedalus server isolated by `DAEDALUS_HOME`. `attach` hands the terminal to tmux and therefore rejects `--json`; every non-interactive command supports the JSON envelope. `send` sends literal text followed by Enter. `stop` first sends Ctrl-C unless `--force` is used, then closes the session. A running session must be stopped before its history row can be removed.

`archive` is the preferred lifecycle action. It stops a live session and preserves its provider conversation locator. `restore` starts a new tmux runtime using Codex or Claude's native resume command; terminal sessions reopen as fresh login shells. `workspace archive` cascades to all sessions in that workspace, while `workspace restore` does not automatically restore them. Add `--archived` to workspace or agent lists to inspect archived records.

Startup reconciliation compares SQLite with tmux. Missing live sessions become `lost`; existing starting sessions become `running`. If tmux itself is unavailable, reconciliation leaves persisted state unchanged and agent lifecycle commands report exit code 5 where applicable.

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
