---
name: daedalus-compact-workspace
description: Shrink a Daedalus workspace's JOURNAL.md or a team lead's TEAM.md by moving what is no longer current into an archive file, keeping every word. Use when the user runs /daedalus-compact-workspace journal or /daedalus-compact-workspace team, or when the Daedalus session header says the journal or team file is large. Handles one file per run.
argument-hint: "journal | team"
---

# Compact a workspace file

Every session that reads `JOURNAL.md` or `TEAM.md` pays for all of it, on
every model call after. This skill keeps the current part in the file and
moves the rest, unchanged, to an archive file that sessions read only when
they need history.

`$ARGUMENTS` says which file: `journal` or `team`. If it is empty or
anything else, ask the user which one and stop. Never do both in one run.

Daedalus shows a bar in the session header when a file passes its limit:

| File         | Limit                 | Aim for under          |
| ------------ | --------------------- | ---------------------- |
| `JOURNAL.md` | {{journalLimitKb}} KB | {{journalTargetKb}} KB |
| `TEAM.md`    | {{teamLimitKb}} KB    | {{teamTargetKb}} KB    |

Aim for half the limit, so the bar does not come back after a few entries.
Measure with `wc -c` before and after; 1 KB is 1,000 bytes.

Rules for both:

- Move text, never rewrite or summarize it in the archive. Nothing is lost.
- Keep the file's own heading and any lines Daedalus generated.
- When unsure whether something is still current, keep it, unless that
  leaves the file over its limit.
- Write the archive first, then the shortened file, so an interruption
  leaves a duplicate rather than a gap.

## journal

The file is `JOURNAL.md` at the workspace root, the folder that holds
`BRIEF.md` (one level up from `worktrees/` if you are in a worktree).

1. Read it. Entries are `## <date> — <title>` sections, oldest first, after
   the intro and any `## Standing decisions` section.
2. Choose what moves: the oldest entries first, whatever their age, until
   what stays is under {{journalTargetKb}} KB. Always keep the newest entry.
3. Read the entries that move for decisions that still hold: a choice, a
   rule, a source of truth, a constraint someone must keep following. Skip
   what a later entry replaced.
4. Append the moving entries, unchanged and in order, to
   `journal/YYYY-MM.md` by the month of each entry's date. Create the folder
   and files as needed.
5. In `JOURNAL.md`, keep or create a `## Standing decisions` section right
   after the top heading and its intro. Add one line per decision from
   step 3: `- <date>: <decision> (journal/YYYY-MM.md)`. Drop lines there
   that a newer decision replaced. Keep each line to one sentence; the
   section must stay small, or it becomes the next thing to compact.
6. Remove the moved entries from `JOURNAL.md`, and make sure the intro says:
   `Older entries are in journal/, by month; grep there for history.`
7. If the file is still over {{journalTargetKb}} KB because the entries that
   stay are long, do not cut them. Name the longest ones and their sizes to
   the user: they hold detail that belongs in a file under `artifacts/`.
8. Tell the user in two lines: the size before and after, how many entries
   moved, and how many standing decisions the file now has.

## team

The file is `TEAM.md` in your working directory. Run this only as the team's
lead; a member says so and stops.

1. Read it and the last part of `daedal team chat --all`, so you know what is
   still open.
2. Keep in `TEAM.md`:
   - the goal, and the plan's open items;
   - each member that is still running: handle, session id, model, what it
     owns, its status;
   - contracts between members that are still in force, exactly as written;
   - decisions that still constrain work, one line each with date and who
     made it;
   - open questions and blockers, including what waits on the user.
3. Move to `TEAM-ARCHIVE.md`, under a `## Archived <today's date>` heading:
   finished work items, members that are gone, decisions and contracts a
   later one replaced, narrative of how something was solved, member
   reports, run and pull request logs.
4. Make sure `TEAM.md` says near the top:
   `History: TEAM-ARCHIVE.md in this folder; grep it when you need it.`
5. If what stays is still over {{teamTargetKb}} KB, say which parts are
   large. Long contracts or plans can move to a file beside `TEAM.md`,
   linked from it; ask the user before doing that.
6. Tell the user in two lines: the size before and after, and what moved.
   Do not post in the team chat; members read the file when they need it.
