import { useSyncExternalStore } from "react";

/**
 * Whether the signed-in account has Pro, for the badge in the top bar. The
 * app sets it when it learns the account; the relay is what enforces it.
 */
let pro = false;
const listeners = new Set<() => void>();

export function setPro(value: boolean): void {
  if (value === pro) return;
  pro = value;
  for (const listener of listeners) listener();
}

export function usePro(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pro,
  );
}
