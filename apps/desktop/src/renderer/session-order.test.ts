import { describe, expect, test } from "bun:test";
import type { AgentSessionDto, TeamDto } from "@daedalus/protocol";
import {
  foldMemberRows,
  membersSummary,
  type MemberMark,
  sessionDisplayOrder,
  sessionDisplayRows,
  teamLookup,
} from "./session-order";

const session = (
  id: string,
  extra: Partial<AgentSessionDto> = {},
): AgentSessionDto =>
  ({
    id,
    pinnedAt: null,
    teamId: null,
    teamHandle: null,
    ...extra,
  }) as AgentSessionDto;

const team: TeamDto = { id: "t1", leadId: "lead", name: "Lead", goal: null };

describe("sessionDisplayOrder", () => {
  test("pinned first, in pin order, then the manual order", () => {
    const order = sessionDisplayOrder(
      [
        session("a"),
        session("b", { pinnedAt: "2026-10-10T02:00:00Z" }),
        session("c"),
        session("d", { pinnedAt: "2026-10-10T01:00:00Z" }),
      ],
      [],
    );
    expect(order.map((item) => item.id)).toEqual(["d", "b", "a", "c"]);
  });

  test("members sit right under their lead", () => {
    const order = sessionDisplayOrder(
      [
        session("member", { teamId: "t1", teamHandle: "builder" }),
        session("other"),
        session("lead"),
      ],
      [team],
    );
    expect(order.map((item) => item.id)).toEqual(["other", "lead", "member"]);
  });

  test("nested teams list each session once, a level deeper under each lead", () => {
    const teams: TeamDto[] = [
      { id: "tp", leadId: "program", name: "program", goal: null },
      { id: "ta", leadId: "trackA", name: "trackA", goal: null },
      { id: "tb", leadId: "trackB", name: "trackB", goal: null },
    ];
    // The manual order puts members before their leads, and the program
    // lead is pinned, as in the Fedramp workspace.
    const rows = sessionDisplayRows(
      [
        session("a1", { teamId: "ta", teamHandle: "a1" }),
        session("trackA", { teamId: "tp", teamHandle: "track-a" }),
        session("b1", { teamId: "tb", teamHandle: "b1" }),
        session("loose"),
        session("trackB", { teamId: "tp", teamHandle: "track-b" }),
        session("a2", { teamId: "ta", teamHandle: "a2" }),
        session("program", { pinnedAt: "2026-11-01T00:00:00Z" }),
      ],
      teams,
    );
    expect(rows.map((row) => `${row.session.id}:${row.depth}`)).toEqual([
      "program:0",
      "trackA:1",
      "a1:2",
      "a2:2",
      "trackB:1",
      "b1:2",
      "loose:0",
    ]);
  });

  test("a loop of leads is still listed, each session once", () => {
    const rows = sessionDisplayRows(
      [
        session("x", { teamId: "ty", teamHandle: "x" }),
        session("y", { teamId: "tx", teamHandle: "y" }),
      ],
      [
        { id: "tx", leadId: "x", name: "x", goal: null },
        { id: "ty", leadId: "y", name: "y", goal: null },
      ],
    );
    expect(rows.map((row) => `${row.session.id}:${row.depth}`)).toEqual([
      "x:0",
      "y:1",
    ]);
  });

  test("a member whose lead is elsewhere stays where it is", () => {
    const order = sessionDisplayOrder(
      [session("member", { teamId: "t1", teamHandle: "builder" })],
      [team],
    );
    expect(order.map((item) => item.id)).toEqual(["member"]);
  });
});

test("teamLookup names the lead and the member's handle", () => {
  const teamOf = teamLookup([team]);
  expect(teamOf(session("lead"))?.role).toBe("lead");
  expect(
    teamOf(session("m", { teamId: "t1", teamHandle: "builder" }))?.handle,
  ).toBe("builder");
  expect(teamOf(session("x"))).toBeUndefined();
});

describe("foldMemberRows", () => {
  const teams: TeamDto[] = [
    { id: "t1", leadId: "top", name: "Top", goal: null },
    { id: "t2", leadId: "sub", name: "Sub", goal: null },
  ];
  const sessions = [
    session("top"),
    session("sub", { teamId: "t1" }),
    session("a", { teamId: "t2" }),
    session("b", { teamId: "t2" }),
    session("solo"),
  ];
  const fold = (
    marks: Record<string, MemberMark> = {},
    open: string[] = [],
    shown?: string,
  ) =>
    foldMemberRows(sessionDisplayRows(sessions, teams), teams, {
      markOf: (one) => marks[one.id] ?? "quiet",
      open: new Set(open),
      shown,
    });
  const ids = (rows: ReturnType<typeof fold>) =>
    rows.map((row) => row.session.id);

  test("leads and solo sessions keep their rows, members fold away", () => {
    const rows = fold({ a: "working" });
    expect(ids(rows)).toEqual(["top", "sub", "solo"]);
    const sub = rows.find((row) => row.session.id === "sub")!;
    expect(sub.members.map((one) => [one.session.id, one.mark])).toEqual([
      ["a", "working"],
      ["b", "quiet"],
    ]);
    // A lead that is a member is a row, not a dot of the lead above it.
    expect(rows[0]!.members).toEqual([]);
  });

  test("a member that waits for the user, or is on screen, gets a row", () => {
    expect(ids(fold({ b: "waits" }))).toEqual(["top", "sub", "b", "solo"]);
    expect(ids(fold({}, [], "a"))).toEqual(["top", "sub", "a", "solo"]);
  });

  test("an open lead lists its members", () => {
    expect(ids(fold({}, ["sub"]))).toEqual(["top", "sub", "a", "b", "solo"]);
  });

  test("the summary leaves out the zeros", () => {
    const mark = (value: MemberMark) => ({ mark: value });
    expect(membersSummary([mark("quiet")])).toBe("1 member");
    expect(
      membersSummary([mark("working"), mark("working"), mark("waits")]),
    ).toBe("1 needs you · 2 working · 3 members");
  });
});

describe("a plan's workers", () => {
  const workers = new Set(["tip", "split"]);
  const list = [
    session("tip", { spawnedBy: "owner" }),
    session("other", { spawnedBy: "owner" }),
    session("owner"),
    session("split", { spawnedBy: "owner" }),
  ];

  test("sit under the agent that started them", () => {
    expect(
      sessionDisplayRows(list, [], workers).map((row) => [
        row.session.id,
        row.depth,
      ]),
    ).toEqual([
      // Started by the owner too, but for no task of a plan.
      ["other", 0],
      ["owner", 0],
      ["tip", 1],
      ["split", 1],
    ]);
  });

  test("stand on their own when that agent is not listed", () => {
    expect(
      sessionDisplayRows(
        list.filter((item) => item.id !== "owner"),
        [],
        workers,
      ).map((row) => row.depth),
    ).toEqual([0, 0, 0]);
  });

  test("fold into the agent that started them, and are counted as workers", () => {
    const rows = foldMemberRows(sessionDisplayRows(list, [], workers), [], {
      markOf: () => "quiet",
      open: new Set(),
      workers,
    });
    expect(rows.map((row) => row.session.id)).toEqual(["other", "owner"]);
    const { members } = rows[1]!;
    expect(members.map((member) => member.session.id)).toEqual([
      "tip",
      "split",
    ]);
    expect(membersSummary(members, "worker")).toBe("2 workers");
  });
});
