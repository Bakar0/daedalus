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
  home?: Pick<
    Parameters<typeof ThreadsPane>[0],
    "filter" | "onFilter" | "onTrack"
  >,
  shown: readonly ThreadRow[] = rows,
  options: { onOpenAsTab?: () => void } = {},
) =>
  renderToStaticMarkup(
    <ThreadsPane
      {...home}
      {...options}
      client={{} as DesktopClient}
      lead={session("lead", { name: "Main agent", teamId: null })}
      now={now}
      onOpenThread={() => {}}
      poll={false}
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

  test("Open as tab is offered in the side panel, as a text link, and not in the tab", () => {
    const panel = pane(undefined, rows, { onOpenAsTab: () => {} });
    expect(panel).toContain(
      'class="threads-link threads-open-tab" title="Open the threads as a tab you can move and split" type="button">Open as tab<',
    );
    expect(pane()).not.toContain("Open as tab");
  });

  test("at Home: Tracked / All and a Track link on each row", () => {
    const home = {
      filter: "all" as const,
      onFilter: () => {},
      onTrack: () => {},
    };
    const tracked = rows.map((each, index) => ({
      ...each,
      tracked: index === 0,
    }));
    const html = pane(home, tracked);
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

    const empty = pane({ ...home, filter: "tracked" }, []);
    expect(empty).toContain("The main agent is not tracking anything");
  });

  test("the Threads button has a dot only while something waits on you", () => {
    const toggle = (waiting: number) =>
      renderToStaticMarkup(
        <ThreadsToggle onOpen={() => {}} open waiting={waiting} />,
      );
    expect(toggle(1)).toContain("threads-dot");
    expect(toggle(1)).toContain("1 waiting on you");
    expect(toggle(0)).not.toContain("threads-dot");
  });
});
