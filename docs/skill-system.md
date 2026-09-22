# Skill system

Research and strategy for two related asks:

1. Make the Cursor `unslop` writing rules apply to every agent response.
2. Give Daedalus a global skill system that installs, enables, disables, and
   shows skills, covering native Claude, Codex, and Cursor skills as well as
   user skills, not only the Daedalus one.

This document records what the providers actually support as of September 2026
and the reasoning behind the design. All six steps of the build order are
implemented. For how to use the result, see [`skills.md`](skills.md).

## Part 1: making unslop always apply

### What the upstream skill actually is

`cursor/plugins/pstack/skills/unslop/SKILL.md` carries this frontmatter:

```yaml
---
name: unslop
description: Cut AI tells from any writing. Must always apply.
disable-model-invocation: true
---
```

The description says "Must always apply" and the frontmatter says the opposite.
`disable-model-invocation: true` stops the agent from selecting the skill on its
own, so the skill loads only when the user types `/unslop`. In pstack the skill
runs two ways: the user invokes it by name, or the `poteto-mode` orchestrator
invokes it as one step of a larger flow. Neither is automatic.

The first conclusion is that copying this skill into a skills directory will not
produce the requested behavior. A skill is loaded on demand. The rules the user
wants are a writing style that should hold for every response, and a style is
not an on-demand workflow.

### What each provider offers for always-on instructions

| Mechanism                             | Claude Code                                                               | Codex and Cursor                                                           | Applies to every response                                                          |
| ------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Skill (`SKILL.md`)                    | `~/.claude/skills`, `.claude/skills`, plugin `skills/`                    | `~/.agents/skills`, `.agents/skills`, `~/.cursor/skills`, `.cursor/skills` | No. Loaded when the description matches, or on `/name`                             |
| Skill with `disable-model-invocation` | supported                                                                 | supported, reported as ignored under `.agents/skills`                      | No. Strictly less often than a normal skill                                        |
| Memory file                           | `CLAUDE.md`, added as a user message after the system prompt              | `AGENTS.md`, read at session start                                         | Yes, but it competes with project content and fades over a long session            |
| Output style                          | `~/.claude/output-styles`, `.claude/output-styles`, `outputStyle` setting | no equivalent                                                              | Yes. Sent with every request, and Claude Code re-states it during the conversation |
| `--append-system-prompt`              | CLI flag                                                                  | no equivalent                                                              | Yes, for one launch                                                                |
| `UserPromptSubmit` hook               | supported                                                                 | supported                                                                  | Yes, once per turn, at the cost of tokens on every turn                            |

### Recommendation

Install the unslop rules as a style where the provider has a style slot, and as
an always-read instruction file where it does not. Keep the skill as well, so a
cleanup pass over existing text stays available on demand.

For Claude Code, write a custom output style with
`keep-coding-instructions: true`:

```markdown
---
name: Unslop
description: Cut AI tells from every response
keep-coding-instructions: true
---
```

followed by the rule list. Claude Code sends the active style with every
request and reminds the model of it mid-conversation, which is the property
`CLAUDE.md` lacks. `keep-coding-instructions: true` keeps the built-in software
engineering instructions, so this changes voice only.

The cost is that Claude Code runs one style at a time. Selecting Unslop gives up
Concise, Explanatory, and Learning. Say so in the UI when Daedalus offers the
toggle.

For Codex, put the rules in `~/.codex/AGENTS.md`, which Codex reads at the start
of every session. For Cursor, use a user rule with `alwaysApply: true`. Neither
product has an output style, so an always-read instruction file is the closest
equivalent.

For all three, also install `unslop/SKILL.md` unchanged, keeping
`disable-model-invocation: true`. That gives `/unslop` for editing text that is
already written, which is a different job from writing cleanly the first time.

### Why not put the rules in the generated workspace files

`BRIEF.md` records the decision that Daedalus does not author the user's
workflow: generated instruction files carry workspace context and stop there.
Writing the rules into `AGENTS_TEMPLATE` would break that decision, because
every workspace on the machine would get them with no way to see them or turn
them off.

Shipping them as a Daedalus capability is different. The rules are listed, they
are labelled as coming from Daedalus, and the user turns them on and off. They
ship off by default. Daedalus offers the style, it does not impose it.

That distinction is the one thing this design asks `BRIEF.md` to record.

## Part 2: the skill system

### Scope: global

Everything here is global, not per workspace. One canonical store under
`$DAEDALUS_HOME`, one state file, and links into each provider's personal
directory. A skill is on or off for the whole machine.

Per-workspace scoping is deliberately left out of the first version. It doubles
the state, and every question it answers can wait.

### Two halves

The system does two separate jobs and it is worth keeping them apart.

**Capabilities that Daedalus ships.** Today that is `daedalus-control`. This
design adds `unslop`. Daedalus owns the files, installs them, and toggles them.
The user sees them and can turn any of them off.

