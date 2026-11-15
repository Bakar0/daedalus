import { describe, expect, test } from "vitest";
import type { WorkflowRun, WorkflowStepState } from "@daedalus/core";
import { gateWaitingText, runLines, stepOutcomeLines } from "./workflows";

const step = (name: string, state: WorkflowStepState) => ({
  name,
  description: "",
  gate: null,
  state,
  startedAt: null,
  endedAt: null,
  approvedAt: null,
  waitingSessionId: null,
  plan: null,
  note: null,
  dynamic: false,
});

const nested: WorkflowRun = {
  id: "run",
  workspaceId: "w",
  sessionId: "s",
  workflow: "feature",
  steps: [
    step("plan", "done"),
    step("release/review", "active"),
    step("release/audit/check", "pending"),
    step("release/ship", "pending"),
    step("feedback", "pending"),
  ],
  groups: [
    {
      id: "release",
      workflow: "release",
      loopTo: "release/review",
      until: "Green",
      iteration: 2,
      lastRound: null,
    },
    {
      id: "release/audit",
      workflow: "audit",
      loopTo: null,
      until: "",
      iteration: 1,
      lastRound: null,
    },
  ],
  dynamic: false,
  modified: false,
  loopTo: null,
  until: "",
  iteration: 1,
  history: [],
  endNote: null,
  startedAt: "2026-11-15T10:00:00.000Z",
  updatedAt: "2026-11-15T10:00:00.000Z",
  endedAt: null,
};

describe("a run with included workflows", () => {
  test("status lists every step by its full id under a heading per workflow", () => {
    expect(runLines(nested)).toEqual([
      "feature at step 'release/review' (2 of 5)",
      "  ✓ plan",
      "  @release [loops to release/review, iteration 2]",
      "    ▶ release/review  ←",
      "    @audit",
      "      · release/audit/check",
      "    · release/ship",
      "  · feedback",
    ]);
  });

  test("a step change counts every step, and a group going round says how to move on", () => {
    expect(
      stepOutcomeLines({ run: nested, looped: false, loopedGroup: null }),
    ).toEqual(["workflow feature: ▶ release/review (2/5)"]);
    expect(
      stepOutcomeLines({
        run: nested,
        looped: false,
        loopedGroup: nested.groups[0]!,
      })[1],
    ).toBe(
      "release goes round: back to 'release/review' for iteration 2, until: Green. To move on, start 'feedback'.",
    );
  });
});

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
