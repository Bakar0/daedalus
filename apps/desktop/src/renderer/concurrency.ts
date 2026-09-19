/**
 * Runs `tasks` with at most `limit` of them in flight.
 *
 * Adding repositories is dominated by clone latency, so the work is fanned out
 * rather than awaited one at a time. The limit exists because the opposite
 * extreme — every selected repository cloning at once — competes for the same
 * network and disk and makes each one slower than it needs to be.
 *
 * Tasks are expected to record their own outcome; a rejection here would abort
 * the remaining work, so callers that want per-item errors catch inside.
 */
export async function runWithConcurrency(
  tasks: ReadonlyArray<() => Promise<void>>,
  limit: number,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.max(0, Math.min(limit, tasks.length)) },
      async () => {
        while (next < tasks.length) {
          const task = tasks[next++];
          if (task) await task();
        }
      },
    ),
  );
}
