# Daedalus implementation plan

## Product definition

Daedalus is a local-first control plane for coding agents.

Its primary objects are:

- **Workspace** — a real directory under a configurable root, defaulting to `~/.daedalus/workspaces/<workspace-slug>`.
- **Task** — a durable unit of work belonging to a workspace. Tasks can exist without an agent.
- **Agent session** — a durable tmux-backed process running in a workspace, optionally attached to a task.

The `daedal` CLI is the complete public interface. The Electrobun desktop app calls the same application services as the CLI and does not own separate business logic. This keeps every operation scriptable and makes the UI optional.

## MVP boundaries

The first usable version should do four things well:

1. Create, list, inspect, rename, and remove workspaces that are real folders.
2. Create, list, inspect, update, and remove tasks within a workspace.
3. Start Claude Code, Codex, or a configured shell command in a durable tmux session, either for a task or taskless.
4. Show all workspaces, tasks, running agents, and live terminals in a desktop UI.

Explicitly defer git worktrees, branches, PR review, remote access, scheduling, multi-user features, analytics, and agent-to-agent orchestration. They can be added after the local lifecycle is reliable.

## Architecture

```text
                    +----------------------+
                    |     daedal CLI       |
                    +----------+-----------+
                               |
                    typed commands/results
                               |
+------------------+-----------v-----------+------------------+
|                         @daedalus/core                       |
| workspace service | task service | agent service | events   |
| validation        | repositories | config        | errors   |
+----------+-------------------+----------------------+--------+
           |                   |                      |
     filesystem          SQLite metadata          tmux adapter
           |                   |                      |
 ~/.daedalus/workspaces   ~/.daedalus/state.db   durable sessions
                                                       |
                                                 claude / codex

                    +----------------------+
                    | Electrobun Bun main  |
                    | calls @daedalus/core |
                    +----------+-----------+
                               | typed RPC + terminal stream
                    +----------v-----------+
                    | React + xterm.js     |
                    +----------------------+
```

### Important design rules

- The filesystem proves whether a workspace exists; SQLite stores searchable metadata and relationships.
- All mutations go through use-case functions in `packages/core`; neither CLI handlers nor React components write files or SQL directly.
- Workspace IDs are immutable readable slugs. Tasks retain immutable internal
  IDs but are referenced by per-workspace numbers displayed as `#1`, `#2`, and
  so on; agent and repository IDs are immutable UUIDs. Human-readable workspace
  slugs remain mutable lookup aliases.
- Commands produce stable exit codes and support both human-readable and `--json` output.
- tmux session names use IDs, not user-provided titles, to avoid quoting and collision problems.
- Agent commands are argument arrays, never interpolated shell strings.
- Destructive operations require `--force`; removal refuses to proceed while live agent sessions exist.
- A task status is user-controlled in the MVP. Agent process state is observed separately and never silently rewrites task status.

## Proposed repository scaffold

```text
daedalus/
├── apps/
│   ├── cli/
│   │   ├── src/index.ts
│   │   └── src/commands/
│   └── desktop/
│       ├── src/bun/                 # Electrobun main process and RPC
│       └── src/renderer/            # React UI and xterm.js terminal
├── packages/
│   ├── core/
│   │   ├── src/domain/              # Workspace, Task, AgentSession types
│   │   ├── src/services/            # Application use cases
│   │   ├── src/repositories/        # Interfaces and SQLite implementations
│   │   ├── src/events/
│   │   └── src/errors.ts
│   ├── platform/
│   │   ├── src/filesystem.ts
│   │   ├── src/process.ts
│   │   └── src/tmux.ts
│   ├── protocol/                    # RPC contracts and shared DTO schemas
│   └── test-utils/
├── migrations/
├── scripts/
├── docs/
│   ├── architecture.md
│   └── cli.md
├── electrobun.config.ts
├── package.json
├── tsconfig.json
├── bunfig.toml
└── README.md
```

Use a Bun workspace monorepo so the CLI and desktop app import the same packages without publishing them. Start with React, Vite, TypeScript, Vitest, Electrobun, and xterm.js. Use `bun:sqlite` directly with small repository classes and versioned SQL migrations; an ORM is unnecessary for this initial schema.

### Dependency version policy

Use the latest **stable** release available at implementation time for every third-party dependency, especially Bun, Electrobun, xterm.js, and tmux. Do not copy version pins from `dev-3.0`, this plan, tutorials, or generated examples without checking the upstream release source first.

At the start of the scaffold and again before each release:

