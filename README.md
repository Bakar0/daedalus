# Daedalus

Daedalus is a macOS-first, local-first control plane for coding agents. Phases 0–6 are implemented: the shared foundation, complete workspace/task CLI, durable tmux-backed agent CLI, Electrobun desktop CRUD application, and integrated per-agent terminals.

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

The centered workspace control switches between two complete layouts: **Board** uses a wide task canvas with a narrower brief inspector, while **Sessions** uses a compact vertical session navigator with a terminal-dominant work area. Use **New session** to start a Codex agent, Claude agent, or free login-shell terminal, optionally linked to a task. Session cards include lifecycle status and start/end time. Task briefs remain editable as GitHub-flavored Markdown. Closing or reopening the app detaches and reconnects terminals without terminating their tmux-owned sessions. Split-terminal presets are intentionally deferred.

Terminal traffic uses a token-authenticated loopback WebSocket. The app restores up to 10,000 lines or 1 MiB of tmux history, retains 10,000 renderer scrollback lines, and bounds both Bun-side and renderer-side pending output to 1 MiB. When a noisy producer outruns the UI, Daedalus drops old pending bytes, reports the amount, and leaves the durable tmux pane available for a fresh bounded capture. Live, reconnecting, exited, and lost states are shown explicitly. CLI `agent attach` remains compatible with the same session.

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
