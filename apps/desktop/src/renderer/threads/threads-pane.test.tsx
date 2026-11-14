import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { AgentSessionDto } from "@daedalus/protocol";
import type { DesktopClient } from "../client-types";
import { ThreadsPane, ThreadsToggle } from "./ThreadsPane";
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

const pane = (openThreadId?: string) =>
  renderToStaticMarkup(
    <ThreadsPane
      client={{} as DesktopClient}
      lead={session("lead", { name: "Main agent", teamId: null })}
      now={now}
      onOpenSession={() => {}}
      onOpenThread={() => {}}
      openThreadId={openThreadId}
      renderTerminal={(thread) => <div>terminal of {thread.id}</div>}
      rows={rows}
      run={async () => undefined}
      workspaceName={(id) => id ?? "here"}
    />,
  );

describe("Threads pane", () => {
  test("groups rows in order, each with its workspace, time and one line; Resolved folds", () => {
    const html = pane();
    expect(html.indexOf("Ready for review")).toBeLessThan(
      html.indexOf("Waiting on you"),
    );
    expect(html).toContain("Cart storage");
    expect(html).toContain("checkout · 4m ago");
    expect(html).toContain("Index on (user_id)?");
    expect(html).toContain("Resolved");
    // Folded: its heading, not its rows.
    expect(html).not.toContain("Fix checkout copy typo");
    expect(html).toContain("2 open");
  });

  test("an open thread shows what it asks, its terminal, a message box and Stop", () => {
    const html = pane("Cart storage");
    expect(html).toContain("← Threads");
    expect(html).toContain("It waits on you");
    expect(html).toContain("terminal of Cart storage");
    expect(html).toContain("Message this thread directly");
    expect(html).toContain(">Stop<");
    expect(html).toContain("Mark done");
  });

  test("the Threads button has a dot only while something waits on you", () => {
    const toggle = (waiting: number) =>
      renderToStaticMarkup(
        <ThreadsToggle onToggle={() => {}} open waiting={waiting} />,
      );
    expect(toggle(1)).toContain("threads-dot");
    expect(toggle(1)).toContain("1 waiting on you");
    expect(toggle(0)).not.toContain("threads-dot");
  });
});
