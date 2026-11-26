/**
 * The card a box of the factory page shows while the pointer rests on it.
 * `useBlockCard` gives the box its pointer handlers and the card to draw.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { BlockTip } from "./factory-tip";
import { tipHome, TIP_HOVER_MS } from "./title-tips";

const GAP = 6;
const EDGE = 8;

/** Parts of a box with a tip of their own: the card stays away from them. */
const OWN_TIP = ".factory-member, .factory-block-time, .factory-threads";

function Card({ anchor, tip }: { anchor: HTMLElement; tip: BlockTip }) {
  const card = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number }>();
  // Under the box and in line with its left edge; over it when there is no
  // room under, and inside the window either way.
  useLayoutEffect(() => {
    const own = card.current;
    if (!own) return;
    const box = anchor.getBoundingClientRect();
    const left = Math.max(
      EDGE,
      Math.min(box.left, window.innerWidth - EDGE - own.offsetWidth),
    );
    const under = box.bottom + GAP;
    const fits = under + own.offsetHeight <= window.innerHeight - EDGE;
    const top = fits ? under : Math.max(EDGE, box.top - GAP - own.offsetHeight);
    setPlace({ left, top });
  }, [anchor, tip]);
  return (
    <div
      className={`factory-tip is-${tip.state} ${place ? "is-placed" : ""}`}
      ref={card}
      role="tooltip"
      style={place}
    >
      <div className="factory-tip-head">
        <span className="factory-tip-state">
          <span className="factory-dot" />
          {tip.stateText}
        </span>
        <span className="factory-tip-kind">{tip.kind}</span>
      </div>
      <div className="factory-tip-title">{tip.title}</div>
      {(tip.owner || tip.started) && (
        <div className="factory-tip-meta">
          {tip.owner && <span className="factory-tip-owner">@{tip.owner}</span>}
          {tip.started && <span>started {tip.started}</span>}
        </div>
      )}
      {tip.needs.length > 0 && (
        <div className="factory-tip-part">
          <span className="factory-tip-label">Needs</span>
          <span className="factory-tip-needs">
            {tip.needs.map((need) => (
              <span className="factory-tip-need" key={need}>
                {need}
              </span>
            ))}
          </span>
        </div>
      )}
      {tip.parts.map((part) => (
        <div className="factory-tip-part" key={part.label}>
          <span className="factory-tip-label">{part.label}</span>
          <p className="factory-tip-text">{part.text}</p>
        </div>
      ))}
      {tip.outputs.length > 0 && (
        <div className="factory-tip-part">
          <span className="factory-tip-label">Outputs</span>
          <dl className="factory-tip-outputs">
            {tip.outputs.map((output) => (
              <div key={output.name}>
                <dt>{output.name}</dt>
                <dd>{output.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

/**
 * A box's card: it shows after the pointer rested on the box as long as
 * any tip in the app waits, and goes on leaving, a press, a scroll and
 * Escape.
 */
export function useBlockCard(tip: () => BlockTip): {
  card: ReactNode;
  handlers: {
    onMouseDown: () => void;
    onMouseLeave: () => void;
    onMouseOver: (event: MouseEvent<HTMLElement>) => void;
  };
} {
  const [anchor, setAnchor] = useState<HTMLElement>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hide = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setAnchor(undefined);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!anchor) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", hide, { capture: true, passive: true });
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, [anchor]);
  const home =
    anchor?.closest<HTMLElement>(".factory-page") ??
    (typeof document === "undefined" ? undefined : tipHome());
  return {
    card:
      anchor && home
        ? createPortal(<Card anchor={anchor} tip={tip()} />, home)
        : null,
    handlers: {
      onMouseDown: hide,
      onMouseLeave: hide,
      onMouseOver: (event) => {
        const box = event.currentTarget;
        if ((event.target as Element).closest(OWN_TIP)) return hide();
        if (anchor || timer.current) return;
        timer.current = setTimeout(() => {
          timer.current = undefined;
          if (box.isConnected) setAnchor(box);
        }, TIP_HOVER_MS);
      },
    },
  };
}
