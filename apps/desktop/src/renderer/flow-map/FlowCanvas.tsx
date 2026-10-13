import { useLayoutEffect, useRef, useState } from "react";
import type {
  FlowComponentDto,
  FlowMapDetailDto,
  TaskDto,
} from "@daedalus/protocol";
import { FlowLine } from "./FlowLine";
import {
  RELATION_STYLES,
  childrenOf,
  relationLabel,
  relationStyle,
  rootOf,
  stagesOf,
  visibleRelations,
  type StageSession,
  type VisibleRelation,
} from "./model";

interface Edge {
  line: VisibleRelation;
  d: string;
  labelX: number;
  labelY: number;
}

interface Box {
  l: number;
  r: number;
  t: number;
  b: number;
}

const markerId = (pattern: string) => `flow-arrow-${pattern}`;

/** How many decisions a box shows before "n earlier". */
const DECISIONS_SHOWN = 2;

export interface FlowCanvasProps {
  detail: FlowMapDetailDto;
  collapsed: ReadonlySet<string>;
  showDropped: boolean;
  showRelations: boolean;
  sessions: ReadonlyMap<string, StageSession>;
  tasks: ReadonlyMap<string, TaskDto>;
  onToggleCollapse: (componentId: string) => void;
  onOpenSession: (session: StageSession) => void;
  onOpenTask: (task: TaskDto) => void;
}

/**
 * The architecture canvas: the root is a frame, its components are columns,
 * and what they contain are boxes inside them, nested as deep as the map
 * goes. Relations are lines between boxes, drawn over them, each in its
 * type's colour and pattern. A collapsed component shows only its head and
 * flow, and the relations of what it contains attach to it.
 */