**Everything else on the machine.** Skills the user wrote, skills from plugins,
skills bundled with a provider. Daedalus does not own these. It finds them,
lists them, and where the provider offers a switch, toggles them.

The first half is what makes unslop work. The second half is what answers "what
skills can my agents actually see right now".

### Principle

Same rule as the rest of the codebase: the filesystem is authoritative for
existence and the state file is an index. A skill exists because a `SKILL.md`
sits where a provider scans. Discovery is always a scan, never a row.

### Layout on disk

Canonical copies, owned by Daedalus:

```text
$DAEDALUS_HOME/skills/daedalus-control/SKILL.md
$DAEDALUS_HOME/skills/unslop/SKILL.md
$DAEDALUS_HOME/styles/Unslop.md
```

Installed into the provider's personal locations, as symlinks to the canonical
copy:

```text
~/.claude/skills/daedalus-control   -> $DAEDALUS_HOME/skills/daedalus-control
~/.agents/skills/daedalus-control   -> $DAEDALUS_HOME/skills/daedalus-control
~/.claude/skills/unslop             -> $DAEDALUS_HOME/skills/unslop
~/.agents/skills/unslop             -> $DAEDALUS_HOME/skills/unslop
~/.claude/output-styles/Unslop.md   -> $DAEDALUS_HOME/styles/Unslop.md
```

Plus one marked block, for the providers with no style slot:

```text
~/.codex/AGENTS.md   <!-- BEGIN daedalus:unslop --> ... <!-- END daedalus:unslop -->
```

### Artifact kinds

A capability installs one or more artifacts, and there are three kinds.

A `skill` artifact is a directory with a `SKILL.md`, linked into
`~/.claude/skills/` and `~/.agents/skills/`.

A `style` artifact is a single Markdown file linked into
`~/.claude/output-styles/`. Only Claude Code has this slot.

An `instructions` artifact is a block written between markers into an existing
file such as `~/.codex/AGENTS.md`. This is the fallback for providers with no
style slot.

### State

State is global and small, so it belongs in the existing config file rather
than in SQLite. `config.ts` already stores `workspaceInstructionFilesEnabled`
through `saveSetting`, and this follows it:

```jsonc
{
  "skills": {
    "daedalus-control": { "enabled": true },
    "unslop": { "enabled": false, "mode": "on-demand" },
  },
}
```

SQLite stays out of it until something needs history or per-workspace rows.

### Sync

One idempotent function, `syncManagedSkills(config)`, runs at app start and
after every toggle. It is the same shape as `syncWorkspaceInstructionFiles`.

For each enabled capability it writes the canonical copy and makes sure each
artifact is in place. For each disabled capability it removes what Daedalus
owns and nothing else.

The safety rules already in `workspace-content.ts` carry over unchanged and
they are the reason this is safe to run repeatedly. `removeSkillLink` deletes a
path only when it is a symlink pointing at the managed target. `removeIfGenerated`
deletes a file only when its content matches what Daedalus generated. A real
file the user put at `~/.claude/skills/unslop` is never touched, and the marked
block in `AGENTS.md` is removed by its markers, leaving the rest of the file
alone.

### How unslop rides on this

One capability, three states, because "on" means two different things for a
style that can either sit ready or apply to everything.

`off` installs nothing.

`on-demand` installs the skill only. You get `/unslop` for cleaning text that
is already written. Nothing changes about how the agent writes by default.

`always` installs the skill, the style, and the `AGENTS.md` block. Claude gets
the output style on every request, Codex and Cursor read the block at session
start.

Activating the style is the last step and it uses machinery that already
exists. `claudeDaedalusSettingsArgs` builds a `--settings` JSON for every Claude
launch and `mergeClaudeSettings` merges it with the user winning every conflict.
Adding `"outputStyle": "Unslop"` there turns the style on for sessions Daedalus
launches, without editing the user's own settings file. If the user has set
their own `outputStyle`, theirs wins and Daedalus leaves it alone.

The consequence to state in the UI: the style applies to sessions Daedalus
launches. A Claude session the user starts in a plain terminal still has the
style file available, but has to select it with `/output-style Unslop`.

The other consequence to state: Claude Code runs one output style at a time, so
`always` means giving up Concise, Explanatory, and Learning.

### What changes for daedalus-control

Today `daedalus-control` is linked per workspace, at
`<workspace>/.agents/skills/daedalus-control` and
`<workspace>/.claude/skills/daedalus-control`. Going global replaces that with
one link per provider under the user's home directory, and
`syncWorkspaceInstructionFiles` stops creating the per-workspace links.
`removeSkillLink` already cleans up the old ones safely, since they point at
the managed target.

This is a real behavior change, not just a move. Per-workspace links meant the
skill appeared only inside Daedalus workspaces. Global means it appears in
every Claude and Codex session on the machine, including ones started nowhere
near Daedalus. The skill is about the `daedal` CLI, which is useful anywhere,
and its description costs a little context in every session. The toggle is the
answer for anyone who does not want that, and the manual "personal
installation" step in `docs/skills.md` goes away because this is now what the
app does.

