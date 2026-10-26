---
name: daedalus-instructions
description: Add, change or remove the user's standing instructions, kept for every workspace in {{instructions}}. Use when the user says how they want something done from now on ("always", "never", "I prefer", "remember that"), asks to forget or change such a rule, or asks what their instructions are.
argument-hint: "[the instruction]"
---

# Custom instructions

The user's standing instructions live in `{{instructions}}`, and every Daedalus
session reads them:

- `INDEX.md` is the index, and every session reads it at the start.
  - `## Always` holds the rules for every request, each written out in full
    as one bullet. Sessions follow them without opening anything else.
  - `## Topics` has one line per topic file:
    `- [git.md](git.md): branch names, commit messages, when to push`.
    The line is how a later agent decides to open the file, so name what
    the rules are about, not just the subject.
- Each topic file holds the rules for one subject, one rule per bullet,
  in the user's terms. Add the reason as a second sentence when the user gave one.

The instruction from the user, if they gave it with the command:

$ARGUMENTS

## Add or change an instruction

1. Read `INDEX.md`. A rule that applies to every request, whatever its
   subject ("always", "every piece of work", "before anything else"), goes
   under `## Always`: edit the bullet already there on the same point, or add
   one, and skip to step 4. Add the section above `## Topics` if it is
   missing. Otherwise pick the topic file the rule belongs in, open it, and
   look for a rule that already covers the subject.
2. Write the rule:
   - An existing rule on the same subject: edit that bullet so the file
     holds one current version.
   - A new subject that fits an existing topic: add a bullet.
   - No topic fits: create a file named for the topic in lowercase kebab
     case (`code-review.md`) with a `# <Topic>` heading and the bullet, then
     add its line to `INDEX.md`.
3. Update the file's line in `INDEX.md` when what the file covers has changed.
4. Tell the user in one line what you wrote and in which file.

Done when the rule is in exactly one place: a bullet under `## Always`, or a
topic file that `INDEX.md` lists with a line naming the rule's subject.

## Remove an instruction

Delete the bullet, under `## Always` or in its topic file. When a topic file has no rules left, delete the file and its
line in `INDEX.md`. Tell the user what you removed.

## Scope

These rules hold in every workspace. A rule for one repository goes in that
repository's `AGENTS.md` or `CLAUDE.md`, and a decision for one workspace goes
in its `BRIEF.md`; when the user's wording leaves the scope open, ask which
they mean before writing.

Workflows and their steps are not instructions; they live in their own folder
and the daedalus-workflows skill changes them. A rule about whether to use
them is an instruction and goes here like any other.

Write a rule as the action and the moment to take it, and name the skill or
command that does it. A later agent reads the rule cold:

- "Use workflows for everything" goes under `## Always` as "Before the first
  command of any request, even a check, start a workflow with the
  daedalus-workflows skill."
