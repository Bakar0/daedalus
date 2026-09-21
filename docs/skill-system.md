# Skill system

Research and strategy for two related asks:

1. Make the Cursor `unslop` writing rules apply to every agent response.
2. Give Daedalus a skill system that installs, enables, disables, and shows
   skills, covering native Claude, Codex, and Cursor skills as well as user
   skills, not only the Daedalus one.

This document records what the providers actually support as of September 2026
and recommends a build order. It is a plan, not shipped behavior. Nothing here
is implemented yet.

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

| Mechanism | Claude Code | Codex and Cursor | Applies to every response |
| --- | --- | --- | --- |
| Skill (`SKILL.md`) | `~/.claude/skills`, `.claude/skills`, plugin `skills/` | `~/.agents/skills`, `.agents/skills`, `~/.cursor/skills`, `.cursor/skills` | No. Loaded when the description matches, or on `/name` |
| Skill with `disable-model-invocation` | supported | supported, reported as ignored under `.agents/skills` | No. Strictly less often than a normal skill |
| Memory file | `CLAUDE.md`, added as a user message after the system prompt | `AGENTS.md`, read at session start | Yes, but it competes with project content and fades over a long session |
| Output style | `~/.claude/output-styles`, `.claude/output-styles`, `outputStyle` setting | no equivalent | Yes. Sent with every request, and Claude Code re-states it during the conversation |
| `--append-system-prompt` | CLI flag | no equivalent | Yes, for one launch |
| `UserPromptSubmit` hook | supported | supported | Yes, once per turn, at the cost of tokens on every turn |

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
workflow: generated instruction files carry workspace context and stop there. A
writing style baked into `AGENTS_TEMPLATE` would break that decision for every
workspace on the machine, including workspaces where the user does not want it.

The skill system in part 2 resolves the tension. Daedalus ships no writing
opinion of its own. It installs and toggles content the user chose, and unslop
is one such choice. The generated `AGENTS.md` stays as it is.

### The integration point that already exists

`claudeDaedalusSettingsArgs` in `packages/core/src/services/providers.ts`
already builds a `--settings` JSON for each Claude launch, and
`mergeClaudeSettings` merges it with whatever the user passed, resolving every
conflict in the user's favor. `outputStyle` is a settings field. Daedalus can
set it there per session without touching any global config, using the merge
rules that already work.

The same holds on the Codex side. `mergeCodexConfigToml` already writes a
marked block into `~/.codex/config.toml`, and Codex reads skill state from that
same file.

## Part 2: the skill system

### Principle

Reuse the rule the rest of the codebase follows: the filesystem is
authoritative for existence and SQLite is an index. A skill exists because a
`SKILL.md` sits in a directory a provider scans. Daedalus discovers skills by
scanning those directories. It never reports a skill from a database row alone,
for the same reason a workspace row is not proof of a workspace.

### Where skills live

Claude Code:

- `~/.claude/skills/<name>/SKILL.md`
- `<project>/.claude/skills/<name>/SKILL.md`, including nested directories
- `<plugin>/skills/<name>/SKILL.md`, invoked as `/plugin-name:skill-name`
- the managed settings directory, for enterprise policy
- any directory passed with `--add-dir`

Codex, checked in this order:

- `$CWD/.agents/skills` and parents up to `$REPO_ROOT/.agents/skills`
- `$HOME/.agents/skills`
- `/etc/codex/skills`
- skills bundled with Codex

Cursor:

- `.agents/skills/` and `.cursor/skills/` in the project
- `~/.agents/skills/` and `~/.cursor/skills/`

Daedalus today:

- `$DAEDALUS_HOME/skills/daedalus-control/`, the one canonical copy
- `<workspace>/.agents/skills/daedalus-control` and
  `<workspace>/.claude/skills/daedalus-control`, symlinks to that copy

### Frontmatter worth reading

`name` and `description` are the two fields every provider shares. Claude Code
accepts a longer list, and the fields that change what a skill does are
`disable-model-invocation`, `user-invocable`, `paths`, `allowed-tools`,
`disallowed-tools`, `model`, `effort`, and `context: fork`. A scanner should
read the whole block, show `name`, `description`, and invocation mode, and keep
the rest for a detail view.

### How each provider turns a skill off

Claude Code uses `skillOverrides` in a settings file:

```json
{
  "skillOverrides": {
    "deploy": "off",
    "legacy-context": "name-only",
    "review": "user-invocable-only"
  }
}
```

The four states are `on`, `name-only`, `user-invocable-only`, and `off`.
`disableBundledSkills: true` turns off the bundled set, and individual entries
in `skillOverrides` override that. Because Daedalus already passes `--settings`
per launch, a Claude toggle can be scoped to one session, which is better than
editing the user's global settings.

Codex uses `~/.codex/config.toml`:

```toml
[[skills.config]]
path = "/path/to/skill/SKILL.md"
enabled = false
```

Codex applies this after a restart, and the setting is global rather than per
session. A Daedalus toggle here changes state for every Codex session on the
machine, so the UI has to label it that way and the CLI has to say it in the
help text.

