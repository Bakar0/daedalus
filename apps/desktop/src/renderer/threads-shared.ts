/**
 * What the Threads pane, the sidebar and a plan's view share about threads:
 * the mark, snoozing, the open counts, and which plan tasks wait on one.
 */
import { useEffect, useState } from "react";
import type { ThreadDto, ThreadPlanDto } from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";

/** A pulse line: the Threads mark. */
export const THREADS_ICON_PATH = "M1.5 8h3l2-5 3 10 2-5h3";

/** How often the counts are read again while shown. */
const REFRESH_MS = 10_000;

/** Put off by the user until a time that has not come yet. */
export const isSnoozed = (
  thread: Pick<ThreadDto, "snoozedUntil">,
  now: number,
): boolean =>
  thread.snoozedUntil !== null && Date.parse(thread.snoozedUntil) > now;

/**
 * Waiting on the user: open, not snoozed, and the owner wrote last or is
 * blocked on it. A thread the user opened on a fork waits on nobody.
 */
export const waitsOnUser = (
  thread: Pick<ThreadDto, "resolvedAt" | "snoozedUntil" | "turn" | "blocking">,
  now: number,
): boolean =>
  !thread.resolvedAt &&
  !isSnoozed(thread, now) &&
  (thread.turn === "user" || thread.blocking);

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

/** Threads waiting on the user: all, by workspace, and by owner. */
export interface ThreadCounts {
  total: number;
  byWorkspace: ReadonlyMap<string, number>;
  bySession: ReadonlyMap<string, number>;
}

/**
 * The session an `@handle` in a session's text names. A session can lead one
 * team and be a member of another (nested teams), and it talks to both: its
 * members by their handles, its peers by theirs and its own lead as
 * `@lead`. So the team it leads is searched first, then the one it is in.
 */
export function handleSession(
  ownerId: string,
  handle: string,
  teams: readonly { id: string; leadId: string }[],
  sessions: readonly {
    id: string;
    teamId?: string | null;
    teamHandle?: string | null;
  }[],
): string | undefined {
  const owner = sessions.find((one) => one.id === ownerId);
  const led = teams.find((team) => team.leadId === ownerId);
  const joined = owner?.teamId
    ? teams.find((team) => team.id === owner.teamId)
    : undefined;
  if (handle === "lead") return joined?.leadId;
  for (const team of [led, joined])
    if (team) {
      const member = sessions.find(
        (one) =>
          one.teamId === team.id &&
          one.id !== ownerId &&
          one.teamHandle?.toLowerCase() === handle,
      );
      if (member) return member.id;
    }
  return undefined;
}

/**
 * The threads waiting on the user that a session's Threads pane shows: its
 * own and, for a lead, its members'. The pane's tab dot counts these.
 */
export const paneThreadCount = (
  counts: Pick<ThreadCounts, "bySession">,
  sessionIds: readonly string[],
): number =>
  sessionIds.reduce((sum, id) => sum + (counts.bySession.get(id) ?? 0), 0);

const NO_THREADS: ThreadCounts = {
  total: 0,
  byWorkspace: new Map(),
  bySession: new Map(),
};

/**
 * Threads waiting on the user, counted for the sidebar's Threads and each
 * session's Threads tab. Polls while mounted.
 */
export function useThreadCounts(client: DesktopClient): ThreadCounts {
  const [count, setCount] = useState(NO_THREADS);
  useEffect(() => {
    let live = true;
    const read = () =>
      void client.request.threadList({}).then(
        (response) => {
          if (live && response.ok) {
            const now = Date.now();
            const open = response.data.filter((thread) =>
              waitsOnUser(thread, now),
            );
            const byWorkspace = new Map<string, number>();
            const bySession = new Map<string, number>();
            for (const thread of open) {
              byWorkspace.set(
                thread.workspaceId,
                (byWorkspace.get(thread.workspaceId) ?? 0) + 1,
              );
              bySession.set(
                thread.sessionId,
                (bySession.get(thread.sessionId) ?? 0) + 1,
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
    // A thread written in here, or anywhere, announces a full change: the
    // count follows it at once instead of on the next poll. Partial ones
    // (activity, telemetry) never carry threads.
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
 * Marks each task: the one an open thread is pinned to waits on the user;
 * the todo tasks after it at its level, up to its parent's end, are held by
 * it.
 */
export function markPlanTasks(
  tasks: ThreadPlanDto["tasks"],
  threads: readonly Pick<ThreadDto, "id" | "taskKey">[],
): { mark: TaskMark; thread?: number }[] {
  const out: { mark: TaskMark; thread?: number }[] = tasks.map(() => ({
    mark: undefined,
  }));
  tasks.forEach((task, index) => {
    const thread = threads.find(
      (item) => item.taskKey && item.taskKey === task.id,
    );
    if (!thread) return;
    out[index] = { mark: "wait", thread: thread.id };
    for (let next = index + 1; next < tasks.length; next += 1) {
      const later = tasks[next]!;
      if (later.depth < task.depth) break;
      if (later.depth > task.depth) continue;
      if (later.state === "todo" && !out[next]!.mark)
        out[next] = { mark: "held", thread: thread.id };
    }
  });
  return out;
}