1. Check the official Bun release page and run the latest stable Bun runtime.
2. Resolve Electrobun and xterm.js from their current stable package tags rather than `next`, beta, release-candidate, or Git branch builds.
3. Install or upgrade to the latest stable tmux release supported on the target OS; do not develop against an unreleased tmux `master` build.
4. Install other direct dependencies from their current stable releases unless a documented compatibility constraint requires otherwise.
5. Commit `bun.lock` so development, CI, and packaged builds use the exact versions that were verified together.
6. Record the verified Bun and minimum tmux versions in `package.json`, `README.md`, and `daedal doctor`.
7. Run the terminal spike and the full test suite after upgrades. If the newest stable releases are incompatible, document the issue and pin the newest known-compatible stable versions—never silently downgrade.

Prefer commands equivalent to `bun add <package>@latest` when bootstrapping, followed by inspection of the resolved version and upstream release notes. “Latest” is a setup and release-time verification rule, not an unbounded runtime auto-update policy.

## Local data layout

```text
~/.daedalus/
├── config.json
├── state.db
├── logs/
└── workspaces/
    └── my-workspace/
        ├── .daedalus/
        │   └── workspace.json       # portable identity marker only
        └── ...user and agent files...
```

`config.json` contains the workspace root and named agent definitions. `state.db` stores tasks, sessions, and indexes. The small workspace marker lets Daedalus repair/rebuild global metadata without putting task databases throughout user projects.

Support `DAEDALUS_HOME` for tests and advanced users. Every automated test should use a temporary home rather than touching the real `~/.daedalus` directory.

## Initial data model

### Workspace

- `id`
- `slug`
- `name`
- `path`
- `created_at`
- `updated_at`
- `archived_at` (nullable; add behavior later if not needed immediately)

### Task

- `id`
- `workspace_id`
- `title`
- `description`
- `status`: `todo | in_progress | blocked | done | cancelled`
- `priority`: `low | normal | high`
- `created_at`
- `updated_at`
- `completed_at` (nullable)

### Agent session

- `id`
- `workspace_id`
- `task_id` (nullable for taskless sessions)
- `provider`: `claude | codex | custom`
- `tmux_session`
- `command` and serialized `args`
- `working_directory`
- `status`: `starting | running | exited | lost`
- `exit_code` (nullable)
- `started_at`
- `ended_at` (nullable)

The database records desired and historical state. tmux remains authoritative for whether a session is currently alive; reconciliation updates stale rows after CLI/UI startup.

## CLI contract

### Global behavior

```text
daedal --help
daedal --version
daedal doctor
daedal <command> --json
```

- Human output goes to stdout, actionable errors to stderr.
- `--json` returns one documented result envelope and no decorative text.
- Workspace references accept an ID or exact slug.
- Task and agent references accept IDs; short unique ID prefixes may be added after the MVP.
- Stable exit codes: `0` success, `1` unexpected failure, `2` usage/validation, `3` not found, `4` conflict, `5` missing dependency.

### Workspace commands

```text
daedal workspace create <name> [--slug <slug>] [--path <path>]
daedal workspace list [--json]
daedal workspace get <workspace>
daedal workspace update <workspace> [--name ...] [--slug ...]
daedal workspace remove <workspace> [--delete-files] [--force]
```

Default `remove` unregisters a workspace and preserves its files. `--delete-files` is explicit, restricted to a verified workspace directory, and refuses ambiguous or root-like paths.

### Task commands

```text
daedal task create --workspace <workspace> --title <title> [--description ...]
daedal task list [--workspace <workspace>] [--status <status>]
daedal task get <task-ref> [--workspace <workspace>]
daedal task current
daedal task update <task-ref> [--workspace <workspace>] [--title ...] [--description ...]
daedal task status <task-ref> <status> [--workspace <workspace>]
daedal task remove <task-ref> [--workspace <workspace>] [--force]
```

### Agent commands

```text
daedal agent spawn --workspace <workspace> --provider codex [--task <task-ref>]
daedal agent spawn --workspace <workspace> --provider claude [--task <task-ref>]
daedal agent spawn --workspace <workspace> --command <configured-name> [--task <task-ref>]
daedal agent list [--workspace <workspace>] [--running]
daedal agent get <agent-id>
daedal agent attach <agent-id>
daedal agent send <agent-id> <text>
daedal agent stop <agent-id> [--force]
daedal agent remove <agent-id>
```

For a task-backed launch, tell the agent to execute the task by number and rely on
the installed Daedalus skill for lookup instructions. Do not duplicate the task
content or CLI workflow in the launch prompt. For a taskless launch, pass the
optional launch message or start the normal interactive provider command.
`attach` hands the user's terminal to tmux; `send` uses tmux input for
automation.

### Provider configuration

```json
{
  "workspaceRoot": "~/.daedalus/workspaces",
  "agents": {
    "codex": { "executable": "codex", "args": [] },
    "claude": { "executable": "claude", "args": [] }
  }
}
```

Implement providers behind an adapter interface:

