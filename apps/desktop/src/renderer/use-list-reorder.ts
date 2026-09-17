import { useCallback, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  dropIndexFor,
  exceedsDragThreshold,
  keyboardMoveTarget,
  moveItem,
  orderChanged,
} from "./list-reorder";

interface ReorderableList {
  /** Current order, as rendered. */
  readonly ids: readonly string[];
  /**
   * Called once, on drop, with the new order — only when it actually changed.
   * Returning the write's promise is what lets the preview survive until the
   * server's order arrives; see `commit`.
   */
  readonly onCommit: (ids: string[]) => void | Promise<unknown>;
  /** Disables dragging — while a mutation is in flight, or in a rail. */
  readonly disabled?: boolean;
}

export interface ReorderHandles {
  /** The order to render right now: the live preview while dragging. */
  readonly order: readonly string[];
  readonly draggingId: string | undefined;
  /** Registers a card's element so the drag can measure it. */
  readonly registerCard: (id: string) => (node: HTMLElement | null) => void;
  readonly onPointerDown: (
    id: string,
  ) => (event: ReactPointerEvent<HTMLElement>) => void;
  /** ⌥↑/⌥↓ handler for a focused card. Returns true when it handled the key. */
  readonly moveByKeyboard: (id: string, direction: "up" | "down") => boolean;
}

/**
 * Pointer-driven reordering for a list of cards.
 *
 * The whole card is the drag target, not just the grip: these cards are
 * already buttons the user clicks constantly, and a 16px strip would be the
 * harder thing to hit. The grip drawn on each card is the signifier for this
 * gesture rather than its only entry point — see `.list-drag-grip` in the
 * stylesheet.
 */
export function useListReorder({
  ids,
  onCommit,
  disabled,
}: ReorderableList): ReorderHandles {
  const [preview, setPreview] = useState<string[] | undefined>();
  const [draggingId, setDraggingId] = useState<string>();
  const cards = useRef(new Map<string, HTMLElement>());
  const gesture = useRef<
    | {
        id: string;
        start: { x: number; y: number };
        dragging: boolean;
        /** The order this gesture began from, for deciding if anything moved. */
        from: string[];
        /** The live order, rewritten as the pointer moves. */
        order: string[];
      }
    | undefined
  >(undefined);
  /**
   * Eats the click that a drag also produces, so a drop never selects.
   *
   * Done by intercepting the one click at the window in the capture phase
   * rather than by leaving a flag for the card's own handler to consume: while
   * a drag is in progress the list has `pointer-events: none`, so a click may
   * never reach a card at all — and a flag nobody consumed would go on to
   * swallow the user's next real click instead.
   */
  const swallowNextClick = useCallback(() => {
    const swallow = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    // If no click follows — the pointer was released outside anything
    // clickable — the listener must not lie in wait for the next one.
    setTimeout(
      () => window.removeEventListener("click", swallow, { capture: true }),
      0,
    );
  }, []);

  /**
   * What is on screen, which is not always what the server last said. A drag
   * that starts while a previous one is still being written must build on the
   * order the user can see — starting from `ids` would silently undo it.
   */
  const rendered = preview ?? ids;

  const registerCard = useCallback(
    (id: string) => (node: HTMLElement | null) => {
      if (node) cards.current.set(id, node);
      else cards.current.delete(id);
    },
    [],
  );

  /**
   * Sends the new order and keeps showing it until the snapshot catches up.
   *
   * Clearing the preview on drop instead would put the pre-drag order back on
   * screen for the length of one round trip, so the card visibly springs home
   * and then re-lands — which reads as the app undoing the drag and redoing
   * it. Holding the preview means the card simply stays where it was put.
   */
  const commit = useCallback(
    (order: string[]) => {
      setPreview(order);
      Promise.resolve(onCommit(order)).finally(() =>
        // Identity, not equality: if another drag started while this write was
        // in flight, that newer preview is the one on screen and must stand.
        setPreview((current) => (current === order ? undefined : current)),
      );
    },
    [onCommit],
  );

  const finish = useCallback(() => {
    const active = gesture.current;
    gesture.current = undefined;
    setDraggingId(undefined);
    if (!active?.dragging) {
      setPreview(undefined);
      return;
    }
    swallowNextClick();
    if (!orderChanged(active.from, active.order)) {
      // Dragged, but back to where it started. Restore whatever was on screen
      // before rather than clearing to `ids`, which may still be catching up.
      setPreview((current) =>
        current === undefined ? undefined : [...active.from],
      );
      return;
    }
    commit([...active.order]);
  }, [commit, swallowNextClick]);

  const onPointerDown = useCallback(
    (id: string) => (event: ReactPointerEvent<HTMLElement>) => {
      // Secondary buttons open menus and must not start a drag; neither may a
      // press that began on one of the card's own action buttons.
      if (disabled || event.button !== 0) return;
      if (
        event.target instanceof Element &&
        event.target.closest("[data-no-drag]")
      )
        return;
      gesture.current = {
        dragging: false,
        from: [...rendered],
        id,
        order: [...rendered],
        start: { x: event.clientX, y: event.clientY },
      };

      const element = event.currentTarget;
      const handleMove = (move: PointerEvent) => {
        const active = gesture.current;
        if (!active) return;
        if (
          !active.dragging &&
          !exceedsDragThreshold(active.start, {
            x: move.clientX,
            y: move.clientY,
          })
        )
          return;
        if (!active.dragging) {
          active.dragging = true;
          element.setPointerCapture?.(move.pointerId);
          setDraggingId(active.id);
        }
        const from = active.order.indexOf(active.id);
        // Measured every move rather than cached at drag start: each reorder
        // reflows the column, so a cached rect describes a layout that no
        // longer exists.
        const midpoints = active.order.map((cardId) => {
          const rect = cards.current.get(cardId)?.getBoundingClientRect();
          return rect ? rect.top + rect.height / 2 : Number.POSITIVE_INFINITY;
        });
        const to = dropIndexFor(midpoints, from, move.clientY);
        if (to === from) return;
        active.order = moveItem(active.order, from, to);
        setPreview([...active.order]);
      };
      const handleUp = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleUp);
        finish();
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleUp);
    },
    [disabled, finish, rendered],
  );

  const moveByKeyboard = useCallback(
    (id: string, direction: "up" | "down") => {
      if (disabled) return false;
      const from = rendered.indexOf(id);
      const to = keyboardMoveTarget(from, direction, rendered.length);
      if (to === undefined) return false;
      // Through `commit` for the same reason a drop is: holding a key down
      // would otherwise make the card flicker back a slot between presses.
      commit(moveItem([...rendered], from, to));
      return true;
    },
    [commit, disabled, rendered],
  );

  return {
    draggingId,
    moveByKeyboard,
    onPointerDown,
    // The preview outlives the gesture by one round trip, then gives way to
    // whatever the server confirmed.
    order: rendered,
    registerCard,
  };
}
