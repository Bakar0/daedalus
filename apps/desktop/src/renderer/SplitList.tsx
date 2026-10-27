import { useEffect, useRef, useState, type ReactNode } from "react";

/** The list column's width when nothing is remembered, and its bounds. */
const DEFAULT_WIDTH = 240;
const MIN_WIDTH = 160;
const MAX_WIDTH = 480;

const storageKey = (id: string) => `daedalus.split.${id}`;

const clamp = (width: number) =>
  Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));

function storedWidth(id: string): number {
  try {
    const value = Number(window.localStorage.getItem(storageKey(id)));
    return value > 0 ? clamp(value) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function storeWidth(id: string, width: number): void {
  try {
    window.localStorage.setItem(storageKey(id), String(width));
  } catch {
    // Without storage the width resets next time.
  }
}

/**
 * A list on the left and its content on the right, as the Workflows, Custom
 * instructions and Team tabs show them. Dragging the line between them sets
 * the list's width, remembered per `id`; double-clicking it resets it.
 */
export function SplitList({
  id,
  label,
  list,
  children,
}: {
  /** Which tab this is, for the remembered width. */
  id: string;
  /** What the list holds, for screen readers. */
  label: string;
  list: ReactNode;
  children: ReactNode;
}) {
  const [width, setWidth] = useState(() => storedWidth(id));
  const drag = useRef<{ startX: number; startWidth: number } | undefined>(
    undefined,
  );
  useEffect(() => setWidth(storedWidth(id)), [id]);
  return (
    <div
      className="workflows-editor split-list"
      style={{ gridTemplateColumns: `${width}px 0 minmax(0, 1fr)` }}
    >
      <nav aria-label={label} className="workflows-list">
        {list}
      </nav>
      <div
        aria-label="Resize the list"
        aria-orientation="vertical"
        aria-valuemax={MAX_WIDTH}
        aria-valuemin={MIN_WIDTH}
        aria-valuenow={width}
        className="split-list-handle"
        onDoubleClick={() => {
          setWidth(DEFAULT_WIDTH);
          storeWidth(id, DEFAULT_WIDTH);
        }}
        onKeyDown={(event) => {
          const step =
            event.key === "ArrowLeft"
              ? -16
              : event.key === "ArrowRight"
                ? 16
                : 0;
          if (!step) return;
          event.preventDefault();
          const next = clamp(width + step);
          setWidth(next);
          storeWidth(id, next);
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { startX: event.clientX, startWidth: width };
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          setWidth(
            clamp(
              drag.current.startWidth + event.clientX - drag.current.startX,
            ),
          );
        }}
        onPointerUp={(event) => {
          if (!drag.current) return;
          const next = clamp(
            drag.current.startWidth + event.clientX - drag.current.startX,
          );
          drag.current = undefined;
          setWidth(next);
          storeWidth(id, next);
        }}
        role="separator"
        tabIndex={0}
        title="Drag to resize · double-click to reset"
      />
      {children}
    </div>
  );
}
