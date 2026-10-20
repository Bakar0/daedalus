import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcResult } from "@daedalus/protocol";

const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** Subscribes `listener` to a push source and returns the unsubscribe. */
export type Subscribe = (listener: () => void) => () => void;

export interface RpcQueryHandlers<T> {
  /** Called with each answer that is kept, before `refresh` resolves. */
  onData?: (data: T) => void;
  /** Called with each failure, so repeated failures are each reported. */
  onError?: (message: string) => void;
}

export interface RpcQueryOptions<T> extends RpcQueryHandlers<T> {
  /** Ask again this often while mounted. */
  pollMs?: number;
  /** Ask again whenever this source fires, such as `client.subscribe`. */
  onDataChanged?: Subscribe;
  /** The query starts over when any of these change. */
  deps: readonly unknown[];
}

export interface RpcQueryResult<T> {
  data: T | undefined;
  /** The last failure's message; cleared by the next success. */
  error: string | undefined;
  /** Resolves once the newest answer has been applied. */
  refresh: () => Promise<void>;
}

/**
 * The query without React: runs `fetch` and applies every answer in order,
 * dropping any that arrives after `stop`. One fetch is in flight and at most
 * one more is queued; further refreshes join the queued one. A `refresh`
 * resolves once an answer at least as new as the call is applied, so pushes
 * that outpace the fetch still end in a fresh answer. A handler that throws
 * is ignored here. The hook is a thin
 * wrapper.
 */
export function createRpcQuery<T>(
  fetch: () => Promise<RpcResult<T>>,
  onResult: (result: { data: T } | { error: string }) => void,
) {
  let stopped = false;
  let running: Promise<void> | undefined;
  let queued: Promise<void> | undefined;
  const fetchOnce = async () => {
    if (stopped) return;
    let outcome: { data: T } | { error: string };
    try {
      const result = await fetch();
      outcome = result.ok
        ? { data: result.data }
        : { error: result.error.message };
    } catch (cause) {
      outcome = { error: errorText(cause) };
    }
    if (stopped) return;
    try {
      onResult(outcome);
    } catch {
      // A handler that throws must not stop later fetches from running.
    }
  };
  const start = () => {
    const run = fetchOnce().finally(() => {
      if (running === run) running = undefined;
    });
    running = run;
    return run;
  };
  return {
    refresh(): Promise<void> {
      if (!running) return start();
      const next = () => {
        queued = undefined;
        return start();
      };
      queued ??= running.then(next, next);
      return queued;
    },
    stop() {
      stopped = true;
    },
  };
}

/**
 * One read of the host, kept fresh. It loads on mount and whenever `deps`
 * change, polls every `pollMs` and reloads when `onDataChanged` fires. A
 * failed read keeps the last data and sets `error`. An answer that arrives
 * after unmount, or after `deps` changed, is dropped. `refresh` stays callable
 * after a mutation and does nothing once the component is gone.
 */
export function useRpcQuery<T>(
  fetch: () => Promise<RpcResult<T>>,
  { pollMs, onDataChanged, onData, onError, deps }: RpcQueryOptions<T>,
): RpcQueryResult<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const latest = useRef({ fetch, onDataChanged, onData, onError });
  latest.current = { fetch, onDataChanged, onData, onError };
  const queryRef = useRef<ReturnType<typeof createRpcQuery<T>> | undefined>(
    undefined,
  );
  const hasSubscription = onDataChanged !== undefined;

  useEffect(() => {
    const query = createRpcQuery(
      () => latest.current.fetch(),
      (outcome) => {
        if ("error" in outcome) {
          setError(outcome.error);
          latest.current.onError?.(outcome.error);
        } else {
          setData(outcome.data);
          setError(undefined);
          latest.current.onData?.(outcome.data);
        }
      },
    );
    queryRef.current = query;
    void query.refresh();
    const timer =
      pollMs === undefined
        ? undefined
        : window.setInterval(() => void query.refresh(), pollMs);
    const unsubscribe = hasSubscription
      ? latest.current.onDataChanged?.(() => void query.refresh())
      : undefined;
    return () => {
      query.stop();
      if (timer !== undefined) window.clearInterval(timer);
      unsubscribe?.();
    };
    // `deps` is the caller's list of what the fetch reads.
  }, [pollMs, hasSubscription, ...deps]);

  const refresh = useCallback(async () => {
    await queryRef.current?.refresh();
  }, []);
  return { data, error, refresh };
}

