/**
 * The wires of the factory page. `StepWires` joins the boxes of one row:
 * a curve from each box to the boxes that need it, with a port at both
 * ends and a dot that travels into the box being worked on. `LayerWires`
 * joins an opened box to the row it opened under it.
 *
 * Both measure the boxes on screen, since a row lays itself out.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { FactoryBlockDto, FactoryLevelDto } from "@daedalus/protocol";

type WireState = "done" | "doing" | "waiting" | "todo";

interface Wire {
  key: string;
  d: string;
  state: WireState;
  from: [number, number];
  to: [number, number];
}

/** How far the work has come along a wire into `to`. */
function wireState(from: FactoryBlockDto, to: FactoryBlockDto): WireState {
  if (from.state !== "done") return "todo";
  return to.state === "done" || to.state === "doing" || to.state === "waiting"
    ? to.state
    : "todo";
}

const boxOf = (root: Element, key: string) =>
  root.querySelector<HTMLElement>(`[data-block="${CSS.escape(key)}"]`);

/**
 * Measures after every render, and again when `root` changes size or
 * something in it scrolls. `read` returns the wires, in `root`'s own
 * coordinates; the state changes only when they do.
 */
function useWires(
  root: RefObject<Element | null>,
  read: (root: Element, box: DOMRect) => Wire[],
): Wire[] {
  const [wires, setWires] = useState<Wire[]>([]);
  const last = useRef("");
  const reader = useRef(read);
  reader.current = read;
  const measure = () => {
    const element = root.current;
    if (!element) return;
    const found = reader.current(element, element.getBoundingClientRect());
    const text = JSON.stringify(found);
    if (text === last.current) return;
    last.current = text;
    setWires(found);
  };
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener("scroll", measure, true);
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", measure, true);
    };
    // `measure` reads through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return wires;
}

const round = (value: number) => Math.round(value * 2) / 2;

/** The wires between the boxes of a level, drawn inside its row. */
export function StepWires({ level }: { level: FactoryLevelDto }) {
  const svg = useRef<SVGSVGElement>(null);
  const wires = useWires(svg, (element, box) => {
    const row = element.parentElement;
    if (!row) return [];
    const byKey = new Map(level.blocks.map((block) => [block.key, block]));
    return level.blocks.flatMap((to) => {
      // A box that names nothing comes after everything one column back.
      const before = to.needs.length
        ? to.needs.flatMap((key) => byKey.get(key) ?? [])
        : level.ordered && to.column > 0
          ? level.blocks.filter((block) => block.column === to.column - 1)
          : [];
      const target = boxOf(row, to.key)?.getBoundingClientRect();
      if (!target) return [];
      return before.flatMap((from) => {
        const source = boxOf(row, from.key)?.getBoundingClientRect();
        if (!source) return [];
        const x1 = round(source.right - box.left);
        const y1 = round(source.top + source.height / 2 - box.top);
        const x2 = round(target.left - box.left);
        const y2 = round(target.top + target.height / 2 - box.top);
        const bend = Math.max(14, (x2 - x1) / 2);
        return {
          key: `${from.key}>${to.key}`,
          d: `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`,
          state: wireState(from, to),
          from: [x1, y1],
          to: [x2, y2],
        } satisfies Wire;
      });
    });
  });
  return (
    <svg aria-hidden="true" className="factory-wires" ref={svg}>
      {wires.map((wire) => (
        <g className={`factory-wire is-${wire.state}`} key={wire.key}>
          <path d={wire.d} />
          <circle
            className="factory-port"
            cx={wire.from[0]}
            cy={wire.from[1]}
            r={3}
          />
          <circle
            className="factory-port is-in"
            cx={wire.to[0]}
            cy={wire.to[1]}
            r={3}
          />
          {wire.state === "doing" && (
            <circle
              className="factory-wire-dot"
              r={3.5}
              style={{ offsetPath: `path("${wire.d}")` }}
            />
          )}
        </g>
      ))}
    </svg>
  );
}

/**
 * The wires from each opened box down to the row it opened. `opened` are
 * the opened boxes from the top row down; the row of the first is marked
 * `data-port="1"` in its header, and so on.
 */
export function LayerWires({ opened }: { opened: readonly FactoryBlockDto[] }) {
  const svg = useRef<SVGSVGElement>(null);
  const wires = useWires(svg, (element, box) => {
    const section = element.parentElement;
    if (!section) return [];
    return opened.flatMap((block, index) => {
      const source = boxOf(section, block.key)?.getBoundingClientRect();
      const port = section
        .querySelector(`[data-port="${index + 1}"]`)
        ?.getBoundingClientRect();
      if (!source || !port) return [];
      // Out of the box's left side, down the gap beside its column, along
      // the line between the two rows, then into the port. A wire that
      // dropped straight down would cross a box standing under this one.
      const x1 = round(source.left - box.left);
      const y1 = round(source.bottom - 14 - box.top);
      const x2 = round(port.left + port.width / 2 - box.left);
      const y2 = round(port.top + port.height / 2 - box.top);
      const gap = x1 - 10;
      const turn = y2 - 20;
      const side = x2 > gap ? 1 : -1;
      const r = Math.min(8, Math.abs(x2 - gap) / 2);
      return {
        key: block.key,
        d: [
          `M${x1} ${y1}`,
          `Q${gap} ${y1} ${gap} ${y1 + 10}`,
          `V${turn - r}`,
          `Q${gap} ${turn} ${gap + side * r} ${turn}`,
          `H${x2 - side * r}`,
          `Q${x2} ${turn} ${x2} ${turn + r}`,
          `V${y2}`,
        ].join(" "),
        state:
          block.state === "done" ||
          block.state === "doing" ||
          block.state === "waiting"
            ? block.state
            : "todo",
        from: [x1, y1],
        to: [x2, y2],
      } satisfies Wire;
    });
  });
  return (
    <svg aria-hidden="true" className="factory-wires is-layers" ref={svg}>
      {wires.map((wire) => (
        <g className={`factory-wire is-layer is-${wire.state}`} key={wire.key}>
          <path d={wire.d} />
          <circle
            className="factory-port is-in"
            cx={wire.from[0]}
            cy={wire.from[1]}
            r={3.5}
          />
        </g>
      ))}
    </svg>
  );
}
