/**
 * A button that asks for its second click in place.
 *
 * The first click arms it: the icon turns into a red "Confirm" pill in the
 * same spot, so the second click needs no mouse travel and no modal. Moving
 * off it, leaving it by keyboard, Escape, or a few seconds without a second
 * click puts the icon back. A second click that lands within a double-click
 * of the first is ignored, so a double-click never confirms by accident.
 */
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
} from "react";

const DISARM_AFTER_MS = 3000;
const DOUBLE_CLICK_MS = 300;

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  onConfirm: () => void;
  /** What the armed pill says. */
  armedLabel?: string;
  /** The armed pill's tooltip: what confirming does. */
  armedTitle?: string;
};

export function ConfirmButton({
  onConfirm,
  armedLabel = "Confirm",
  armedTitle,
  children,
  className,
  title,
  onBlur,
  onKeyDown,
  onMouseLeave,
  ...props
}: Props) {
  const [armed, setArmed] = useState(false);
  const armedAt = useRef(0);
  const button = useRef<HTMLButtonElement>(null);
  // Its size before arming. The pill is styled for icon buttons, and on a
  // text button it came out smaller than the button it replaced; it is
  // never allowed to be.
  const [size, setSize] = useState<{ width: number; height: number }>();
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), DISARM_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <button
      {...props}
      ref={button}
      aria-label={armed ? (armedTitle ?? armedLabel) : props["aria-label"]}
      className={armed ? `${className ?? ""} confirm-armed` : className}
      data-armed={armed ? "true" : undefined}
      // The bar along the pill's bottom drains over the same window.
      style={
        armed
          ? ({
              ...props.style,
              ...(size ? { minWidth: size.width, minHeight: size.height } : {}),
              "--confirm-window": `${DISARM_AFTER_MS}ms`,
            } as CSSProperties)
          : props.style
      }
      onBlur={(event) => {
        setArmed(false);
        onBlur?.(event);
      }}
      onClick={() => {
        if (!armed) {
          const rect = button.current?.getBoundingClientRect();
          if (rect) setSize({ width: rect.width, height: rect.height });
          armedAt.current = Date.now();
          setArmed(true);
          return;
        }
        if (Date.now() - armedAt.current < DOUBLE_CLICK_MS) return;
        setArmed(false);
        onConfirm();
      }}
      onKeyDown={(event) => {
        // Handled here so a modal or drawer behind it does not close too.
        if (armed && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setArmed(false);
        }
        onKeyDown?.(event);
      }}
      onMouseLeave={(event) => {
        setArmed(false);
        onMouseLeave?.(event);
      }}
      title={armed ? (armedTitle ?? armedLabel) : title}
      type="button"
    >
      {armed ? armedLabel : children}
    </button>
  );
}
