/**
 * A small popup menu on the `<details>` pattern `.board-settings` already
 * uses, so the trigger opens on Enter and Space and on a click without any
 * script. What the element does not do is added here: a press outside or Tab
 * away closes it, Escape closes it and returns focus to the trigger, and the
 * arrow keys move between items.
 *
 * Escape is marked handled (`preventDefault`) before it can bubble to the
 * window, where the task drawer listens for Escape to close itself. The
 * drawer skips handled events, so Escape inside a menu closes the menu and
 * leaves the drawer open.
 *
 * The popover opens in the top layer (the Popover API), so a scrolling list
 * or a clipping card around the trigger cannot cut it off. `placeMenu` puts it
 * next to the trigger and keeps it inside the window.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

const ITEMS = [
  '[role="menuitem"]:not(:disabled)',
  '[role="menuitemradio"]:not(:disabled)',
  '[role="menuitemcheckbox"]:not(:disabled)',
].join(", ");

export interface MenuRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Space kept between the popover and the trigger, and the window edge. */
const GAP = 5;
const MARGIN = 8;

/**
 * Where the popover goes, in window coordinates. `below` opens under the
 * trigger, lined up with its `align` edge, and above it when there is no room
 * below. `left` opens beside the trigger on its left, and on its right when
 * there is no room on the left. Either way the result is kept inside the
 * window.
 */
export function placeMenu({
  align,
  menu,
  placement,
  trigger,
  viewport,
}: {
  align: "start" | "end";
  menu: { width: number; height: number };
  placement: "below" | "left";
  trigger: MenuRect;
  viewport: { width: number; height: number };
}): { top: number; left: number } {
  const right = trigger.left + trigger.width;
  const bottom = trigger.top + trigger.height;
  let top: number;
  let left: number;
  if (placement === "left") {
    top = trigger.top;
    left = trigger.left - GAP - menu.width;
    if (left < MARGIN && right + GAP + menu.width <= viewport.width - MARGIN)
      left = right + GAP;
  } else {
    left = align === "start" ? trigger.left : right - menu.width;
    top = bottom + GAP;
    if (
      top + menu.height > viewport.height - MARGIN &&
      trigger.top - GAP - menu.height >= MARGIN
    )
      top = trigger.top - GAP - menu.height;
  }
  const clamp = (value: number, size: number, limit: number) =>
    Math.max(MARGIN, Math.min(value, limit - MARGIN - size));
  return {
    top: clamp(top, menu.height, viewport.height),
    left: clamp(left, menu.width, viewport.width),
  };
}

export function Menu({
  align = "start",
  children,
  className,
  describedBy,
  label,
  menuLabel,
  placement = "below",
  summary,
  summaryClassName,
  title,
}: {
  /** Which edge of the trigger the popover lines up with. */
  align?: "start" | "end";
  children: ReactNode;
  className?: string;
  /** Id of the element inside the trigger that reads the current value. */
  describedBy?: string;
  /** Accessible name of the trigger. */
  label: string;
  /** Accessible name of the list of items. */
  menuLabel: string;
  /** Under the trigger, or beside it on its left. */
  placement?: "below" | "left";
  summary: ReactNode;
  summaryClassName?: string;
  title?: string;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const items = () =>
    [
      ...(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []),
    ] as HTMLElement[];
  const close = (returnFocus: boolean) => {
    const details = ref.current;
    if (!details?.open) return;
    details.open = false;
    if (returnFocus) details.querySelector("summary")?.focus();
  };

  // Into the top layer while open, placed against the trigger, and placed
  // again when the window resizes or anything around the trigger scrolls.
  useLayoutEffect(() => {
    const popover = popoverRef.current;
    const trigger = ref.current?.querySelector("summary");
    if (!open || !popover || !trigger || !("showPopover" in popover)) return;
    popover.showPopover();
    const place = () => {
      const box = trigger.getBoundingClientRect();
      const { top, left } = placeMenu({
        align,
        menu: { width: popover.offsetWidth, height: popover.offsetHeight },
        placement,
        trigger: {
          top: box.top,
          left: box.left,
          width: box.width,
          height: box.height,
        },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
      popover.style.top = `${top}px`;
      popover.style.left = `${left}px`;
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
      if (popover.matches(":popover-open")) popover.hidePopover();
    };
  }, [open, align, placement]);

  useEffect(() => {
    if (!open) return;
    // The checked item, or the first, takes focus so the arrow keys work
    // straight away.
    const list = items();
    (
      list.find((item) => item.getAttribute("aria-checked") === "true") ??
      list[0]
    )?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDetailsElement>) => {
    const details = ref.current;
    if (!details) return;
    if (!details.open) {
      if (event.key === "ArrowDown" && event.target === details.firstChild) {
        event.preventDefault();
        details.open = true;
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    const list = items();
    if (list.length === 0) return;
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => {
      event.preventDefault();
      list[(next + list.length) % list.length]?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index < 0 ? -1 : index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(-1);
  };

  return (
    <details
      className={["menu", className].filter(Boolean).join(" ")}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && !event.currentTarget.contains(next)) close(false);
      }}
      onKeyDown={onKeyDown}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      ref={ref}
    >
      <summary
        aria-describedby={describedBy}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className={summaryClassName}
        title={title}
      >
        {summary}
      </summary>
      <div
        aria-label={menuLabel}
        className={`menu-popover menu-align-${align}`}
        popover="manual"
        // Choosing an item closes the menu; the item's own click has already
        // run by the time this sees the event.
        onClick={(event) => {
          if ((event.target as Element).closest(ITEMS)) close(true);
        }}
        ref={popoverRef}
        role="menu"
      >
        {children}
      </div>
    </details>
  );
}

export function MenuCheck() {
  return (
    <svg
      aria-hidden="true"
      className="menu-check"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.2"
      viewBox="0 0 24 24"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function MenuChevron() {
  return (
    <svg
      aria-hidden="true"
      className="menu-chevron"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.2"
      viewBox="0 0 24 24"
    >
      <path d="M7 10l5 5 5-5" />
    </svg>
  );
}
