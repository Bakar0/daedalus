# Developing Daedalus

## Requirements

- macOS 14 or newer with the Xcode Command Line Tools
- Bun **1.4.2**
- tmux **3.7c** or newer on `PATH`, for the test suite

The app itself bundles tmux, built by `scripts/build-tmux.ts`, so `bun run build` does not need a tmux installed.

## Setup

```sh
bun install --frozen-lockfile
bun node_modules/electrobun/bin/electrobun.cjs prepare
```

## Running

```sh
bun run dev              # run the app from source
bun run build            # package build/dev-macos-arm64/Daedalus-dev.app
bun run daedal --help    # run the CLI from source
```

A dev build keeps its data in `~/.daedalus-dev`, apart from the installed app in `~/.daedalus`. To keep an experiment out of both, set `DAEDALUS_HOME`:

```sh
DAEDALUS_HOME=/tmp/daedalus-test bun run daedal doctor
```

## Checks

| Command                       | Checks                                             |
| ----------------------------- | -------------------------------------------------- |
| `bun test`                    | unit and SQLite migration tests                    |
| `bun run typecheck`           | strict TypeScript                                  |
| `bun run format:check`        | Prettier formatting                                |
| `bun run verify:versions`     | exact dependency and Bun pins                      |
| `bun run test:agent-tmux`     | agent lifecycle against a real tmux                |
| `bun run test:cli-agent`      | workspace → task → agent → cleanup through the CLI |
| `bun run test:terminal-agent` | terminals: noisy output, reconnect, cleanup        |
| `bun run test:settings-ui`    | the Settings dialog, in a real browser             |

CI runs the first six, and `bun run build`, on every push.

## Releasing

Set `version` in `package.json`, merge it, and push a matching `v<version>` tag. The release workflow builds both architectures, publishes the GitHub release and updates the Homebrew cask. See [docs/releasing.md](docs/releasing.md).

## Further reading

- [Architecture](docs/architecture.md)
- [Skill system](docs/skill-system.md)
- [Phase 0 decisions](docs/phase-0.md)