Cursor has no documented programmatic switch. The only reliable action is
linking or unlinking the skill directory under `.agents/skills` or
`.cursor/skills`. Treat this as a known gap rather than a hidden failure: report
Cursor state as link presence and say that is what it means.

### Domain model

```ts
type SkillScope =
  | "daedalus-managed"
  | "user-claude"
  | "user-codex"
  | "user-cursor"
  | "project-claude"
  | "project-codex"
  | "project-cursor"
  | "plugin-claude"
  | "bundled";

type SkillInvocation = "auto" | "user-only" | "model-only";
type SkillState = "on" | "name-only" | "user-invocable-only" | "off";

interface DiscoveredSkill {
  id: string;
  name: string;
  description: string;
  skillPath: string;
  scope: SkillScope;
  providers: Array<"claude" | "codex" | "cursor">;
  managedBy: "daedalus" | "user" | "plugin";
  invocation: SkillInvocation;
  state: SkillState;
  linkTarget?: string;
  problem?: "unreadable-frontmatter" | "name-mismatch" | "broken-link";
}
```

`problem` is there because the existing provider scrapers return `undefined` on
every failure path, which `BRIEF.md` already lists as a risk. A skill with a
`SKILL.md` Daedalus cannot parse should appear in the list marked unreadable,
not vanish from it.

### Installation

Generalize what `workspace-content.ts` already does for one skill.
`ensureDaedalusControlSkill` writes a fixed set of three files to a fixed path.
Replace it with an installer that takes a source and a name, writes the
canonical copy to `$DAEDALUS_HOME/skills/<name>/`, and records the install.

`ensureSkillLink` and `removeSkillLink` generalize without changes to their
logic. Keep their safety rule exactly as written: `removeSkillLink` removes a
path only when it is a symlink pointing at the managed target, so a user's own
file or directory at a discovery path is never touched.

Sources, in the order they are worth building:

1. A local directory containing `SKILL.md`.
2. A git repository and a subdirectory inside it, which covers
   `cursor/plugins` at `pstack/skills/unslop`.
3. A plugin or marketplace package, once the first two work.

### CLI surface

The existing shape is `daedal <noun> <verb>`, with human text on stdout, errors
on stderr, one JSON envelope under `--json`, and the fixed exit codes 0, 1, 2,
3, 4, 5.

```text
daedal skill list [--workspace <ws>] [--provider claude|codex|cursor]
                  [--scope <scope>] [--json]
daedal skill get <name> [--json]
daedal skill install <path> [--name <name>]
daedal skill install --git <url> --path <subdir> [--name <name>]
daedal skill remove <name> --force
daedal skill enable <name> [--provider <p>] [--workspace <ws>]
daedal skill disable <name> [--provider <p>] [--workspace <ws>]
daedal skill link <name> --workspace <ws>
daedal skill doctor
```

`remove` takes `--force` because it deletes files, matching task removal.
`doctor` reports broken links, unreadable frontmatter, name collisions across
scopes, and Codex entries waiting for a restart.

### Storage

One migration adds two tables. `skill_install` indexes what Daedalus installed:
id, name, source kind, source reference, canonical path, installed timestamp.
`skill_state` holds desired state keyed by skill id, provider, and scope.

Both are indexes. Discovery scans the filesystem every time and reconciles
against these tables the way session reconciliation works against tmux. An
installed skill whose directory is gone reports as missing rather than
disappearing.

### Layering

`packages/core/src/services/skills.ts` owns discovery, install, removal, and
state, and is the only place that decides anything. `@daedalus/platform` owns
the directory scan and the symlink calls, most of which exist already.
`@daedalus/protocol` gains a `SkillDto` and the RPC methods. `apps/cli` maps
arguments and exit codes. The renderer gets a Skills panel and calls RPC. No
logic moves into either adapter.

### What the user sees

A Skills panel in Settings lists every discovered skill grouped by scope, with
the provider it applies to, whether the model can select it on its own, its
current state, and its path on disk. Per session, show the skills that session
can actually see, because that is the question the user is asking when they open
the panel.

### Build order

1. Read-only discovery and `daedal skill list`. This alone answers the
   visibility half of the ask and cannot break a running session.
2. Generalize the managed installer, then `install`, `remove`, and `link`.
3. Enable and disable through each provider's own switch, Claude first, since
   the settings injection already exists and is per session.
4. The desktop Skills panel.
5. Git sources.

### Risks

Reports say Cursor ignores `disable-model-invocation` under `.agents/skills`, so
the invocation column states intent rather than a guarantee. Label it as read
from frontmatter.

A skill scanner reads three provider on-disk formats, which adds to the scraping
risk `BRIEF.md` already records for session recovery and telemetry. The `problem`
field keeps a parse failure visible instead of silent.

Codex applies `[[skills.config]]` only after a restart, and the change is
global. Both facts have to reach the user at the moment they toggle.

Cursor has no documented disable, so a Cursor toggle can only add or remove a
link.

Name collisions are allowed by the providers. Codex shows both entries rather
than merging them. Daedalus should show both as well and mark the collision.
