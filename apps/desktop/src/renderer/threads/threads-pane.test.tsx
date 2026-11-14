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

const pane = (
  openThreadId?: string,
  home?: Pick<
    Parameters<typeof ThreadsPane>[0],
    "filter" | "onFilter" | "onTrack"
  >,
  shown: readonly ThreadRow[] = rows,
) =>
  renderToStaticMarkup(
    <ThreadsPane
      {...home}
      client={{} as DesktopClient}
      lead={session("lead", { name: "Main agent", teamId: null })}
      now={now}
      onOpenSession={() => {}}
      onOpenThread={() => {}}
      openThreadId={openThreadId}
      renderTerminal={(thread) => <div>terminal of {thread.id}</div>}
      rows={shown}
      run={async () => undefined}
      workspaceName={(id) => id ?? "here"}
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

  test("an open thread shows what it asks, its terminal and Stop, and no second message box", () => {
    const html = pane("Cart storage");
    expect(html).toContain("← Threads");
    expect(html).toContain("It waits on you");
    expect(html).toContain("terminal of Cart storage");
    expect(html).not.toContain("Message this thread directly");
    expect(html).toContain(">Stop<");
    expect(html).toContain("Mark done");
    // A lead's pane has no filter and no tracking.
    expect(html).not.toContain("Stop tracking");
    expect(pane()).not.toContain("Tracked");
  });

  test("at Home: Tracked / All, a Track link on each row, and Track in the open thread", () => {
    const home = {
      filter: "all" as const,
      onFilter: () => {},
      onTrack: () => {},
    };
    const tracked = rows.map((each, index) => ({
      ...each,
      tracked: index === 0,
    }));
    const html = pane(undefined, home, tracked);
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain(">Tracked<");
    expect(html).toContain(
      'aria-pressed="true" class="threads-filter-option" type="button">All<',
    );
    // The tracked row carries the eye in All, and each row its link.
    expect(html).toContain("Tracked by the main agent");
    expect(html).toContain(">Stop tracking<");
    expect(html).toContain(">Track<");
    // No filled buttons: every one is a text link.
    expect(html).not.toContain("threads-button");

    const open = pane("Cart storage", home, tracked);
    expect(open).toContain(">Track<");
    expect(open).toContain("Open in full");
    expect(open).toContain(">Stop<");
    expect(open).not.toContain("Mark done");

    const empty = pane(undefined, { ...home, filter: "tracked" }, []);
    expect(empty).toContain("The main agent is not tracking anything");
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
