# Daedalus

Daedalus is a macOS-first, local-first control plane for coding agents. This repository currently contains the Phase 0 terminal proof and the Phase 1 foundation: a Bun workspace, shared core/platform/protocol packages, a thin `daedal` CLI, and an Electrobun + React + ghostty-web desktop shell.

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

Start the desktop terminal spike with:

```sh
bun run dev
```

It creates or reconnects to the isolated `daedalus_spike` session on the `daedalus-spike` tmux server. Closing and reopening the window or app does not terminate that shell.

To keep tests and experiments out of the real home directory:

```sh
DAEDALUS_HOME=/tmp/my-daedalus-home bun run daedal doctor
```

The default data directory is `~/.daedalus`, containing `config.json`, `state.db`, `logs/`, and `workspaces/`. Configuration and migrations create directories and databases, never a workspace or task record.

## Commands

- `bun test` — fast unit and SQLite migration integration tests
- `bun run test:terminal-spike` — real isolated tmux transport verification
- `bun run format:check` — formatting validation
- `bun run typecheck` — strict TypeScript validation
- `bun run build` — shared packages, CLI, Vite renderer, and packaged Electrobun app
- `bun run verify:versions` — exact dependency and Bun runtime guard
- `bun run daedal --help` — Phase 1 CLI surface
- `bun run daedal doctor [--json]` — environment diagnostics

Workspace/task CRUD and production agent lifecycle behavior deliberately begin in later phases. The Phase 1 migration establishes their schema, but no CRUD handler bypasses the shared core.

## Documentation

- [Architecture](docs/architecture.md)
- [Phase 0 decisions and spike evidence](docs/phase-0.md)
- [CLI contract](docs/cli.md)
