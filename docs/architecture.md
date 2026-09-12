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

- `@daedalus/core` owns configuration, domain types, structured errors, application context, events, and SQLite migrations. Future mutations belong in services here.
- `@daedalus/platform` owns operating-system boundaries: filesystem creation, argv-safe process execution, and tmux control-mode transport.
- `@daedalus/protocol` owns serializable CLI/desktop DTOs and terminal wire messages.
- `apps/cli` maps arguments, results, errors, and exit codes onto the shared application layer.
- `apps/desktop/src/bun` starts the same application context and owns native process/terminal resources.
- `apps/desktop/src/renderer` only renders terminal bytes and sends input/resize events. It does not access files, SQLite, or tmux.

## Persistence

`DAEDALUS_HOME` overrides the default `~/.daedalus` root. Configuration resolves all data paths from that root. SQLite starts in WAL mode with a five-second busy timeout. Migrations are sorted SQL files applied transactionally and recorded in `schema_migrations`.

The initial migration defines the planned workspace, task, and agent-session tables so later phases can add repositories without changing the foundation. No Phase 2–4 CRUD behavior is implemented yet.

## Terminal lifecycle

The Phase 0 bridge attaches a tmux control client to a durable, named session. `%output` notifications carry the pane's actual terminal byte stream; octal-escaped control bytes are decoded before forwarding. User input is sent with argv-safe `tmux send-keys` calls, and resize uses the attached control client's `refresh-client -C` command.

A random token protects a WebSocket server bound only to `127.0.0.1`. New renderer clients receive an ANSI-preserving pane capture before live output. Renderer or WebSocket closure only detaches the control client; tmux and the shell continue running.

Typed Electrobun RPC remains the intended transport for bounded request/response and domain messages in later UI phases. Terminal streaming is isolated behind `TmuxControlBridge`, so backpressure can be expanded without affecting core services.
