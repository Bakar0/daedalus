/**
 * The sidebar as a WAI-ARIA tree: workspaces are level 1, their sessions
 * level 2. The tree is one Tab stop and the keys move inside it. The
 * decision is pure and works on the items as they are shown, in order, so
 * a folded workspace's sessions are simply not in the list.
 */

export interface TreeItem {
  readonly id: string;
  readonly level: number;
  /** The level-1 item a session sits under. */
  readonly parent?: string;
  /** Whether it has children it can show or hide. */
  readonly expandable: boolean;
  readonly expanded: boolean;
  /** What type-ahead matches. */
  readonly label?: string;
}

export type TreeAction =
  | { kind: "focus"; id: string }
  | { kind: "expand"; id: string }
  | { kind: "collapse"; id: string };

/**
 * What a key does on the item `currentId`, or undefined when the tree leaves
 * it alone (Enter and Space are the item's own: it is a button).
 */
export function treeKeyAction(
  items: readonly TreeItem[],
  currentId: string,
  key: string,
): TreeAction | undefined {
  const index = items.findIndex((item) => item.id === currentId);
  const current = items[index];
  if (!current) return undefined;
  const focus = (item: TreeItem | undefined): TreeAction | undefined =>
    item && item.id !== currentId ? { kind: "focus", id: item.id } : undefined;
  switch (key) {
    case "ArrowDown":
      return focus(items[index + 1]);
    case "ArrowUp":
      return focus(items[index - 1]);
    case "Home":
      return focus(items[0]);
    case "End":
      return focus(items.at(-1));
    case "ArrowRight": {
      if (!current.expandable) return undefined;
      if (!current.expanded) return { kind: "expand", id: current.id };
      const child = items[index + 1];
      return child?.parent === current.id ? focus(child) : undefined;
    }
    case "ArrowLeft": {
      if (current.expandable && current.expanded)
        return { kind: "collapse", id: current.id };
      return current.parent
        ? focus(items.find((item) => item.id === current.parent))
        : undefined;
    }
    default:
      return typeAhead(items, index, key);
  }
}

/**
 * A printable key moves to the next item, after the current one and
 * wrapping, whose label starts with it.
 */
function typeAhead(
  items: readonly TreeItem[],
  index: number,
  key: string,
): TreeAction | undefined {
  if (key.length !== 1 || !/\S/.test(key)) return undefined;
  const wanted = key.toLocaleLowerCase();
  for (let step = 1; step < items.length; step += 1) {
    const item = items[(index + step) % items.length];
    if (item?.label?.trim().toLocaleLowerCase().startsWith(wanted))
      return { kind: "focus", id: item.id };
  }
  return undefined;
}

/**
 * The item that is the tree's one Tab stop: the one focus was last on while
 * it is still shown, else the selected one, else the first.
 */
export function treeTabStop(
  shown: readonly string[],
  lastFocused: string | undefined,
  selected: readonly (string | undefined)[],
): string | undefined {
  if (lastFocused && shown.includes(lastFocused)) return lastFocused;
  return selected.find((id) => id && shown.includes(id)) ?? shown[0];
}

/**
 * Where focus goes when the item `removedId` leaves the list: the next item,
 * or the previous when it was the last.
 */
export function neighbourOf(
  shown: readonly string[],
  removedId: string,
): string | undefined {
  const index = shown.indexOf(removedId);
  if (index < 0) return undefined;
  return shown[index + 1] ?? shown[index - 1];
}