```ts
interface AgentProvider {
  probe(): Promise<ProviderAvailability>;
  buildLaunch(
    input: LaunchInput,
  ): Promise<{
    executable: string;
    args: string[];
    env: Record<string, string>;
  }>;
}
```

Do not hard-code provider-specific resume, permission, or model flags into the general agent service.

## tmux and terminal design

The backend owns tmux. The renderer only understands a byte stream plus resize/input messages.

1. Spawn a detached tmux session with a deterministic name such as `daedalus_<agent-id>` and working directory set to the workspace.
2. Start the agent via an argv-safe wrapper, recording the pane/session identity.
3. For CLI attachment, execute `tmux attach-session` normally.
4. For the desktop terminal, run a Bun-side tmux client/PTY bridge and forward output to the renderer over Electrobun RPC or a dedicated local WebSocket.
5. Feed xterm.js with received bytes; forward `onData` and resize events to the Bun bridge.
6. On startup, reconcile SQLite sessions with `tmux list-sessions` and label missing sessions `lost` or `exited`.

The desktop proof-of-concept should validate interactive programs, colors, Unicode, resize, scrollback, paste, and reconnect before substantial UI work. Terminal transport is the highest-risk part of the MVP.

## Desktop UI

### Layout

```text
+----------------+--------------------------------------+----------------------+
| Workspaces     | Tasks                                | Agent / terminal     |
|                |                                      |                      |
| + New          | status filter          + New task    | session header       |
| workspace A    | [todo] Add auth                      | live xterm.js        |
| workspace B    | [run ] Build API                     | terminal             |
|                | [done] Write tests                   |                      |
+----------------+--------------------------------------+----------------------+
```

### MVP screens and actions

- Workspace sidebar: list, select, create, rename, unregister.
- Task list: filter by status, create, edit, change status, delete.
- Agent panel: choose provider, spawn for selected task or workspace, see process state, stop, reconnect.
- Terminal panel: one live terminal at a time; multiple simultaneous sessions appear as tabs or a compact list.
- Settings: workspace root, agent executable discovery, theme.
- Empty/error states: missing tmux, missing provider executable, missing workspace folder, dead session.

Use optimistic UI only for low-risk metadata edits. Workspace deletion and process lifecycle operations should wait for confirmed backend results.

## Delivery phases

### Phase 0 — decisions and terminal spike

- Confirm macOS-first support for the MVP.
- Confirm that workspaces are plain directories, not git worktrees.
- Resolve and record the latest stable Bun, Electrobun, xterm.js, and tmux versions from their official upstream sources.
- Prototype Bun ↔ tmux ↔ xterm.js interactive transport inside a minimal Electrobun window.
- Decide Electrobun RPC versus a loopback WebSocket for sustained terminal bytes based on the spike.

**Exit:** a shell running in tmux can be used interactively in the desktop window, survives window reload, and reconnects.

### Phase 1 — project scaffold

- Initialize Git and Bun workspace package structure.
- Install the latest stable direct dependencies and commit the resolved `bun.lock`; add runtime/dependency version checks to CI.
- Add strict TypeScript, lint/typecheck, Vitest, formatting, and build scripts.
- Add Electrobun + Vite + React desktop shell and a minimal CLI executable.
- Add config loading, `DAEDALUS_HOME`, structured errors, logging, and SQLite migration runner.
- Add CI for typecheck, unit tests, and builds.

**Exit:** `bun install`, `bun test`, `bun run dev`, and `bun run build` work from a clean clone; `daedal --help` runs.

### Phase 2 — workspace CLI

- Implement workspace domain/service/repository layers.
- Implement safe folder creation and identity marker.
- Add create/list/get/update/remove commands and JSON output.
- Add path traversal, collision, symlink, and destructive-delete tests.

**Exit:** all workspace lifecycle operations work headlessly and preserve files unless deletion is explicitly requested.

### Phase 3 — task CLI

- Add task schema/migrations and CRUD services.
- Add task CLI commands, filtering, validation, and JSON contracts.
- Define consistent not-found/conflict behavior.

**Exit:** scripts can completely manage tasks without launching the app.

### Phase 4 — agent and tmux CLI

- Implement tmux capability probe and lifecycle adapter.
- Implement Codex, Claude Code, and custom-command providers.
- Add spawn/list/get/attach/send/stop/remove.
- Add task prompt construction and taskless launch.
- Add startup reconciliation and crash/restart tests.

**Exit:** multiple agents can run concurrently in different workspace folders and survive CLI process exit.

### Phase 5 — desktop CRUD UI

- Define typed Electrobun RPC using DTOs from `packages/protocol`.
- Add workspace, task, and session queries/mutations backed by core services.
- Build the three-column application shell and settings.
- Subscribe to domain/session events so CLI-originated changes appear without app restart.

