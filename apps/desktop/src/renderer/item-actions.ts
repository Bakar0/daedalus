/**
 * What can be done to one item (a session, a workspace, a task, a file), as
 * data. The item's own menu draws it, and the ⌘K palette's Actions panel
 * lists it, so an action is defined once and offered in both places.
 *
 * The component that owns an item registers resolvers. One is given the
 * element that had focus and answers with that item's actions, or nothing
 * when the element is not one of its items: the palette asks it when it
 * opens, to put the focused item first. The other is given an item's id, so
 * the palette can offer the actions of any session, task or workspace it
 * lists, focused or not.
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

/** The kinds of item that have actions. */
export type ItemKind = "session" | "task" | "workspace" | "file";

/** Which item: a session's, task's or workspace's id, or a file's path. */
export interface ItemRef {
  kind: ItemKind;
  id: string;
}

export interface ItemActions {
  /** What the item is, as the palette heads its actions: `Session "api"`. */
  title: string;
  actions: ItemAction[];
  /** The item itself, so the palette can show it as its own row. */
  ref?: ItemRef;
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

export type ItemIdResolver = (id: string) => ItemActions | undefined;

const idResolvers = new Map<ItemKind, ItemIdResolver[]>();

/** Adds a resolver of one kind's items by id; returns its removal. */
export function registerItemActionsById(
  kind: ItemKind,
  resolver: ItemIdResolver,
): () => void {
  const list = idResolvers.get(kind) ?? [];
  list.push(resolver);
  idResolvers.set(kind, list);
  return () => {
    const current = idResolvers.get(kind);
    const index = current?.lastIndexOf(resolver) ?? -1;
    if (current && index >= 0) current.splice(index, 1);
  };
}

/**
 * The actions of the item `ref` names, from the newest resolver of its kind
 * that knows it; undefined when none is mounted that does (a task's board
 * is not on screen, say).
 */
export function itemActionsById(ref: ItemRef): ItemActions | undefined {
  const list = idResolvers.get(ref.kind) ?? [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const found = list[index]?.(ref.id);
    if (found && found.actions.length > 0) return found;
  }
  return undefined;
}

/** `registerItemActionsById` for as long as the component is mounted. */
export function useItemActionsById(
  kind: ItemKind,
  resolver: ItemIdResolver,
): void {
  const latest = useRef(resolver);
  latest.current = resolver;
  useEffect(
    () => registerItemActionsById(kind, (id) => latest.current(id)),
    [kind],
  );
}
