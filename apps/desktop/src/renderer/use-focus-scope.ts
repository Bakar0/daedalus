/**
 * Focus for a layer on top of the page: a dialog, or a tab that was opened
 * to be worked in. A scope takes focus when it opens, keeps Tab and
 * Shift+Tab inside itself, makes the page behind it `inert`, and gives focus
 * back to whatever had it when it closes.
 *
 * The decisions are plain functions so they can be tested without a DOM;
 * the hook only wires them to elements and events.
 */
import { useEffect, useRef, type RefObject } from "react";

/**
 * Where Tab should go inside a scope of `count` tab stops, from stop
 * `current`, or -1 when focus is on the scope itself (or somewhere that is
 * not one of its stops). Undefined leaves the move to the browser, which
 * steps between the stops in the middle; a number is the stop to focus,
 * wrapping at either end; -1 keeps focus on the scope, which has no stops.
 */
export function trapTab(
  count: number,
  current: number,
  backwards: boolean,
): number | undefined {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return backwards ? count - 1 : 0;
  if (backwards && current === 0) return count - 1;
  if (!backwards && current === count - 1) return 0;
  return undefined;
}

/** What `pickRestoreTarget` needs of an element. */
export interface RestoreCandidate {
  readonly isConnected: boolean;
  closest?(selector: string): unknown;
  readonly disabled?: boolean;
}

/**
 * The first candidate that can still take focus: in the document, not
 * disabled and not under an `inert` page. The candidates are the element
 * that had focus first, then the containers around it that can hold focus,
 * so a button that went away with its menu or row gives focus to its list.
 */
export function pickRestoreTarget<T extends RestoreCandidate>(
  candidates: readonly (T | null | undefined)[],
): T | undefined {
  for (const candidate of candidates) {
    if (!candidate || !candidate.isConnected || candidate.disabled) continue;
    if (candidate.closest?.("[inert]")) continue;
    return candidate;
  }
  return undefined;
}

const TABBABLE = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "iframe",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]",
].join(",");

/** The elements Tab stops at inside `root`, in document order. */
export function tabbableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((element) => {
    if (element.tabIndex < 0) return false;
    if ((element as HTMLButtonElement).disabled) return false;
    if (element instanceof HTMLInputElement && element.type === "hidden")
      return false;
    if (element.closest("[inert]")) return false;
    if (element.getClientRects().length === 0) return false;
    // Only the checked radio of a group is a stop; arrows move inside it.
    if (
      element instanceof HTMLInputElement &&
      element.type === "radio" &&
      !element.checked &&
      element.name &&
      root.querySelector(
        `input[type="radio"][name="${CSS.escape(element.name)}"]:checked`,
      )
    )
      return false;
    return true;
  });
}

/**
 * How many open scopes hold each element inert. An element is inert while
 * any scope holds it, so scopes that close out of order never wake the page
 * under one that is still open. An element that was inert before any scope
 * touched it is not ours and is left alone.
 */
const inertHolds = new Map<InertTarget, number>();

/** What the inert bookkeeping needs of an element. */
export interface InertTarget {
  inert: boolean;
}

/** Holds `element` inert; false when it was inert already, and not ours. */
export function holdInert(element: InertTarget): boolean {
  const held = inertHolds.get(element);
  if (held === undefined && element.inert) return false;
  inertHolds.set(element, (held ?? 0) + 1);
  element.inert = true;
  return true;
}

/** Lets go of one hold; the element wakes when the last one goes. */
export function releaseInert(element: InertTarget): void {
  const held = inertHolds.get(element);
  if (held === undefined) return;
  if (held > 1) {
    inertHolds.set(element, held - 1);
    return;
  }
  inertHolds.delete(element);
  element.inert = false;
}

/**
 * Makes everything outside `element` inert: every sibling of it and of each
 * of its ancestors up to the body. A sibling that comes later in the
 * document and holds another open scope is drawn above this one, so it
 * stays live. Returns the undo.
 */
export function inertOutside(element: HTMLElement): () => void {
  const changed: HTMLElement[] = [];
  const above = openRoots().filter(
    (root) =>
      root !== element &&
      Boolean(
        element.compareDocumentPosition(root) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
  );
  let node: HTMLElement | null = element;
  while (node && node !== document.body) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) break;
    for (const sibling of parent.children) {
      if (sibling === node || !(sibling instanceof HTMLElement)) continue;
      if (sibling.tagName === "SCRIPT") continue;
      if (above.some((root) => sibling.contains(root))) continue;
      if (holdInert(sibling)) changed.push(sibling);
    }
    node = parent;
  }
  return () => {
    for (const item of changed) releaseInert(item);
  };
}

