# Desktop RPC and UI

The desktop is a thin adapter over the same `ApplicationContext` used by `daedal`. Workspace selection stays in the left sidebar and a centered app-header control switches the complete workspace composition. Board mode gives most width to the task canvas and keeps a narrower persistent brief inspector. Sessions mode replaces both with a compact vertical session navigator and a terminal-dominant work area. Workspace mode uses a compact, lazily expanded filesystem explorer beside a CodeMirror editor with Markdown preview. Root `BRIEF.md` and `JOURNAL.md` open like normal workspace files; freshly fetched repository references under `repos/` and session-owned worktrees appear in the explorer. The repository add button opens a fuzzy finder over the global repository library and also supports cloning a remote. There is no separate Activity view or permanent session rail. Session cards list task-linked and workspace-level sessions and show their durable lifecycle timestamps. Task briefs render as GitHub-flavored Markdown and switch to their portable plain-text source for edits.

**New session** presents Codex, Claude, and Terminal as a direct row of tool choices instead of a dropdown. There is no workspace or task selector in this dialog: every session opens in the currently selected workspace, and free terminals start its login shell there. Sessions persist their explicit `agent` or `terminal` kind and use the same durable tmux ownership, reconnect, stop, and remove lifecycle. Selecting a session card switches the agent terminal surface. The settings dialog reports the resolved `DAEDALUS_HOME`, workspace root, database, tmux capability, configured provider executables, and renderer-local theme preference.

The bottom integrated-terminal panel is a separate utility surface available in Board, Sessions, and Workspace modes. Its **+** action creates a persisted login shell in the configured Daedalus home. Each active workspace card has an **Open in integrated terminal** action that creates a named tab in the workspace's validated registered path. Tabs show live state, can be selected or closed, and survive panel collapse and app restart through SQLite metadata plus tmux ownership. They never appear in the agent Sessions list.

## Agent status and attention

Lifecycle status answers "is this session running". Activity answers "does it
need me", and only the second one changes what the user does next, so the two
attention activities are the only loud tier in the UI. Everything else is
ambient.

`AgentActivityDto` (`{ sessionId, activity, detail, since, observedAt, source }`)
and `SessionAttentionDto` ride on the snapshot beside session telemetry. The
renderer is an adapter over them: `sessionStatusView` folds lifecycle status,
activity, and the attention badge into one thing to draw, and the only
computation the renderer does on its own is formatting elapsed time.

### Indicator vocabulary

| Tone        | Colour     | Shape                                                                   | Meaning                                                               |
| ----------- | ---------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `attention` | red        | larger dot, **solid outer ring**, count badge when more than one reason | `needs_permission` or `needs_input`; the user is the thing in the way |
| `working`   | periwinkle | **pulsing halo**                                                        | the agent is doing something, or the session is still starting        |
| `idle`      | green      | plain dot                                                               | running, nothing observed                                             |
| `done`      | green      | plain dot                                                               | the turn finished                                                     |
| `error`     | amber      | plain dot                                                               | the turn failed                                                       |
| `lost`      | red        | thin ring                                                               | the tmux session vanished                                             |
| `ended`     | grey       | plain dot                                                               | exited                                                                |

Colour is never the only carrier: shape and motion distinguish every tier on
their own, so the vocabulary survives colour-blindness and a glance at a dense
list. Motion respects `prefers-reduced-motion`. An observation whose `source`
is `pane` renders with a dashed ring, reduced opacity, and an "unconfirmed"
chip — a heuristic presented as a fact is how a status display loses its
credibility. `aria-label` always names the activity and the wait, never the
colour.

### Surfaces

- **Session rows** show the dot, the activity label, `waiting 4m` for attention
  states, and the newest reason or activity detail as a truncated second line.
- **The sessions toolbar** carries a **Needs me** filter. Blocked sessions used
  to float to the top of the list as well; they no longer do, because the list
  order is now the user's — see _Manual order_ below. A blocked session stays
  where it was put and is found by its tone, its badge and the filter.
- **The collapsed workspace indicator** sorts blocked sessions first, so the
  five-icon truncation can never be the reason one goes unnoticed. This one is
  not a list the user arranges, so nothing is being overridden.
