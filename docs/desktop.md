# Desktop RPC and UI

The Phase 5 desktop is a thin adapter over the same `ApplicationContext` used by `daedal`. Its three columns cover workspace selection, task cards, and a focused Markdown task brief. Briefs render as GitHub-flavored Markdown by default and switch to their portable plain-text source for explicit edits; that same source is stored in SQLite and passed directly into agent launch prompts. Compact `+` actions open workspace and task creation dialogs. Each task card owns its default agent-tool selector, spawn action, and compact session indicator; there is no separate agent-management screen. The settings dialog reports the resolved `DAEDALUS_HOME`, workspace root, database, tmux capability, configured provider executables, and a renderer-local theme preference.

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

The collapsible terminal under Settings is the original isolated Phase 0 transport spike, not an agent terminal. Per-agent interaction, terminal selection, reconnect, buffering, and cleanup remain Phase 6 work.

## Testing

`apps/desktop/src/bun/rpc.test.ts` drives the RPC adapter through a real temporary application context, SQLite database, workspace filesystem, and fake tmux boundary. `apps/desktop/src/renderer/App.test.tsx` renders lifecycle and dependency states with an injected typed client. All test homes are isolated and never touch the user's Daedalus data.
