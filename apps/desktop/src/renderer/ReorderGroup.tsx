import type { ReactNode } from "react";
import { useListReorder, type ReorderHandles } from "./use-list-reorder";

/**
 * One reorderable list among several rendered by the same component.
 *
 * A hook cannot be called once per item of a list whose length changes, and
 * the left column holds one session list per workspace (#55). Each list gets
 * its own instance of this component, and so its own drag state; a session
 * position is an order within one workspace, so nothing crosses between them.
 */
export function ReorderGroup({
  children,
  disabled,
  ids,
  onCommit,
}: {
  readonly children: (reorder: ReorderHandles) => ReactNode;
  readonly disabled?: boolean;
  readonly ids: readonly string[];
  readonly onCommit: (ids: string[]) => void | Promise<unknown>;
}) {
  const reorder = useListReorder({ disabled, ids, onCommit });
  return <>{children(reorder)}</>;
}
