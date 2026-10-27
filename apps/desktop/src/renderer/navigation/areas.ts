import type { CommandArea } from "@daedalus/protocol";

/**
 * The app's regions: the sidebar, the center, the right panel, the
 * integrated terminal panel and, while any are showing, the toasts. Each
 * root carries `data-area` with its name, which is how a command's `when`
 * knows where focus is.
 */
export const REGION_AREAS = [
  "sidebar",
  "center",
  "right-panel",
  "terminal-panel",
  "toasts",
] as const satisfies readonly CommandArea[];

export type RegionArea = (typeof REGION_AREAS)[number];
