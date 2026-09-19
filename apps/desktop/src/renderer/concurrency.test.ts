import { describe, expect, test } from "bun:test";
import { runWithConcurrency } from "./concurrency";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

describe("runWithConcurrency", () => {
  test("runs every task", async () => {
    const completed: number[] = [];
    await runWithConcurrency(
      Array.from({ length: 9 }, (_, index) => async () => {
        completed.push(index);
      }),
      4,
    );
    expect(completed.sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  test("never exceeds the limit, and keeps it saturated", async () => {
    const gates = Array.from({ length: 6 }, deferred);
    let inFlight = 0;
    let peak = 0;
    let started = 0;
    const run = runWithConcurrency(
      gates.map((gate) => async () => {
        started += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await gate.promise;
        inFlight -= 1;
      }),
      2,
    );
    // Only the first two may have begun while nothing has settled.
    await Promise.resolve();
    expect(started).toBe(2);
    for (const gate of gates) gate.resolve();
    await run;
    expect(peak).toBe(2);
    expect(started).toBe(6);
  });

  test("a slow task does not hold back the others", async () => {
    const slow = deferred();
    const order: string[] = [];
    const run = runWithConcurrency(
      [
        async () => {
          await slow.promise;
          order.push("slow");
        },
        async () => {
          order.push("fast-1");
        },
        async () => {
          order.push("fast-2");
        },
      ],
      3,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["fast-1", "fast-2"]);
    slow.resolve();
    await run;
    expect(order).toEqual(["fast-1", "fast-2", "slow"]);
  });

  test("an empty task list starts no workers", async () => {
    await expect(runWithConcurrency([], 4)).resolves.toBeUndefined();
  });
});
