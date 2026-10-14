import { describe, expect, test } from "vitest";
import type {
  FlowComponentDto,
  FlowMapDetailDto,
  FlowRelationDto,
} from "@daedalus/protocol";
import { routeEdges } from "./FlowCanvas";
import {
  ancestorsOf,
  childrenOf,
  relationLabel,
  segmentLook,
  stageHeartbeat,
  visibleRelations,
  type StageSession,
} from "./model";

const component = (
  id: string,
  parentId: string | null,
  position = 0,
  droppedReason: string | null = null,
): FlowComponentDto => ({
  id,
  parentId,
  number: 0,
  position,
  name: id,
  deliverable: `${id} works`,
  doneWhen: "",
  taskId: null,
  droppedReason,
});

const relation = (
  id: string,
  fromId: string,
  toId: string,
  type: FlowRelationDto["type"] = "calls",
  droppedReason: string | null = null,
): FlowRelationDto => ({
  id,
  number: 0,
  fromId,
  toId,
  type,
  note: `${id} note`,
  droppedReason,
});

/** Checkout: a web client and an API server holding orders and payments. */
const detail = (relations: FlowRelationDto[]): FlowMapDetailDto => ({
  map: {
    id: "m",
    workspaceId: "w",
    number: 1,
    name: "Checkout",
    updatedAt: "now",
  },
  components: [
    component("root", null),
    component("api", "root", 1),
    component("web", "root", 0),
    component("orders", "api", 0),
    component("payments", "api", 1),
    component("fraud", "root", 2, "Radar does it"),
  ],
  relations,
  stages: [],
  decisions: [],
  history: [],
});

describe("the flow map model", () => {
  test("children come in their order, dropped ones only when asked", () => {
    const map = detail([]);
    expect(childrenOf(map, "root", false).map((c) => c.id)).toEqual([
      "web",
      "api",
    ]);
    expect(childrenOf(map, "root", true).map((c) => c.id)).toEqual([
      "web",
      "api",
      "fraud",
    ]);
    expect(ancestorsOf(map, "orders")).toEqual(["api", "root"]);
  });

  test("a collapsed component takes the relations of what it holds, merged with a count", () => {
    const map = detail([
      relation("r1", "web", "orders"),
      relation("r2", "web", "payments"),
      relation("r3", "payments", "orders", "publishes to"),
      relation("r4", "web", "fraud", "depends on"),
    ]);
    const open = visibleRelations(map, new Set(), false);
    expect(open.map((line) => line.key)).toEqual([
      "web>orders>calls",
      "web>payments>calls",
      "payments>orders>publishes to",
    ]);
    const shut = visibleRelations(map, new Set(["api"]), false);
    // The line inside the collapsed box vanishes; two calls become one line.
    expect(shut).toEqual([
      expect.objectContaining({
        key: "web>api>calls",
        count: 2,
        ids: ["r1", "r2"],
      }),
    ]);
    expect(relationLabel(shut[0]!)).toBe("calls · ×2");
    expect(relationLabel(open[0]!)).toBe("calls · r1 note");
    // A relation to a dropped component shows faint, only with dropped on.
    expect(
      visibleRelations(map, new Set(), true).find(
        (line) => line.to === "fraud",
      ),
    ).toMatchObject({ dropped: true });
  });

  test("the heartbeat follows the agent on the stage", () => {
    const session = (overrides: Partial<StageSession>): StageSession => ({
      id: "s",
      workspaceId: "w",
      name: "Builder",
      provider: "claude",
      live: true,
      activity: "working",
      question: null,
      ...overrides,
    });
    const running = { shown: "running" as const, sessionId: "s" };
    expect(stageHeartbeat(running, session({}))).toBe("working");
    expect(stageHeartbeat(running, session({ activity: "needs_input" }))).toBe(
      "attention",
    );
    expect(stageHeartbeat(running, session({ live: false }))).toBe("stalled");
    expect(stageHeartbeat(running, undefined)).toBe("stalled");
    expect(
      stageHeartbeat({ shown: "running", sessionId: null }, undefined),
    ).toBe("working");
    expect(
      stageHeartbeat({ shown: "done", sessionId: "s" }, session({})),
    ).toBeNull();
  });

  test("the line is green up to the stage at work", () => {
    expect(
      ["done", "running", "skipped", "blocked", "waiting", "todo"].map((s) =>
        segmentLook(s as Parameters<typeof segmentLook>[0]),
      ),
    ).toEqual(["lit", "lit", "lit", "blocked", "hold", "dim"]);
  });

  test("ends sharing a side of a box spread out, and a same-column link loops out", () => {
    const boxes: Record<
      string,
      { l: number; r: number; t: number; b: number }
    > = {
      web: { l: 0, r: 100, t: 0, b: 100 },
      orders: { l: 200, r: 300, t: 0, b: 100 },
      payments: { l: 200, r: 300, t: 150, b: 250 },
    };
    const map = detail([
      relation("r1", "web", "orders"),
      relation("r2", "web", "payments"),
      relation("r3", "payments", "orders", "publishes to"),
    ]);
    const edges = routeEdges(
      visibleRelations(map, new Set(), false),
      (id) => boxes[id],
    );
    const starts = edges
      .filter((edge) => edge.line.from === "web")
      .map((edge) => Number(/^M100,([\d.]+)/.exec(edge.d)?.[1]));
    expect(new Set(starts).size).toBe(2);
    expect(edges.find((edge) => edge.line.from === "payments")?.d).toMatch(
      /^M300,/,
    );
  });
});
