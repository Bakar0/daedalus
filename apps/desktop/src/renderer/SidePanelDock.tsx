/**
 * The bottom of the side panel: the Workflow and Custom instructions panes,
 * under whichever tab is open. It stays at the bottom however little the tab
 * shows, fits its panes until the user drags its top edge, and then keeps the
 * height they chose. A double click on the edge gives the fitted size back.
 */
import { useRef, useState, type ReactNode } from "react";
import { remember, remembered } from "./WorkflowPane";

const HEIGHT_KEY = "daedalus.sidePanelDock.height";
const MIN_HEIGHT = 72;

export function SidePanelDock({ children }: { children: ReactNode }) {
  // Null fits the panes; a number is the height the user dragged to.
  const [height, setHeight] = useState<number | null>(
    () => Number(remembered(HEIGHT_KEY)) || null,
  );
  const dock = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  return (
    <div
      className="side-panel-dock"
      ref={dock}
      style={height === null ? undefined : { height }}
    >
      <div
        aria-label="Resize workflow and custom instructions"
        aria-orientation="horizontal"
        className="side-panel-dock-edge"
        onDoubleClick={() => {
          setHeight(null);
          remember(HEIGHT_KEY, "");
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            startY: event.clientY,
            startHeight: dock.current?.getBoundingClientRect().height ?? 0,
          };
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const limit = Math.max(MIN_HEIGHT, window.innerHeight * 0.75);
          setHeight(
            Math.round(
              Math.min(
                limit,
                Math.max(
                  MIN_HEIGHT,
                  drag.current.startHeight +
                    (drag.current.startY - event.clientY),
                ),
              ),
            ),
          );
        }}
        onPointerUp={() => {
          drag.current = null;
          if (height !== null) remember(HEIGHT_KEY, String(height));
        }}
        role="separator"
        title="Drag to resize; double-click to fit"
      />
      {children}
    </div>
  );
}
