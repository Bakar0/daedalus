import { describe, expect, test } from "vitest";
import {
  byteSize,
  moveLabel,
  pathLines,
  sessionLines,
  tooBigLines,
} from "./workspace-move";

describe("byteSize", () => {
  test("uses binary units with one decimal under ten", () => {
    expect(byteSize(0)).toBe("0 bytes");
    expect(byteSize(1_073_741_824)).toBe("1 GB");
    expect(byteSize(1_610_612_736)).toBe("1.5 GB");
    expect(byteSize(268_435_456)).toBe("256 MB");
    expect(byteSize(1_536)).toBe("1.5 KB");
    expect(byteSize(12_800)).toBe("13 KB");
  });
});

describe("lines from the pod", () => {
  test("are plain, cut short, and capped at twelve", () => {
    const lines = pathLines([
      "CLAUDE.md\u001b[31m",
      "x".repeat(300),
      ...Array.from({ length: 20 }, (_, index) => `file-${index}`),
    ]);
    expect(lines[0]).toBe("CLAUDE.md [31m");
    expect(lines[1]!.length).toBe(120);
    expect(lines[1]!.endsWith("…")).toBe(true);
    expect(lines).toHaveLength(12);
    expect(lines.at(-1)).toBe("and 11 more");
  });

  test("name what is over its cap with its size", () => {
    expect(
      tooBigLines([
        { what: "repos/app", bytes: 1_610_612_736, maxBytes: 1_073_741_824 },
      ]),
    ).toEqual(["repos/app: 1.5 GB, at most 1 GB"]);
  });

  test("name sessions by name only", () => {
    expect(sessionLines([{ id: "s1", name: "server\nwork" }])).toEqual([
      "server work",
    ]);
  });
});

describe("moveLabel", () => {
  test("says where the workspace is going", () => {
    expect(moveLabel({ workspaceId: "w", to: "cloud", phase: "copying" })).toBe(
      "Moving to the cloud…",
    );
    expect(moveLabel({ workspaceId: "w", to: "mac", phase: "moved" })).toBe(
      "Moved to this Mac",
    );
    expect(moveLabel({ workspaceId: "w", to: "mac", phase: "failed" })).toBe(
      "Move failed",
    );
  });
});
