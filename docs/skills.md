# Agent skills

Daedalus manages skills globally. One canonical copy per skill under
`DAEDALUS_HOME`, and a link in each provider's personal directory, so a skill
installed once applies to every session on the machine rather than only to the
ones Daedalus starts.

Design notes and the research behind the choices are in
[`skill-system.md`](skill-system.md).

## What Daedalus ships

| Capability         | Default | What it is                                                      |
| ------------------ | ------- | --------------------------------------------------------------- |
| `daedalus-control` | on      | Drives Daedalus through the `daedal` CLI                        |
| `unslop`           | off     | Writing rules that cut AI tells, from `cursor/plugins` `pstack` |

Both are listed in Settings and in `daedal skill list`, and both can be turned
off. Daedalus installs nothing the user did not ask for.

## Layout on disk

```text
$DAEDALUS_HOME/skills/<name>/      the one real copy
$DAEDALUS_HOME/styles/<Name>.md    the one real copy of an output style

~/.claude/skills/<name>            symlink to the copy
~/.agents/skills/<name>            symlink to the copy
~/.claude/output-styles/<Name>.md  symlink to the copy
~/.codex/AGENTS.md                 a fenced block, for providers with no style
```

A non-stable build suffixes every name it installs: a dev build writes
`~/.claude/skills/daedalus-control-dev` and `~/.claude/output-styles/
Unslop-dev.md`, pointing at `~/.daedalus-dev`. `DAEDALUS_HOME` carries the
channel but the provider directories do not, so without the suffix the stable
app and a dev build would relink the same path to their own home and the last
one launched would win. The frontmatter `name:` is rewritten to match, so
nothing reports a name that disagrees with its folder.

`DAEDALUS_HOME` defaults to `$HOME/.daedalus`. The provider directories follow
`CLAUDE_CONFIG_DIR` and `CODEX_HOME` where those exist; `DAEDALUS_AGENTS_HOME`
and `DAEDALUS_CURSOR_HOME` override the other two, which have no published
variable of their own.

Two skill links cover all three providers. Claude Code reads `~/.claude/skills`,
and Codex and Cursor both read `~/.agents/skills`. `~/.cursor/skills` is still
scanned when listing, because a user may have put something there by hand.

Daedalus only ever removes a symlink that points at its own copy, and only ever
cuts the block between its own markers. A real file or directory at a discovery
path is left alone, and the Skills panel says so on the row rather than failing
quietly.

## The three states of a writing style

`unslop` has one more state than a plain skill, because a style can sit ready
or apply to everything.

| State       | Installs                                    | Effect                                   |
| ----------- | ------------------------------------------- | ---------------------------------------- |
| `off`       | nothing                                     | the default                              |
| `on-demand` | the skill                                   | `/unslop` cleans text already written    |
| `always`    | the skill, the style, the `AGENTS.md` block | the agent writes this way from the start |

Installing a style only makes it available. A style applies when it is
selected, so `always` also sets `outputStyle` in `~/.claude/settings.json`,
which is what makes it every Claude session and not only the ones Daedalus
starts. The launch argument carries the same selection, so a Daedalus session
is covered either way.

Claude Code runs one output style at a time, and that is why the selection is
the one thing here Daedalus will refuse to do. If the user already has a style
of their own selected, Daedalus installs the file and leaves the slot alone,
because taking it would silently switch their style off. The panel then shows a
`selected` row marked as left alone and says the rules are not applying, rather
than reporting an install that is doing nothing. Daedalus sets the slot only
when it is empty or already holds its own choice, and gives it back the same
way when the capability is turned off.

The other consequence worth knowing: choosing `always` means giving up Concise,
Explanatory and Learning while it is on.

## Everything else on the machine

`daedal skill list` and the Skills panel also report skills Daedalus does not
own: ones the user wrote, plugin skills, and whatever else the providers can
see.

