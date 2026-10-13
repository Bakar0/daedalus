---
name: daedalus-flow
description: Build and keep a Daedalus flow map - break an idea or task into components that each deliver something, link them with typed relations, give each a flow of stages, and record what was decided. Use only in a session that holds the Daedalus flow ability, when the user asks to map, plan or break down work, when you start or finish a stage, or when the shape of the work changes.
---

# Keeping a flow map

This session holds the Daedalus flow ability. The maps you make are yours:
only you, and the user, change their shape. Other agents in the workspace
work on their stages, a rebirth hands the maps to your successor, and the
user watches them from your session's Map bar. Keep a map true while the
work happens. It is the shared picture of the job, not a log.

## Resolve the CLI once

Use `"{{daedal}}"` for every command below, exactly that path. It works out
which session and workspace you are from your working directory. Below,
`daedal` means that executable. Every command takes `--json`.

Start by looking at what exists:

```
daedal flow maps
daedal flow show [--map <n>] [--dropped]
```

`flow show` with no `--map` shows your own map. Only make a new map when
the work is a new idea or system; one map per idea.

## Components are deliverables

A map starts as one root component, the idea or task itself:

```
daedal flow new "Checkout" --deliverable "A customer pays for an order end to end" \
  --done-when "An order placed in staging is charged and confirmed"
```

Split it into the large parts, and those into smaller ones only where it
helps:

```
daedal flow add "API server" --in Checkout --deliverable "Orders and payments over REST"
daedal flow add "Orders API" --in "API server" --deliverable "POST /orders and GET /orders/:id" \
  --done-when "The contract tests pass against staging"
```

The rules:

- Every component produces something meaningful on its own: a working
  endpoint, a migration, a screen, a design document. "Write the types" or
  "add a test" are steps inside a stage, not components.
- If a component cannot be split into parts that each deliver something,
  it stays one component, however large. Never split to make the map look
  finer.
- State the deliverable in one line, and say how anyone can tell it was
  delivered (`--done-when`).
- A component sits in one parent. Something shared, such as a library two
  services use, lives in one place and the others relate to it.
- Name components with words. Names cannot contain `/` and siblings need
  different names, because paths address them: `"API server/Orders API"`.
  Numbers work everywhere too: `#7` or `7`.

## Relations

Link components that talk to or need each other, at any level and across
parents. Pick the type that says what crosses the line:

| Type           | Use when                                                                     |
| -------------- | ---------------------------------------------------------------------------- |
| `calls`        | It sends a request and waits for the answer (HTTP, RPC).                     |
| `publishes to` | It sends an event or message and does not wait (queue, topic, webhook).      |
| `reads from`   | It reads data the other side stores (database, cache, file).                 |
| `writes to`    | It writes data the other side stores.                                        |
| `depends on`   | It needs the other side's contract or code to build. No traffic at run time. |

```
daedal flow relate "Web client" "Orders API" --type calls --note "REST /orders"
daedal flow relate "Payments" "Orders DB" --type writes --note "payment rows"
```

The note is short: a protocol, a path, a table. A relation only describes
the system; it does not make one stage wait for another. When a stage
really cannot go on until another component's work lands, block it with
the reason (below).

## Flows

Each component gets the stages it needs, in order, from this fixed set:
research, plan, prototype, implement, validate, deploy. You cannot invent
stages.

```
daedal flow stages "Orders API" plan,implement,validate
daedal flow stages "Payment form" research,prototype,implement,validate
```

- A spike may be research only. A small change may be implement,validate.
  A release may be the whole set.
- Use prototype when a component has an open design question that is
  cheaper to try than to argue about: what a screen looks like, whether a
  state model holds up. The prototype's deliverable is the answer. Record it
  with `flow decide`, and keep the prototype code off the main branch.
- A container's flow depends on what it contains:
  - `rollup:implement` is worked out from the components inside: running
    while any of theirs runs, done when all are done or skipped. You never
    set it.
  - `after:validate=integration` is the container's own stage. It starts
    only when every component inside finished its validate (or its whole
    flow, when it has no validate), and you set it from then on. The text
    after `=` is the label the map shows.
  - A container can also have plain stages of its own, such as the root's
    research and plan.

  ```
  daedal flow stages Checkout research,plan,rollup:implement,after:validate=integration,after:deploy=release
  ```

Changing a flow keeps the state of stages that stay. A stage that already
started and is left out needs a choice: `--drop "<reason>"` keeps it faint
on the map with the reason, `--delete` removes it.

## Working a stage

```
daedal flow stage start "Orders API" implement
daedal flow stage finish "Orders API" implement
daedal flow stage block "Orders API" implement --reason "Waiting for the payments contract"
daedal flow stage skip "Orders API" plan --reason "The plan came from the parent"
```

- `start` claims the stage for this session. The map shows your name on it
  and a heartbeat while you work. If another running session holds the
  stage, the command is refused: leave it to them, or ask the user.
- Start a stage when you begin it and finish it when its deliverable is
  done, not in batches at the end. The map is only useful if it is current.
- An orchestration lead can start a member already on a stage:
  `daedal agent spawn --team --name orders --message "<instructions>" --flow-stage "Orders API:implement"`.
  The member gets the claim and needs no ability: any session in the
  workspace can start, finish, block and skip stages on your map. Only you
  and the user reset one or change the map's shape.
- A rebirth successor takes over the stages you hold.

## Changing the map

The map changes as you learn. Add, rename (`flow edit --name`), move
(`flow edit --in`), and remove freely. When you remove something, choose:

- `daedal flow drop <component|r<n>> --reason "<why>"` when it was a real
  option that was considered and decided against ("a separate fraud
  service: dropped, Stripe Radar already scores orders"). It stays on the
  map, faint, with the reason.
- `daedal flow delete <component|r<n>>` when it was noise: a typo, a
  duplicate, a split that was never a real option. It goes with no trace.
  A component that contains others needs `--with-contents`.

`flow restore` brings a dropped one back.

## Decisions

Record a decision on the component it belongs to, when it is worth
remembering: a choice between real options, a constraint someone set, what
a prototype showed. One or two sentences, with the reason.

```
daedal flow decide "Payment form" "Stripe Elements, not a custom card field: PCI scope stays with Stripe."
```

Not every edit is a decision. The map keeps its own history of changes
(`daedal flow history`).

## Tasks

When a component becomes work someone picks up on the board, link it:
`daedal flow link "Orders API" --task 42`. The box shows the task number and
the task's drawer names the map. Finishing a component's stages never moves
the task; its status is the user's.

## The user

The user edits the map by asking you, or runs `daedal flow` from a
terminal; their changes show as `user` in the history. Ask the user before
dropping or deleting something they added. Do not run commands that change
the map after Daedalus says the ability was removed; `flow show` still
works.
