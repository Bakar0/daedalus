import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { TeamDetailDto } from "@daedalus/protocol";
import { TeamView } from "./TeamPanel";

const now = Date.parse("2026-10-04T10:00:00Z");
const at = (seconds: number) => new Date(now + seconds * 1000).toISOString();

const detail: TeamDetailDto = {
  team: {
    id: "team-1",
    leadId: "lead-1",
    name: "Checkout API",
    goal: "Ship v2",
  },
  members: [
    {
      handle: "lead",
      role: "lead",
      sessionId: "lead-1",
      name: "Checkout API",
      status: "running",
      unread: 0,
      undelivered: 0,
      lastError: null,
    },
    {
      handle: "server",
      role: "member",
      sessionId: "server-1",
      name: "server",
      status: "running",
      unread: 2,
      undelivered: 1,
      lastError: "no inbox yet",
    },
  ],
  messages: [
    {
      id: 1,
      author: "user",
      body: "@server start with /orders",
      tags: ["server"],
      createdAt: at(-120),
    },
    {
      id: 2,
      author: "server",
      body: "one\ntwo\nthree\nfour\nfive",
      tags: ["lead"],
      createdAt: at(-60),
    },
  ],
};

const view = (overrides: Partial<Parameters<typeof TeamView>[0]> = {}) =>
  renderToStaticMarkup(
    <TeamView
      busy={false}
      detail={detail}
      error={undefined}
      now={now}
      onOpenSession={() => {}}
      onReadMore={() => {}}
      onPost={async () => []}
      onSetGoal={async () => {}}
      teamId="team-1"
      {...overrides}
    />,
  );

describe("the Team tab", () => {
  test("shows the goal, members with their state, and the chat", () => {
    const html = view();
    expect(html).toContain("Checkout API");
    expect(html).toContain("Lead and 1 member · 2 messages");
    expect(html).toContain("Ship v2");
    expect(html).toContain("A team is a lead session");
    expect(html).toContain("Read more and examples");
    expect(html).toContain('data-tone="failing"');
    expect(html).toContain("1 not delivered: no inbox yet");
    expect(html).toContain('title="2 unread"');
    // The user's own posts read as "you", with their tags as chips.
    expect(html).toContain("<strong>you</strong>");
    expect(html).toContain('<span class="team-tag">@server</span>');
  });

  test("folds a long message until asked", () => {
    const html = view();
    expect(html).toContain('data-folded="true"');
    expect(html).toContain("Show all");
  });

  test("says when it cannot read the team", () => {
    expect(view({ detail: undefined, error: "No team" })).toContain("No team");
    expect(view({ detail: undefined })).toContain("Loading team…");
  });
});
