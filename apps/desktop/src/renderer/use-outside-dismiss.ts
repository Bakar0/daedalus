import { useEffect, useRef, type RefObject } from "react";

/**
 * Closes a drawer when the user presses outside it. A press on the button
 * that toggles it (`data-panel-toggle`) or inside one of the app's dialogs,
 * such as a confirm the drawer opened, does not count.
 */
export function useOutsideDismiss(
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
): void {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    const listener = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (ref.current?.contains(target)) return;
      if (target.closest("[data-panel-toggle], .modal-backdrop")) return;
      dismiss.current();
    };
    document.addEventListener("pointerdown", listener, true);
    return () => document.removeEventListener("pointerdown", listener, true);
  }, [ref]);
}
