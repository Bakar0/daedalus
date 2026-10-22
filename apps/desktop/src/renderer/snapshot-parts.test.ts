import { describe, expect, test } from "vitest";
import type { DesktopSnapshotDto } from "@daedalus/protocol";
import {
  changeReachesBeyondSnapshot,
  mergeSnapshotParts,
  PendingSnapshotParts,
} from "./snapshot-parts";

describe("PendingSnapshotParts", () => {
  test("starts with, and falls back to, the whole snapshot", () => {
    const pending = new PendingSnapshotParts();
    expect(pending.take()).toBe("full");
    // A refresh nobody announced reads everything.
    expect(pending.take()).toBe("full");
  });
  test("collects the parts named since the last request", () => {
    const pending = new PendingSnapshotParts();
    pending.take();
    pending.note({ parts: ["sessionActivity"] });
    pending.note({ parts: ["telemetry", "sessionActivity"] });
    expect(pending.take()).toEqual(["sessionActivity", "telemetry"]);
  });
  test("a change that names nothing, or a mutation, asks for everything", () => {
    const pending = new PendingSnapshotParts();
    pending.take();
    pending.note({ parts: ["sessionActivity"] });
    pending.note({});
    pending.note({ parts: ["telemetry"] });
    expect(pending.take()).toBe("full");
    pending.note({ parts: ["toasts"] });
    pending.full();
    expect(pending.take()).toBe("full");
  });
});

describe("changeReachesBeyondSnapshot", () => {
  test("activity and token counts stay inside the snapshot", () => {
    expect(
      changeReachesBeyondSnapshot({ parts: ["sessionActivity", "telemetry"] }),
    ).toBe(false);
  });
  test("anything else, or an unnamed change, may move more", () => {
    expect(changeReachesBeyondSnapshot({ parts: ["worktrees"] })).toBe(true);
    expect(changeReachesBeyondSnapshot({ parts: ["attention"] })).toBe(true);
    expect(changeReachesBeyondSnapshot({})).toBe(true);
    expect(changeReachesBeyondSnapshot()).toBe(true);
  });
});

test("mergeSnapshotParts replaces only the parts it was given", () => {
  const snapshot = {
    agents: [{ id: "a" }],
    sessionActivity: [],
    sessionTelemetry: [],
  } as unknown as DesktopSnapshotDto;
  const merged = mergeSnapshotParts(snapshot, {
    sessionActivity: [{ sessionId: "a" }] as never,
  });
  expect(merged.agents).toBe(snapshot.agents);
  expect(merged.sessionTelemetry).toBe(snapshot.sessionTelemetry);
  expect(merged.sessionActivity).toEqual([{ sessionId: "a" }]);
});
