import type { RegionArea } from "./areas";

/**
 * Where focus goes when what had it is gone (an archived sidebar item, a
 * closed task page) or at start: a region's natural default, found once it
 * is on screen.
 */

export const areaRoot = (area: RegionArea): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-area="${area}"]`);

/** On screen, and not inside something hidden or inert. */
export const isShown = (element: Element): boolean =>
  element.isConnected &&
  element.getClientRects().length > 0 &&
  !element.closest('[hidden], [aria-hidden="true"], [inert]');

const FOCUSABLE = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Where each region puts focus when it has nothing better: the sidebar's
 * Tab stop (the selected item), the center's terminal or editor, the right
 * panel's open tab, the active integrated terminal.
 */
const DEFAULTS: Record<RegionArea, readonly string[]> = {
  sidebar: ['[role="treeitem"][tabindex="0"]', '[role="treeitem"]'],
  center: [
    ".xterm-helper-textarea",
    ".monaco-editor textarea",
    "[data-area-default]",
    '.board-card[tabindex="0"]',
    '[role="tab"][aria-selected="true"]',
  ],
  "right-panel": [
    "[data-area-default]",
    '[role="tab"][aria-selected="true"]',
    '[role="tab"][tabindex="0"]',
  ],
  "terminal-panel": [
    ".integrated-terminal-surface.active .xterm-helper-textarea",
    "[data-area-default]",
    '[role="tab"][aria-selected="true"]',
  ],
  toasts: [],
};

const firstShown = (root: ParentNode, selector: string) =>
  [...root.querySelectorAll<HTMLElement>(selector)].find(isShown);

export function defaultTarget(
  area: RegionArea,
  root: HTMLElement,
): HTMLElement | undefined {
  for (const selector of DEFAULTS[area]) {
    const found = firstShown(root, selector);
    if (found) return found;
  }
  return firstShown(root, FOCUSABLE);
}

/**
 * Focuses what `find` returns once it is on screen, trying for a few frames:
 * a page opened by the same key renders, and may load, before its contents
 * can take focus. A newer request cancels an older one.
 */
let focusRequest = 0;
export function focusWhenReady(
  find: () => HTMLElement | null | undefined,
  { frames = 30 }: { frames?: number } = {},
): void {
  const request = ++focusRequest;
  let left = frames;
  const attempt = () => {
    if (request !== focusRequest) return;
    const target = find();
    if (target && isShown(target)) {
      target.focus();
      return;
    }
    left -= 1;
    if (left > 0) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

/** The default focus target of a region, for `focusWhenReady`. */
export const areaDefault = (area: RegionArea): HTMLElement | undefined => {
  const root = areaRoot(area);
  return root ? defaultTarget(area, root) : undefined;
};
