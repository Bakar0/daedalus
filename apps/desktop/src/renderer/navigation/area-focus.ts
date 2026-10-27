import {
  type RegionArea,
  REGION_AREAS,
  cycleArea,
  isRegionArea,
} from "./areas";

/**
 * Moving focus between the app's regions (see `areas.ts`). Each region
 * remembers the element that last had focus inside it; entering the region
 * again goes back there while it is still on screen, else to the region's
 * natural default. A thin accent edge marks the focused region while the
 * keyboard is being used (`html[data-keyboard-nav]`).
 */

const lastFocused = new Map<RegionArea, WeakRef<HTMLElement>>();

export const areaRoot = (area: RegionArea): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-area="${area}"]`);

/** On screen, and not inside something hidden or inert. */
export const isShown = (element: Element): boolean =>
  element.isConnected &&
  element.getClientRects().length > 0 &&
  !element.closest('[hidden], [aria-hidden="true"], [inert]');

/** A region shows when its root is on screen and not marked away. */
const regionShown = (root: HTMLElement) =>
  isShown(root) && root.getAttribute("data-area-hidden") !== "true";

export const visibleAreas = (): RegionArea[] =>
  REGION_AREAS.filter((area) => {
    const root = areaRoot(area);
    return root !== null && regionShown(root);
  });

/** The region an element is in. */
export function regionOf(element: Element | null): RegionArea | undefined {
  for (let node = element; node; node = node.parentElement) {
    const area = node.getAttribute("data-area");
    if (isRegionArea(area)) return area;
  }
  return undefined;
}

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
 * Where each region puts focus when it has nothing to go back to: the
 * sidebar's Tab stop (the selected item), the center's terminal or editor,
 * the right panel's open tab, the active integrated terminal.
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

/** Marks that the keyboard is driving, which shows the area edge. */
export function markKeyboardNavigation(): void {
  document.documentElement.setAttribute("data-keyboard-nav", "true");
}

/**
 * Focuses a region: where focus last was in it, if that is still there,
 * else its default. Says whether focus landed in it.
 */
export function focusArea(
  area: RegionArea,
  {
    preferLast = true,
    mark = true,
  }: { preferLast?: boolean; mark?: boolean } = {},
): boolean {
  const root = areaRoot(area);
  if (!root || !regionShown(root)) return false;
  const last = lastFocused.get(area)?.deref();
  const target =
    preferLast && last && root.contains(last) && isShown(last)
      ? last
      : defaultTarget(area, root);
  if (!target) return false;
  if (mark) markKeyboardNavigation();
  target.focus();
  return root.contains(document.activeElement);
}

/** F6 (1) or ⇧F6 (-1): the next visible region that takes focus. */
export function cycleFocus(direction: 1 | -1): boolean {
  const visible = visibleAreas();
  let current = regionOf(document.activeElement);
  // A region with nothing to focus is passed over rather than ending the
  // cycle on it.
  for (let tries = 0; tries < visible.length; tries += 1) {
    const next = cycleArea(visible, current, direction);
    if (!next) return false;
    if (focusArea(next)) return true;
    current = next;
  }
  return false;
}

function onFocusIn(event: FocusEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const area = regionOf(target);
  if (area) lastFocused.set(area, new WeakRef(target));
}

const NAVIGATION_KEYS = new Set([
  "Tab",
  "F6",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
]);

function onKeyDown(event: KeyboardEvent) {
  if (NAVIGATION_KEYS.has(event.key)) markKeyboardNavigation();
}

function onPointerDown() {
  document.documentElement.removeAttribute("data-keyboard-nav");
}

let installs = 0;

/** Tracks the last focused element of each region; returns the uninstall. */
export function installAreaTracking(): () => void {
  installs += 1;
  if (installs === 1) {
    window.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
  }
  return () => {
    installs -= 1;
    if (installs > 0) return;
    window.removeEventListener("focusin", onFocusIn, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
  };
}

/**
 * Focuses what `find` returns once it is on screen, trying for a few frames:
 * a panel opened by the same key renders, and may load, before its contents
 * can take focus. A newer request cancels an older one.
 */
let focusRequest = 0;
export function focusWhenReady(
  find: () => HTMLElement | null | undefined,
  { frames = 30, mark = true }: { frames?: number; mark?: boolean } = {},
): void {
  const request = ++focusRequest;
  let left = frames;
  const attempt = () => {
    if (request !== focusRequest) return;
    const target = find();
    if (target && isShown(target)) {
      if (mark) markKeyboardNavigation();
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
