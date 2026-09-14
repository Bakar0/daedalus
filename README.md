# Daedalus

Daedalus is a macOS-first, local-first control plane for coding agents. Phases 0–6 are implemented: the shared foundation, complete workspace/task CLI, durable tmux-backed agent CLI, Electrobun desktop CRUD application, and integrated per-agent terminals.

Workspaces are ordinary work-package directories rather than repositories themselves. Daedalus stores one bare clone per remote in its global repository library and creates freshly fetched, read-only planning checkouts under each workspace's `repos/` directory. Agent sessions start in isolated folders and create independent linked Git worktrees only for repositories they actually need. SQLite stores searchable metadata, while the filesystem remains authoritative for workspace existence and tmux remains authoritative for live sessions.

## Requirements

- macOS 14 or newer
- Bun **1.4.2** (verified; pinned in CI and checked by `daedal doctor`)
- tmux **3.7c** or newer
- Electrobun **2.0.1** (project dependency; its paired Hutch/Cottontail toolchain is resolved by Electrobun)

The dependency baseline was verified on 2026-09-12. Exact JavaScript versions are recorded in `package.json` and `bun.lock`; see [Phase 0 decisions](docs/phase-0.md) for upstream sources and transport evidence.

## Getting started

```sh
bun install --frozen-lockfile
bun node_modules/electrobun/bin/electrobun.cjs prepare
bun test
bun run typecheck
bun run build
bun run daedal --help
```

Start the desktop application with:

```sh
bun run dev
```

The centered workspace control switches between three complete layouts: **Board** uses a wide task canvas with a narrower brief inspector, **Sessions** uses a compact vertical session navigator with a terminal-dominant work area, and **Workspace** shows `BRIEF.md`, `JOURNAL.md`, physical files, repository attachments, and materialized session worktrees. **New session** presents Codex, Claude, and Terminal as direct tool choices. Session cards include lifecycle status and start/end time. Task briefs remain editable as GitHub-flavored Markdown. Closing or reopening the app detaches and reconnects terminals without terminating their tmux-owned sessions.

A separate VS Code-style integrated terminal lives at the bottom of both workspace modes. Its tabs are persisted independently from agent conversations: **+** opens a shell in `DAEDALUS_HOME`, while the terminal action on a workspace card opens one in that workspace path. Collapsing the panel or restarting the app leaves its tmux sessions available; closing a tab terminates and removes only that utility terminal.

Terminal traffic uses a token-authenticated loopback WebSocket. A native Bun PTY attaches to the durable tmux session and preserves exact redraw, cursor, shortcut, Unicode, and resize behavior; the renderer retains 10,000 scrollback lines while attached. Both Bun-side and renderer-side pending output are bounded to 1 MiB. When a noisy producer outruns the UI, Daedalus drops old pending bytes, reports the amount, and leaves the durable tmux pane available for a fresh redraw. Live, reconnecting, exited, and lost states are shown explicitly. CLI `agent attach` remains compatible with the same session.

Changes made through `daedal` while the desktop is open are detected and shown promptly. Workspace and task deletion retain the same core safety guards as the CLI; the UI requires explicit confirmation and never deletes workspace files by default.

Sessions and workspaces use an archive-first lifecycle. Archiving a session stops its tmux process and moves it to the collapsed archive while preserving its provider conversation. Restoring a Codex or Claude session launches a fresh tmux runtime through the provider's native resume command. Archiving a workspace archives all of its sessions; restoring the workspace leaves those sessions archived until they are restored individually. Free terminals reopen as fresh shells in the same workspace.

To keep tests and experiments out of the real home directory:

```sh
DAEDALUS_HOME=/tmp/my-daedalus-home bun run daedal doctor
```

The default data directory is `~/.daedalus`, containing `config.json`, `state.db`, `logs/`, and `workspaces/`. Configuration and migrations create directories and databases, never a workspace or task record.

## Commands

- `bun test` — fast unit and SQLite migration integration tests
- `bun run test:agent-tmux` — isolated production agent/tmux lifecycle verification
- `bun run test:cli-agent` — full workspace → task → agent → cleanup CLI integration
- `bun run test:terminal-spike` — real isolated tmux transport verification
- `bun run test:terminal-agent` — real per-agent terminal, noisy output, reconnect, and cleanup verification
- `bun run format:check` — formatting validation
- `bun run typecheck` — strict TypeScript validation
- `bun run build` — shared packages, CLI, Vite renderer, and packaged Electrobun app
- `bun run verify:versions` — exact dependency and Bun runtime guard
- `bun run daedal --help` — complete Phase 2–4 CLI surface
- `bun run daedal doctor [--json]` — environment diagnostics

Quick start:

```sh
bun run daedal workspace create "My project"
bun run daedal task create --workspace my-project --title "Implement feature"
bun run daedal agent spawn --workspace my-project --provider codex
bun run daedal agent list --running
```

Every mutation flows through `@daedalus/core`. Workspace removal preserves files unless both `--delete-files` and `--force` are supplied; task removal requires `--force`; live agents block workspace and task removal.

## Documentation

- [Architecture](docs/architecture.md)
- [Phase 0 decisions and spike evidence](docs/phase-0.md)
- [CLI contract](docs/cli.md)
- [Desktop RPC and UI](docs/desktop.md)
- [Agent skills and installation](docs/skills.md)