- **The workspace card** carries a `2 need you` roll-up, so a blocked session in
  a workspace nobody is looking at is discoverable without clicking in.
- **The session detail header** puts the activity beside the model and context
  readout, and raises a panel listing the open reasons with a **Clear** action
  when the session is blocked.

### The badge

One badge per session holding a _set of open reasons_, never a counter of
events. Repeated raises accumulate onto the same badge: identical text collapses
rather than piling up, the newest five are kept, and the sixth evicts the
oldest so the freshest context survives. The count lives on the indicator and
the reason text lives in the session detail, deliberately not in a native
tooltip that cannot be styled.

Clearing is all-or-nothing — there is no per-reason resolution — and it is
privileged in two ways that are easy to miss. It happens on the transition out
of the attention state whether or not the user ever came, because a badge that
outlives its cause trains people to ignore badges. And it is never queued and
never silenced, not even in Focus mode: suppressing an alert is a preference,
suppressing the retraction of an alert is a bug. Clearing also purges anything
queued for that session, or the badge would come back to life the moment the
queue flushed.

A low-confidence `pane` reading may raise a badge but never retracts one.

## Notifications

Three distinct channels, never two at once for the same event:

- **Badge** — persistent, described above.
- **Toast** — ephemeral, five seconds, clickable, with an
  `info`/`success`/`error` level. At most three are on screen; the rest stay
  queued and appear as the stack drains. Three is where both Sonner's default
  and the usability literature land: past that a stack stops being read and
  starts being dismissed unread.

  They are drawn as a **deck, not a list**. Stacked down a corner, three cards
  wall off whatever is underneath them, which is how a notification turns into
  an obstacle. Collapsed, the deck costs the height of one card plus a 14px
  sliver per toast behind it, each one scaled down 5% and with its contents
  hidden so it reads as an edge rather than showing through as a smudge; all
  cards take the front card's height so none juts out. Pointing at the deck —
  or tabbing into it — fans it out to full height and **pauses every
  countdown**, and leaving resumes them with the time that was left rather than
  from the top. Each card carries the gap below it as a hover target, so moving
  between fanned cards does not collapse the deck mid-read, and the container
  itself is `pointer-events: none` so it never swallows a click meant for the
  app beneath.

  The deck is aligned with the **app header**, not with the content below it.
  The header's right side holds nothing but a transient "Working…" indicator,
  the brand sits left and the mode switcher is centred, so the deck floats over
  static chrome rather than over the thing being read — the same reasoning that
  makes it collapse at all. Below 1000px the centred switcher would slide under
  a right-aligned deck, so there it drops back beneath the header: covering
  navigation is worse than covering a paragraph.

  Level is a dot in the same vocabulary as the session indicators, not a
  coloured bar down the edge. Every toast has its own labelled dismiss, shown
  on hover and always reachable by keyboard, because an auto-dismissing alert
  still needs a way to be closed now; a deck of more than one adds a single
  **Clear all**. Each toast owns its own countdown, so one arriving late does
  not cut short the one already on screen.

- **Native OS notification** — for when the app is backgrounded.

The channel is chosen by **presence**, not by suppressing on focus. The window
publishes `{ appForeground, workspaceId, sessionId }` every three seconds and
the host samples system idle time alongside it, into `presence.json` under
`DAEDALUS_HOME`. A heartbeat older than eight seconds reads as "no app", so a
closed window stops absorbing alerts within a few seconds rather than
swallowing them indefinitely. Routing:

| Where the user is                        | Channel                                     |
| ---------------------------------------- | ------------------------------------------- |
| Focused on this very session             | nothing ephemeral; badge only               |
| App open, looking at something else      | toast (+ badge when blocking)               |
| App backgrounded, closed, or idle ≥ 300s | native notification (+ badge when blocking) |

Alerts fire on transitions, never on a level, and are debounced per session:
a turn that bounces `working → needs_permission → working` three times is one
alert. The title carries the workspace, the session name, and the task number
when task-backed.

Native alerts go down a three-tier ladder, and `degraded` reports which tier
the caller actually got:

