import { describe, expect, test } from "bun:test";
import type { AgentSessionDto, TeamDto } from "@daedalus/protocol";
import { sessionDisplayOrder, teamLookup } from "./session-order";

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
