# Daedalus

A macOS app and CLI for running coding agents such as Claude Code and Codex, organized by workspace and task.

- **Workspaces and a task board.** Each workspace has a brief, a journal, tasks and the repositories it works on.
- **Sessions that outlive the app.** Every agent runs in tmux. Quitting, updating or reopening the app leaves them running.
- **One worktree per session.** Agents get their own Git worktrees, so parallel sessions never share a checkout.
- **A CLI over the same core.** `daedal` does everything the app does, from a terminal or from inside an agent.

## Install

Requires macOS 14 or newer, on Apple silicon or Intel, and `git`.

1. **Install Daedalus.**

   ```sh
   brew install --cask bakar0/tap/daedalus
   ```

2. **Install the agent CLIs you use**, such as Claude Code or Codex, and sign in to each once in a terminal. Daedalus starts them but doesn't install them.

3. **Open Daedalus** from Applications. The first launch takes a few extra seconds while the app unpacks itself.

4. **Add `daedal` to your shell**, to use it from your own terminal. Sessions started by Daedalus already have it.

   ```sh
   echo 'export PATH="$HOME/.daedalus/bin:$PATH"' >> ~/.zshrc
   ```

   Open a new terminal and run `daedal doctor` to check the install.

The app carries its own Bun and tmux, so nothing else needs to be installed.

### Without Homebrew

Download the DMG for your Mac from the [latest release](https://github.com/Bakar0/daedalus/releases/latest), `stable-macos-arm64-Daedalus.dmg` for Apple silicon or `stable-macos-x64-Daedalus.dmg` for Intel, and drag Daedalus to Applications.

Releases aren't signed with an Apple Developer ID yet, so macOS refuses to open a downloaded copy until you run this once:

```sh
xattr -dr com.apple.quarantine /Applications/Daedalus.app
```

The Homebrew cask does this for you.

## Updates

Daedalus checks for a new release when it starts and every six hours. When one is out, a dot appears on the Settings button, and **Update and restart** appears under the toolbar and in **Settings → About**. The app replaces itself and reopens; running sessions are not interrupted.

**Daedalus → Check for Updates…** checks right away. `brew upgrade` leaves Daedalus alone, since it updates itself.

## Your data

Everything lives in `~/.daedalus`: the database, workspaces, repositories, worktrees and logs. Reinstalling, updating or uninstalling the app never touches it, not even `brew uninstall --zap`.

## Using the CLI

```sh
daedal workspace create "My project"
daedal task create --workspace my-project --title "Implement feature"
daedal agent spawn --workspace my-project --provider claude
daedal agent list --running
```

`daedal --help` lists every command. See the [CLI reference](docs/cli.md).

## Development

Requires macOS 14 or newer with the Command Line Tools, Bun **1.4.2**, and tmux **3.7c** or newer on `PATH` for the tests.

```sh
bun install --frozen-lockfile
bun node_modules/electrobun/bin/electrobun.cjs prepare
bun test && bun run typecheck
bun run dev          # run the app from source
bun run build        # package Daedalus-dev.app
```

A dev build keeps its data in `~/.daedalus-dev`, apart from the installed app. To keep an experiment out of both, set `DAEDALUS_HOME`:

```sh
DAEDALUS_HOME=/tmp/daedalus-test bun run daedal doctor
```

| Command                       | What it checks                                     |
| ----------------------------- | -------------------------------------------------- |
| `bun test`                    | unit and SQLite migration tests                    |
| `bun run typecheck`           | strict TypeScript                                  |
| `bun run format:check`        | Prettier formatting                                |
| `bun run verify:versions`     | exact dependency and Bun pins                      |
| `bun run test:agent-tmux`     | agent lifecycle against a real tmux                |
| `bun run test:cli-agent`      | workspace → task → agent → cleanup through the CLI |
| `bun run test:terminal-agent` | terminals: noisy output, reconnect, cleanup        |
| `bun run test:settings-ui`    | the Settings dialog, in a real browser             |

Pushing a `v<version>` tag publishes a release; see [Releasing](docs/releasing.md).

## Documentation

| Document                                       | Covers                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| [Architecture](docs/architecture.md)           | package boundaries, persistence, session lifecycle and terminals |
| [Desktop](docs/desktop.md)                     | the board, sessions, terminals, notifications and quitting       |
| [Workspace content](docs/workspace-content.md) | workspaces, the repository library and worktrees                 |
| [CLI](docs/cli.md)                             | every `daedal` command                                           |
| [Skills](docs/skills.md)                       | the agent skills Daedalus installs                               |
| [Skill system](docs/skill-system.md)           | the design of skills and writing styles                          |
| [Releasing](docs/releasing.md)                 | releases, updates, signing and the Homebrew cask                 |
| [Phase 0](docs/phase-0.md)                     | the original dependency and transport decisions                  |
