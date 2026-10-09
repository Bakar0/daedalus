---
name: daedalus-control
description: Operate Daedalus with the daedal CLI. Use when the user asks to open or create a board task, spawn or start a Codex or Claude agent, inspect or change Daedalus workspace, repository, worktree, task, or session state, or when a command needs an API key, token or password (Daedalus secrets); do not use for ordinary work inside an already-selected repository.
---

# Daedalus control

Use `daedal` as the public interface to Daedalus. Prefer `--json` for every
non-interactive command, parse the `{ "ok", "data" }` envelope, and report the
identifiers and paths that a later command needs.

Use `"{{daedal}}"` for every command, exactly that path. It is this Daedalus
build's CLI; the `daedal` on `PATH` can belong to another build. If it does
not exist, report that the Daedalus app must be opened once to install it.
Inside a session, the CLI works out which session it is from the working
directory, so commands about "this session" need no session id.

## Establish context

1. Inspect only the state needed for the request with `workspace list`, `task
list`, `repo list`, or `agent list`.
2. Use a workspace ID or exact slug. Tasks are displayed as `#1`, `#2`, and so
   on, with numbering scoped to each workspace. Outside a session, use
   `<workspace>#<number>` or pass the number with `--workspace`.
3. In an agent session, use `task current` to read its assigned task. The
   internal task ID is not the human-facing task number.
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
- Agent lifecycle does not update task status, and neither should you. The
  board derives each task's lane (Needs me, Ready for review, Running, Queued,
  Parked, Done) from status plus session and worktree state; change status
  only when the user asks.

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
  model name. Omit `--model` to use the workspace's default model when the
  provider is the workspace's default provider (`workspace get` shows both),
  and the provider's recommended default otherwise; `data.defaultModel`
  reports that default when available. Custom `--command` agents do not have a
  discoverable model catalog.
- Do not change the task's status after spawning. Starting a task-backed
  session moves a `todo` or `blocked` task to `in_progress` on its own when the
  workspace's `--start-sets-in-progress` setting is on, which is the default.
  Everything else about status is the user's call.
- To have an agent write a task's brief rather than do the task, spawn with
  `--draft-brief`. Hand long briefs over with `task update <ref>
--description-file <path>`, or `-` for stdin, rather than quoting them into
  `--description`.
- When your context is nearly full, or you are asked to hand off, use the
  handoff skill (`/daedalus-handoff`). It writes the note and runs `daedal agent
continue`, which starts a fresh session on the same task, working directory
  and worktrees and archives yours once the command exits.
- Use `agent send` for literal follow-up text. `agent attach` is interactive and
  is unsuitable for machine-readable automation.
- Prefer `agent archive` over `stop` plus `remove` when preserving the provider
  conversation is useful. Restore archived conversations with `agent restore`.

## Secrets

When a tool needs an API key, token or password, do not ask the user to paste
it. Run `daedal secret list` to see the secrets you can use (the workspace's
own and the global ones), then give the tool the ones it needs:

```bash
"{{daedal}}" exec --secret GH_TOKEN -- gh pr list
```

The command gets `GH_TOKEN` in its environment and its piped output shows the
value as `***`. A variable used inside a shell command needs a shell to expand
it: `exec --secret API_KEY -- sh -c 'curl -H "Authorization: Bearer $API_KEY" …'`.
If the secret is missing, `exec` exits 3; ask the user to add it in the
app (the key on the All workspaces card for everywhere, the key on the
workspace's card for this workspace) or with `daedal secret set`. Do not
print, encode or copy a secret's value.

## Reporting on yourself

Daedalus can see that a session exists; it cannot see why one is stuck. Tell it.

- **MUST** run `daedal attention "<reason>"` when you are blocked on the user —
  a decision you cannot make, a question you need answered, an approval you are
  waiting on. Write the reason as the thing the user has to resolve
  ("Need a decision on the schema"), not as a status ("waiting"). Daedalus
  never reads your reply for questions: one asked only in text shows as done.
- Do not call it to say you finished. The end of your turn marks the session
  done on its own.
- Reasons accumulate on one badge and identical text collapses, so calling it
  again with more context is safe and is the intended use. Repeated calls never
  produce repeated alerts.
- **MUST** run `daedal attention --clear` as soon as the block is resolved, even
  if the user never came to look. A badge that outlives its cause teaches people
  to ignore badges. A clear is never suppressed, so it always goes through.
- Use `daedal notify "<message>" [--level info|success|error]` for something
  worth seeing but not worth chasing — a long build finished, a turn failed.
- **Never** ping for per-step progress, routine tool calls, or anything already
  visible on screen. The value of these signals is entirely in their rarity.
- Run `daedal ui state --json` first when you want to choose a channel
  yourself: it reports whether the app is running and in the foreground, which
  session it is showing, how long the user has been idle, and whether Focus mode
  is on. A suppressed alert reports itself as suppressed rather than failing,
  so treat `suppressed: "focus_mode"` as success.

## Safety and completion

- Never use `workspace remove`, `task remove`, `agent remove`, `--force`, or
  `--delete-files` unless the user explicitly requests the corresponding
  destructive action.
- Inspect live sessions and worktrees before detach or removal operations.
- After a mutation, verify the affected object with a targeted `get` or `list`
  command and summarize the resulting state.

For the full command catalog and exit codes, read [references/cli.md](references/cli.md).
