# Phase 0 decisions and terminal spike

Verified on 2026-09-12 on macOS 26.6.2 arm64.

## Product decisions

- MVP platform: macOS first. Electrobun 2.0.1 officially supports macOS 14+.
- Workspace model: plain directories under a configurable root, not Git worktrees.
- Terminal owner: the Bun-side desktop main process attaches to a tmux-owned shell; the renderer only handles terminal bytes, input, and dimensions.
- Terminal transport: token-gated loopback WebSocket for sustained byte traffic; typed Electrobun RPC for low-volume product operations.

## Verified stable versions

| Dependency                      | Exact version | Stable source checked                                                     |
| ------------------------------- | ------------: | ------------------------------------------------------------------------- |
| Bun                             |         1.4.2 | <https://bun.sh/>                                                         |
| tmux                            |          3.7c | <https://github.com/tmux/tmux/wiki> and Homebrew stable bottle            |
| Electrobun                      |         2.0.1 | <https://www.npmjs.com/package/electrobun> and stable initializer catalog |
| ghostty-web                     |         0.4.0 | <https://www.npmjs.com/package/ghostty-web>                               |
| React / React DOM               |        19.3.0 | npm `latest`                                                              |
| Vite                            |         8.3.0 | npm `latest`                                                              |
| TypeScript                      |         7.0.2 | npm `latest`                                                              |
| Vitest                          |         5.0.0 | npm `latest`                                                              |
| Prettier                        |         3.9.6 | npm `latest`                                                              |
| @vitejs/plugin-react            |         6.1.1 | npm `latest`                                                              |
| @types/bun                      |         1.4.2 | npm `latest`                                                              |
| @types/react / @types/react-dom |        19.3.0 | npm `latest`                                                              |

All are exact direct pins. `bun.lock` records the full resolution. Electrobun's `hutch.config.ts` separately pins the native SDK/toolchain to 2.0.1.

## Transport evidence

tmux control mode is designed for terminal integrations and emits pane bytes as `%output` notifications. It escapes bytes below ASCII 32 and backslash as octal, which the bridge decodes. It also provides `refresh-client -C` for client dimensions and `pause-after`/resume primitives for future flow control.

The automated real-tmux spike (`bun run test:terminal-spike`) proved:

1. Interactive input reached a login shell and output returned through control mode.
2. ANSI SGR red and mixed Hebrew, CJK, and emoji bytes survived the bridge.
3. `stty size` observed the renderer-equivalent resize of 27 rows by 91 columns.
4. Pane history remained capturable after the first control client disconnected.
5. A second control client received new live output from the same tmux session.

Vite successfully bundles ghostty-web 0.4.0 and its WASM asset into the Electrobun view. The packaged macOS build completes with Electrobun 2.0.1.

## Why WebSocket, not RPC, for terminal bytes

Electrobun RPC is an excellent typed boundary for commands and domain DTOs. The terminal path differs: it is sustained, bursty, naturally binary, and must later expose bounded buffering/backpressure. A loopback WebSocket supplies binary frames, native browser lifecycle semantics, and a clean one-stream-per-connection abstraction. Binding only to loopback and requiring a random per-process token limits exposure.

The decision is intentionally encapsulated. RPC will announce/query sessions; the WebSocket will carry only terminal stream messages.
