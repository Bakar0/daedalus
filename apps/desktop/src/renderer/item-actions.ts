/**
 * What can be done to one item on screen (a sidebar session or workspace, a
 * board card, a file), as data. The item's own menu draws it, and the ⌘K
 * palette lists it first when the palette is opened with that item focused,
 * so an action is defined once and offered in both places.
 *
 * The component that owns an item registers a resolver: given the element
 * that had focus, it answers with that item's actions, or nothing when the
 * element is not one of its items. The palette asks the resolvers when it
 * opens.
 */
import { useEffect, useRef } from "react";

export interface ItemAction {
  /** Stable within the item: `rename`, `archive`. */
  id: string;
  label: string;
  run(): void;
  disabled?: boolean;
  /**
   * Running it needs a second confirmation; this says what confirming does.
   * The menu arms its button, the palette asks for a second Enter.
   */
  confirm?: string;
  /** A switch's current state, for an action that toggles. */
  checked?: boolean;
  /** A key the item's own list answers to (`mod+c`), shown beside it. */
  keys?: string;
  /** Destroys something: drawn in the danger colour. */
  danger?: boolean;
  /** Longer words for the action, kept for its tooltip and the search. */
  description?: string;
}

export interface ItemActions {
  /** What the item is, as the palette heads its actions: `Session "api"`. */
  title: string;
  actions: ItemAction[];
}

export type ItemActionResolver = (element: Element) => ItemActions | undefined;

const resolvers: ItemActionResolver[] = [];

/** Adds a resolver; returns its removal. The latest one added is asked first. */
export function registerItemActions(resolver: ItemActionResolver): () => void {
  resolvers.push(resolver);
  return () => {
    const index = resolvers.lastIndexOf(resolver);
    if (index >= 0) resolvers.splice(index, 1);
  };
}

/**
 * The actions of the item `element` belongs to: the first resolver, newest
 * first, that knows it. Undefined when no item had focus, or it has no
 * actions.
 */
export function itemActionsFor(
  element: Element | null,
  list: readonly ItemActionResolver[] = resolvers,
): ItemActions | undefined {
  if (!element) return undefined;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const found = list[index]?.(element);
    if (found && found.actions.length > 0) return found;
  }
  return undefined;
}

/**
 * Registers a resolver for as long as the component is mounted; the latest
 * one is always the one called, so it may close over state.
 */
export function useItemActions(resolver: ItemActionResolver): void {
  const latest = useRef(resolver);
  latest.current = resolver;
  useEffect(
    () => registerItemActions((element) => latest.current(element)),
    [],
  );
}
