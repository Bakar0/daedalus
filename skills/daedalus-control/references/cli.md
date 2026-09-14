# Daedalus CLI reference

Add `--json` anywhere on a non-interactive command for a compact result envelope.

## Workspaces

```text
daedal workspace create <name> [--slug <slug>] [--path <path>]
daedal workspace list [--archived]
daedal workspace get <workspace>
daedal workspace update <workspace> [--name <name>] [--slug <slug>]
daedal workspace archive <workspace>
daedal workspace restore <workspace>
daedal workspace remove <workspace> [--delete-files] --force
```

## Tasks and board status

```text
daedal task create --workspace <workspace> --title <title> [--description <text>] [--priority <priority>]
daedal task list [--workspace <workspace>] [--status <status>]
daedal task get <task-id>
daedal task update <task-id> [--title <title>] [--description <text>] [--priority <priority>]
daedal task status <task-id> <status>
daedal task remove <task-id> --force
```

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
entries are shared across workspaces and adding an existing remote refreshes it.

## Agents and sessions

```text
daedal agent models <codex|claude>
daedal agent spawn --workspace <workspace> (--provider <codex|claude> | --command <configured-name>) [--task <task-id>] [--name <name>] [--model <model>]
daedal agent list [--workspace <workspace>] [--running|--archived]
daedal agent get <agent-id>
daedal agent attach <agent-id>
daedal agent send <agent-id> <text>
daedal agent archive <agent-id> [--force]
daedal agent restore <agent-id>
daedal agent stop <agent-id> [--force]
daedal agent remove <agent-id>
```

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
