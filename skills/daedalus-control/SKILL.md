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
2. Use a workspace ID or exact slug. Tasks are displayed as `#1`, `#2`, and so
   on, with numbering scoped to each workspace. Outside a session, use
   `<workspace>#<number>` or pass the number with `--workspace`.
3. In an agent session, use `task current` to read its assigned task. The
   environment exposes `DAEDALUS_SESSION_ID`, `DAEDALUS_WORKSPACE_ID`,
   `DAEDALUS_TASK_ID`, and `DAEDALUS_TASK_NUMBER` for automation. The internal
   task ID is not the human-facing task number.
4. Run `daedal --version --json` and `daedal <area> help` when compatibility is
   in doubt. Treat the resolved CLI's actual help as authoritative; report a
   missing command or option specifically rather than guessing that the build
   is stale.

## Operate the board

- Create and update workspaces with `daedal workspace ...`.
- Create tasks with a concrete title and useful description, then use the
  returned task number for human-facing references.
- Valid task statuses are `todo`, `in_progress`, `blocked`, `done`, and
  `cancelled`; priorities are `low`, `normal`, and `high`.
- Agent lifecycle does not update task status. Change task status explicitly
  when the user's workflow calls for it.

## Repositories and worktrees

- `repo library add <url-or-absolute-path>` creates one shared bare clone under
  the Daedalus repository library. Adding an existing remote refreshes that
  clone instead of creating a duplicate. A local source must be an absolute
  Git path; a remote source must be a complete clone URL understood by Git.
- The UI's GitHub picker can clone through the authenticated `gh` CLI. The
  public CLI currently uses Git for URL/path inputs, so do not pass a bare
  `owner/repository` name or assume GitHub-picker authentication is available.
- Library membership and workspace attachment are separate. To reproduce the
  UI's complete add flow, first run `daedal repo library add`, capture the
  returned library ID, then run
  `daedal repo attach --workspace <workspace> --repository <library-id>`.
- Attaching creates or refreshes the workspace's read-only planning checkout
  under `repos/`; it does not create a writable implementation checkout.
- Treat workspace `repos/` checkouts as read-only planning references.
- Before editing, create only the needed writable worktree with
  `daedal repo worktree create --session <session-id> --repository <name-or-id>`
  and continue in the returned path.

## Sessions

- Spawn a session only when the user asks to delegate, compare agents, or start
  another Daedalus session. Do not recursively spawn agents for ordinary coding.
- Use `--provider codex` or `--provider claude`; include `--task <number>` when
  the session owns a board task. Use `--message <text>` for optional additional
  launch instructions; task-backed sessions are automatically told to execute
  the task by number.
- Before filling `--model`, run `daedal agent models <codex|claude> --json`.
  Use an exact `data.models[].id` value, not its display label or a guessed
  model name. `data.defaultModel` reports the provider default when available;
  omit `--model` to use that default. Custom `--command` agents do not have a
  discoverable model catalog.
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
