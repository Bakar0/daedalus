import { describe, expect, test } from "vitest";
import type {
  FlowComponent,
  FlowStage,
  FlowStageKind,
  FlowStageMode,
  FlowStageState,
} from "../domain";
import { componentShownState, liveComponentIds, shownStages } from "./flow-rollup";

const component = (
  id: string,
  parentId: string | null,
  droppedReason: string | null = null,
): FlowComponent => ({
  id,
  mapId: "m",
  parentId,
  number: 0,
  position: 0,
  name: id,
  deliverable: "",
  doneWhen: "",
  taskId: null,
  droppedReason,
  droppedAt: droppedReason ? "now" : null,
  createdAt: "now",
  updatedAt: "now",
});

let next = 0;
const stage = (
  componentId: string,
  kind: FlowStageKind,
  state: FlowStageState = "todo",
  mode: FlowStageMode = "own",
): FlowStage => ({
  id: `s${next++}`,
  componentId,
  kind,
  position: next,
  mode,
  label: null,
  state,
  note: null,
  sessionId: null,
  startedAt: null,
  finishedAt: null,
  droppedReason: null,
  droppedAt: null,
});

const shown = (
  components: FlowComponent[],
  stages: FlowStage[],
  componentId: string,
) =>
  shownStages(components, stages)
    .filter((s) => s.componentId === componentId)
    .map((s) => `${s.kind}:${s.shown}`);

describe("flow rollup", () => {
  const tree = [
    component("root", null),
    component("api", "root"),
    component("web", "root"),
  ];

  test("a rollup stage follows the components inside", () => {
    const parent = stage("root", "implement", "todo", "rollup");
    expect(
      shown(tree, [parent, stage("api", "implement"), stage("web", "implement")], "root"),
    ).toEqual(["implement:todo"]);
    expect(
      shown(
        tree,
        [parent, stage("api", "implement", "running"), stage("web", "implement")],
        "root",
      ),
    ).toEqual(["implement:running"]);
    // One finished and one not started still means the work is under way.
    expect(
      shown(tree, [parent, stage("api", "implement", "done"), stage("web", "implement")], "root"),
    ).toEqual(["implement:running"]);
    expect(
      shown(
        tree,
        [parent, stage("api", "implement", "done"), stage("web", "implement", "skipped")],
        "root",
      ),
    ).toEqual(["implement:done"]);
    expect(
      shown(
        tree,
        [parent, stage("api", "implement", "blocked"), stage("web", "implement", "running")],
        "root",
      ),
    ).toEqual(["implement:blocked"]);
    // Nothing inside has the kind: there is nothing to do.
    expect(shown(tree, [parent, stage("api", "plan")], "root")).toEqual(["implement:skipped"]);
  });

  test("a container cannot show done while something inside still runs, whatever was stored", () => {
    const parent = stage("root", "implement", "done", "rollup");
    expect(
      shown(tree, [parent, stage("api", "implement", "running")], "root"),
    ).toEqual(["implement:running"]);
  });

  test("an after stage waits for the components inside, then shows what the agent set", () => {
    const integration = stage("root", "validate", "todo", "after");
    const base = [stage("api", "validate", "done"), stage("web", "validate", "running")];
    expect(shown(tree, [integration, ...base], "root")).toEqual(["validate:waiting"]);
    expect(
      shown(tree, [integration, base[0]!, stage("web", "validate", "done")], "root"),
    ).toEqual(["validate:todo"]);
    // A component with no stage of that kind must finish its whole flow.
    const release = stage("root", "deploy", "todo", "after");
    expect(
      shown(tree, [release, stage("api", "implement", "done"), stage("web", "implement", "running")], "root"),
    ).toEqual(["deploy:waiting"]);
  });

  test("rollups nest through several levels", () => {
    const deep = [...tree, component("orders", "api")];
    const stages = [
      stage("root", "implement", "todo", "rollup"),
      stage("api", "implement", "todo", "rollup"),
      stage("orders", "implement", "running"),
    ];
    expect(shown(deep, stages, "api")).toEqual(["implement:running"]);
    expect(shown(deep, stages, "root")).toEqual(["implement:running"]);
  });

  test("dropped components and stages leave the rollup", () => {
    const withDropped = [...tree, component("fraud", "root", "Stripe Radar does it")];
    const parent = stage("root", "implement", "todo", "rollup");
    const droppedStage = { ...stage("web", "implement", "running"), droppedReason: "no", droppedAt: "now" };
    expect(
      shown(
        withDropped,
        [parent, stage("api", "implement", "done"), droppedStage, stage("fraud", "implement", "running")],
        "root",
      ),
    ).toEqual(["implement:done"]);
    expect(liveComponentIds([...withDropped, component("rules", "fraud")])).toEqual(
      new Set(["root", "api", "web"]),
    );
  });

  test("a component's state for its box", () => {
    const list = (states: FlowStageState[]) =>
      componentShownState(
        shownStages(tree, states.map((state) => stage("api", "plan", state))),
      );
    expect(list([])).toBe("todo");
    expect(list(["done", "skipped"])).toBe("done");
    expect(list(["done", "todo"])).toBe("running");
    expect(list(["blocked", "running"])).toBe("blocked");
  });
});
