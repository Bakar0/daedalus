import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { AgentSessionDto } from "@daedalus/protocol";
import type { DesktopClient } from "../client-types";
import { ThreadsPane } from "./ThreadsPane";
import type { ThreadRow } from "./thread-groups";

const now = Date.parse("2026-11-14T12:00:00Z");

const session = (id: string, changes: Partial<AgentSessionDto> = {}) =>
  ({
    id,
    name: id,
    workspaceId: "checkout",
    status: "running",
    teamId: "team",
    resolvedAt: null,
    ...changes,
  }) as AgentSessionDto;

const row = (
  id: string,
  group: ThreadRow["group"],
  detail: string,
): ThreadRow => ({
  session: session(id),
  group,
  title: id,
  workspaceName: "checkout",
  at: new Date(now - 4 * 60_000).toISOString(),
  detail,
  failed: false,
});

const rows = [
  row("Cart screen crash", "review", "PR #412 open · ready for your review"),
  row("Cart storage", "waiting", "Index on (user_id)?"),
  row("Fix checkout copy typo", "resolved", "PR #398 merged"),
];

const pane = (shown: readonly ThreadRow[] = rows) =>
  renderToStaticMarkup(
    <ThreadsPane
      lead={session("lead", { name: "Checkout lead", teamId: null })}
      now={now}
      onOpenThread={() => {}}
      rows={shown}
    />,
  );

describe("Threads pane", () => {
  test("groups rows in order, each with its workspace, time and one line; Resolved folds", () => {
    const html = pane();
    expect(html.indexOf("Waiting on you")).toBeLessThan(
      html.indexOf("Ready for review"),
    );
    expect(html).toContain("Cart storage");
    expect(html).toContain("checkout · 4m ago");
    expect(html).toContain("Index on (user_id)?");
    expect(html).toContain("Resolved");
    // Folded: its heading, not its rows.
    expect(html).not.toContain("Fix checkout copy typo");
    expect(html).toContain("2 open");
  });

  test("rows open their session; no thread opens in place, with no terminal of its own", () => {
    const html = pane();
    expect(html).toContain('title="Open Cart storage"');
    expect(html).not.toContain("← Threads");
    expect(html).not.toContain("terminal of");
    expect(html).not.toContain("Open in full");
    // A lead's list has no filter and no tracking.
    expect(html).not.toContain("Stop tracking");
    expect(html).not.toContain("Tracked");
  });
});
