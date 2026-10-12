---
name: daedalus-refinement
description: Refine a task with the user before its brief is written. Interview them in rounds about the idea, find the gaps, unknowns and fuzzy terms, settle each decision, then write the brief back to the task. Use when Daedalus starts a Refine session, when the user wants an idea stress-tested or refined, or says "grill me" or "refine this".
argument-hint: "[task number or what to refine]"
---

# Refinement

The user has an idea for a task. Your job is to find what is still unclear
about it, get each open decision settled by the user, and only then write the
brief. A brief written from guesses is worse than no brief, because the agent
that runs it will treat the guesses as decisions.

What to refine:

$ARGUMENTS

Use `"{{daedal}}"` for every daedal command below, exactly that path.

## 1. Read before you ask

Read the task (`"{{daedal}}" task get <number>`), the workspace's `BRIEF.md`,
recent `JOURNAL.md` entries, and the repositories under `repos/` that the task
touches. Facts are your job, never the user's. Do not ask the user anything you
could look up. When a question needs a fact you have not found yet, send a
sub-agent to find it and keep going with the questions that do not depend on
it.

## 2. Interview in rounds

Treat the idea as a tree of decisions: each decision opens the ones that hang
off it. The frontier is every decision whose prerequisites are already settled,
the questions you can ask now without guessing at answers you have not heard.

Each round, ask the whole frontier at once. Number each question and give your
recommended answer:

```
**Q1. <question title>**: <the question, with the choices when there are any>

Recommended: <your answer and a one-line reason>
```

A question whose answer depends on another question in the same round belongs
to a later round. After the user answers, recompute the frontier and ask the
next round.

Before you wait for answers, run `"{{daedal}}" attention "<N> questions about
task #<number>"` so the user sees that the session needs them. Run
`"{{daedal}}" attention --clear` once they reply.

While you ask, push on the idea the way a reviewer would:

- **Fuzzy words.** When the user uses a vague or overloaded term, propose one
  precise term and ask which they mean. "You said 'account'. Is that the Mac's
  sign-in or the Pro plan?"
- **Clashes with what exists.** When the user's term or claim conflicts with
  `BRIEF.md`, the journal or the code, say so with the file and line. "The code
  cancels the whole order, but you said partial cancellation works. Which is
  right?"
- **Concrete scenarios.** Invent edge cases that force a boundary: what happens
  with zero items, two sessions at once, a missing repository, a user who
  cancels halfway.
- **Scope.** Ask what is out of scope, and what "done" looks like in a way
  someone can check.

The user may answer "you decide" for a question. Then your recommendation is
the decision; record it as one.

## 3. Confirm, then write the brief

The interview is done when the frontier is empty: every branch visited and
nothing left silently assumed. Summarize the settled decisions in a few lines
and ask the user to confirm. Do not write the brief before they do.

Then write the brief back to the task, through standard input:

```sh
"{{daedal}}" task update <number> --description-file - <<'BRIEF'
...
BRIEF
```

Everything you learned goes into the brief and nowhere else. Do not create
glossary, ADR or other files. A brief has these parts, each only if it has
content:

- **Goal.** What the task changes and why, in two or three sentences.
- **Decisions.** Each settled decision as one line, with the reason when it is
  not obvious.
- **Terms.** Any word the interview had to pin down, defined in one sentence.
- **Scope.** What is in, and what is explicitly out.
- **Done when.** Checks a reviewer can run or see.
- **Open.** Anything the user chose to leave undecided, said as such.

Do not start the task itself, and do not change its status. After the brief is
written, say so in one line and stop.

<!-- Adapted from Matt Pocock's grilling and domain-modeling skills
(github.com/mattpocock/skills), MIT License, Copyright (c) 2026 Matt Pocock. -->