1. **`terminal-notifier`**, when it is on `PATH` — the only widely available way
   to attach a _click action_. It runs `daedal focus <session-id>`, which parks
   a request under `DAEDALUS_HOME` and raises the app; the host picks the
   request up on its next tick and the window selects that session.
2. **Electrobun's `Utils.showNotification`**, when the app itself is the caller
   — correctly attributed to this bundle and needs nothing installed, but
   clicking it can only raise the app, not choose a session.
3. **`osascript`** — always available, attributed to Script Editor, no click
   target at all.

The app that gets raised follows the home's channel: a `~/.daedalus-dev` home
raises `dev.daedalus.app.dev`, never the stable app. They are separate
applications and macOS keys activation off the identifier.

Electrobun 1.18.1 exposes `setDockIconVisible` but no dock _badge_, so the
attention count has nowhere native to go; the host logs `attention_count_changed`
and the in-app workspace roll-up is what the user reads.

**Focus mode** is a global setting in the settings dialog. It stops toasts and
desktop notifications while activity transitions keep flowing normally, so the
board stays live and only the interruptions stop. A suppressed alert is
reported as `suppressed: "focus_mode"` with the reason `focus mode is on`,
never silently dropped, so a caller can always tell suppression from failure.

## Giving the agent a voice

Inference can tell you a session is blocked; only the agent can tell you why.
`daedal attention "<reason>"`, `daedal attention --clear`, `daedal notify`, and
`daedal ui state` let a session report on itself and pick its own channel. This
is also the only path that works for `custom` provider sessions and for any
agent with no hook support at all.

## Contract

`@daedalus/protocol` defines serializable workspace, task, agent, integrated-terminal, settings, and snapshot DTOs plus `DesktopRpcSchema`. Every request returns `RpcResult<T>` so validation, not-found, conflict, dependency, and internal failures retain stable codes across the process boundary.

The Bun handlers only convert DTOs, normalize errors, and call `context.workspaces`, `context.tasks`, `context.agents`, or `context.terminals`. Filesystem identity checks, SQLite operations, task validation, provider launches, and tmux lifecycle behavior remain in shared packages.

Available calls cover:

- workspace snapshot/create/get/update/remove;
- task create/get/update/status/remove;
- agent get/spawn/send/stop/remove/archive/restore;
- attention raise/clear, toast acknowledgement, presence publication, and the
  Focus mode setting;
- integrated terminal create/close;
- settings and executable capability discovery through the snapshot.

Workspace removal always supplies the core `force` guard after UI confirmation. The UI first asks whether files should be deleted and then requires a second confirmation describing the exact action. Task deletion, agent stop, and session-history removal also require confirmation. Live agents continue to block task and workspace removal in core.

## Cross-process refresh

Successful desktop mutations emit a typed `dataChanged` message immediately. The main process also reconciles agent state and fingerprints the WAL-backed SQLite records every 1.2 seconds. A changed fingerprint emits the same message, allowing CLI-created or updated objects to appear without restarting the app. The renderer responds by requesting a fresh snapshot rather than merging untrusted deltas.

## Terminal boundary

The renderer receives a token-bearing loopback endpoint at launch and adds either the selected agent UUID or integrated-terminal UUID. The Bun process resolves the typed target to its recorded tmux session, rejects non-live sessions, and attaches through a native PTY that streams tmux's exact redraw and cursor bytes. Input and dimensions flow back as small typed JSON messages and are written directly to that PTY. A selected xterm.js instance provides interactive input, paste, Unicode, ANSI color, resize, procedurally aligned block/box glyphs, and 10,000 lines of scrollback.

The transport caps pending output at 1 MiB on both sides and pauses Bun-side draining while the WebSocket exceeds a 256 KiB high-water mark. Old pending bytes are discarded on overflow with a terminal notice; tmux keeps the authoritative pane and redraws it for a new PTY attachment. Unexpected socket closure retries with bounded exponential delay. Normal session switching and view teardown close the socket, terminal, timers, and tmux PTY client without killing the underlying session. Stop and remove remain explicit actions on each session card.

