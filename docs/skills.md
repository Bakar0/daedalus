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

Selecting the style is the last step, and it rides the `--settings` JSON
Daedalus already passes on each Claude launch, so it never edits the user's own
settings file. A user who set their own `outputStyle` keeps it.

Two consequences worth knowing. The style applies to sessions Daedalus launches;
a Claude session started in a plain terminal has the file available but has to
select it with `/output-style Unslop`. And Claude Code runs one output style at
a time, so `always` means giving up Concise, Explanatory, and Learning.

## Everything else on the machine

`daedal skill list` and the Skills panel also report skills Daedalus does not
own: ones the user wrote, plugin skills, and whatever else the providers can
see. Each row carries its origin, the providers that can see it, whether the
agent may select it on its own, and its path.

Turning one of those off uses the provider's own switch rather than moving the
user's files. Claude Code takes `skillOverrides` through the settings argument,
which makes it per session. Codex takes `[[skills.config]]` in `config.toml`,
which is global and applies only after Codex restarts. Cursor has no documented
switch, so there the only honest action is adding or removing a link.

## Commands

```text
daedal skill list [--provider claude|codex|cursor] [--managed] [--json]
daedal skill get <name>
daedal skill enable <name> [--mode on-demand|always]
daedal skill disable <name>
daedal skill visibility <name> <on|name-only|user-invocable-only|off>
daedal skill install <path> [--name <name>]
daedal skill install --git <url> --path <subdir> [--name <name>]
daedal skill remove <name> --force
daedal skill sync
daedal skill doctor
```

None of them takes `--workspace`. `sync` is idempotent and also runs when the
app starts.

## Authoring

`skills/daedalus-control/` and `skills/unslop/` are the canonical authoring
packages, in the Agent Skills `SKILL.md` format, with `styles/Unslop.md` beside
them. They are compiled into the binary as text, so a Daedalus upgrade ships new
skill text without the user reinstalling anything.

The optional `agents/openai.yaml` supplies Codex and ChatGPT desktop metadata.
Claude ignores that product-specific file and reads the shared `SKILL.md` plus
its references.
