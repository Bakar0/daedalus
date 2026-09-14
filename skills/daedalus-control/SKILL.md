---
name: daedalus-control
description: Operate Daedalus with the daedal CLI. Use when the user asks to open or create a board task, spawn or start a Codex or Claude agent, or inspect or change Daedalus workspace, repository, worktree, task, or session state; do not use for ordinary work inside an already-selected repository.
---

# Daedalus control

Use `daedal` as the public interface to Daedalus. Prefer `--json` for every
non-interactive command, parse the `{ "ok", "data" }` envelope, and report the
identifiers and paths that a later command needs.

Before the first command, resolve the CLI once. Use `daedal` when
`command -v daedal` succeeds. Otherwise, use the executable at
`${DAEDALUS_HOME:-$HOME/.daedalus}/bin/daedal`. If neither exists, report that
the Daedalus app must be opened once to install its CLI shim. Use the resolved
executable consistently for the rest of the request.

## Establish context

1. Inspect only the state needed for the request with `workspace list`, `task
list`, `repo list`, or `agent list`.
2. Use a workspace UUID or exact slug. Task and session references are UUIDs.
3. When `DAEDALUS_SESSION_ID` is set, it identifies the current session. When
   `DAEDALUS_TASK_ID` is set, it identifies the task that launched it.
4. Run `daedal <area> help` when the installed CLI may be newer than this skill.

## Operate the board

- Create and update workspaces with `daedal workspace ...`.
- Create tasks with a concrete title and useful description, then use the
  returned task ID for status changes or session assignment.
- Valid task statuses are `todo`, `in_progress`, `blocked`, `done`, and
  `cancelled`; priorities are `low`, `normal`, and `high`.
- Agent lifecycle does not update task status. Change task status explicitly
  when the user's workflow calls for it.

## Repositories and worktrees

- Add a remote URL or absolute local Git path to the shared library with
  `daedal repo library add <url-or-path>`.
- Attach the returned library repository ID with
  `daedal repo attach --workspace <workspace> --repository <library-id>`.
- Treat workspace `repos/` checkouts as read-only planning references.
- Before editing, create only the needed writable worktree with
  `daedal repo worktree create --session <session-id> --repository <name-or-id>`
  and continue in the returned path.

## Sessions

- Spawn a session only when the user asks to delegate, compare agents, or start
  another Daedalus session. Do not recursively spawn agents for ordinary coding.
- Use `--provider codex` or `--provider claude`; include `--task <task-id>` when
  the session owns a board task.
- After successfully spawning a task-backed session, move the task to
  `in_progress` unless the user asked to leave it queued or in another status.
- Use `agent send` for literal follow-up text. `agent attach` is interactive and
  is unsuitable for machine-readable automation.
- Prefer `agent archive` over `stop` plus `remove` when preserving the provider
  conversation is useful. Restore archived conversations with `agent restore`.

## Safety and completion

- Never use `workspace remove`, `task remove`, `agent remove`, `--force`, or
  `--delete-files` unless the user explicitly requests the corresponding
  destructive action.
- Inspect live sessions and worktrees before detach or removal operations.
- After a mutation, verify the affected object with a targeted `get` or `list`
  command and summarize the resulting state.

For the full command catalog and exit codes, read [references/cli.md](references/cli.md).