The panel distinguishes live, reconnected, reconnecting, exited, and lost states. Desktop startup reconciliation makes existing tmux sessions reconnectable after app restart. CLI attachment remains independent and compatible because the desktop never replaces or proxies session ownership.

## Manual order

Both navigator lists — workspaces and the sessions inside one — are arranged by
hand. Order lives in a `position` column, not in browser storage, because it is
durable user data rather than a view preference: it survives a reinstall, and
`daedal workspace reorder` / `daedal agent reorder` can set it without the app
running. The renderer never sorts either list; it renders what the snapshot
gives it, which is what the service already ordered.

A newly created workspace or session takes the top slot, leaving the order
below it untouched.

**Dragging.** A card is picked up anywhere on it, after the pointer travels
`DRAG_THRESHOLD_PX` (5px). These cards are buttons first — a click selects the
workspace or session — and a movement threshold is what lets one gesture serve
both without a press-and-hold delay. The click that ends a real drag is
swallowed so a drop never also selects. The card's own action buttons
(archive, open terminal) are marked `data-no-drag` and start nothing.

**No affordance.** There is no grip and no grab cursor, by request: the cards
look exactly as they did, and dragging is something you find rather than
something the list advertises.

**The card in hand** keeps full opacity — fading it reads as disabled rather
than picked up — and is lifted with a shadow, a slight scale, and a neutral
hairline rather than the accent colour, which means "selected" everywhere else.
Its background is stated outright rather than inherited from `:hover`, and the
drag takes **no pointer capture**. Both are the same lesson: capture is released
the moment its element moves in the DOM, and React moves the minimum number of
nodes — the dragged node when a card travels _down_ the list, its neighbours
when it travels _up_. Deriving the held card's look from `:hover` therefore made
the highlight vanish in one direction only. The drag listens on the window and
measures rects, so capture bought nothing anyway; with it gone,
`pointer-events: none` on the list mid-drag becomes load-bearing, since it is
what keeps `:hover` off the cards the pointer merely crosses.

**Keyboard.** ⌥↑ and ⌥↓ move the focused card one place, clamped at the ends
rather than wrapping.

**Filtered lists.** A reorder names only the cards the user can see, and the
service deals them back into the slots those cards occupied. Dragging inside
the **Needs me** filter therefore cannot disturb the sessions it is hiding, and
dragging an active workspace cannot move an archived one.

## Archives

The primary session lifecycle action is Archive. It stops a live process and moves the logical session into a collapsed **Archived sessions** section at the bottom of the selected workspace's session navigator. **Restore & resume** uses the persisted provider conversation locator and exposes the session only after a new tmux runtime starts successfully.

Archived workspaces appear in a collapsed section at the bottom of the workspace sidebar. Archiving a workspace also archives all sessions inside it. Restoring the workspace makes its tasks visible again but intentionally leaves its sessions in the archive for individual restoration.

## Testing

`apps/desktop/src/bun/rpc.test.ts` drives the RPC adapter through a real temporary application context, SQLite database, workspace filesystem, and fake tmux boundary. Terminal tests cover upgrade authentication, bounded noisy-output queues, socket high-water behavior, ANSI/Unicode capture, input, resize, reconnect status, and resource cleanup. `apps/desktop/src/renderer/App.test.tsx` renders lifecycle, dependency, and multi-session terminal selection states with an injected typed client, and covers the indicator vocabulary, the attention roll-up, snapshot-order rendering, and the toast cap. `apps/desktop/src/renderer/list-reorder.test.ts` covers the drag arithmetic — click-versus-drag, the drop slot, and keyboard moves — without a DOM, and `packages/core/src/services/ordering.test.ts` covers the subset-reorder rule. `bun run test:reorder-ui` drives a real drag in headless Chrome and samples the DOM across it, in both directions and on an unselected card — the only way either of the two interaction bugs this feature shipped with was reachable, since both were invisible in a single rendered frame. `packages/core/src/services/activity.test.ts` covers badge accumulation, privileged clearing, and alert debouncing against a real temporary context with the native notifier injected — no test ever reaches the real Notification Center. `bun run test:terminal-agent` exercises the real isolated tmux path. All test homes and tmux sockets are isolated and never touch the user's Daedalus data.
