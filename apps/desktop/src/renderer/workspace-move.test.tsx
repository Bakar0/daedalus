import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  byteSize,
  cloudLimitMessage,
  moveLabel,
  moveStepLabel,
  pathLines,
  sessionLines,
  tooBigLines,
  WorkspaceMoveState,
  WorkspaceNotice,
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

describe("WorkspaceMoveState", () => {
  const render = (props: Partial<Parameters<typeof WorkspaceMoveState>[0]>) =>
    renderToStaticMarkup(
      <WorkspaceMoveState
        name="app"
        onCancel={() => {}}
        onDismiss={() => {}}
        {...props}
      />,
    );

  test("marks the steps done and now, and offers Cancel only while waiting", () => {
    const copying = render({
      move: {
        workspaceId: "w",
        to: "cloud",
        phase: "copying",
        detail: "Copying repos/app",
      },
    });
    expect(copying).toContain('data-phase="copying"');
    expect(copying.match(/data-state="done"/g)).toHaveLength(2);
    expect(copying.match(/data-state="now"/g)).toHaveLength(1);
    expect(copying).toContain("Copying repos/app");
    expect(copying).not.toContain("workspace-move-cancel");
    const waiting = render({
      move: { workspaceId: "w", to: "mac", phase: "waiting" },
    });
    expect(waiting).toContain('data-testid="workspace-move-cancel"');
  });

  test("a failure says why, as plain text, and that nothing moved", () => {
    const failed = render({
      move: {
        workspaceId: "w",
        to: "cloud",
        phase: "failed",
        message: "<b>The pod</b> did not answer",
      },
    });
    expect(failed).toContain('data-phase="failed"');
    expect(failed).toContain("&lt;b&gt;The pod&lt;/b&gt; did not answer");
    expect(failed).toContain("stays where it was");
    expect(failed).not.toContain("workspace-move-steps");
    const early = render({ error: "The gateway refused the move" });
    expect(early).toContain('data-testid="workspace-move-dismiss"');
  });
});

describe("WorkspaceNotice", () => {
  test("cuts a long notice short", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceNotice
        onDismiss={() => {}}
        testId="workspace-notice"
        text={"x".repeat(900)}
      />,
    );
    expect(markup).toContain("…");
    expect(markup).not.toContain("x".repeat(401));
    expect(markup).toContain('data-testid="workspace-notice-dismiss"');
  });
});

describe("the move's picture", () => {
  test("flows toward where the workspace goes and names the step", () => {
    const home = renderToStaticMarkup(
      <WorkspaceMoveState
        move={{ workspaceId: "w", to: "mac", phase: "starting" }}
        name="app"
        onCancel={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(home).toContain('data-to="mac"');
    expect(home).not.toContain("data-settled");
    expect(home).toContain("Starting on this Mac");
    expect(
      moveStepLabel({ workspaceId: "w", to: "cloud", phase: "starting" }),
    ).toBe("Starting in the cloud");
    expect(
      moveStepLabel({ workspaceId: "w", to: "cloud", phase: "waiting" }),
    ).toBe("Waiting for sessions");
  });

  test("settles when the move ends well", () => {
    const moved = renderToStaticMarkup(
      <WorkspaceMoveState
        move={{ workspaceId: "w", to: "cloud", phase: "moved" }}
        name="app"
        onCancel={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(moved).toContain('data-settled="true"');
    expect(moved).toContain("In the cloud");
  });
});

describe("cloudLimitMessage", () => {
  test("names the workspaces in the cloud from this Mac's records", () => {
    expect(
      cloudLimitMessage("You may have at most 2 workspaces", ["app", "site"]),
    ).toBe(
      "2 workspaces are already in the cloud: app, site. Move one home first.",
    );
  });

  test("counts the ones this Mac does not know", () => {
    expect(
      cloudLimitMessage("You may have at most 5 workspaces", ["app"]),
    ).toBe(
      "5 workspaces are already in the cloud: app and 4 more from another Mac or an earlier install. Move one home first.",
    );
    expect(cloudLimitMessage("You may have at most 5 workspaces", [])).toBe(
      "5 workspaces are already in the cloud, all from another Mac or an earlier install. The gateway deletes them after 30 days asleep.",
    );
  });

  test("leaves other messages as they are", () => {
    expect(cloudLimitMessage("The pod did not answer.", ["app"])).toBe(
      "The pod did not answer.",
    );
  });
});
