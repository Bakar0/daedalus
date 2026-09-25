# Architecture

Daedalus has one application layer and two thin adapters.

```text
daedal CLI ─┐
            ├─> @daedalus/core ─> filesystem / SQLite / tmux
desktop RPC ┘          │
                      └─> domain events and structured errors

tmux PTY client ─> loopback WebSocket ─> xterm.js renderer
```

## Package boundaries

- `@daedalus/core` owns configuration, domain types, structured errors, application context, events, SQLite repositories, and all workspace/task/agent services.
- `@daedalus/platform` owns operating-system boundaries: filesystem creation, argv-safe process execution, and tmux PTY transport.
- `@daedalus/protocol` owns serializable CLI/desktop DTOs, the typed Electrobun RPC schema, stable result envelopes, and terminal wire messages.
- `apps/cli` maps arguments, results, errors, and exit codes onto the shared application layer.
- `apps/desktop/src/bun` starts the same application context and owns native process/terminal resources.
- `apps/desktop/src/renderer` renders application state, calls typed RPC methods, and hosts selected xterm.js agent and integrated-terminal surfaces. It does not access files, SQLite, provider processes, or tmux.

## Persistence

`DAEDALUS_HOME` overrides the default `~/.daedalus` root. Configuration resolves all data paths from that root. SQLite starts in WAL mode with a five-second busy timeout. Migrations are sorted SQL files applied transactionally and recorded in `schema_migrations`.

The initial migration defines workspace, task, and session tables; later migrations add session kind, names, archives, native resume locators, a separate `integrated_terminals` table, workspace repository attachments, and session-owned worktree indexes. Small repositories share one WAL-mode connection and expose an explicit transaction boundary. Services own every mutation; CLI and desktop startup only construct an application context and call those services.

Workspace rows are indexes, not proof of existence. Services require a real non-symlink directory with a matching `.daedalus/workspace.json` ID marker before returning or using a workspace. Slugs are mutable aliases; IDs and paths are stable. File deletion additionally rejects root-like targets, symlinks, and invalid markers.

Workspace content follows the contract in [workspace-content.md](workspace-content.md). Root `BRIEF.md` and `JOURNAL.md` files are visible, portable context while `.daedalus/` remains internal. Remote repositories have one global bare clone under `<DAEDALUS_HOME>/repos`; a successful fetch of the remote default branch produces a pinned detached planning checkout in each workspace. Agent sessions start in immutable task/session identity paths and create linked worktrees from that pinned commit only when they need to modify a repository.

Agent sessions use names derived only from immutable UUIDs. Provider adapters build executable and argument arrays, and the tmux adapter preserves those argv boundaries. Because packaged macOS apps do not inherit an interactive shell PATH, tmux discovery also checks the standard Apple Silicon and Intel Homebrew locations before reporting it unavailable. On startup, live SQLite rows are reconciled against the isolated Daedalus tmux server; missing sessions become `lost`, while task status remains untouched. Reconciliation only observes — it runs on nearly every CLI command and on the desktop poll, so it never starts a process. Revival is a separate, explicit call: the app sweeps once at startup, and `daedal agent revive` does the same thing from the command line. Both relaunch through the one path `restore` uses, resuming the provider's native conversation so each agent returns idle at its prompt; a cross-process lock file under `DAEDALUS_HOME` and a `hasSession` check immediately before each launch keep a racing app start and CLI sweep from creating two runtimes under one tmux name. A session that cannot be resumed stays `lost` and records `lostReason`.

Sessions do not inherit the environment of whoever launched Daedalus. Opened from an agent's shell, the app, or a `daedal agent spawn` run inside an agent, carries that agent's `NO_COLOR`, `TERM=dumb`, `TMUX`, `CLAUDECODE`, `CLAUDE_CODE_*` and its own `DAEDALUS_SESSION_ID`, and tmux copies its server's environment into every session it starts. `INHERITED_SESSION_VARIABLES` in `@daedalus/platform` lists these. `CommandTmuxClient` runs every tmux command with them removed, so a server it starts is clean, and before each new session it unsets them from the global environment of a server that already holds them. The CLI keeps them in its own process, where `DAEDALUS_SESSION_ID` tells it which session is calling, and passes none of them to tmux; the new session gets its own `DAEDALUS_*` values at launch. The desktop host also deletes them from its own environment at startup. `attach` is the exception: it draws in the caller's terminal, so it keeps the caller's `TERM`.

## Lifecycle and activity are orthogonal

`AgentSessionStatus` (`starting`, `running`, `exited`, `lost`) is the process
axis, owned by `reconcile()` and answered by tmux. `AgentActivity` (`unknown`,
`working`, `needs_permission`, `needs_input`, `idle`, `done`, `error`) is a
second, orthogonal axis answering whether the agent is working, finished, or
waiting for a person. They are kept apart rather than widened into one enum
because an idle session and one blocked on a permission dialog are both
`running`, and only the second changes what the user does next. Neither axis
touches `Task.status`: the board is a third thing again.

