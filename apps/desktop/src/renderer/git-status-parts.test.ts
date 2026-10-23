import { describe, expect, test } from "vitest";
import {
  fetchOutcomeNote,
  gitStatusParts,
  pullRequestSummary,
} from "./WorkspaceApp";

const texts = (parts: ReturnType<typeof gitStatusParts>) =>
  parts.map((part) => part.text);

describe("gitStatusParts", () => {
  const status = {
    state: "ahead" as const,
    changedFiles: 0,
    ahead: 3,
    behind: 0,
  };
  test("shows nothing for a clean tree that is up to date", () => {
    expect(
      texts(
        gitStatusParts({
          ...status,
          ahead: 2,
          unpushed: 0,
          upstream: "tracking",
        }),
      ),
    ).toEqual([]);
  });

  test("counts what the branch's upstream lacks as waiting to be pushed", () => {
    expect(
      texts(gitStatusParts({ ...status, unpushed: 1, upstream: "tracking" })),
    ).toEqual(["↑1"]);
  });

  test("tells a branch that was never pushed, or lost its upstream, apart", () => {
    const never = gitStatusParts({ ...status, unpushed: 3, upstream: "none" });
    expect(texts(never)).toEqual(["⇡3 not pushed"]);
    expect(never[0]?.title).toContain("never pushed");
    const gone = gitStatusParts({ ...status, unpushed: 3, upstream: "gone" });
    expect(gone[0]?.title).toContain("deleted there");
  });

  test("shows uncommitted files and how far behind the base, in that order", () => {
    expect(
      texts(
        gitStatusParts({
          ...status,
          state: "modified",
          changedFiles: 2,
          behind: 14,
          unpushed: 2,
          upstream: "tracking",
        }),
      ),
    ).toEqual(["✎2", "↑2", "↓14"]);
  });

  test("counts the file list shown under the row when it is loaded", () => {
    expect(
      texts(gitStatusParts({ ...status, changedFiles: 5 }, false, 4)),
    ).toEqual(["✎4"]);
  });

  test("says nothing about commits or distance once the pull request holds the work", () => {
    // A squash merge leaves the commits on no remote branch, which is
    // exactly the tree that used to read "↑2" forever.
    expect(
      texts(
        gitStatusParts(
          {
            state: "diverged",
            changedFiles: 0,
            ahead: 2,
            behind: 5,
            unpushed: 2,
            upstream: "gone",
          },
          true,
        ),
      ),
    ).toEqual([]);
    expect(
      texts(
        gitStatusParts(
          { state: "modified", changedFiles: 1, ahead: 1, behind: 0 },
          true,
        ),
      ),
    ).toEqual(["✎1"]);
  });
});

describe("pullRequestSummary", () => {
  const pull = {
    number: 156,
    url: "https://github.com/o/r/pull/156",
    state: "OPEN" as const,
    isDraft: false,
    title: "Run on cloud",
  };
  test("names state, checks and review", () => {
    const summary = pullRequestSummary({
      ...pull,
      checks: "failing",
      review: "approved",
    });
    expect(summary.state).toBe("open");
    expect(summary.title).toContain("Pull request #156: Run on cloud");
    expect(summary.title).toContain("open · checks failing · approved");
  });
  test("calls an open draft a draft, and says when GitHub could not confirm", () => {
    const summary = pullRequestSummary({ ...pull, isDraft: true }, true);
    expect(summary.state).toBe("draft");
    expect(summary.title).toContain("Not confirmed");
  });
});

describe("fetchOutcomeNote", () => {
  const outcome = {
    repositoryId: "r",
    name: "product",
    from: "a".repeat(40),
    to: "b".repeat(40),
    newCommits: 0,
    commits: [],
    behind: 0,
  };

  test("names what a fetch brought in", () => {
    const note = fetchOutcomeNote({
      ...outcome,
      newCommits: 3,
      commits: [
        { hash: "1234567890", subject: "Fix the board" },
        { hash: "abcdef1234", subject: "Add fetch all" },
      ],
    });
    expect(note.text).toBe("+3 new");
    expect(note.title).toBe(
      "1234567 Fix the board\nabcdef1 Add fetch all\n…and 1 more",
    );
  });

  test("tells up to date, held back and failed apart", () => {
    expect(fetchOutcomeNote(outcome).text).toBe("up to date");
    expect(
      fetchOutcomeNote({ ...outcome, behind: 2, heldBack: "local-changes" }),
    ).toMatchObject({ tone: "held", text: "not moved" });
    expect(
      fetchOutcomeNote({ ...outcome, error: "Could not fetch" }),
    ).toMatchObject({ tone: "error", title: "Could not fetch" });
  });
});
