# Session abilities

Every agent in Daedalus is an ordinary session. A session can be named,
pinned and colored, and it can hold abilities: things Daedalus adds to it on
top of being a session. There is one: orchestration, which makes a session
the lead of a team.

Routines are not an ability. They live on the Routines page in the app's
sidebar: a prompt that runs on a schedule in a workspace, each run a headless
session of its own. See `daedal routine --help`.

## Name, pin and color

Any session, with or without abilities:

```
daedal session rename <session> <name>
daedal session pin|unpin <session>
daedal session color <session> <red|orange|gold|green|teal|blue|purple|pink|#rrggbb|none>
```

`<session>` is a session id, or a session's name when exactly one live
session has it. Pinned sessions sit at the top of their workspace's list, in
the order they were pinned. The color marks the session's card on its left
edge. Besides the eight named colors, a session can take any `#rrggbb`; in
the app, the rainbow swatch at the end of the color row opens a grid of 50
more. A rebirth successor keeps the pin and the color, and its name gains a
` · 2`. A team's lead is numbered like any other session; the team's name
leaves the counter out, so it stays the same.

`agent spawn` takes the same choices at creation: `--color <color>` and
`--pin`.

## Abilities

An ability is a definition in Daedalus's code. A session holds one through a
row in `session_abilities`. The ability's data, such as a team's goal, hangs
off that row's id, so a rebirth moves everything with one update.

```
daedal agent spawn --workspace <w> --provider claude --name Argus --ability orchestration
daedal session grant <session> orchestration
daedal session revoke <session> orchestration
daedal session abilities <session>
```

- **Orchestration** adds one line to the launch prompt saying what the
  session holds and which skill to follow. Granted to a running session,
  Daedalus sends one note, as described under Delivery below; until then
  `session abilities` shows the note as waiting.
- **Revoke** stops what the ability does and sends a note saying so. The row
  and its data stay, so granting it again brings everything back.
- **Archive** pauses what a session holds; **restore** resumes it.
- Abilities work on Claude and Codex sessions. A terminal or a custom command
  cannot hold one.

The skills an ability uses are Daedalus managed skills, installed for every
provider like the others and listed in Settings, Skills. Daedalus writes
nothing into a session's folder, which is usually a repository worktree.
Sessions without the ability can see the skills, but its commands refuse to
work for them.

### Delivery

The host tick, every 1.2 seconds while the app is open, hands each waiting
grant or revoke note to its session.

A Claude session gets it through its inbox, nothing typed. Every Claude
session Daedalus launches has an inbox: a named pipe at
`<home>/inbox/<session>.fifo`, readable only by the user, and a hook on
`Stop` and `SessionStart` with `asyncRewake` that waits on it in a `/bin/sh`
of about 2 MB. Notes and the rebirth request go to the mailbox file beside
the pipe (`<session>.fifo.mail`), because they must arrive whatever the
session is doing. Daedalus appends the note and pokes the pipe. A waiter that
is reading prints the mailbox at once; otherwise the session is in a turn,
and the waiter that `Stop` starts when the turn ends prints it. The waiter
prints to stderr and exits 2, and Claude wakes with it as a hook note, so it
never shows as something the user sent and never touches their draft.

A Codex session, or a Claude session launched before inboxes existed, gets
the note typed, when all of these hold:

1. The session is running and idle. Activity comes from the provider's
   hooks; when it is unknown, the pane decides (an input box and no "esc to
   interrupt").
2. Its input box is empty. Daedalus reads the pane with its escape codes just
   before typing and ignores dim text, which is a placeholder: Claude's
   suggested next prompt, or Codex's "Ask Codex to do anything".
3. Nobody pressed a key in the session's terminal in the last 2 minutes.
   Scrolling and selecting are not keystrokes. The host keeps this in memory,
   so after an app restart nothing holds.

The skills never take the session or the CLI from the environment, which
Claude can swap for another session's (see "The calling session" in
`docs/cli.md`). They call this home's `bin/daedal` by full path, and the CLI
finds the session from the working directory.

## Orchestration and teams

