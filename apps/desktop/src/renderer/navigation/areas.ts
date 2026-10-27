import type { CommandArea } from "@daedalus/protocol";

/**
 * The app's regions, in the order F6 visits them: the sidebar, the center,
 * the right panel, the integrated terminal panel and, while any are showing,
 * the toasts. Each root carries `data-area` with its name.
 */
export const REGION_AREAS = [
  "sidebar",
  "center",
  "right-panel",
  "terminal-panel",
  "toasts",
] as const satisfies readonly CommandArea[];

export type RegionArea = (typeof REGION_AREAS)[number];

export const isRegionArea = (value: unknown): value is RegionArea =>
  typeof value === "string" &&
  (REGION_AREAS as readonly string[]).includes(value);

/**
 * The region F6 (`direction` 1) or ⇧F6 (-1) moves to from `current`, among
 * the visible ones, wrapping at the ends. From nowhere, F6 enters the first
 * and ⇧F6 the last; a current region that is no longer visible counts as
 * nowhere.
 */
export function cycleArea(
  visible: readonly RegionArea[],
  current: RegionArea | undefined,
  direction: 1 | -1,
): RegionArea | undefined {
  const ordered = REGION_AREAS.filter((area) => visible.includes(area));
  if (ordered.length === 0) return undefined;
  const index = current ? ordered.indexOf(current) : -1;
  if (index < 0) return direction === 1 ? ordered[0] : ordered.at(-1);
  return ordered[(index + direction + ordered.length) % ordered.length];
}
