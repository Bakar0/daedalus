// The Map tab on a fake client, for scripts/map-ui-check.ts. It renders the
// real FlowMapView over sample data; window.mapTest changes the data the way
// an agent's `daedal flow` commands would, and bumps the revision as the
// host does when its fingerprint moves.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  FlowComponentDto,
  FlowMapDetailDto,
  FlowRelationDto,
  FlowStageDto,
  TaskDto,
  WorkspaceDto,
} from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { FlowMapView } from "./flow-map/FlowMapView";
import type { StageSession } from "./flow-map/model";
import "./styles.css";

const component = (
  id: string,
  number: number,
  parentId: string | null,
  name: string,
  deliverable: string,
  extra: Partial<FlowComponentDto> = {},
): FlowComponentDto => ({
  id,
  parentId,
  number,
  position: number,
  name,
  deliverable,
  doneWhen: "",
  taskId: null,
  droppedReason: null,
  ...extra,
});

let stageNumber = 0;
const stage = (
  componentId: string,
  kind: FlowStageDto["kind"],
  shown: FlowStageDto["shown"] = "todo",
  extra: Partial<FlowStageDto> = {},
): FlowStageDto => ({
  id: `stage-${stageNumber++}`,
  componentId,
  kind,
  position: stageNumber,
  mode: "own",
  label: null,
  state: shown === "waiting" ? "todo" : shown,
  shown,
  note: null,
  sessionId: null,
  startedAt: null,
  finishedAt: null,
  droppedReason: null,
  ...extra,
});

let relationNumber = 0;
const relation = (
  fromId: string,
  toId: string,
  type: FlowRelationDto["type"],
  note: string | null,
  droppedReason: string | null = null,
): FlowRelationDto => ({
  id: `relation-${++relationNumber}`,
  number: relationNumber,
  fromId,
  toId,
  type,
  note,
  droppedReason,
});

const sample = (): FlowMapDetailDto => ({
  map: {
    id: "map-1",
    workspaceId: "shop",
    number: 1,
    name: "Checkout",
    updatedAt: "2026-10-13T08:00:00.000Z",
  },
  components: [
    component(
      "root",
      1,
      null,
      "Checkout",
      "A customer pays for an order end to end",
    ),
    component(
      "web",
      2,
      "root",
      "Web client",
      "Checkout screens in the storefront",
    ),
    component(
      "page",
      3,
      "web",
      "Checkout page",
      "Cart summary and Place order",
      {
        taskId: "task-12",
      },
    ),
    component(
      "form",
      4,
      "web",
      "Payment form",
      "Card entry with Stripe Elements",
    ),
    component("api", 5, "root", "API server", "Orders and payments over REST"),
    component(
      "orders",
      6,
      "api",
      "Orders API",
      "POST /orders, GET /orders/:id",
    ),
    component(
      "payments",
      7,
      "api",
      "Payments service",
      "Payment intents and the webhook",
    ),
    component("data", 8, "root", "Data", "Where orders live"),
    component("db", 9, "data", "Orders DB", "Postgres schema and migrations"),
    component(
      "worker",
      10,
      "data",
      "Receipt worker",
      "Emails a receipt per paid order",
    ),
    component("fraud", 11, "root", "Fraud service", "Scores orders", {
      droppedReason: "Stripe Radar scores orders already",
    }),
  ],
  relations: [
    relation("page", "orders", "calls", "REST /orders"),
    relation("form", "payments", "calls", "REST /payments"),
    relation("payments", "worker", "publishes to", "order.paid"),
    relation("orders", "db", "writes to", "orders"),
    relation("worker", "db", "reads from", "orders"),
    relation("page", "form", "depends on", "card token"),
    relation("orders", "fraud", "calls", "score", "Dropped with the service"),
  ],
  stages: [
    stage("root", "research", "done"),
    stage("root", "plan", "done"),
    stage("root", "implement", "running", { mode: "rollup" }),
    stage("root", "validate", "waiting", {
      mode: "after",
      label: "integration",
    }),
    stage("root", "deploy", "waiting", { mode: "after", label: "release" }),
    stage("web", "implement", "running", { mode: "rollup" }),
    stage("web", "validate", "waiting", { mode: "after", label: "e2e" }),
    stage("page", "plan", "done", { sessionId: "s-builder" }),
    stage("page", "implement", "running", { sessionId: "s-builder" }),
    stage("page", "validate"),
    stage("form", "research", "done", { sessionId: "s-designer" }),
    stage("form", "prototype", "running", { sessionId: "s-designer" }),
    stage("form", "implement"),
    stage("api", "implement", "running", { mode: "rollup" }),
    stage("api", "validate", "running", { mode: "rollup" }),
    stage("orders", "plan", "done"),
    stage("orders", "implement", "done"),
    stage("orders", "validate", "running", { sessionId: "s-tester" }),
    stage("payments", "plan", "done"),
    stage("payments", "implement", "running", { sessionId: "s-gone" }),
    stage("payments", "validate"),
    stage("data", "implement", "done", { mode: "rollup" }),
    stage("db", "implement", "done"),
    stage("worker", "implement", "blocked", {
      note: "Waiting for the order.paid event shape",
    }),
    stage("fraud", "research", "done"),
  ],
  decisions: [
    {
      id: 1,
      componentId: "root",
      text: "Three parts: web client, API server, data. A fraud service was considered and dropped.",
      author: "Mapper",
      createdAt: "2026-10-12T09:00:00.000Z",
    },
    {
      id: 2,
      componentId: "form",
      text: "Stripe Elements, not a custom card field: PCI scope stays with Stripe.",
      author: "Designer",
      createdAt: "2026-10-12T10:00:00.000Z",
    },
  ],
  history: [
    {
      id: 2,
      text: "Started implement on 'Checkout page'",
      author: "Builder",
      createdAt: "2026-10-13T07:50:00.000Z",
    },
    {
      id: 1,
      text: "Started the map 'Checkout'",
      author: "Mapper",
      createdAt: "2026-10-12T08:00:00.000Z",
    },
  ],
});