A session holding the orchestration ability leads a team: sessions working
toward one goal. The lead plans the work, adds members, and sends each one
the decisions that affect it. Members are ordinary sessions the user can open,
answer and be reborn. The user is above the lead and can add a member too.

In the app:

- **Orchestration** is a switch in Create session and in a session's card
  menu. A member's menu does not offer it.
- A lead's card has a **+** that adds a member: a name, which becomes its
  `@handle`, Claude or Codex (the lead's provider is chosen at first), a
  model, and optional **Instructions**. The member runs in the lead's
  workspace and in its color. Without instructions
  it starts knowing only its team, its lead and the goal, says it is ready,
  and waits for the user to instruct it in its own session; the lead is
  told so in the chat.
- Members wear their lead's color, and changing the lead's color changes
  theirs.
- In the session list, a lead's card says **Team lead** and a member's says
  its `@handle`. Members are listed right under their lead and indented. The
  grouping is only how the list is drawn; dragging changes the stored order
  as before.
- A lead's or member's terminal has a **Team** bar. Its **Team** button
  opens the team's tab in the center tab strip. It starts with one line
  saying what a team is and a link to this section. Members are listed on
  the left and the chat fills the right, as in the Workflows tab, and the
  line between them drags to resize. It holds the goal, edited in place;
  each member with a status dot, its unread count and any delivery that
  failed, a click away from its session; the newest 100 messages of the
  chat, where a message longer than four lines folds; and a box to post as
  the user (⌘↵ sends). The open tab reads the team again every 4 seconds.

```
daedal agent spawn --workspace <w> --provider claude --name "Checkout API" --ability orchestration
daedal agent spawn --team --name server --message "<instructions>"   # inside the lead
daedal agent spawn --team "Checkout API" --message "<instructions>"  # the user
daedal team say "@server the token field is access_token"
daedal team chat [--tagged | --all]
daedal team list
daedal team goal "<text>"
```

The team is the lead's `session_abilities` row: its id is the team id, and its
`goal` config is the shared goal. A rebirth moves the ability to the successor,
so the team follows the lead with no other change. A member records its team
in `agent_sessions.team_id` and its handle in `team_handle`; a member's
rebirth successor takes both, and the predecessor leaves the team.

- **Members** start in the lead's workspace, on the lead's provider unless
  `--provider` asks for the other. A team can mix Claude and Codex in any
  combination of lead and members, because each session gets team
  messages through its own provider's inbox. A task is optional. The handle comes from
  `--name`, else the task title, else `member`, with `-2`, `-3` for repeats.
  `lead`, `user`, `daedalus` and `all` are reserved. The launch prompt names
  the team, the lead, the other members and the goal, and points to the
  `daedalus-team` skill.
- **The user adds a member** with `--team <lead>`. Daedalus then posts in the
  chat, as `daedalus` and tagging only the lead, who was added with which
  instructions. The lead manages that member like its own.
- **Status notes.** When a member needs the user, at most as often as the
  user is notified about it, and when it stops or is archived, Daedalus
  posts a note in the chat as `daedalus`, tagging only the lead: "@lead
  @server needs the user: …" or "@lead @server stopped running.". A lead
  needing the user posts nothing, and neither does a rebirth or a member's
  permission prompt: only the user can answer one, on the member's card, and
  the note would wake the lead at its full context for nothing. A member the
  lead itself stops or archives posts nothing either: the note is skipped
  when the posting process runs as the lead (`DAEDALUS_SESSION_ID`).
- **Pausing and ending a team.** Archiving the lead, by hand or by quitting
  the app with "Quit and stop sessions", pauses the team: members keep their
  handle and color, messages to the lead wait for it, no member can be added,
  and the app marks members "lead archived". Restoring the lead resumes the
  team and sends what waited. Only revoking the ability (Orchestration off,
  which asks to confirm "End team") ends a team: every member's team is
  cleared and they keep running as plain sessions. A member cannot be granted
  orchestration.

### The chat

`team_messages` stores every post: the team, the author (`lead`, `user`,
`daedalus` or a handle), the body and the tags. Tags decide who is told:
`@<handle>` and `@lead` push the message into that session, `@all` into every
one but the author's, and `@user` reaches no session. An unknown tag is
refused with the list of handles; a message that tags no session is stored
with a warning. The lead is not copied on members' messages to each other.

Delivery runs in the process that posts, so it works with the app closed.
Each reader has a row in `team_cursors`: `delivered_through`, the last tagged
message that reached its session, `read_through`, the last one `team
chat` printed to it, and `tagged_read_through`, the last message tagging it
that `team chat --tagged` printed. A tagged read moves only that marker, so
the rest of the chat stays unread, and a later full read skips what it
printed. Each read updates only its own column, so it never undoes a
delivery saved meanwhile. One delivery is a single line naming how many waiting
messages tag the reader and who wrote them, and the command that reads them:
`[team "<name>"] 2 new messages for you from lead and user. Read them with:
daedal team chat --tagged`. The messages stay in the chat. Both providers show a
command call as one folded row, so the conversation shows a line and a row
per delivery instead of every message in full. The cursor moves under a write lock
before the send, so two processes never send the same message, and moves
back if the send fails. A failure is kept in `last_error`, shown by
`team list`, and the send is tried again on the next post, on `team chat` and
`team list`, on the session's own `SessionStart` and `Stop` hooks, and when a
spawn, restore or revive has the session running. A resumed session sits
idle, so its hooks alone would not deliver. An archived member can be
tagged; the message waits until it is restored. `@all` reaches live sessions
only.

- **Claude** sessions get the message on their inbox socket. Daedalus finds
  the live `<claudeHome>/sessions/<pid>.json` whose `sessionId` is the
  session's, and writes one line to its `messagingSocketPath`:
  `{"type":"user","message":{"role":"user","content":...},"from":...,"session_id":...}`.
  Claude shows it as a message from another session, with `from` as the
  sender. The line format comes from Claude's debug log, not its public
  docs, so a Claude update can break it; the failure then shows in
  `team list`. Leads and members launch with `crossSessionInbound: "accept"`
  in Daedalus's settings, because a session in bypassPermissions mode would
  otherwise hold each message behind an approval dialog. A session granted
  orchestration while running has not got that setting until it is
  relaunched.
- **Codex** sessions get it through `codex queue --thread <thread> --message
<text>`, run with the session's account. A busy session runs it after its
  current turn, as a user turn; only the `[team ...]` prefix and the skill
  mark it as a teammate's.

Claude adds its own paragraph under every message from another session,
saying that it is not from the user. No setting or line field turns it off,
which is one more reason the delivered line is short.

Neither path types into the session's pane, so it never touches what the user
is typing. Messages the user posts reach Claude members as peer messages too;
an instruction that needs the user's own authority is typed in the member's
session directly.

The lead keeps the plan, the members, the contracts between them and every
decision in `TEAM.md` in its working directory (the `daedalus-orchestration`
skill). A rebirth successor reads it first.

### Large journal and team files

Every session that reads `JOURNAL.md` or a lead's `TEAM.md` pays for the whole
file on every model call after. The desktop snapshot's `largeFiles` lists each
workspace journal past 50 KB and each running lead's `TEAM.md` past 20 KB
(`context-files.ts`). A session's header then shows a bar for each that it
reads: "JOURNAL.md is 164 KB. To shrink it, run:" with `/daedalus-compact-workspace journal` and a Copy
button. The journal bar shows on every session of the workspace that is not
a team member; the `TEAM.md` bar, with `/daedalus-compact-workspace team`,
on the lead only. Members get neither, since the lead owns both files. The
skill moves what is no
longer current, unchanged, to `journal/YYYY-MM.md` or `TEAM-ARCHIVE.md`,
aiming for half the limit. Daedalus fills the limits and targets into the
installed skill (`{{journalLimitKb}}` and the rest, in `skills.ts`), so the
skill and the bar use the same numbers.

The generated `AGENTS.md` and session instruction files keep entries small at
the source: an entry is a dated heading and at most 5 one-line bullets, and
evidence goes in `artifacts/`. Files still holding the earlier journal line
are upgraded on the next sync.
Daedalus never runs it on its own.
