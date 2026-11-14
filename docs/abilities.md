# Session abilities

Every agent in Daedalus is an ordinary session. A session can be named,
pinned and colored, and it can hold abilities: things Daedalus adds to it on
top of being a session. There is one: orchestration, the record of a team a
session leads. Nobody grants it by hand any more: any session becomes a lead
when it adds its first member (see Orchestration and teams).

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
daedal session grant <session> orchestration
daedal session revoke <session> orchestration
daedal session abilities <session>
```

- **Orchestration** adds one line to the launch prompt saying the session
  leads a team and which skill to follow. Every Claude and Codex session's
  Daedalus instructions (its system prompt) carry one line on how to lead a
  team. Granted to a running session with `session grant`, which starts a
  team with no members, Daedalus sends one note, as described under Delivery
  below; until then
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

A team is a lead and its members: sessions working toward one goal. Any
Claude or Codex session on this Mac can lead one, with no switch or grant: the
first `agent spawn --team` run inside a session makes it the lead, and the
user's `agent spawn --team <session>` makes that session one. Every agent
session is told so in one line of its Daedalus instructions. The lead plans the work,
adds members, and sends each one the decisions that affect it. Members are
ordinary sessions the user can open, answer and be reborn. The user is above
the lead and can add a member too.

In the app:

- A lead's card menu has **End team**, which asks to confirm. There is no
  switch to make a lead: the session becomes one when a member is added.
- A lead's card has a **+** that adds a member: a name, which becomes its
  `@handle`, Claude or Codex (the lead's provider is chosen at first), a
  model, and optional **Instructions**. The member runs in the lead's
  workspace (the CLI's `--workspace` picks another) and in its color. Without instructions
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
daedal agent spawn --team --name server --message "<instructions>"   # inside any session
daedal agent spawn --team "Checkout API" --message "<instructions>"  # the user
daedal agent spawn --team --workspace docs --message "<instructions>"  # a member elsewhere
daedal team say "@server the token field is access_token"
daedal team chat [--tagged | --all]
daedal team list
daedal team tree
daedal team goal "<text>"
daedal team pause|resume
```

The team is the lead's `orchestration` row in `session_abilities`, made when
its first member is added: its id is the team id, and its
`goal` config is the shared goal. A rebirth moves the ability to the successor,
so the team follows the lead with no other change. A member records its team
in `agent_sessions.team_id` and its handle in `team_handle`; a member's
rebirth successor takes both, and the predecessor leaves the team.

- **Members** start in the lead's workspace unless `--workspace` names
  another, on the lead's provider unless
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
- **Hand-back.** Members do not post "done". When a member's turn ends,
  Daedalus posts to its lead, as `daedalus`, tagging only the lead and with
  `kind = 'handback'` in `team_messages`: "@server finished:" and the turn's
  last assistant message (Claude's and Codex's `Stop` hook
  `last_assistant_message`, cut at 3000 characters), "@server failed: <the
  error>" (`StopFailure`), "@server was interrupted by the user." (an
  interrupt straight from `working`), or "@server is waiting on the user:
  <its question>" with a line saying the user answers it in the member's
  session. `ActivityService.onTurnEnd` calls `TeamService.handBack` on the
  transition into each of those; a pane reading is a guess and ends no turn.
  A permission prompt hands nothing back: only the user can answer it, on the
  member's card. A member that leads hands back to its own lead in the same
  way, so a piece of a nested tree reports up one level at a time.
- **Hand-back rate.** A lead gets hand-backs at most once a minute
  (`HANDBACK_INTERVAL_MS`), measured from `team_cursors.delivered_at`, its
  last delivery. A delivery holding only hand-backs inside that minute waits;
  anything else, such as a member's question, goes at once and takes the
  waiting hand-backs with it. The desktop app sends what waited on its tick
  (`TeamService.flushDue`); with the app closed it goes with the lead's next
  delivery or turn.
- **Notifications.** A member's finished turn does not notify the user,
  since its lead got it. Its failure and its wait on the user still do, and
  its card shows them. A lead's finished turn is a reply to the user: when
  the user is not looking at the lead, the notification's body is the start
  of its last message. A lead needing the user posts nothing to the team.
- **Status notes.** When a member stops or is archived, Daedalus posts
  "@lead @server stopped running." as `daedalus`, tagging only the lead. A
  member the lead itself stops or archives posts nothing: the note is
  skipped when the posting process runs as the lead (`DAEDALUS_SESSION_ID`).
