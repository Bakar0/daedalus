/**
 * What the Threads pane, the sidebar and a plan's view share about threads:
 * the mark, snoozing, the open counts, and which plan tasks wait on one.
 */
import { useEffect, useState } from "react";
import type { AskDto, AskPlanDto } from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";

/** A pulse line: the Threads mark. */
export const THREADS_ICON_PATH = "M1.5 8h3l2-5 3 10 2-5h3";

/** How often the counts are read again while shown. */
const REFRESH_MS = 10_000;

/** Put off by the user until a time that has not come yet. */
export const isSnoozed = (
  ask: Pick<AskDto, "snoozedUntil">,
  now: number,
): boolean => ask.snoozedUntil !== null && Date.parse(ask.snoozedUntil) > now;

/** The snooze lengths a card offers, as the time each one ends. */
export function snoozeChoices(now: Date): { label: string; until: Date }[] {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return [
    { label: "5 min", until: new Date(now.getTime() + 5 * 60_000) },
    { label: "1 hour", until: new Date(now.getTime() + 60 * 60_000) },
    { label: "Tomorrow 9:00", until: tomorrow },
  ];
}

/** Open asks: all of them, by workspace, and by the session that asked. */
export interface OpenAskCounts {
  total: number;
  byWorkspace: ReadonlyMap<string, number>;
  bySession: ReadonlyMap<string, number>;
}

/**
 * The open questions a session's Threads pane shows: its own and, for a
 * lead, its members'. The pane's tab dot counts these and nothing else.
 */
export const paneAskCount = (
  counts: Pick<OpenAskCounts, "bySession">,
  sessionIds: readonly string[],
): number =>
  sessionIds.reduce((sum, id) => sum + (counts.bySession.get(id) ?? 0), 0);

const NO_ASKS: OpenAskCounts = {
  total: 0,
  byWorkspace: new Map(),
  bySession: new Map(),
};

/**
 * Open questions, counted for the sidebar's Threads and each session's
 * Threads tab. Polls while mounted.
 */
export function useOpenAskCounts(client: DesktopClient): OpenAskCounts {
  const [count, setCount] = useState(NO_ASKS);
  useEffect(() => {
    let live = true;
    const read = () =>
      void client.request.askList({}).then(
        (response) => {
          if (live && response.ok) {
            const now = Date.now();
            // A fork thread is the user's own; it waits on nobody.
            const open = response.data.filter(
              (ask) =>
                ask.state === "open" &&
                ask.kind === "question" &&
                !isSnoozed(ask, now),
            );
            const byWorkspace = new Map<string, number>();
            const bySession = new Map<string, number>();
            for (const ask of open) {
              byWorkspace.set(
                ask.workspaceId,
                (byWorkspace.get(ask.workspaceId) ?? 0) + 1,
              );
              bySession.set(
                ask.sessionId,
                (bySession.get(ask.sessionId) ?? 0) + 1,
              );
            }
            setCount({ total: open.length, byWorkspace, bySession });
          }
        },
        () => undefined,
      );
    read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") read();
    }, REFRESH_MS);
    window.addEventListener("focus", read);
    // An ask answered here, or asked or closed anywhere, announces a full
    // change: the count follows it at once instead of on the next poll.
    // Partial ones (activity, telemetry) never carry asks.
    const unsubscribe = client.subscribe((change) => {
      if (!change?.parts?.length) read();
    });
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", read);
      unsubscribe();
    };
  }, [client]);
  return count;
}

type TaskMark = "wait" | "held" | undefined;

/**
 * Marks each task: the one an open ask is pinned to waits on the user; the
 * todo tasks after it at its level, up to its parent's end, are held by it.
 */
export function markPlanTasks(
  tasks: AskPlanDto["tasks"],
  asks: readonly Pick<AskDto, "id" | "taskKey">[],
): { mark: TaskMark; ask?: number }[] {
  const out: { mark: TaskMark; ask?: number }[] = tasks.map(() => ({
    mark: undefined,
  }));
  tasks.forEach((task, index) => {
    const ask = asks.find((item) => item.taskKey && item.taskKey === task.id);
    if (!ask) return;
    out[index] = { mark: "wait", ask: ask.id };
    for (let next = index + 1; next < tasks.length; next += 1) {
      const later = tasks[next]!;
      if (later.depth < task.depth) break;
      if (later.depth > task.depth) continue;
      if (later.state === "todo" && !out[next]!.mark)
        out[next] = { mark: "held", ask: ask.id };
    }
  });
  return out;
}
