# Daedalus

macOS desktop app plus a `daedal` CLI over one core. `@daedalus/core` owns config,
domain, SQLite and services; `@daedalus/platform` owns OS boundaries;
`@daedalus/protocol` owns DTOs and the typed RPC schema. The CLI and the
Electrobun desktop app are both adapters and hold no business logic.

## Building and running the app

```
bun install
bun test && bun run typecheck    # correctness
bun run build                    # packages the dev channel
```

`bun run build` produces `build/dev-macos-arm64/Daedalus-dev.app`. It works
headlessly, so an agent can and should run it to prove a change still packages.
Both build commands end with `scripts/bundle-plist.ts`, which adds the
Info.plist keys Electrobun's template cannot (App Nap opt-out); run it again
after any manual `electrobun build`.

An agent **can** launch it with `open build/dev-macos-arm64/Daedalus-dev.app`.
`open` hands the bundle to Launch Services, which starts it in the user's GUI
session, so this works from an agent's `Background` launchd session
(`launchctl managername`) and opens no terminal window.

What an agent **cannot** do is see or drive the result: screen capture needs a
Screen Recording grant the agent does not have, and there is no way to click.
So a change that has to be _looked at_ still ends with a handoff — say plainly
that visual confirmation is outstanding rather than implying the build proved
it. Never drive Terminal.app through `osascript` to get a GUI session; it opens
windows on the user's machine and `open` already does the job.

## Channels

| Channel | Command                | Bundle             | Identifier             | Home              |
| ------- | ---------------------- | ------------------ | ---------------------- | ----------------- |
| dev     | `bun run build`        | `Daedalus-dev.app` | `dev.daedalus.app.dev` | `~/.daedalus-dev` |
| stable  | `bun run build:stable` | `Daedalus.app`     | `dev.daedalus.app`     | `~/.daedalus`     |

The identifiers differ on purpose. macOS keys Launch Services, preferences,
notifications and URL registration off the identifier, so a shared one makes a
preview build the same app twice rather than a second app. The homes differ for
the same reason: two apps on one SQLite file corrupt or lock each other.

A non-stable build applies its channel suffix to whatever home it resolves,
**including one inherited from `DAEDALUS_HOME`**. Daedalus exports that variable
into every agent session it starts, so an agent that builds a dev app and opens
it would otherwise hand the stable home straight to it — the exact arrangement
the channels exist to prevent, arriving by inheritance rather than by anyone
choosing it. There is deliberately no way to point a dev build at the stable
home; copy the database if that is really what you want.

`bun run app:install` builds stable and installs it to `~/Applications`, which
needs no administrator rights. It refuses while Daedalus is running.

## Electrobun

Pinned to **1.18.1**. Do not move to 2.x: its Hutch/Cottontail toolchain cannot
package on this machine — every subcommand evaluates `electrobun.config.ts`
through Cottontail, which will not start without a native wrapper that the
toolchain never installs, and supplying it by hand starts an AppKit event loop
instead of loading the config. Electrobun's own `hello-world` template fails the
same way, so it is upstream, not this repository. 2.x adds multi-language main
processes, uninstallers, screen capture and its own DOM renderer — none of which
this app uses.

`views://` URLs resolve as resource paths, so they take **no query string and no
fragment**; either makes the page fail to load. Renderer parameters travel over
RPC instead (see `terminalEndpoint`).

## Conventions

- TypeScript is strict with `noUncheckedIndexedAccess`. No `any`, no
  shell-string execution — executables and arguments are always arrays.
- Prettier is authoritative; run `bunx prettier --write` on files you touch.
- `bun test` is the suite, and `bun run test` is the same command. Vitest
  supplies the assertion API but cannot run the suite: it resolves neither the
  `@daedalus/*` path aliases nor the Bun APIs the services are written against,
  and collects only 11 of 26 files.
