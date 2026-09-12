# Daedalus

Daedalus is a macOS-first, local-first control plane for coding agents. Phases 0–5 are implemented: the terminal proof, shared foundation, complete workspace/task CLI, durable tmux-backed agent CLI, and the Electrobun desktop CRUD application. Integrated per-agent terminal productization remains intentionally deferred to Phase 6.

Workspaces are ordinary directories. They are not Git worktrees. SQLite stores searchable metadata, while the filesystem remains authoritative for workspace existence and tmux remains authoritative for live sessions.

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

The three-column UI manages workspaces, task cards, and focused task details through typed Electrobun RPC backed by `@daedalus/core`. Agent launch and session state live on each task card instead of in a separate agent screen. The Settings dialog retains the collapsible Phase 0 terminal transport spike, which creates or reconnects to the isolated `daedalus_spike` session. Closing and reopening the app does not terminate that shell or any agent session.

Changes made through `daedal` while the desktop is open are detected and shown promptly. Workspace and task deletion retain the same core safety guards as the CLI; the UI requires explicit confirmation and never deletes workspace files by default.

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
