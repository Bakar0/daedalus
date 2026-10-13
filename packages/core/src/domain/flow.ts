import type { UUID } from "./index";

/**
 * The stages a component's flow is built from, in their usual order. The set
 * is fixed in code so every map reads the same way; an agent picks which
 * ones a component needs and in what order, but cannot invent one.
 */
export const FLOW_STAGE_KINDS = [
  "research",
  "plan",
  "prototype",
  "implement",
  "validate",
  "deploy",
] as const;

export type FlowStageKind = (typeof FLOW_STAGE_KINDS)[number];

/** What a stage of each kind is for, as the CLI help and the skill say it. */
export const FLOW_STAGE_MEANINGS: Readonly<Record<FlowStageKind, string>> = {
  research: "Find out what is true before deciding: docs, code, options.",
  plan: "Decide the shape: the parts, the contracts, the order.",
  prototype:
    "Throwaway code that answers one design question; the answer is the deliverable, the code stays off the main branch.",
  implement: "Build the deliverable for real.",
  validate: "Prove it works: tests, checks, a look by the user.",
  deploy: "Ship it where it runs or where people get it.",
};

/** The relation types between components, fixed like the stages. */
export const FLOW_RELATION_TYPES = [
  "calls",
  "publishes to",
  "reads from",
  "writes to",
  "depends on",
] as const;

export type FlowRelationType = (typeof FLOW_RELATION_TYPES)[number];

/** What crosses the line and whether the sender waits. */
export const FLOW_RELATION_MEANINGS: Readonly<
  Record<FlowRelationType, string>
> = {
  calls: "Sends a request and waits for the answer (HTTP, RPC).",
  "publishes to":
    "Sends an event or message and does not wait (queue, topic, webhook).",
  "reads from": "Reads data the other side stores (database, cache, file).",
  "writes to": "Writes data the other side stores.",
  "depends on":
    "Needs the other side's contract or code to build. No traffic at run time.",
};

/** A stage's state as stored. */
export type FlowStageState = "todo" | "running" | "done" | "skipped" | "blocked";

/**
 * A stage's state as shown: what is stored, or for a container's computed
 * stages what its components make it. `waiting` is an `after` stage whose
 * components have not reached it yet.
 */
export type FlowShownState = FlowStageState | "waiting";

/**
 * Who decides a stage's state. `own`: an agent sets it. `rollup`: a
 * container's stage of the same kind as its components' stages, computed
 * from theirs. `after`: a container's own stage that can start only once
 * every component inside finished its stage of that kind, or its whole flow
 * when it has none of that kind; an agent sets it from then on.
 */
export type FlowStageMode = "own" | "rollup" | "after";

export const FLOW_STAGE_MODES: readonly FlowStageMode[] = [
  "own",
  "rollup",
  "after",
];

export interface FlowMap {
  id: UUID;
  workspaceId: UUID;
  /** Readable number within the workspace. */
  number: number;
  /** The root component's name. */
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface FlowComponent {
  id: UUID;
  mapId: UUID;
  /** Null for the root. */
  parentId: UUID | null;
  /** Readable number within the map. */
  number: number;
  position: number;
  name: string;
  /** What it produces, in one line. */
  deliverable: string;
  /** How anyone can tell it was delivered. */
  doneWhen: string;
  taskId: UUID | null;
  /** Set when the component was considered and dropped. */
  droppedReason: string | null;
  droppedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FlowRelation {
  id: UUID;
  mapId: UUID;
  number: number;
  fromId: UUID;
  toId: UUID;
  type: FlowRelationType;
  note: string | null;
  droppedReason: string | null;
  droppedAt: string | null;
  createdAt: string;
}

export interface FlowStage {
  id: UUID;
  componentId: UUID;
  kind: FlowStageKind;
  position: number;
  mode: FlowStageMode;
  /** A name shown instead of the kind, such as "integration" for validate. */
  label: string | null;
  state: FlowStageState;
  /** Why it is blocked or skipped. */
  note: string | null;
  /** The session that claimed it; kept after it finishes. */
  sessionId: UUID | null;
  startedAt: string | null;
  finishedAt: string | null;
  droppedReason: string | null;
  droppedAt: string | null;
}

/** A stage with its state as shown. */
export interface FlowShownStage extends FlowStage {
  shown: FlowShownState;
}

export interface FlowDecision {
  id: number;
  componentId: UUID;
  text: string;
  /** A session's name, or `user`. */
  author: string;
  sessionId: UUID | null;
  createdAt: string;
}

export interface FlowHistoryEntry {
  id: number;
  mapId: UUID;
  componentId: UUID | null;
  relationId: UUID | null;
  text: string;
  author: string;
  createdAt: string;
}

/** A whole map as read: every row, with the computed stage states. */
export interface FlowMapDetail {
  map: FlowMap;
  components: FlowComponent[];
  relations: FlowRelation[];
  /** Every stage, dropped ones included, in component then position order. */
  stages: FlowShownStage[];
  decisions: FlowDecision[];
}
