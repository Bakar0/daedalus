import { describe, expect, test } from "bun:test";
import type { RpcResult } from "@daedalus/protocol";
import {
  createMutation,
  createRpcQuery,
  isPending,
  type PendingState,
} from "./use-rpc";

const ok = <T>(data: T): RpcResult<T> => ({ ok: true, data });
const failed = (message: string): RpcResult<never> =>
  ({ ok: false, error: { message } }) as RpcResult<never>;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

describe("createRpcQuery", () => {
  test("reports data, then an error, from the same fetch", async () => {
    const results: unknown[] = [];
    const answers = [ok(1), failed("down")];
    const query = createRpcQuery(
      async () => answers.shift()!,
      (outcome) => results.push(outcome),
    );
    await query.refresh();
    await query.refresh();
    expect(results).toEqual([{ data: 1 }, { error: "down" }]);
  });

  test("a thrown request becomes an error", async () => {
    const results: unknown[] = [];
    const query = createRpcQuery<number>(
      async () => {
        throw new Error("no host");
      },
      (outcome) => results.push(outcome),
    );
    await query.refresh();
    expect(results).toEqual([{ error: "no host" }]);
  });

  test("an answer that arrives after stop is dropped", async () => {
    const gate = deferred<RpcResult<number>>();
    const results: unknown[] = [];
    const query = createRpcQuery(
      () => gate.promise,
      (outcome) => results.push(outcome),
    );
    const pending = query.refresh();
    query.stop();
    gate.resolve(ok(1));
    await pending;
    expect(results).toEqual([]);
  });

  test("a snapshot fetched before an action never replaces the newer one fetched after it", async () => {
    // The window asks for a snapshot, the user acts, the window asks again.
    // The second fetch starts only after the first answered, so the answer
    // from before the action can never land after the one from after it.
    const gates = [
      deferred<RpcResult<string>>(),
      deferred<RpcResult<string>>(),
    ];
    let calls = 0;
    const applied: string[] = [];
    const query = createRpcQuery(
      () => gates[calls++]!.promise,
      (outcome) => {
        if ("data" in outcome) applied.push(outcome.data);
      },
    );
    const before = query.refresh();
    const after = query.refresh();
    expect(calls).toBe(1);
    gates[0]!.resolve(ok("before the action"));
    await before;
    gates[1]!.resolve(ok("after the action"));
    await after;
    expect(applied).toEqual(["before the action", "after the action"]);
    expect(applied.at(-1)).toBe("after the action");
  });

  test("refreshes faster than the fetch coalesce, and every answer is applied in order", async () => {
    const gates = [
      deferred<RpcResult<string>>(),
      deferred<RpcResult<string>>(),
    ];
    let calls = 0;
    const results: unknown[] = [];
    const query = createRpcQuery(
      () => gates[calls++]!.promise,
      (outcome) => results.push(outcome),
    );
    const first = query.refresh();
    const second = query.refresh();
    const third = query.refresh();
    const fourth = query.refresh();
    expect(calls).toBe(1);
    gates[0]!.resolve(ok("a"));
    await first;
    expect(results).toEqual([{ data: "a" }]);
    expect(calls).toBe(2);
    gates[1]!.resolve(ok("b"));
    await Promise.all([second, third, fourth]);
    expect(results).toEqual([{ data: "a" }, { data: "b" }]);
    expect(calls).toBe(2);
  });

  test("a refresh waits for an answer at least as new as the call", async () => {
    const gates = [
      deferred<RpcResult<string>>(),
      deferred<RpcResult<string>>(),
    ];
    let calls = 0;
    const query = createRpcQuery(
      () => gates[calls++]!.promise,
      () => undefined,
    );
    void query.refresh();
    const later = query.refresh();
    let done = false;
    void later.then(() => {
      done = true;
    });
    gates[0]!.resolve(ok("old"));
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    gates[1]!.resolve(ok("new"));
    await later;
    expect(done).toBe(true);
  });

  test("a throwing handler does not stop later fetches", async () => {
    let calls = 0;
    const query = createRpcQuery(
      async () => ok(++calls),
      () => {
        throw new Error("handler");
      },
    );
    await query.refresh();
    await query.refresh();
    expect(calls).toBe(2);
  });

  test("a refresh queued behind a failed fetch still runs", async () => {
    const gate = deferred<RpcResult<number>>();
    const results: unknown[] = [];
    let calls = 0;
    const query = createRpcQuery(
      () => (calls++ === 0 ? gate.promise : Promise.resolve(ok(2))),
      (outcome) => results.push(outcome),
    );
    const first = query.refresh();
    const second = query.refresh();
    gate.resolve(failed("down"));
    await Promise.all([first, second]);
    expect(results).toEqual([{ error: "down" }, { data: 2 }]);
  });

  test("a refresh after the fetch settled starts a new one", async () => {
    let calls = 0;
    const query = createRpcQuery(
      async () => ok(++calls),
      () => undefined,
    );
    await query.refresh();
    await query.refresh();
    expect(calls).toBe(2);
  });
});