const sessions = new Map<string, StageSession>([
  [
    "s-builder",
    {
      id: "s-builder",
      workspaceId: "shop",
      name: "Builder",
      provider: "claude",
      live: true,
      activity: "working",
      question: null,
    },
  ],
  [
    "s-designer",
    {
      id: "s-designer",
      workspaceId: "shop",
      name: "Designer",
      provider: "codex",
      live: true,
      activity: "needs_input",
      question: "Card form on one line or two?",
    },
  ],
  [
    "s-tester",
    {
      id: "s-tester",
      workspaceId: "shop",
      name: "Tester",
      provider: "claude",
      live: true,
      activity: "working",
      question: null,
    },
  ],
  [
    "s-gone",
    {
      id: "s-gone",
      workspaceId: "shop",
      name: "Payments agent",
      provider: "claude",
      live: false,
      activity: null,
      question: null,
    },
  ],
]);

const task: TaskDto = {
  id: "task-12",
  workspaceId: "shop",
  number: 12,
  title: "Checkout page",
} as TaskDto;

const workspace = { id: "shop", name: "Shop", slug: "shop" } as WorkspaceDto;

let detail = sample();
const calls: string[] = [];
const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
const client = {
  request: {
    flowMaps: () => {
      calls.push("flowMaps");
      return ok([detail.map]);
    },
    flowMap: () => {
      calls.push("flowMap");
      return ok(structuredClone(detail));
    },
  },
} as unknown as DesktopClient;

const listeners = new Set<() => void>();
const opened: string[] = [];

declare global {
  interface Window {
    mapTest: {
      calls: string[];
      opened: string[];
      /** The builder finishes implement and starts validate. */
      advance: () => void;
      theme: (theme: "dark" | "light") => void;
    };
  }
}

window.mapTest = {
  calls,
  opened,
  advance() {
    detail = structuredClone(detail);
    for (const item of detail.stages) {
      if (item.componentId !== "page") continue;
      if (item.kind === "implement") item.state = item.shown = "done";
      if (item.kind === "validate") {
        item.state = item.shown = "running";
        item.sessionId = "s-builder";
      }
    }
    detail.history.unshift({
      id: 3,
      text: "Finished implement on 'Checkout page'",
      author: "Builder",
      createdAt: "2026-10-13T08:10:00.000Z",
    });
    for (const listener of listeners) listener();
  },
  theme(theme) {
    document.querySelector(".app")?.setAttribute("data-theme", theme);
  },
};

function Page() {
  const [revision, setRevision] = useState(1);
  useEffect(() => {
    const listener = () => setRevision((value) => value + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return (
    <div
      className="app"
      data-theme="dark"
      style={{ display: "flex", flexDirection: "column", padding: "0 20px" }}
    >
      <FlowMapView
        client={client}
        dataRevision={revision}
        onError={(message) => {
          throw new Error(message);
        }}
        onOpenSession={(session) => opened.push(`session:${session.id}`)}
        onOpenTask={(item) => opened.push(`task:${item.id}`)}
        sessions={sessions}
        tasks={new Map([[task.id, task]])}
        workspace={workspace}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
