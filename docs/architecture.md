# Architecture

Daedalus has one application layer and two thin adapters.

```text
daedal CLI ─┐
            ├─> @daedalus/core ─> filesystem / SQLite / tmux
desktop RPC ┘          │
                      └─> domain events and structured errors

tmux control client ─> loopback WebSocket ─> ghostty-web renderer
```

## Package boundaries

- `@daedalus/core` owns configuration, domain types, structured errors, application context, events, SQLite repositories, and all workspace/task/agent services.
- `@daedalus/platform` owns operating-system boundaries: filesystem creation, argv-safe process execution, and tmux control-mode transport.
- `@daedalus/protocol` owns serializable CLI/desktop DTOs, the typed Electrobun RPC schema, stable result envelopes, and terminal wire messages.
- `apps/cli` maps arguments, results, errors, and exit codes onto the shared application layer.
- `apps/desktop/src/bun` starts the same application context and owns native process/terminal resources.
- `apps/desktop/src/renderer` renders application state, calls typed RPC methods, and hosts selected `ghostty-web` agent and integrated-terminal surfaces. It does not access files, SQLite, provider processes, or tmux.

## Persistence

`DAEDALUS_HOME` overrides the default `~/.daedalus` root. Configuration resolves all data paths from that root. SQLite starts in WAL mode with a five-second busy timeout. Migrations are sorted SQL files applied transactionally and recorded in `schema_migrations`.

The initial migration defines workspace, task, and session tables; later migrations add session kind, names, archives, native resume locators, a separate `integrated_terminals` table, workspace repository attachments, and session-owned worktree indexes. Small repositories share one WAL-mode connection and expose an explicit transaction boundary. Services own every mutation; CLI and desktop startup only construct an application context and call those services.

Workspace rows are indexes, not proof of existence. Services require a real non-symlink directory with a matching `.daedalus/workspace.json` ID marker before returning or using a workspace. Slugs are mutable aliases; IDs and paths are stable. File deletion additionally rejects root-like targets, symlinks, and invalid markers.

Workspace content follows the contract in [workspace-content.md](workspace-content.md). Root `BRIEF.md` and `JOURNAL.md` files are visible, portable context while `.daedalus/` remains internal. Remote repositories have one global bare clone under `<DAEDALUS_HOME>/repos`; a successful fetch of the remote default branch produces a pinned detached planning checkout in each workspace. Agent sessions start in immutable task/session identity paths and create linked worktrees from that pinned commit only when they need to modify a repository.

Agent sessions use names derived only from immutable UUIDs. Provider adapters build executable and argument arrays, and the tmux adapter preserves those argv boundaries. Because packaged macOS apps do not inherit an interactive shell PATH, tmux discovery also checks the standard Apple Silicon and Intel Homebrew locations before reporting it unavailable. On startup, live SQLite rows are reconciled against the isolated Daedalus tmux server; missing sessions become `lost`, while task status remains untouched.

## Terminal lifecycle

Each renderer connection names a typed agent or integrated-terminal UUID, never a tmux session directly. The Bun process resolves that UUID through core, verifies that its recorded session is live, and attaches a tmux control client to the durable session. `%output` notifications carry the pane's actual terminal byte stream; octal-escaped control bytes are decoded before forwarding. User input is sent with argv-safe `tmux send-keys` calls, and resize uses the attached control client's `refresh-client -C` command. Closing a view detaches only its control client. Stop remains a core agent action and CLI `attach` continues to address the same tmux session.

A random per-process token protects a WebSocket server bound only to `127.0.0.1`; invalid paths, tokens, or agent UUIDs are rejected before upgrade. New renderer clients receive an ANSI-preserving capture bounded to 10,000 tmux history lines or 1 MiB before queued live output. The Bun-side pending queue and renderer pending queue are each capped at 1 MiB, the socket has a 256 KiB high-water mark, and delivery is batched. Overflow discards oldest pending bytes and emits a visible recovery notice instead of allowing unbounded memory growth. `ghostty-web` owns a separate 10,000-line display scrollback.

At desktop startup, core reconciles agent and integrated-terminal SQLite rows against the isolated tmux server. Sessions that still exist reconnect and are labeled accordingly; vanished sessions become `lost`. Explicitly stopped sessions are `exited`. The change poll ends terminal connections whose sessions stop or disappear. Switching sessions or terminal tabs disposes the prior renderer terminal, WebSocket, resize observer, retry timer, and tmux control client while leaving the underlying tmux session untouched.

## Archive and native resume

Archive state is independent of process state. `archived_at` hides a workspace or session from active lists, while the existing session status continues to describe the most recent tmux runtime. Archiving a live session stops that runtime first. Workspace archive delegates to the agent service and is committed only after all of its sessions have been archived.

Agent sessions persist a provider-owned conversation locator. Claude receives a UUID at initial launch through `--session-id`; Codex receives an immutable Daedalus session name and is archived, unarchived, and resumed through its native CLI. Resume creates a new tmux runtime for the same logical session and increments `resume_count`. If provider restore or tmux launch fails, the Daedalus session remains archived. Terminal sessions have no provider transcript and reopen as a fresh login shell.

Typed Electrobun RPC carries bounded desktop snapshots, mutations, and change messages. Desktop mutations publish an immediate message; a Bun-side SQLite fingerprint and agent reconciliation check detects mutations made by other processes, including the CLI, and publishes the same message within roughly 1.2 seconds. The renderer then reloads one consistent snapshot through core services.

Terminal streaming remains isolated behind `TmuxControlBridge` and its authenticated loopback WebSocket. Domain CRUD stays on typed RPC; sustained terminal bytes do not pass through that request channel.