**Exit:** every Phase 2–4 operation has a working UI equivalent and changes made through the CLI become visible promptly.

### Phase 6 — integrated terminal (complete)

- Productize the terminal spike, including input, resize, scrollback, reconnect, and cleanup.
- Add session switching and clear status indicators.
- Add bounded buffering/backpressure so noisy commands cannot freeze the UI.
- Test ANSI behavior, Unicode, large output, and app restart.

**Exit:** Codex and Claude Code are comfortably usable inside the app and remain attachable from the CLI.

Implemented with task-card-owned session actions, Task brief/Terminal inspector views, per-agent session switching, authenticated loopback transport, bounded capture/scrollback/pending queues, high-water backpressure, app-restart reconnect, explicit lifecycle states, and deterministic bridge/UI cleanup. Automated coverage includes transport authentication, ANSI/Unicode, resize, noisy output, switching, reconnect, and cleanup.

### Phase 7 — hardening and first release

Before Phase 7, the archive lifecycle was added as a final product capability: sessions can be stopped and archived into a collapsed list, then restored through Codex or Claude's native conversation resume support. Workspaces can be archived with all contained sessions and restored without automatically restoring those sessions. Archive state is persisted independently from runtime status and is available through core, CLI, desktop RPC, and UI.

The desktop also exposes persisted utility terminals separately from agent sessions. A bottom panel provides multiple selectable tabs, a default shell rooted at `DAEDALUS_HOME`, workspace-card launch actions, collapse without process loss, and explicit tab close through the existing tmux transport.

- Implement `daedal doctor` for Bun, tmux, provider, directory, database, and session checks.
- Add recovery for missing folders, corrupt markers, stale sessions, and interrupted migrations.
- Package the desktop app and standalone CLI; document installation and shell PATH setup.
- Write the quick-start flow and architecture/CLI references.
- Run an end-to-end test: workspace → task → agent → terminal → stop → cleanup.

**Exit:** a new user can install Daedalus, create a workspace and task, run an agent, and reconnect after restarting the app.

## Test strategy

- **Unit:** slug/path validation, state transitions, provider launch building, error mapping.
- **Repository integration:** migrations and CRUD against a temporary SQLite database.
- **Filesystem integration:** workspace lifecycle under a temporary `DAEDALUS_HOME`.
- **tmux integration:** isolated tmux socket/server name so tests never touch the user's sessions.
- **CLI contract:** stdout, stderr, JSON schemas, and exit codes via subprocess tests.
- **Desktop component:** RPC mocking for CRUD and lifecycle states.
- **End-to-end:** packaged or development app connected to real tmux, gated separately from fast tests.

## Recommended implementation order inside each feature

For each capability, implement in this order:

1. Domain types and validation.
2. Repository interface and persistent implementation.
3. Core use case and tests.
4. CLI command and contract tests.
5. RPC endpoint.
6. UI action and state handling.

This preserves the CLI-first requirement and prevents the UI from becoming the accidental source of business logic.

## Key risks and mitigations

- **Terminal streaming:** prove it first; isolate transport behind an interface and add flow control.
- **tmux portability:** ship macOS-first, probe versions/capabilities, and keep platform logic outside core services.
- **CLI/UI concurrent writes:** use SQLite transactions, WAL mode, a busy timeout, and post-mutation events/polling.
- **Unsafe deletion:** verify identity markers and canonical paths; preserve workspace files by default.
- **Provider CLI changes:** capability probes and provider adapters keep changes local.
- **State drift:** reconcile the database, folders, and tmux sessions at startup and through `doctor`.
- **Command injection:** use executable/argument arrays and validated tmux identifiers; never concatenate user input into shell commands.

## Definition of MVP complete

- A user can create a real workspace at the configured root from either CLI or UI.
- The same user can perform full task CRUD from either interface.
- Codex and Claude Code can start with or without a task in that workspace.
- Each agent runs in an independently addressable tmux session and survives Daedalus closing.
- The user can attach from a terminal or use the same session through the embedded xterm.js terminal.
- CLI output is automation-safe with documented JSON and exit-code contracts.
- Files are not deleted without a specific destructive flag and validated target.
- Clean-install, restart/reconnect, and concurrent-agent end-to-end tests pass.

## First implementation slice

Build one vertical slice before filling out all CRUD:

1. Scaffold the monorepo and minimal Electrobun window.
2. Add `daedal workspace create demo` and `workspace list`.
3. Add `daedal agent spawn --workspace demo --command shell`.
4. Display that tmux session in xterm.js.
5. Close and reopen the app, then reconnect to the same session.

That slice validates every architectural boundary—CLI, shared core, storage, filesystem, tmux, Electrobun RPC, and terminal rendering—before investing in the full product surface.
