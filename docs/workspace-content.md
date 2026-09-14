# Workspace content and repository worktrees

## Purpose

A Daedalus workspace is a work package. It holds the brief, journal, outputs,
and isolated working copies needed for a small or large body of work. It is not
the permanent owner of the repositories involved in that work: the same
canonical repository can participate in many workspaces at the same time.

The filesystem remains authoritative for workspace content. SQLite indexes
attached repositories and session worktrees so the desktop can present and
operate on them without giving the renderer direct filesystem access.

## Filesystem contract

Every workspace has this visible structure:

```text
<workspace>/
  BRIEF.md
  JOURNAL.md
  AGENTS.md       # optional Daedalus-managed bridge
  CLAUDE.md       # optional Daedalus-managed bridge
  artifacts/
  repos/
    <repository-name>/          # detached planning/reference checkout
  worktrees/
    <task-id>-<task-slug>/
      <session-id>/
        <repository-name>/
  .daedalus/
    workspace.json
```

`BRIEF.md` is concise, current, provider-neutral context: objective, scope,
decisions, active work, blockers, and next steps. `JOURNAL.md` is chronological
history. Journal entries use the kinds `decision`, `progress`, `blocker`,
`question`, `handoff`, and `completed`; these kinds can later drive developer
attention indicators. Daedalus-owned journal appends must be serialized and
must never use an unsafe read-modify-write sequence.

`.daedalus/` is reserved for identity and internal configuration. User-facing
context does not live there.

Existing registered workspaces are provisioned lazily and non-destructively:
missing standard files and directories are created, but existing content is
never replaced.

## Repository library and attachments

Daedalus keeps one global repository library under
`<DAEDALUS_HOME>/repos/<repository-id>.git`. These are bare clones: they share
Git objects and remote refs without pretending to be editable project
checkouts. The repository picker fuzzy-searches this indexed library and can
clone another remote into it.

Attaching a library repository is intentionally freshness-sensitive. Daedalus
must successfully fetch `origin`, resolve the remote-advertised default branch
through `origin/HEAD`, and capture its commit. It then creates a detached
planning checkout at:

```text
<workspace>/repos/<repository-name>
```

It never derives this checkout from the bare repository's local `HEAD`.
Failure to fetch or resolve the remote default branch fails the attachment
rather than silently using stale code. The attachment records the branch,
commit, and fetch timestamp so later session worktrees use the same reproducible
base.

Every attachment has one behavior: the workspace receives a read-only planning
checkout, and task sessions receive independent writable Git worktrees when
they need to implement changes. The repository picker does not ask users to
choose an access mode.

Daedalus does not clone a repository once per workspace. Workspace checkouts
repeat only working files and share the global clone's object database.

## Session worktrees

Every agent session starts in an isolated folder. Task-backed sessions use:

```text
worktrees/<task-id-prefix>-<task-slug>/<session-id>
```

Workspace-level sessions use `worktrees/unassigned/<session-id>`. No repository
worktrees are created during spawn. The bootstrap instructions list every
attached read-only checkout, and the bundled CLI lets the agent materialize only
the repository it needs:

```sh
daedal repo worktree create --session "$DAEDALUS_SESSION_ID" --repository <name>
```

The command prints the writable path and is idempotent. The task ID and session
ID are immutable, while the task slug is a creation-time hint; renaming a task
never moves an existing session folder. A requested repository is created below
the session folder and uses a unique branch derived from the workspace, task,
and session. Consequently:

- different tasks can modify the same repository concurrently;
- multiple sessions or models can attempt the same task independently;
- one session can change several repositories as one logical attempt.

Every session worktree branches from the attachment's captured `base_commit`,
not from a mutable local branch or the global clone's `HEAD`. Thus parallel
models attached at the same workspace revision start from identical code even
if the remote advances afterward.

Sessions without a task have the same lazy behavior and create no worktree until
the user or agent identifies a repository that needs modification. Integrated
terminal sessions continue to open at their explicitly selected path and do not
participate in agent worktree creation.

Archiving or restoring a session or workspace never removes worktrees. Cleanup
is a separate future operation and must refuse to remove dirty or otherwise
unsafe work unless the user explicitly resolves it.

## Agent context

By default, Daedalus creates a provider-neutral `AGENTS.md` in the workspace
root. It tells agents to read `BRIEF.md`, recent `JOURNAL.md` entries, and
`.daedalus/workspace.json`; respect repository access roles; follow each
repository's own instructions before modifying it; and journal meaningful
decisions, blockers, questions, and handoffs. A generated root `CLAUDE.md`
imports that file with `@AGENTS.md`.

Daedalus also installs one `daedalus-control` skill under
`$DAEDALUS_HOME/skills/` and links it into each workspace at
`.agents/skills/daedalus-control` for Codex and
`.claude/skills/daedalus-control` for Claude. The skill teaches agents to
inspect and operate Board, Workspace, repository, worktree, and session state
through the bundled `daedal` CLI. The distributable source package lives at
`skills/daedalus-control/` in this repository.

This guidance can be disabled globally in Settings. Disabling it removes only
exact, untouched instruction files and workspace links targeting the managed
skill. User-authored files and directories are preserved. When enabled,
Daedalus also leaves pre-existing user files alone and does not create or modify
provider files inside attached repositories.

New agent sessions additionally receive a concise provider-neutral bootstrap
identifying `BRIEF.md`, `JOURNAL.md`, their isolated session folder, existing
writable worktrees, reference paths, and the exact CLI command for creating a
needed worktree. This remains active when root instruction files are disabled.
Native resume reuses the recorded working directory and worktrees.

## Initial desktop experience

Workspace is a third main mode beside Board and Sessions. Its primary surface
is a VS Code-like two-pane editor: a lazily expanded filesystem explorer on
the left and a CodeMirror 6 text editor on the right. It shows:

- the physical contents of the selected workspace through on-demand directory
  reads;
- editable text files, with explicit save and `Cmd/Ctrl+S` support;
- source/preview switching for Markdown files including `BRIEF.md` and
  `JOURNAL.md`;
- new-file and new-folder controls in the explorer header;
- attached repositories with their access roles, base branch, and commit;
- task/session worktree groupings already materialized on disk.

The editor rejects traversal, internal `.daedalus` paths, symbolic links,
binary content, and files larger than 1 MB. Saves are atomic and use the
previously read content as an optimistic concurrency check so an agent's
external edit cannot be silently overwritten. Repository attachments and
working trees are secondary collapsed explorer sections.

The Repositories explorer section exposes an add button. Its modal is a
multi-select fuzzy-search over the global library. A separate remote URL input
clones a missing repository into the library and selects it; one final action
attaches every selected repository. Repository updating, worktree comparison,
cleanup, and attention rollups remain separate follow-up capabilities.
