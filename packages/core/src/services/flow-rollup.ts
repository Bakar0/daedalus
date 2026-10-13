import type {
  FlowComponent,
  FlowShownStage,
  FlowShownState,
  FlowStage,
  FlowStageKind,
} from "../domain";

const finished = (state: FlowShownState) =>
  state === "done" || state === "skipped";

/**
 * The ids of the components that are still on the map: not dropped, and not
 * inside a dropped component.
 */
export function liveComponentIds(
  components: readonly FlowComponent[],
): Set<string> {
  const byId = new Map(
    components.map((component) => [component.id, component]),
  );
  const live = new Set<string>();
  const isLive = (component: FlowComponent, seen: Set<string>): boolean => {
    if (component.droppedReason !== null) return false;
    if (component.parentId === null) return true;
    if (seen.has(component.id)) return false;
    const parent = byId.get(component.parentId);
    return parent ? isLive(parent, new Set(seen).add(component.id)) : false;
  };
  for (const component of components)
    if (isLive(component, new Set())) live.add(component.id);
  return live;
}

/**
 * Every stage with the state the map shows. An agent's `own` stages show
 * what it set. A container's `rollup` stage is worked out from its live
 * components' stages of the same kind: done when all of them are done or
 * skipped, blocked when one is blocked, running once one has started, and
 * skipped when none has that kind. An `after` stage waits until every live
 * component inside finished its stage of that kind, or its whole flow when it
 * has none of that kind; from then on it shows what the agent set. Nothing
 * computed is stored, so a container never lags behind what it contains.
 */
export function shownStages(
  components: readonly FlowComponent[],
  stages: readonly FlowStage[],
): FlowShownStage[] {
  const live = liveComponentIds(components);
  const children = new Map<string, string[]>();
  for (const component of components) {
    if (component.parentId === null || !live.has(component.id)) continue;
    children.set(component.parentId, [
      ...(children.get(component.parentId) ?? []),
      component.id,
    ]);
  }
  const stagesOf = new Map<string, FlowStage[]>();
  for (const stage of stages)
    stagesOf.set(stage.componentId, [
      ...(stagesOf.get(stage.componentId) ?? []),
      stage,
    ]);

  const memo = new Map<string, FlowShownStage[]>();
  const shownFor = (componentId: string, path: Set<string>) => {
    const cached = memo.get(componentId);
    if (cached) return cached;
    // A cycle cannot be stored, but a broken row must not hang a read.
    if (path.has(componentId)) return [];
    const inner = new Set(path).add(componentId);
    const kids = (children.get(componentId) ?? []).map((id) =>
      shownFor(id, inner).filter((stage) => stage.droppedReason === null),
    );
    const own = (stagesOf.get(componentId) ?? []).map(
      (stage): FlowShownStage => ({
        ...stage,
        shown:
          stage.droppedReason !== null || stage.mode === "own"
            ? stage.state
            : stage.mode === "rollup"
              ? rollup(kids, stage.kind)
              : after(kids, stage),
      }),
    );
    memo.set(componentId, own);
    return own;
  };
  return components.flatMap((component) => shownFor(component.id, new Set()));
}

function rollup(
  kids: readonly FlowShownStage[][],
  kind: FlowStageKind,
): FlowShownState {
  const same = kids.flatMap((list) => list.filter((s) => s.kind === kind));
  if (same.length === 0) return "skipped";
  if (same.every((stage) => finished(stage.shown))) return "done";
  if (same.some((stage) => stage.shown === "blocked")) return "blocked";
  if (same.some((stage) => stage.shown === "running" || finished(stage.shown)))
    return "running";
  return "todo";
}

function after(
  kids: readonly FlowShownStage[][],
  stage: FlowStage,
): FlowShownState {
  if (stage.state === "skipped") return "skipped";
  const ready = kids.every((list) => {
    const same = list.filter((s) => s.kind === stage.kind);
    return (same.length ? same : list).every((s) => finished(s.shown));
  });
  return ready ? stage.state : "waiting";
}

/** One state for a whole component, for tinting its box. */
export function componentShownState(
  stages: readonly FlowShownStage[],
): FlowShownState {
  const current = stages.filter((stage) => stage.droppedReason === null);
  if (current.length === 0) return "todo";
  if (current.every((stage) => finished(stage.shown))) return "done";
  if (current.some((stage) => stage.shown === "blocked")) return "blocked";
  if (current.some((stage) => stage.shown === "running")) return "running";
  if (current.some((stage) => finished(stage.shown))) return "running";
  return current.some((stage) => stage.shown === "waiting")
    ? "waiting"
    : "todo";
}
