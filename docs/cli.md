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
daedal agent spawn --workspace <workspace> --provider codex [--task <task-id>]
daedal agent spawn --workspace <workspace> --provider claude [--task <task-id>]
daedal agent spawn --workspace <workspace> --command <configured-name> [--task <task-id>]
daedal agent list [--workspace <workspace>] [--running]
daedal agent get <agent-id>
daedal agent attach <agent-id>
daedal agent send <agent-id> <text>
daedal agent stop <agent-id> [--force]
daedal agent remove <agent-id>
```

Built-in provider definitions come from `config.json`. Named custom definitions use `--command`. Executables and arguments are always passed as arrays. Task-backed Codex and Claude launches receive `title + blank line + description` as one prompt argument. Custom launches receive the same prompt in `DAEDALUS_TASK_PROMPT`; all task-backed launches also receive `DAEDALUS_TASK_ID`.

Each launch gets a durable `daedalus_<uuid>` tmux session on a Daedalus server isolated by `DAEDALUS_HOME`. `attach` hands the terminal to tmux and therefore rejects `--json`; every non-interactive command supports the JSON envelope. `send` sends literal text followed by Enter. `stop` first sends Ctrl-C unless `--force` is used, then closes the session. A running session must be stopped before its history row can be removed.

Startup reconciliation compares SQLite with tmux. Missing live sessions become `lost`; existing starting sessions become `running`. If tmux itself is unavailable, reconciliation leaves persisted state unchanged and agent lifecycle commands report exit code 5 where applicable.

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

`daedal doctor [--json]` checks the verified Bun version, tmux availability/minimum, resolved home, and migrated database.
