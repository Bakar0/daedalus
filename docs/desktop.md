# Desktop RPC and UI

The desktop is a thin adapter over the same `ApplicationContext` used by `daedal`. Workspace selection stays in the left sidebar and a centered app-header control switches the complete workspace composition. Board mode gives most width to the task canvas and keeps a narrower persistent brief inspector. Sessions mode replaces both with a compact vertical session navigator and a terminal-dominant work area. Workspace mode uses a compact, lazily expanded filesystem explorer beside a CodeMirror editor with Markdown preview. Root `BRIEF.md` and `JOURNAL.md` open like normal workspace files; freshly fetched repository references under `repos/` and session-owned worktrees appear in the explorer. The repository add button opens a fuzzy finder over the global repository library and also supports cloning a remote. There is no separate Activity view or permanent session rail. Session cards list task-linked and workspace-level sessions and show their durable lifecycle timestamps. Task briefs render as GitHub-flavored Markdown and switch to their portable plain-text source for edits.

**New session** presents Codex, Claude, and Terminal as a direct row of tool choices instead of a dropdown. There is no workspace or task selector in this dialog: every session opens in the currently selected workspace, and free terminals start its login shell there. Sessions persist their explicit `agent` or `terminal` kind and use the same durable tmux ownership, reconnect, stop, and remove lifecycle. Selecting a session card switches the agent terminal surface. The settings dialog reports the resolved `DAEDALUS_HOME`, workspace root, database, tmux capability, configured provider executables, and renderer-local theme preference.

The bottom integrated-terminal panel is a separate utility surface available in Board, Sessions, and Workspace modes. Its **+** action creates a persisted login shell in the configured Daedalus home. Each active workspace card has an **Open in integrated terminal** action that creates a named tab in the workspace's validated registered path. Tabs show live state, can be selected or closed, and survive panel collapse and app restart through SQLite metadata plus tmux ownership. They never appear in the agent Sessions list.

## Contract

`@daedalus/protocol` defines serializable workspace, task, agent, integrated-terminal, settings, and snapshot DTOs plus `DesktopRpcSchema`. Every request returns `RpcResult<T>` so validation, not-found, conflict, dependency, and internal failures retain stable codes across the process boundary.

The Bun handlers only convert DTOs, normalize errors, and call `context.workspaces`, `context.tasks`, `context.agents`, or `context.terminals`. Filesystem identity checks, SQLite operations, task validation, provider launches, and tmux lifecycle behavior remain in shared packages.

Available calls cover:

- workspace snapshot/create/get/update/remove;
- task create/get/update/status/remove;
- agent get/spawn/send/stop/remove/archive/restore;
- integrated terminal create/close;
- settings and executable capability discovery through the snapshot.

Workspace removal always supplies the core `force` guard after UI confirmation. The UI first asks whether files should be deleted and then requires a second confirmation describing the exact action. Task deletion, agent stop, and session-history removal also require confirmation. Live agents continue to block task and workspace removal in core.

## Cross-process refresh

Successful desktop mutations emit a typed `dataChanged` message immediately. The main process also reconciles agent state and fingerprints the WAL-backed SQLite records every 1.2 seconds. A changed fingerprint emits the same message, allowing CLI-created or updated objects to appear without restarting the app. The renderer responds by requesting a fresh snapshot rather than merging untrusted deltas.

## Terminal boundary

The renderer receives a token-bearing loopback endpoint at launch and adds either the selected agent UUID or integrated-terminal UUID. The Bun process resolves the typed target to its recorded tmux session, rejects non-live sessions, and attaches through a native PTY that streams tmux's exact redraw and cursor bytes. Input and dimensions flow back as small typed JSON messages and are written directly to that PTY. A selected xterm.js instance provides interactive input, paste, Unicode, ANSI color, resize, procedurally aligned block/box glyphs, and 10,000 lines of scrollback.

The transport caps pending output at 1 MiB on both sides and pauses Bun-side draining while the WebSocket exceeds a 256 KiB high-water mark. Old pending bytes are discarded on overflow with a terminal notice; tmux keeps the authoritative pane and redraws it for a new PTY attachment. Unexpected socket closure retries with bounded exponential delay. Normal session switching and view teardown close the socket, terminal, timers, and tmux PTY client without killing the underlying session. Stop and remove remain explicit actions on each session card.

The panel distinguishes live, reconnected, reconnecting, exited, and lost states. Desktop startup reconciliation makes existing tmux sessions reconnectable after app restart. CLI attachment remains independent and compatible because the desktop never replaces or proxies session ownership.

## Archives

The primary session lifecycle action is Archive. It stops a live process and moves the logical session into a collapsed **Archived sessions** section at the bottom of the selected workspace's session navigator. **Restore & resume** uses the persisted provider conversation locator and exposes the session only after a new tmux runtime starts successfully.

Archived workspaces appear in a collapsed section at the bottom of the workspace sidebar. Archiving a workspace also archives all sessions inside it. Restoring the workspace makes its tasks visible again but intentionally leaves its sessions in the archive for individual restoration.

## Testing

`apps/desktop/src/bun/rpc.test.ts` drives the RPC adapter through a real temporary application context, SQLite database, workspace filesystem, and fake tmux boundary. Terminal tests cover upgrade authentication, bounded noisy-output queues, socket high-water behavior, ANSI/Unicode capture, input, resize, reconnect status, and resource cleanup. `apps/desktop/src/renderer/App.test.tsx` renders lifecycle, dependency, and multi-session terminal selection states with an injected typed client. `bun run test:terminal-agent` exercises the real isolated tmux path. All test homes and tmux sockets are isolated and never touch the user's Daedalus data.
