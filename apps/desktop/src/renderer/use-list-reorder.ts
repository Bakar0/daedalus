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
  /** Called once, on drop, with the new order. Only when it actually changed. */
  readonly onCommit: (ids: string[]) => void;
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
  /**
   * True when the gesture that just ended was a drag, so the click it also
   * produced should not be treated as a selection.
   */
  readonly consumeDragClick: () => boolean;
  /** ⌥↑/⌥↓ handler for a focused card. Returns true when it handled the key. */
  readonly moveByKeyboard: (id: string, direction: "up" | "down") => boolean;
}

/**
 * Pointer-driven reordering for a list of cards.
 *
 * The whole card is the drag target rather than a grip, because these cards
 * are already buttons the user clicks constantly and a 16px strip would be the
 * harder thing to hit. The grip drawn on each card is the signifier for this
 * gesture, not its only entry point — see `.list-drag-grip` in the stylesheet.
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
        order: string[];
      }
    | undefined
  >(undefined);
  // Read and cleared by the click handler the same gesture produces. A ref, not
  // state, because the click arrives before React would re-render.
  const draggedClick = useRef(false);

  const registerCard = useCallback(
    (id: string) => (node: HTMLElement | null) => {
      if (node) cards.current.set(id, node);
      else cards.current.delete(id);
    },
    [],
  );

  const finish = useCallback(() => {
    const active = gesture.current;
    gesture.current = undefined;
    setPreview(undefined);
    setDraggingId(undefined);
    if (!active?.dragging) return;
    draggedClick.current = true;
    if (orderChanged(ids, active.order)) onCommit(active.order);
  }, [ids, onCommit]);

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
        id,
        order: [...ids],
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
    [disabled, finish, ids],
  );

  const consumeDragClick = useCallback(() => {
    const dragged = draggedClick.current;
    draggedClick.current = false;
    return dragged;
  }, []);

  const moveByKeyboard = useCallback(
    (id: string, direction: "up" | "down") => {
      if (disabled) return false;
      const from = ids.indexOf(id);
      const to = keyboardMoveTarget(from, direction, ids.length);
      if (to === undefined) return false;
      onCommit(moveItem([...ids], from, to));
      return true;
    },
    [disabled, ids, onCommit],
  );

  return {
    consumeDragClick,
    draggingId,
    moveByKeyboard,
    onPointerDown,
    // The preview is dropped as soon as the gesture ends, so the next render
    // shows whatever the server confirmed rather than a local guess.
    order: preview ?? ids,
    registerCard,
  };
}
