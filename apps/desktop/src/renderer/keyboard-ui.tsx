/**
 * How the app shows its keys on screen: glyphs in `<kbd>`, a tooltip that
 * appears on keyboard focus as well as on hover, and the short hints in
 * empty states. Every key comes from the command table through
 * `shortcutLabel`, so a rebound key shows its new glyphs everywhere.
 */
import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import {
  type CommandId,
  formatAriaKeyShortcuts,
  formatKeyGlyphs,
} from "@daedalus/protocol";
import { ariaKeyShortcuts, shortcutLabel } from "./commands";

/** A key as glyphs, one `<kbd>` per chord of a sequence. */
export function KeyGlyphs({ glyphs }: { glyphs: string }) {
  return (
    <span className="key-glyphs">
      {glyphs.split(" ").map((chord, index) => (
        <kbd key={`${chord}-${index}`}>{chord}</kbd>
      ))}
    </span>
  );
}

/** How long a pointer rests, or keyboard focus stays, before it shows. */
const HOVER_DELAY_MS = 500;
const FOCUS_DELAY_MS = 300;

type TooltipChildProps = {
  "aria-describedby"?: string;
  "aria-keyshortcuts"?: string;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onMouseDown?: (event: MouseEvent<HTMLElement>) => void;
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: MouseEvent<HTMLElement>) => void;
};

/** Whether focus arrived by keyboard: `:focus-visible`, where supported. */
const focusVisible = (element: Element) => {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
};

/**
 * A tooltip for one control, in place of `title`: it shows after a short
 * rest of the pointer, and also when the control takes keyboard focus,
 * which `title` never does. It shows the command's key as `<kbd>` glyphs,
 * and gives the control `aria-keyshortcuts` and `aria-describedby`. Escape,
 * a press, leaving and blurring hide it. `keys` is for a key that is not a command's
 * (Escape closing a page).
 */
export function Tooltip({
  children,
  command,
  keys,
  label,
}: {
  children: ReactElement<TooltipChildProps>;
  command?: CommandId;
  keys?: string;
  label: string;
}) {
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLElement>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const glyphs = command
    ? shortcutLabel(command)
    : keys
      ? formatKeyGlyphs(keys)
      : undefined;
  const aria = command
    ? ariaKeyShortcuts(command)
    : keys
      ? formatAriaKeyShortcuts([keys]) || undefined
      : undefined;

  const cancel = () => clearTimeout(timer.current);
  const showLater = (element: HTMLElement, delay: number) => {
    cancel();
    timer.current = setTimeout(() => {
      if (element.isConnected) setAnchor(element);
    }, delay);
  };
  const hide = () => {
    cancel();
    setAnchor(undefined);
  };
  useEffect(() => cancel, []);
  useEffect(() => {
    if (!anchor) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAnchor(undefined);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [anchor]);

  const own = children.props;
  const control = cloneElement(children, {
    "aria-describedby": [own["aria-describedby"], id].filter(Boolean).join(" "),
    ...(aria ? { "aria-keyshortcuts": aria } : {}),
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      own.onMouseEnter?.(event);
      showLater(event.currentTarget, HOVER_DELAY_MS);
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      own.onMouseLeave?.(event);
      hide();
    },
    // A press is the control being used: the tip goes, and the focus the
    // press gives it is not keyboard focus, so it does not come back.
    onMouseDown: (event: MouseEvent<HTMLElement>) => {
      own.onMouseDown?.(event);
      hide();
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      own.onFocus?.(event);
      if (focusVisible(event.currentTarget))
        showLater(event.currentTarget, FOCUS_DELAY_MS);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      own.onBlur?.(event);
      hide();
    },
  });

  const box = anchor?.getBoundingClientRect();
  // Below the control, or above it near the bottom of the window; kept
  // inside the window either way.
  const style = box
    ? {
        left: Math.max(
          8,
          Math.min(box.left + box.width / 2, window.innerWidth - 8),
        ),
        ...(box.bottom + 40 > window.innerHeight
          ? { bottom: window.innerHeight - box.top + 6 }
          : { top: box.bottom + 6 }),
      }
    : undefined;
  const tip = (
    <span
      className="tooltip"
      hidden={!anchor}
      id={id}
      role="tooltip"
      style={style}
    >
      <span className="tooltip-label">{label}</span>
      {glyphs && <KeyGlyphs glyphs={glyphs} />}
    </span>
  );
  return (
    <>
      {control}
      {typeof document === "undefined" ? tip : createPortal(tip, document.body)}
    </>
  );
}

export interface KeyHint {
  command: CommandId;
  label: string;
}

/**
 * A muted line of keys for an empty state: `⌘K to do anything · ⌘N new
 * session`. A command with no key (unbound) is left out.
 */
export function KeyHints({ hints }: { hints: readonly KeyHint[] }) {
  const shown = hints.flatMap((hint) => {
    const glyphs = shortcutLabel(hint.command);
    return glyphs ? [{ ...hint, glyphs }] : [];
  });
  if (shown.length === 0) return null;
  return (
    <span className="key-hints">
      {shown.map((hint, index) => (
        <span className="key-hint" key={hint.command}>
          {index > 0 && (
            <span aria-hidden="true" className="key-hint-dot">
              ·
            </span>
          )}
          <KeyGlyphs glyphs={hint.glyphs} /> {hint.label}
        </span>
      ))}
    </span>
  );
}