type Operation<T> = Promise<RpcResult<T>> | (() => Promise<RpcResult<T>>);

/** What a mutation reports: the keys in flight, and whether any run is. */
export interface PendingState {
  keys: ReadonlySet<string>;
  any: boolean;
}

/** `pending(key?)` over a reported state; no key asks about any run. */
export const isPending = (state: PendingState, key?: string) =>
  key === undefined ? state.any : state.keys.has(key);

export interface MutationOptions {
  /** Runs when a change starts, such as to clear the last error. */
  onStart?: () => void;
  /** Runs after every change, failed or not, while it still counts as pending. */
  onSettled?: (outcome: { ok: boolean }) => void | Promise<void>;
  /** A failed result or a thrown request, as a message. */
  onError?: (message: string) => void;
}

/**
 * The mutation runner without React. `onChange` fires whenever the set of
 * pending keys changes.
 */
export function createMutation(
  options: () => MutationOptions,
  onChange: (pending: PendingState) => void,
) {
  /** In-flight runs by key. Runs without a key count only in `total`. */
  const running = new Map<string, number>();
  let total = 0;
  const publish = () =>
    onChange({ keys: new Set(running.keys()), any: total > 0 });
  return {
    pending(key?: string) {
      return key === undefined ? total > 0 : running.has(key);
    },
    async run<T>(
      operation: Operation<T>,
      key?: string,
    ): Promise<T | undefined> {
      // Only a keyed request that has not been made yet can be skipped. A
      // promise is already on its way to the host, so it always runs through.
      if (
        key !== undefined &&
        typeof operation === "function" &&
        running.has(key)
      )
        return undefined;
      if (key !== undefined) running.set(key, (running.get(key) ?? 0) + 1);
      total += 1;
      publish();
      options().onStart?.();
      let data: T | undefined;
      let ok = false;
      try {
        const result = await (typeof operation === "function"
          ? operation()
          : operation);
        if (result.ok) {
          data = result.data;
          ok = true;
        } else options().onError?.(result.error.message);
      } catch (cause) {
        options().onError?.(errorText(cause));
      }
      try {
        await options().onSettled?.({ ok });
      } catch (cause) {
        // The change went through; only what followed it failed.
        options().onError?.(errorText(cause));
      } finally {
        if (key !== undefined) {
          const left = (running.get(key) ?? 1) - 1;
          if (left > 0) running.set(key, left);
          else running.delete(key);
        }
        total -= 1;
        publish();
      }
      return ok ? data : undefined;
    },
  };
}

export interface MutationResult {
  /**
   * Runs one change. `operation` is the request, or a function that makes it.
   * With a `key` and a function, a run is skipped while one under that key is
   * in flight and the function is never called. Resolves to the data, or
   * undefined after a failure, which `onError` has already seen.
   */
  run: <T>(operation: Operation<T>, key?: string) => Promise<T | undefined>;
  /** Whether the change under `key` runs, or with no key whether any does. */
  pending: (key?: string) => boolean;
}

/** Runs changes against the host and tracks which are in flight. */
export function useMutation(options: MutationOptions = {}): MutationResult {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [pendingState, setPendingState] = useState<PendingState>({
    keys: new Set(),
    any: false,
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const mutationRef = useRef<ReturnType<typeof createMutation> | undefined>(
    undefined,
  );
  mutationRef.current ??= createMutation(
    () => optionsRef.current,
    (keys) => {
      if (mounted.current) setPendingState(keys);
    },
  );
  const mutation = mutationRef.current;
  const run = useCallback(
    <T>(operation: Operation<T>, key?: string) => mutation.run(operation, key),
    [mutation],
  );
  const pending = useCallback(
    (key?: string) => isPending(pendingState, key),
    [pendingState],
  );
  return { run, pending };
}
