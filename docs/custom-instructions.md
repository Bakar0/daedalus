# Custom instructions

Custom instructions are how you like things done, written once and followed
by every agent session in every workspace. Tell an agent "from now on, always
open a draft PR" and it saves the rule with the daedalus-instructions skill;
the next session follows it without being told.

Read and edit them in the Custom instructions tab (the side panel's "Custom
instructions" pane, "Open ↗"), or ask an agent to add, change or remove one.

## Where they live

Everything is markdown in the `instructions` folder of the Daedalus home
(`~/.daedalus/instructions`):

| File         | What it holds                                                   |
| ------------ | --------------------------------------------------------------- |
| `INDEX.md`   | rules for every request, and one line per topic file            |
| `<topic>.md` | the rules for one subject, such as `git.md` or `code-review.md` |

Every session reads `INDEX.md` when it starts:

- Rules under `## Always` hold for every request. Each is written out in full
  as one bullet, so a session follows it without opening another file.
- Each line under `## Topics` names a topic file and what its rules cover. A
  session opens a topic file only when its line fits the task, so a long set
  of rules costs a session nothing until it needs them.

A topic file starts with a `# Heading`, which names the file (`# Code review`
is `code-review.md`), and holds one rule per bullet. Adding, renaming or
deleting a topic in the Custom instructions tab keeps its line in `INDEX.md`
in step.

A rule for one repository belongs in that repository's `AGENTS.md` or
`CLAUDE.md`, and a decision for one workspace in its `BRIEF.md`. Custom
instructions are for what holds everywhere.

## Writing a rule

An agent reads a rule cold, at the moment it applies. Write the action and the
moment to take it, and name the command or skill that does it:

| Instead of           | Write                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------- |
| Be careful with git. | Never push to `main`; open a pull request from a branch.                                     |
| Keep me in the loop. | Before a change that touches more than three files, list the files and wait for my OK.       |
| Use workflows.       | Before the first command of any request, start a workflow with the daedalus-workflows skill. |

Add the reason as a second sentence when there is one. It helps an agent
apply the rule to a case you did not foresee.

## Examples

### INDEX.md

```markdown
# Custom instructions

How the user likes things done, in every workspace. Agents read this file at
the start of a session.

## Always

Rules for every request, written out in full. Follow them before the first
command of each request.

- Answer in plain sentences; no headings or tables for an answer under ten lines.
- Ask before deleting anything you did not create in this session.

## Topics

Each line names a topic file in this folder and what it covers. Open the
files that apply to the task.

- [git.md](git.md): branch names, commit messages, when to push and open PRs
- [code-review.md](code-review.md): what to check before calling a change done
- [writing.md](writing.md): docs, READMEs and PR descriptions
```

### git.md

```markdown
# Git

- Name branches `<type>/<short-description>`, such as `fix/login-timeout`.
- Write commit subjects in the imperative, under 60 characters.
- Commit and push only when I ask. Open pull requests as drafts.
- Never force-push a branch someone else has pushed to.
```

### code-review.md

```markdown
# Code review

- Run the full test suite and the type check before saying a change is done,
  and paste the summary line.
- Read the diff once more before committing; remove debug output and
  commented-out code.
- A change to a public API needs a line in the changelog.
```

### writing.md

```markdown
# Writing

- Use sentence case for headings.
- Lead with what changed and why; leave out how long it took.
- Link issues and pull requests by full URL.
```