The panel groups them by the directory they were found in, and each group
collapses. A name found in two directories stays two rows, because that is two
files both providers will load. A row is one line carrying the name, its path
under the group, and a tag when the agent cannot select it on its own or when
Daedalus could not read it. Clicking a row opens the skill's own text, which is
fetched only then rather than shipped with the list. The filter is the same
fuzzy matcher the repository picker uses, so `clskl2` finds `claude-skill-2`,
and a search reopens whatever it matched.

Each group is one directory. The provider directories are named after the
provider; every plugin is its own group under the plugin's own name, because
one "Claude plugin" heading over several plugins says nothing about which
plugin a skill came from.

The switch on a row is on or off, and nothing else. Claude Code's
`skillOverrides` also accepts `name-only` and `user-invocable-only`, and
neither is the user's to set: the first is a token-budget trick, and the second
is the same decision as `disable-model-invocation` in the skill's own
frontmatter, which the author already made and which the row already reports.

Turning a skill off writes one line into `config.json` and touches nothing
else. The skill's own files are never moved, renamed or deleted; they belong to
the user. The setting is applied at launch, through each provider's own switch,
and each provider answers differently:

| Provider    | How it is applied                                                                           | What it reaches                              |
| ----------- | ------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Claude Code | `skillOverrides` in `~/.claude/settings.json`, and in the settings argument Daedalus passes | every Claude session, from its next one      |
| Codex       | `[[skills.config]]` in `~/.codex/config.toml`                                               | every Codex on the machine, once it restarts |
| Cursor      | nothing exists                                                                              | nothing                                      |

`~/.claude/settings.json` is the one file of the user's own that Daedalus
edits, and it is what makes a switch mean every Claude session rather than only
the ones Daedalus starts. The launch argument still carries the same overrides,
so a Daedalus session is covered even if that write cannot happen.

JSON has no comment to fence a block with, the way the Codex config does, so
the keys Daedalus owns there are the ones it wrote down having written. An
override the user set themselves is never removed, every other setting in the
file is carried across, the first write leaves a one-time
`settings.json.daedalus-backup`, and a file Daedalus cannot parse is left alone
for the user to repair.

Cursor publishes no way to turn a skill off, so for a skill that only Cursor
loads the panel disables the switch and says to move or rename the folder
instead. A switch that silently does nothing is worse than no switch.

The Codex entries are written whether or not that build supports hooks. The two
travel in the same fenced block, and deciding both from one version probe meant
that on an older Codex a skill switched off was switched off in name only.
Entries are written only for skills Codex actually scans, so a skill under
`~/.cursor/skills` never appears in `~/.codex/config.toml` naming a path Codex
would never load.

## Commands

```text
daedal skill list [--provider claude|codex|cursor] [--managed] [--json]
daedal skill get <name>
daedal skill enable <name> [--mode on-demand|always]
daedal skill disable <name>
daedal skill visibility <name> <on|off>
daedal skill install <path> [--name <name>]
daedal skill install --git <url> --path <subdir> [--name <name>]
daedal skill remove <name> --force
daedal skill sync
daedal skill doctor
```

None of them takes `--workspace`. `sync` is idempotent and also runs when the
app starts.

`install` is a CLI operation only. The Skills panel shows what is installed and
switches it on and off; it does not offer a box to type a path or a repository
URL into, because installing a skill is a thing you do once and a control you
then read past every time you open Settings. A skill installed from the CLI
appears in the panel like any other, with a Remove button.

## Authoring

`skills/daedalus-control/` and `skills/unslop/` are the canonical authoring
packages, in the Agent Skills `SKILL.md` format, with `styles/Unslop.md` beside
them. They are compiled into the binary as text, so a Daedalus upgrade ships new
skill text without the user reinstalling anything.

The optional `agents/openai.yaml` supplies Codex and ChatGPT desktop metadata.
Claude ignores that product-specific file and reads the shared `SKILL.md` plus
its references.
