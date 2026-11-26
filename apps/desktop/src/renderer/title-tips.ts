/**
 * Tooltip timing for the whole app, and the tips of every control that
 * names itself with `title`.
 *
 * A browser shows a `title` after well over a second, too late to tell
 * what an icon does. `installTitleTips` shows the same words in the app's
 * own tooltip instead, on the timing below, for every element with a
 * `title` and without changing how the element is written.
 *
 * The timing follows what design systems publish: a rest of 300 to 500 ms
 * confirms the pointer means the control (PatternFly 300, GitLab and SAP
 * Fiori 500, Visa at most 500). Every tip waits the same, also right after
 * another one: a tip that came at once beside ones that waited read as a
 * fault.
 */

/** How long the pointer rests on a control before its tip shows. */
export const TIP_HOVER_MS = 300;
/** How long keyboard focus stays on a control before its tip shows. */
export const TIP_FOCUS_MS = 300;

/** Where a tooltip is put so the theme's colours reach it. */
export const tipHome = (doc: Document = document): HTMLElement =>
  doc.querySelector<HTMLElement>(".app") ?? doc.body;

const GAP = 6;
const EDGE = 8;

/**
 * Shows every `title` in the app's tooltip. While the pointer or keyboard
 * focus is on an element its `title` is taken off, so the browser's own
 * tip never shows, and put back when it leaves. Call once per window.
 */
export function installTitleTips(doc: Document = document): () => void {
  const view = doc.defaultView;
  if (!view) return () => undefined;
  const tip = doc.createElement("span");
  tip.className = "tooltip tooltip-title";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;

  let anchor: HTMLElement | undefined;
  let text = "";
  let shown = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // React may write the `title` again while it is taken off.
  const watcher = new view.MutationObserver(() => {
    const fresh = anchor?.getAttribute("title");
    if (!anchor || fresh === null || fresh === undefined) return;
    text = fresh;
    anchor.removeAttribute("title");
    if (shown) place();
  });

  const place = () => {
    if (!anchor) return;
    // The theme's colours are set on the app's root, not on the page.
    const home = tipHome(doc);
    if (tip.parentElement !== home) home.append(tip);
    tip.textContent = text;
    tip.hidden = false;
    const box = anchor.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    const center = Math.max(
      EDGE + half,
      Math.min(box.left + box.width / 2, view.innerWidth - EDGE - half),
    );
    tip.style.left = `${center}px`;
    const below = box.bottom + GAP + tip.offsetHeight <= view.innerHeight;
    tip.style.top = below ? `${box.bottom + GAP}px` : "";
    tip.style.bottom = below ? "" : `${view.innerHeight - box.top + GAP}px`;
  };

  const leave = () => {
    clearTimeout(timer);
    watcher.disconnect();
    if (anchor?.isConnected && text && !anchor.hasAttribute("title"))
      anchor.setAttribute("title", text);
    shown = false;
    anchor = undefined;
    tip.hidden = true;
  };

  const enter = (element: HTMLElement, delay: number) => {
    if (element === anchor) return;
    leave();
    const title = element.getAttribute("title");
    if (!title?.trim()) return;
    anchor = element;
    text = title;
    element.removeAttribute("title");
    watcher.observe(element, { attributes: true, attributeFilter: ["title"] });
    timer = setTimeout(() => {
      if (!anchor?.isConnected) return leave();
      shown = true;
      place();
    }, delay);
  };

  const titled = (target: EventTarget | null) =>
    target instanceof view.Element
      ? (target.closest("[title]") as HTMLElement | null)
      : null;

  /** The control last pressed: it says nothing more until the pointer leaves. */
  let pressed: HTMLElement | undefined;
  const onOver = (event: MouseEvent) => {
    const element = titled(event.target);
    // A control that was just used, or whose menu is open, needs no tip.
    if (
      element &&
      (element === pressed || element.getAttribute("aria-expanded") === "true")
    )
      return;
    if (element) enter(element, TIP_HOVER_MS);
    else if (anchor && !anchor.contains(event.target as Node)) leave();
  };
  const onOut = (event: MouseEvent) => {
    const to = event.relatedTarget as Node | null;
    if (pressed && !pressed.contains(to)) pressed = undefined;
    if (anchor && !anchor.contains(to)) leave();
  };
  const onPress = (event: MouseEvent) => {
    pressed = anchor ?? titled(event.target) ?? undefined;
    leave();
  };
  const onFocus = (event: FocusEvent) => {
    const element = titled(event.target);
    let keyboard = true;
    try {
      keyboard = (event.target as Element).matches(":focus-visible");
    } catch {
      // Without `:focus-visible`, every focus counts as the keyboard's.
    }
    if (element && keyboard) enter(element, TIP_FOCUS_MS);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") leave();
  };

  doc.addEventListener("mouseover", onOver, true);
  doc.addEventListener("mouseout", onOut, true);
  doc.addEventListener("focusin", onFocus, true);
  doc.addEventListener("focusout", leave, true);
  // A press is the control being used, and a scroll moves it away.
  doc.addEventListener("mousedown", onPress, true);
  doc.addEventListener("wheel", leave, { capture: true, passive: true });
  doc.addEventListener("keydown", onKey, true);
  view.addEventListener("blur", leave);
  return () => {
    leave();
    doc.removeEventListener("mouseover", onOver, true);
    doc.removeEventListener("mouseout", onOut, true);
    doc.removeEventListener("focusin", onFocus, true);
    doc.removeEventListener("focusout", leave, true);
    doc.removeEventListener("mousedown", onPress, true);
    doc.removeEventListener("wheel", leave, true);
    doc.removeEventListener("keydown", onKey, true);
    view.removeEventListener("blur", leave);
    tip.remove();
  };
}