/**
 * The element focus should go back to, and the containers around it that
 * can hold focus, nearest first.
 */
export function restoreCandidates(start: Element | null): HTMLElement[] {
  const candidates: HTMLElement[] = [];
  let node: Element | null = start;
  while (node && node !== document.body) {
    if (
      node instanceof HTMLElement &&
      (node === start || node.hasAttribute("tabindex"))
    )
      candidates.push(node);
    node = node.parentElement;
  }
  return candidates;
}

/** Focuses the first candidate that can take it; false when none can. */
export function restoreFocus(candidates: readonly HTMLElement[]): boolean {
  const target = pickRestoreTarget(candidates);
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}

/** Whether nothing in particular holds focus: the body, or no element. */
export const focusIsLost = () =>
  !document.activeElement || document.activeElement === document.body;

/**
 * The index of the item drawn on top: the last in document order, where
 * `follows(a, b)` says `b` comes after `a`. Undefined for none.
 */
export function topmostIndex<T>(
  items: readonly T[],
  follows: (a: T, b: T) => boolean,
): number | undefined {
  let top: number | undefined;
  items.forEach((item, index) => {
    const current = top === undefined ? undefined : items[top];
    if (current === undefined || follows(current, item)) top = index;
  });
  return top;
}

// The open scopes' elements, read when asked, since a queued dialog swaps
// the element under one scope.
const open: RefObject<HTMLElement | null>[] = [];

const openRoots = () =>
  open.flatMap((ref) => (ref.current?.isConnected ? [ref.current] : []));

/**
 * Whether `element` is the open scope drawn on top, the one that answers Tab
 * and Escape. Scopes stack by document order rather than by when they
 * opened: the app's confirms come last in the page, so one stays on top of a
 * dialog opened after it.
 */
export function isTopmostScope(element: HTMLElement | null): boolean {
  if (!element) return false;
  const roots = openRoots();
  const top = topmostIndex(roots, (a, b) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING),
  );
  return top !== undefined && roots[top] === element;
}

/** Focus in a terminal or the code editor: Tab is a key they type. */
const inTypingSurface = () =>
  Boolean(document.activeElement?.closest(".xterm, .monaco-editor"));

/**
 * Makes the element in `ref` a focus scope while `active`. The element
 * should have `tabIndex={-1}`: it takes focus itself when nothing inside it
 * did (an `autoFocus` child wins), and keeps it when it has no tab stops.
 */
export function useFocusScope(
  ref: RefObject<HTMLElement | null>,
  active = true,
): void {
  // Read while rendering, before an `autoFocus` child moves focus in the
  // commit. The candidates are worked out now too: by the time an effect
  // runs, an opener inside another dialog may already be gone.
  const restoreTo = useRef<HTMLElement[] | null>(null);
  if (!active) restoreTo.current = null;
  else if (restoreTo.current === null && typeof document !== "undefined")
    restoreTo.current = restoreCandidates(document.activeElement);

  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const candidates = restoreTo.current ?? [];
    open.push(ref);
    const release = inertOutside(root);
    if (isTopmostScope(root) && !root.contains(document.activeElement))
      root.focus({ preventScroll: true });

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (inTypingSurface()) return;
      const scope = ref.current;
      if (!scope || !isTopmostScope(scope)) return;
      const stops = tabbableIn(scope);
      const current = stops.findIndex(
        (stop) => stop === document.activeElement,
      );
      const next = trapTab(stops.length, current, event.shiftKey);
      if (next === undefined) return;
      event.preventDefault();
      (next === -1 ? scope : stops[next])?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      open.splice(open.indexOf(ref), 1);
      release();
      // Only when the scope really went: StrictMode's rehearsal unmount
      // leaves it in the page, and focus must stay on its autoFocus child.
      // And only when focus went with it: if the user moved it on purpose,
      // that is where it should stay.
      if (root.isConnected) return;
      if (focusIsLost()) restoreFocus(candidates);
    };
  }, [active, ref]);
}
