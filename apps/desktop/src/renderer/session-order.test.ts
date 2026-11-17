import { describe, expect, test } from "bun:test";
import type { AgentSessionDto, TeamDto } from "@daedalus/protocol";
import {
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
