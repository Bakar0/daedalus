import { describe, expect, test } from "bun:test";
import type { AgentSessionDto, TeamDto } from "@daedalus/protocol";
import { agentTree, flattenAgents } from "./agent-tree";

const session = (
  id: string,
  extra: Partial<AgentSessionDto> = {},
): AgentSessionDto =>
  ({
    id,
    pinnedAt: null,
    teamId: null,
    teamHandle: null,
    spawnedBy: null,
    ...extra,
  }) as AgentSessionDto;

const team: TeamDto = { id: "t1", leadId: "lead", name: "Lead", goal: null };

const ids = (tree: ReturnType<typeof agentTree>) =>
  tree.roots.map((root) =>
    flattenAgents(root).map((row) => `${row.depth}:${row.session.id}`),
  );

describe("agentTree", () => {
  test("an agent nobody created is a root", () => {
    const tree = agentTree([session("a"), session("b")], []);
    expect(ids(tree)).toEqual([["0:a"], ["0:b"]]);
  });

  test("a spawned agent sits under the one that spawned it", () => {
    const tree = agentTree(
      [
        session("main"),
        session("child", { spawnedBy: "main" }),
        session("grandchild", { spawnedBy: "child" }),
      ],
      [],
    );
    expect(ids(tree)).toEqual([["0:main", "1:child", "2:grandchild"]]);
    expect(tree.rootOf("grandchild")).toBe("main");
    expect(tree.rootOf("main")).toBe("main");
    expect(tree.rootOf("nobody")).toBeUndefined();
  });

  test("a team member sits under its lead, whoever spawned it", () => {
    const tree = agentTree(
      [
        session("other"),
        session("lead"),
        session("member", {
          teamId: "t1",
          teamHandle: "api",
          spawnedBy: "other",
        }),
      ],
      [team],
    );
    expect(ids(tree)).toEqual([["0:other"], ["0:lead", "1:member"]]);
  });

  test("a lead that is its own team's member falls back to who spawned it", () => {
    const tree = agentTree(
      [session("main"), session("lead", { teamId: "t1", spawnedBy: "main" })],
      [team],
    );
    expect(ids(tree)).toEqual([["0:main", "1:lead"]]);
  });

  test("a parent that is not listed leaves the agent a root", () => {
    const tree = agentTree([session("child", { spawnedBy: "gone" })], []);
    expect(ids(tree)).toEqual([["0:child"]]);
    expect(tree.pinned).toEqual([]);
  });

  test("pinned created agents are listed in pin order; pinned roots are not", () => {
    const tree = agentTree(
      [
        session("main", { pinnedAt: "2026-11-01T00:00:00Z" }),
        session("b", {
          spawnedBy: "main",
          pinnedAt: "2026-11-03T00:00:00Z",
        }),
        session("a", {
          spawnedBy: "main",
          pinnedAt: "2026-11-02T00:00:00Z",
        }),
        session("c", { spawnedBy: "main" }),
      ],
      [],
    );
    expect(tree.pinned.map((item) => item.id)).toEqual(["a", "b"]);
  });

  test("a loop of parents still lists every agent once", () => {
    const tree = agentTree(
      [session("a", { spawnedBy: "b" }), session("b", { spawnedBy: "a" })],
      [],
    );
    expect(ids(tree).flat().sort()).toEqual(["0:a", "1:b"]);
    expect(tree.rootOf("b")).toBe("a");
  });
});
