# Custom instructions

Custom instructions are how you like things done, written once and followed
by every agent session in every workspace. Tell an agent "from now on, always
open a draft PR" and it saves the rule with the daedalus-instructions skill;
the next session follows it without being told.

Read and edit them in the Custom instructions tab (the side panel's "Custom
instructions" pane, "Open ↗"), or ask an agent to add, change or remove one.

## Where they live

`INDEX.md` in the `instructions` folder of the Daedalus home
(`~/.daedalus/instructions`) holds the rules for every request. Every session
reads it when it starts. Each rule under `## Always` is written out in full
as one bullet, so a session follows it without opening another file.

Rules about one subject, such as git or code review, are
[tools](workflows.md#a-tool-file): one file per subject in
`~/.daedalus/workflows/tools`. A session sees each tool's one-line
description with `daedal tool list` and opens a tool only when it fits the
task, so a long set of rules costs a session nothing until it needs them. A
workflow step can also suggest a tool to the agent that runs it. You read and
edit tools on the Workflows page.

Until this change these subject rules were topic files beside `INDEX.md`.
Daedalus turns each one into a tool the first time it runs, keeps the old
file in `instructions/moved-to-tools`, and rewrites any rule in `INDEX.md`
that named the file to name the tool.

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

## Tools

Rules about one subject, such as getting access or reading logs, are tools.
`daedal tool list` names each with what it covers; open the ones that apply
to the task with `daedal tool show <name>`.
```

### tools/git.md

```markdown
---
name: git
description: branch names, commit messages, when to push and open PRs
---

- Name branches `<type>/<short-description>`, such as `fix/login-timeout`.
- Write commit subjects in the imperative, under 60 characters.
- Commit and push only when I ask. Open pull requests as drafts.
- Never force-push a branch someone else has pushed to.
```

### tools/code-review.md

```markdown
---
name: code-review
description: what to check before calling a change done
---

- Run the full test suite and the type check before saying a change is done,
  and paste the summary line.
- Read the diff once more before committing; remove debug output and
  commented-out code.
- A change to a public API needs a line in the changelog.
```

### tools/writing.md

```markdown
---
name: writing
description: docs, READMEs and PR descriptions
---

- Use sentence case for headings.
- Lead with what changed and why; leave out how long it took.
- Link issues and pull requests by full URL.
```
