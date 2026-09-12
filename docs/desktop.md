# Desktop RPC and UI

The desktop is a thin adapter over the same `ApplicationContext` used by `daedal`. Workspace selection stays in the left sidebar. The workspace surface switches between a task Board and a Sessions view; there is no separate Activity view or permanent session rail. Session cards list task-linked and workspace-level sessions and show their durable lifecycle timestamps. One selected session fills the terminal area on the right. Briefs open from board cards, render as GitHub-flavored Markdown, and switch to their portable plain-text source for edits; that same source is stored in SQLite and passed into linked agent launches.

**New session** can start a Codex agent, Claude agent, or free terminal and can optionally link it to a task. Free terminals start the user's login shell in the workspace directory. Sessions persist their explicit `agent` or `terminal` kind and use the same durable tmux ownership, reconnect, stop, and remove lifecycle. Multiple terminal split layouts are not exposed yet; selecting a session card switches the one terminal surface. The settings dialog reports the resolved `DAEDALUS_HOME`, workspace root, database, tmux capability, configured provider executables, and renderer-local theme preference.

## Contract

`@daedalus/protocol` defines serializable workspace, task, agent, settings, and snapshot DTOs plus `DesktopRpcSchema`. Every request returns `RpcResult<T>` so validation, not-found, conflict, dependency, and internal failures retain stable codes across the process boundary.

The Bun handlers only convert DTOs, normalize errors, and call `context.workspaces`, `context.tasks`, or `context.agents`. Filesystem identity checks, SQLite operations, task validation, provider launches, and tmux lifecycle behavior remain in shared packages.

Available calls cover:

- workspace snapshot/create/get/update/remove;
- task create/get/update/status/remove;
- agent get/spawn/send/stop/remove;
- settings and executable capability discovery through the snapshot.

Workspace removal always supplies the core `force` guard after UI confirmation. The UI first asks whether files should be deleted and then requires a second confirmation describing the exact action. Task deletion, agent stop, and session-history removal also require confirmation. Live agents continue to block task and workspace removal in core.

## Cross-process refresh

Successful desktop mutations emit a typed `dataChanged` message immediately. The main process also reconciles agent state and fingerprints the WAL-backed SQLite records every 1.2 seconds. A changed fingerprint emits the same message, allowing CLI-created or updated objects to appear without restarting the app. The renderer responds by requesting a fresh snapshot rather than merging untrusted deltas.

## Terminal boundary

The renderer receives a token-bearing loopback endpoint at launch and adds only the selected agent UUID. The Bun process resolves the UUID to its recorded tmux session, rejects non-live sessions, captures bounded ANSI history, and then streams live binary output. Input and dimensions flow back as small typed JSON messages. A single selected `ghostty-web` instance provides interactive input, paste, Unicode, ANSI color, resize, and 10,000 lines of scrollback.

The transport caps pending output at 1 MiB on both sides and pauses Bun-side draining while the WebSocket exceeds a 256 KiB high-water mark. Old pending bytes are discarded on overflow with a terminal notice; tmux keeps the authoritative pane and a reconnect performs a new bounded capture. Unexpected socket closure retries with bounded exponential delay. Normal session switching and view teardown close the socket, terminal, timers, and tmux control client without killing the underlying session. Stop and remove remain explicit actions on each session card.

The panel distinguishes live, reconnected, reconnecting, exited, and lost states. Desktop startup reconciliation makes existing tmux sessions reconnectable after app restart. CLI attachment remains independent and compatible because the desktop never replaces or proxies session ownership.

## Testing

`apps/desktop/src/bun/rpc.test.ts` drives the RPC adapter through a real temporary application context, SQLite database, workspace filesystem, and fake tmux boundary. Terminal tests cover upgrade authentication, bounded noisy-output queues, socket high-water behavior, ANSI/Unicode capture, input, resize, reconnect status, and resource cleanup. `apps/desktop/src/renderer/App.test.tsx` renders lifecycle, dependency, and multi-session terminal selection states with an injected typed client. `bun run test:terminal-agent` exercises the real isolated tmux path. All test homes and tmux sockets are isolated and never touch the user's Daedalus data.
