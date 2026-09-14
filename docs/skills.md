# Agent skills

Daedalus ships one provider-neutral skill instead of maintaining separate
Claude and Codex instructions. Its distributable source is
`skills/daedalus-control/` and follows the Agent Skills `SKILL.md` format.

## App integration

When **Create workspace agent guidance** is enabled in Settings, Daedalus keeps
one app-managed skill at:

```text
$DAEDALUS_HOME/skills/daedalus-control/
```

`DAEDALUS_HOME` defaults to `$HOME/.daedalus`. Each available workspace gets
two provider discovery links pointing to that canonical directory:

```text
<workspace>/.agents/skills/daedalus-control/SKILL.md
<workspace>/.claude/skills/daedalus-control/SKILL.md
```

Codex and Claude sessions launched by Daedalus start below the workspace root,
so they discover the relevant project-scoped link. Both agents support
symlinked skill folders. This keeps one installed copy while requiring no
changes to a user's global agent configuration.

The skill first uses `daedal` from `PATH`. For sessions launched another way,
it falls back to `${DAEDALUS_HOME:-$HOME/.daedalus}/bin/daedal`, which the app
creates whenever it starts.

Disabling the setting removes only workspace links that target the managed
Daedalus skill. It preserves the canonical package and any user-created file or
directory at the discovery location.

## Personal installation

To make the skill available when Codex or Claude is launched outside a
Daedalus workspace, copy or symlink the canonical `skills/daedalus-control/`
directory into the provider's personal skill directory:

| Provider    | Personal location                        |
| ----------- | ---------------------------------------- |
| Codex       | `$HOME/.agents/skills/daedalus-control/` |
| Claude Code | `$HOME/.claude/skills/daedalus-control/` |

Using symlinks keeps both providers on the same source revision. A packaged
release should copy the folder instead, because the application bundle is the
stable source and may move during updates.

Codex invokes the skill explicitly as `$daedalus-control`. Claude Code invokes
it as `/daedalus-control`. Both agents may also select it automatically when a
request matches its description.

## Distribution

Keep `skills/daedalus-control/` as the canonical authoring package. For local
development and project-scoped use, the direct skill folder is enough. For
installation by other users, bundle that same folder under `skills/` in the
provider's plugin package; provider-specific manifests should wrap the shared
skill rather than fork its instructions.

The optional `agents/openai.yaml` supplies Codex and ChatGPT desktop metadata.
Claude ignores that product-specific metadata and reads the shared `SKILL.md`
plus its references.
