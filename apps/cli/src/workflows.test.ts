import { describe, expect, test } from "vitest";
import { gateWaitingText } from "./workflows";

describe("gate waiting text", () => {
  test("a session the user talks to asks in its conversation", () => {
    const text = gateWaitingText("decide", "result");
    expect(text).toContain("waits for the user to approve what came out");
    expect(text).toContain("Ask them in the conversation and stop.");
    expect(text).toContain("Daedalus has no approve button");
    expect(text).not.toContain("@lead");
  });

  test("a team member asks its lead, who approves for it", () => {
    const text = gateWaitingText("plan", "start", "member-1");
    expect(text).toContain("waits for the user to agree before it starts");
    expect(text).toContain("Tag @lead with what to approve and stop.");
    expect(text).toContain("daedal workflow approve --session member-1");
    expect(text).toContain("Daedalus has no approve button");
  });
});