describe("createMutation", () => {
  const harness = (
    options: {
      onStart?: () => void;
      onError?: (message: string) => void;
      onSettled?: (outcome: { ok: boolean }) => void | Promise<void>;
    } = {},
  ) => {
    const changes: string[][] = [];
    const states: PendingState[] = [];
    const mutation = createMutation(
      () => options,
      (state) => {
        states.push(state);
        changes.push([...state.keys]);
      },
    );
    return { mutation, changes, states };
  };

  test("returns the data and runs onSettled while still pending", async () => {
    const seen: boolean[] = [];
    let mutation!: ReturnType<typeof harness>["mutation"];
    ({ mutation } = harness({
      onSettled: ({ ok }) => {
        seen.push(ok, mutation.pending());
      },
    }));
    expect(await mutation.run(Promise.resolve(ok("done")))).toBe("done");
    expect(seen).toEqual([true, true]);
    expect(mutation.pending()).toBe(false);
  });

  test("a failed result reaches onError and resolves to undefined", async () => {
    const errors: string[] = [];
    const settled: boolean[] = [];
    const { mutation } = harness({
      onError: (message) => errors.push(message),
      onSettled: ({ ok }) => {
        settled.push(ok);
      },
    });
    expect(await mutation.run(Promise.resolve(failed("nope")))).toBeUndefined();
    expect(errors).toEqual(["nope"]);
    expect(settled).toEqual([false]);
  });

  test("a throwing request is reported like a failed result", async () => {
    const errors: string[] = [];
    const { mutation } = harness({ onError: (m) => errors.push(m) });
    const result = await mutation.run(() => Promise.reject(new Error("boom")));
    expect(result).toBeUndefined();
    expect(errors).toEqual(["boom"]);
    expect(mutation.pending()).toBe(false);
  });

  test("a failing onSettled is reported and keeps the data", async () => {
    const errors: string[] = [];
    const { mutation } = harness({
      onError: (message) => errors.push(message),
      onSettled: () => {
        throw new Error("reload failed");
      },
    });
    expect(await mutation.run(Promise.resolve(ok(7)))).toBe(7);
    expect(errors).toEqual(["reload failed"]);
    expect(mutation.pending()).toBe(false);
  });

  test("overlapping runs without a key all go through and all count", async () => {
    const first = deferred<RpcResult<string>>();
    const second = deferred<RpcResult<string>>();
    const { mutation } = harness();
    const one = mutation.run(first.promise);
    const two = mutation.run(second.promise);
    expect(mutation.pending()).toBe(true);
    first.resolve(ok("a"));
    expect(await one).toBe("a");
    expect(mutation.pending()).toBe(true);
    second.resolve(ok("b"));
    expect(await two).toBe("b");
    expect(mutation.pending()).toBe(false);
  });

  test("overlapping unkeyed functions all run and do not touch keyed state", async () => {
    const first = deferred<RpcResult<number>>();
    const second = deferred<RpcResult<number>>();
    const { mutation, changes } = harness();
    const one = mutation.run(() => first.promise);
    const two = mutation.run(() => second.promise);
    expect(mutation.pending()).toBe(true);
    expect(mutation.pending("")).toBe(false);
    first.resolve(ok(1));
    second.resolve(ok(2));
    expect([await one, await two]).toEqual([1, 2]);
    expect(mutation.pending()).toBe(false);
    expect(changes.every((keys) => keys.length === 0)).toBe(true);
  });

  test("the reported state shows busy during an unkeyed run", async () => {
    const gate = deferred<RpcResult<number>>();
    const { mutation, states } = harness();
    const run = mutation.run(() => gate.promise);
    const during = states.at(-1)!;
    expect(isPending(during)).toBe(true);
    expect(isPending(during, "a")).toBe(false);
    gate.resolve(ok(1));
    await run;
    expect(isPending(states.at(-1)!)).toBe(false);
  });

  test("a promise under a key is never skipped", async () => {
    const gate = deferred<RpcResult<number>>();
    const { mutation } = harness();
    const first = mutation.run(gate.promise, "a");
    const second = mutation.run(Promise.resolve(ok(2)), "a");
    expect(await second).toBe(2);
    expect(mutation.pending("a")).toBe(true);
    gate.resolve(ok(1));
    expect(await first).toBe(1);
    expect(mutation.pending("a")).toBe(false);
  });

  test("onStart runs before the request settles", async () => {
    const order: string[] = [];
    const { mutation } = harness({ onStart: () => order.push("start") });
    await mutation.run(() => {
      order.push("request");
      return Promise.resolve(ok(1));
    });
    expect(order).toEqual(["start", "request"]);
  });

  test("keys are tracked apart and a running key drops a duplicate", async () => {
    const gate = deferred<RpcResult<number>>();
    const { mutation, changes } = harness();
    const first = mutation.run(() => gate.promise, "a");
    expect(mutation.pending("a")).toBe(true);
    expect(mutation.pending("b")).toBe(false);
    expect(mutation.pending()).toBe(true);
    let started = false;
    const duplicate = await mutation.run(() => {
      started = true;
      return Promise.resolve(ok(2));
    }, "a");
    expect(duplicate).toBeUndefined();
    expect(started).toBe(false);
    gate.resolve(ok(1));
    expect(await first).toBe(1);
    expect(mutation.pending()).toBe(false);
    expect(changes).toEqual([["a"], []]);
  });
});