**Lifecycle dominates on conflict.** A session that becomes `exited` has its
activity cleared rather than preserved, because "working" is the most damaging
thing a display can claim about a session that is already gone.

`lost` is deliberately not that case. A reboot kills the tmux server under every
open conversation at once, and the revive sweep puts each agent back at the
point it stopped — usually still blocked on the same question. Clearing the
badges there would wipe every reason the user had to look at exactly the moment
a restart handed them a whole board of them, so a `lost` session keeps its
reading, its badge and its queued notifications. Staleness decay still applies,
so a `working` reading on a session that never comes back fades to `unknown`
rather than being believed forever.

**Activity signals are advisory and carry their confidence.** Every reading
records a `source` — `agent` (the session reporting on itself), `hook`,
`transcript`, `pane` — and a lower-ranked source is refused outright while a
higher-ranked reading is still fresh. Provider fidelity is asymmetric enough
that without this the whole display silently degrades to the confidence of its
worst detector.

Transitions are guarded compare-and-sets rather than blind writes, because
hooks fire concurrently and arrive out of order: routine activity may not
overwrite a state meaning "the user is the thing in the way", and a turn-end
may only finish a turn that was actually running. This replaces a turn or
sequence identifier, which would answer a narrower question — "is this the same
turn" rather than "is what I am about to overwrite more meaningful than what I
carry".

Durable activity is a per-session JSON file under `<DAEDALUS_HOME>/activity/`,
written by the hook sink with the same atomic temp-and-rename discipline as
`<DAEDALUS_HOME>/telemetry/`, and SQLite is the index over it. The split exists
because a provider hook is a short-lived process that must succeed while the
app is not running and the database is held by somebody else: it writes the
record first and updates the index second, and startup replays the records so a
restart mid-turn keeps the turn.

## Terminal lifecycle

Each renderer connection names a typed agent or integrated-terminal UUID, never a tmux session directly. The Bun process resolves that UUID through core, verifies that its recorded session is live, and attaches a tmux client through Bun's native pseudo-terminal. The PTY carries tmux's exact terminal byte stream, including redraw and cursor state. User input is written directly to the PTY and resize uses the PTY's native resize operation, so multi-key terminal shortcuts are interpreted by tmux and the provider TUI rather than reconstructed as `send-keys` commands. Closing a view terminates only its attached client. Stop remains a core agent action and CLI `attach` continues to address the same tmux session.

A random per-process token protects a WebSocket server bound only to `127.0.0.1`; invalid paths, tokens, or agent UUIDs are rejected before upgrade. tmux redraws its current screen and cursor into each new PTY attachment, avoiding the duplicated and cursorless `capture-pane` plus live-stream reconstruction. The Bun-side pending queue and renderer pending queue are each capped at 1 MiB, the socket has a 256 KiB high-water mark, and delivery is batched. Overflow discards oldest pending bytes and emits a visible recovery notice instead of allowing unbounded memory growth. xterm.js owns a separate 10,000-line display scrollback and procedurally renders block and box-drawing glyphs while the view remains attached.

At desktop startup, core reconciles agent and integrated-terminal SQLite rows against the isolated tmux server. Sessions that still exist reconnect and are labeled accordingly; vanished sessions become `lost`. Explicitly stopped sessions are `exited`. The change poll ends terminal connections whose sessions stop or disappear. Switching sessions or terminal tabs disposes the prior renderer terminal, WebSocket, resize observer, retry timer, and tmux PTY client while leaving the underlying tmux session untouched.

## Archive and native resume

Archive state is independent of process state. `archived_at` hides a workspace or session from active lists, while the existing session status continues to describe the most recent tmux runtime. Archiving a live session stops that runtime first. Workspace archive delegates to the agent service and is committed only after all of its sessions have been archived.

Agent sessions persist a provider-owned conversation locator. Claude receives a UUID at initial launch through `--session-id`; Daedalus recovers Codex's UUID from its uniquely timed writer lock at startup and from rollout metadata for older Codex versions. Persisted conversations are archived, unarchived, and resumed through their native CLIs. Codex sessions archived before their first user event have no persisted conversation yet, so they restore as a fresh empty Codex session. Resume creates a new tmux runtime for the same logical session and increments `resume_count`. If provider restore or tmux launch fails, the Daedalus session remains archived. Terminal sessions have no provider transcript and reopen as a fresh login shell.

Typed Electrobun RPC carries bounded desktop snapshots, mutations, and change messages. Desktop mutations publish an immediate message; a Bun-side SQLite fingerprint and agent reconciliation check detects mutations made by other processes, including the CLI, and publishes the same message within roughly 1.2 seconds. The renderer then reloads one consistent snapshot through core services.

Terminal streaming remains isolated behind `TmuxPtyBridge` and its authenticated loopback WebSocket. Domain CRUD stays on typed RPC; sustained terminal bytes do not pass through that request channel.