### Discovery, for everything Daedalus does not own

A scan of the personal and bundled locations for each provider.

Claude Code reads `~/.claude/skills/`, project `.claude/skills/` including
nested directories, plugin `skills/` directories, the managed settings
directory, and anything passed with `--add-dir`.

Codex reads `$CWD/.agents/skills` and parents up to the repository root, then
`$HOME/.agents/skills`, then `/etc/codex/skills`, then its bundled set.

Cursor reads `.agents/skills/` and `.cursor/skills/` in the project, and
`~/.agents/skills/` and `~/.cursor/skills/`.

The first version scans the personal locations, since the scope is global.
Project locations are read later, for the per-session view.

```ts
type SkillOrigin = "daedalus" | "user" | "plugin" | "bundled";
type SkillInvocation = "auto" | "user-only" | "model-only";
type SkillState = "on" | "name-only" | "user-invocable-only" | "off";

interface DiscoveredSkill {
  name: string;
  description: string;
  skillPath: string;
  providers: Array<"claude" | "codex" | "cursor">;
  origin: SkillOrigin;
  invocation: SkillInvocation;
  state: SkillState;
  linkTarget?: string;
  problem?: "unreadable-frontmatter" | "name-mismatch" | "broken-link";
}
```

`problem` exists because the provider scrapers already in the codebase return
`undefined` on every failure path, which `BRIEF.md` lists as a risk. A
`SKILL.md` that cannot be parsed appears in the list marked unreadable rather
than disappearing from it.

### Turning off a skill Daedalus does not own

Each provider has its own switch and the design uses it rather than moving the
user's files.

Claude Code has `skillOverrides` in settings, with the states `on`,
`name-only`, `user-invocable-only`, and `off`, plus `disableBundledSkills`.
Daedalus already injects a settings JSON per launch, so this works without
touching the user's own settings file.

Codex has `[[skills.config]]` with `path` and `enabled = false` in
`~/.codex/config.toml`, and `mergeCodexConfigToml` already writes a marked
block into that file. It applies after a restart and it is global, and both
facts have to reach the user at the moment they toggle.

Cursor has no documented programmatic switch. The only honest action is adding
or removing a link, and the UI should say that is what the toggle does.

### CLI surface

Global, so no `--workspace`.

```text
daedal skill list [--provider claude|codex|cursor] [--json]
daedal skill show <name> [--json]
daedal skill enable <name> [--mode on-demand|always]
daedal skill disable <name>
daedal skill install <path> [--name <name>]
daedal skill install --git <url> --path <subdir> [--name <name>]
daedal skill remove <name> --force
daedal skill doctor
```

`--mode` applies to a capability that has more than one on state, which today
is only `unslop`. `remove` takes `--force` because it deletes files, matching
task removal. `doctor` reports broken links, unreadable frontmatter, name
collisions, and Codex entries waiting for a restart.

### What the user sees

One Skills panel in Settings, global, with two groups.

"From Daedalus" lists `daedalus-control` and `unslop` with a toggle each, and
for `unslop` the three states. Each row says what turning it on writes and
where.

"Found on your machine" lists everything discovered, grouped by provider, with
the origin, whether the model can select it on its own, its state, and its path
on disk. Read-only in the first version.

### Layering

`packages/core/src/services/skills.ts` owns discovery, install, sync, and
state, and is the only place that decides anything. `@daedalus/platform` owns
the scan and the symlink calls, most of which exist. `@daedalus/protocol` gains
a `SkillDto` and RPC methods. `apps/cli` maps arguments and exit codes. The
renderer calls RPC. No logic in either adapter.

### Build order, and what landed

1. `ensureDaedalusControlSkill` became a capability installer and
   `daedalus-control` moved to global links.
2. `unslop` arrived as the second capability, with its three states and the
   `outputStyle` line in the settings injection.
3. Discovery and `daedal skill list`, covering everything on the machine.
4. The Skills panel in Settings, in its own renderer file.
5. Visibility for skills Daedalus does not own, through each provider's switch.
6. Installing from a directory or a shallow git clone.

All six are implemented. Two things that were planned here changed on contact
with the code. State lives in `config.json` rather than in SQLite, because it
turned out to be one small global map and a migration bought nothing. And the
collision check counts what each link resolves to rather than counting names:
every managed skill is linked into two provider directories, so counting names
reported a collision for each of them on a clean install.

### Risks

Moving `daedalus-control` to global puts it in every session on the machine.
That is the intended meaning of global, and it is still worth saying out loud
before it ships.

Reports say Cursor ignores `disable-model-invocation` under `.agents/skills`,
so the invocation column states what the frontmatter says, not a guarantee.

The scanner reads three provider on-disk formats, adding to the scraping risk
`BRIEF.md` already records. The `problem` field keeps a parse failure visible.

Codex applies `[[skills.config]]` only after a restart.

Name collisions are allowed. Codex shows both entries rather than merging them,
and Daedalus should show both and mark the collision.