export function FlowCanvas(props: FlowCanvasProps) {
  const { detail, collapsed, showDropped, showRelations } = props;
  const canvas = useRef<HTMLDivElement>(null);
  const boxes = useRef(new Map<string, HTMLElement>());
  const [edges, setEdges] = useState<Edge[]>([]);
  const [hover, setHover] = useState<string | null>(null);

  const register = (id: string) => (element: HTMLElement | null) => {
    if (element) boxes.current.set(id, element);
    else boxes.current.delete(id);
  };

  useLayoutEffect(() => {
    const measure = () => {
      const base = canvas.current?.getBoundingClientRect();
      if (!base || !showRelations) return setEdges([]);
      setEdges(
        routeEdges(visibleRelations(detail, collapsed, showDropped), (id) => {
          const rect = boxes.current.get(id)?.getBoundingClientRect();
          return rect
            ? {
                l: rect.left - base.left,
                r: rect.right - base.left,
                t: rect.top - base.top,
                b: rect.bottom - base.top,
              }
            : undefined;
        }),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (canvas.current) {
      observer.observe(canvas.current);
      for (const element of boxes.current.values()) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [detail, collapsed, showDropped, showRelations]);

  const root = rootOf(detail);
  if (!root) return null;
  const lit = (line: VisibleRelation) =>
    hover !== null && (line.from === hover || line.to === hover);

  return (
    <div
      className="flow-canvas"
      onMouseLeave={() => setHover(null)}
      onMouseOver={(event) => {
        const box = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-component]",
        );
        setHover(box?.dataset.component ?? null);
      }}
      ref={canvas}
    >
      <div
        className={`flow-frame ${hover === root.id ? "flow-hover" : ""}`}
        data-component={root.id}
        ref={register(root.id)}
      >
        <ComponentHead component={root} {...props} />
        <div className="flow-columns">
          {childrenOf(detail, root.id, showDropped).map((column) => (
            <ComponentBox
              component={column}
              depth={1}
              hover={hover}
              key={column.id}
              register={register}
              {...props}
            />
          ))}
        </div>
      </div>
      <svg
        aria-hidden="true"
        className={`flow-edges ${hover ? "flow-edges-faded" : ""}`}
      >
        <defs>
          {RELATION_STYLES.map((style) => (
            <marker
              className={`flow-marker flow-marker-${style.pattern}`}
              id={markerId(style.pattern)}
              key={style.pattern}
              markerHeight="7"
              markerWidth="7"
              orient="auto-start-reverse"
              refX="9"
              refY="5"
              viewBox="0 0 10 10"
            >
              <path
                className={
                  style.filled ? "flow-marker-filled" : "flow-marker-open"
                }
                d="M0,0 L10,5 L0,10 z"
              />
            </marker>
          ))}
        </defs>
        {edges.map((edge) => {
          const style = relationStyle(edge.line.type);
          return (
            <path
              className={[
                "flow-edge",
                `flow-edge-${style.pattern}`,
                edge.line.dropped ? "flow-edge-dropped" : "",
                lit(edge.line) ? "flow-edge-on" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              d={edge.d}
              data-relation={edge.line.key}
              key={edge.line.key}
              markerEnd={`url(#${markerId(style.pattern)})`}
            />
          );
        })}
      </svg>
      {/* Labels in their own layer above the boxes, so none hides behind one. */}
      <svg
        aria-hidden="true"
        className={`flow-edges flow-edge-labels ${hover ? "flow-edges-faded" : ""}`}
      >
        {edges.map((edge) => (
          <text
            className={[
              "flow-edge-label",
              `flow-edge-label-${relationStyle(edge.line.type).pattern}`,
              edge.line.dropped ? "flow-edge-dropped" : "",
              lit(edge.line) ? "flow-edge-on" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            key={edge.line.key}
            textAnchor="middle"
            x={edge.labelX}
            y={edge.labelY}
          >
            {relationLabel(edge.line)}
          </text>
        ))}
      </svg>
    </div>
  );
}

function ComponentBox(
  props: FlowCanvasProps & {
    component: FlowComponentDto;
    depth: number;
    hover: string | null;
    register: (id: string) => (element: HTMLElement | null) => void;
  },
) {
  const { component, depth, detail, showDropped, collapsed, hover } = props;
  const inside = childrenOf(detail, component.id, showDropped);
  const shut = collapsed.has(component.id);
  return (
    <div
      className={[
        depth === 1 ? "flow-column" : "flow-box",
        component.droppedReason !== null ? "flow-dropped" : "",
        hover === component.id ? "flow-hover" : "",
        shut ? "flow-collapsed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-component={component.id}
      ref={props.register(component.id)}
    >
      <ComponentHead {...props} canCollapse={inside.length > 0} />
      {!shut && inside.length ? (
        <div className="flow-inside">
          {inside.map((child) => (
            <ComponentBox
              {...props}
              component={child}
              depth={depth + 1}
              key={child.id}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ComponentHead(
  props: FlowCanvasProps & {
    component: FlowComponentDto;
    canCollapse?: boolean;
  },
) {
  const { component, detail, collapsed, showDropped } = props;
  const [allDecisions, setAllDecisions] = useState(false);
  const task = component.taskId ? props.tasks.get(component.taskId) : undefined;
  const decisions = detail.decisions.filter(
    (decision) => decision.componentId === component.id,
  );
  const shown = allDecisions ? decisions : decisions.slice(-DECISIONS_SHOWN);
  return (
    <div className="flow-head">
      <div className="flow-title">
        {props.canCollapse ? (
          <button
            aria-expanded={!collapsed.has(component.id)}
            aria-label={`${collapsed.has(component.id) ? "Expand" : "Collapse"} ${component.name}`}
            className="quiet flow-caret"
            onClick={() => props.onToggleCollapse(component.id)}
            type="button"
          >
            {collapsed.has(component.id) ? "▸" : "▾"}
          </button>
        ) : null}
        <span className="flow-name">{component.name}</span>
        <span className="flow-number">#{component.number}</span>
        {task ? (
          <button
            className="quiet flow-task-chip"
            onClick={() => props.onOpenTask(task)}
            title={task.title}
            type="button"
          >
            task #{task.number}
          </button>
        ) : null}
      </div>
      {component.droppedReason !== null ? (
        <div className="flow-reason">Dropped: {component.droppedReason}</div>
      ) : (
        <div
          className="flow-deliverable"
          title={
            component.doneWhen ? `Done when: ${component.doneWhen}` : undefined
          }
        >
          {component.deliverable}
        </div>
      )}
      <FlowLine
        onOpenSession={props.onOpenSession}
        sessions={props.sessions}
        stages={stagesOf(detail, component.id, showDropped)}
      />
      {shown.length ? (
        <ul className="flow-decisions">
          {decisions.length > shown.length ? (
            <li>
              <button
                className="quiet flow-link"
                onClick={() => setAllDecisions(true)}
                type="button"
              >
                {decisions.length - shown.length} earlier
              </button>
            </li>
          ) : null}
          {shown.map((decision) => (
            <li
              key={decision.id}
              title={`${decision.author}, ${decision.createdAt}`}
            >
              {decision.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Routes each relation line from one box's side to another's. Ends that meet
 * one side of a box spread along it, ordered by where the other end is, so
 * lines into one box do not meet at a point. Boxes stacked in one column get
 * a loop out to the right, each loop a little wider than the last.
 */
export function routeEdges(
  lines: readonly VisibleRelation[],
  rect: (id: string) => Box | undefined,
): Edge[] {
  interface Plan {
    line: VisibleRelation;
    a: Box;
    b: Box;
    mode: "lr" | "rl" | "loop";
    aSide: "l" | "r";
    bSide: "l" | "r";
    ay: number;
    by: number;
  }
  const plans: Plan[] = [];
  for (const line of lines) {
    const a = rect(line.from);
    const b = rect(line.to);
    if (!a || !b) continue;
    const mode = a.r < b.l ? "lr" : b.r < a.l ? "rl" : "loop";
    plans.push({
      line,
      a,
      b,
      mode,
      aSide: mode === "rl" ? "l" : "r",
      bSide: mode === "lr" ? "l" : "r",
      ay: (a.t + a.b) / 2,
      by: (b.t + b.b) / 2,
    });
  }
  const ports = new Map<string, Array<{ plan: Plan; end: "a" | "b" }>>();
  for (const plan of plans)
    for (const end of ["a", "b"] as const) {
      const id = end === "a" ? plan.line.from : plan.line.to;
      const key = `${id}:${end === "a" ? plan.aSide : plan.bSide}`;
      ports.set(key, [...(ports.get(key) ?? []), { plan, end }]);
    }
  for (const list of ports.values()) {
    const otherY = (port: { plan: Plan; end: "a" | "b" }) => {
      const other = port.end === "a" ? port.plan.b : port.plan.a;
      return (other.t + other.b) / 2;
    };
    list.sort((x, y) => otherY(x) - otherY(y));
    list.forEach((port, index) => {
      const box = port.end === "a" ? port.plan.a : port.plan.b;
      // Keep clear of the head, where the name and flow line sit.
      const top = box.t + Math.min(18, (box.b - box.t) / 3);
      const y = top + ((box.b - top) * (index + 1)) / (list.length + 1);
      if (port.end === "a") port.plan.ay = y;
      else port.plan.by = y;
    });
  }
  let loops = 0;
  return plans.map(({ line, a, b, mode, ay, by }) => {
    if (mode === "lr") {
      const mid = (a.r + b.l) / 2;
      return {
        line,
        d: `M${a.r},${ay} C${mid},${ay} ${mid},${by} ${b.l},${by}`,
        labelX: mid,
        labelY: (ay + by) / 2 - 5,
      };
    }
    if (mode === "rl") {
      const mid = (b.r + a.l) / 2;
      return {
        line,
        d: `M${a.l},${ay} C${mid},${ay} ${mid},${by} ${b.r},${by}`,
        labelX: mid,
        labelY: (ay + by) / 2 - 5,
      };
    }
    const out = Math.max(a.r, b.r) + 28 + 14 * loops++;
    return {
      line,
      d: `M${a.r},${ay} C${out},${ay} ${out},${by} ${b.r},${by}`,
      labelX: out - 6,
      labelY: (ay + by) / 2 - 5,
    };
  });
}
