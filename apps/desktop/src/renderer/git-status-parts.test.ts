import { describe, expect, test } from "vitest";
import { fetchOutcomeNote, gitStatusParts } from "./WorkspaceApp";

const texts = (parts: ReturnType<typeof gitStatusParts>) =>
  parts.map((part) => part.text);

describe("gitStatusParts", () => {
  test("shows only commits origin lacks as waiting to be pushed", () => {
    expect(
      texts(
        gitStatusParts({
          state: "ahead",
          changedFiles: 0,
          ahead: 3,
          behind: 0,
          unpushed: 1,
        }),
      ),
    ).toEqual(["↑1"]);
  });

  test("says pushed when every commit ahead is already on origin", () => {
    expect(
      texts(
        gitStatusParts({
          state: "ahead",
          changedFiles: 0,
          ahead: 2,
          behind: 0,
          unpushed: 0,
        }),
      ),
    ).toEqual(["pushed"]);
  });

  test("says merged, and nothing about distance, once the pull request landed", () => {
    // A squash merge leaves the commits unreachable from origin, which is
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
          },
          true,
        ),
      ),
    ).toEqual(["merged"]);
  });

  test("still shows uncommitted changes on a merged tree", () => {
    expect(
      texts(
        gitStatusParts(
          { state: "modified", changedFiles: 1, ahead: 1, behind: 0 },
          true,
        ),
      ),
    ).toEqual(["~1", "merged"]);
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