- **Teams inside teams.** A member can lead a team of its own: it runs
  `agent spawn --team` itself, or the user names it with `--team <member>`.
  A session is a member of at most one team and leads at most one. A tree
  goes at most 3 levels below its top lead (`TEAM_MAX_DEPTH`) and a lead
  has at most 5 members that are not archived (`TEAM_MAX_MEMBERS`); past
  either, the spawn is refused and the refusal names the lead to add to, or
  says to archive a member. A session in two teams posts `@lead` to its own
  lead's team and any other tag to the team it leads; `team chat` reads both,
  and its notices name the team with `--team <lead>`. `team tree` prints the
  tree from its top lead, and `team list` marks a member that leads.
- **Pausing and ending a team.** `team pause` pauses a team and every team
  below it: messages to members wait, with the reason in `team list`, and no
  member can be added; the lead still hears from its members. `team resume`
  sends what waited. Archiving the lead, by hand or by quitting the app with
  "Quit and stop sessions", pauses its team the same way: members keep their
  handle and color, messages to the lead wait for it, and the app marks
  members "lead archived". Restoring the lead resumes the team and sends what
  waited. Archiving a lead by hand (`agent archive`, the card's Archive)
  archives every member below it too, and stopping a lead stops them; each
  member is restored on its own. Quitting the app archives sessions one by one
  and does not cascade. Only **End team** (`session revoke <lead>
orchestration`) ends a team: every member's team is cleared and they keep
  running as plain sessions, and members that lead keep their own teams.

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
delivery saved meanwhile. One delivery carries every waiting message that
tags the reader, in full, oldest first: a `[team "<name>"] <author>:` header,
the body under it with every line indented two spaces, so no body line can
pass for a header, and last a reply line, `Reply with: daedal team say
"@server ..."`, naming the sessions that wrote (for a hand-back, the member
it is about), with `--team <lead>` for a session in two teams. A delivered
message is marked read for `team chat --tagged`. Past 16,000 characters the
oldest are left out, counted in a first line that says to read them with
`team chat --tagged`, and stay unread. The cursor moves under a write lock
before the send, so two processes never send the same message, and moves
back if the send fails. A failure is kept in `last_error`, shown by
`team list`, and the send is tried again on the next post, on `team chat` and
`team list`, on the session's own `SessionStart` and `Stop` hooks, and when a
spawn, restore or revive has the session running. A resumed session sits
idle, so its hooks alone would not deliver. An archived member can be
tagged; the message waits until it is restored. `@all` reaches live sessions
only.

- **Claude** sessions launched with the inbox hook get the messages in their
  Daedalus inbox mailbox (`session-inbox.ts`), line breaks and all: the
  waiter prints the mailbox file whole. Only a line on the pipe is one line. The hook wakes an idle
  session at once, as "Stop hook feedback", and a busy one when its turn
  ends, with every notice that came in meanwhile, so a busy lead wakes once.
  The mailbox is append-only, so a team notice never disturbs a rebirth or
  other note waiting beside it. Claude's own socket, below, queued the line as a prompt, and a
  prompt arriving while the user typed was sent with their draft.
- **Claude** sessions started before the inbox hook, or whose inbox waiter is
  no longer running (a session idle for days can lose it), get the message on
  their inbox socket, so it is not left waiting. Daedalus finds
  the live `<claudeHome>/sessions/<pid>.json` whose `sessionId` is the
  session's, and writes one line to its `messagingSocketPath`:
  `{"type":"user","message":{"role":"user","content":...},"from":...,"session_id":...}`.
  Claude shows it as a message from another session, with `from` as the
  sender. The line format comes from Claude's debug log, not its public
  docs, so a Claude update can break it; the failure then shows in
  `team list`. Every agent session launches with `crossSessionInbound:
"accept"` in Daedalus's settings, because any session may lead or join a
  team while it runs, and a session in bypassPermissions mode would otherwise
  hold each message behind an approval dialog.
- **Codex** sessions get it through `codex queue --thread <thread> --message
<text>`, run with the session's account. A busy session runs it after its
  current turn, as a user turn; only the `[team ...]` prefix and the skill
  mark it as a teammate's.

Claude adds its own paragraph under every message from another session,
saying that it is not from the user. No setting or line field turns it off.

A member on a cloud host has no inbox on this Mac; its delivery is typed into
its prompt while it waits there, on one line, with `/` between the lines,
since a line break typed into a prompt could submit what came before it.

None of these paths types into the session's pane. Messages the user posts reach Claude members as peer messages too;
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
