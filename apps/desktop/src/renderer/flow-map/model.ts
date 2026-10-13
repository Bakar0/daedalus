import type {
  AgentActivity,
  FlowComponentDto,
  FlowMapDetailDto,
  FlowRelationDto,
  FlowRelationTypeDto,
  FlowShownStateDto,
  FlowStageDto,
} from "@daedalus/protocol";

/**
 * The relation types as the map draws them. Each one has its own colour,
 * line pattern and arrowhead, so a line reads without its label; the legend
 * says what each means.
 */
export const RELATION_STYLES: ReadonlyArray<{
  type: FlowRelationTypeDto;
  meaning: string;
  /** The CSS class suffix for the line pattern. */
  pattern: string;
  /** Filled arrowhead, or open for a build-time dependency. */
  filled: boolean;
}> = [
  {
    type: "calls",
    meaning: "Sends a request and waits for the answer (HTTP, RPC).",
    pattern: "calls",
    filled: true,
  },
  {
    type: "publishes to",
    meaning:
      "Sends an event or message and does not wait (queue, topic, webhook).",
    pattern: "publishes",
    filled: true,
  },
  {
    type: "reads from",
    meaning: "Reads data the other side stores (database, cache, file).",
    pattern: "reads",
    filled: true,
  },
  {
    type: "writes to",
    meaning: "Writes data the other side stores.",
    pattern: "writes",
    filled: true,
  },
  {
    type: "depends on",
    meaning:
      "Needs the other side's contract or code to build. No traffic at run time.",
    pattern: "depends",
    filled: false,
  },
];

export const relationStyle = (type: FlowRelationTypeDto) =>
  RELATION_STYLES.find((style) => style.type === type) ?? RELATION_STYLES[0]!;

export const rootOf = (detail: FlowMapDetailDto) =>
  detail.components.find((component) => component.parentId === null);

/** The components directly inside one, in their order. */
export function childrenOf(
  detail: FlowMapDetailDto,
  parentId: string,
  showDropped: boolean,
): FlowComponentDto[] {
  return detail.components
    .filter(
      (component) =>
        component.parentId === parentId &&
        (showDropped || component.droppedReason === null),
    )
    .sort((a, b) => a.position - b.position || a.number - b.number);
}

/** The components a component sits in, nearest first. */
export function ancestorsOf(
  detail: FlowMapDetailDto,
  componentId: string,
): string[] {
  const byId = new Map(detail.components.map((c) => [c.id, c]));
  const out: string[] = [];
  let at = byId.get(componentId)?.parentId ?? null;
  while (at !== null && !out.includes(at)) {
    out.push(at);
    at = byId.get(at)?.parentId ?? null;
  }
  return out;
}

/** Whether a component, or one it sits in, was dropped. */
export function isDropped(
  detail: FlowMapDetailDto,
  componentId: string,
): boolean {
  const byId = new Map(detail.components.map((c) => [c.id, c]));
  return [componentId, ...ancestorsOf(detail, componentId)].some(
    (id) => byId.get(id)?.droppedReason != null,
  );
}

/** A component's flow as drawn: dropped stages only when asked for. */
export function stagesOf(
  detail: FlowMapDetailDto,
  componentId: string,
  showDropped: boolean,
): FlowStageDto[] {
  return detail.stages
    .filter(
      (stage) =>
        stage.componentId === componentId &&
        (showDropped || stage.droppedReason === null),
    )
    .sort((a, b) => a.position - b.position);
}

/** A relation as drawn: its ends may be lifted onto a collapsed component. */
export interface VisibleRelation {
  key: string;
  type: FlowRelationTypeDto;
  from: string;
  to: string;
  /** The note of the first relation drawn on this line. */
  note: string | null;
  /** How many relations this line stands for. */
  count: number;
  /** Every relation on it is dropped, or touches a dropped component. */
  dropped: boolean;
  /** The relations it stands for. */
  ids: string[];
}

/**
 * The relation lines the canvas draws. Each end moves up to the outermost
 * collapsed component it sits in, so a collapsed column still shows how it
 * connects. Lines that end inside one collapsed box vanish, and lines with
 * the same ends and type merge with a count. Without `showDropped`, a
 * relation that is dropped or touches a dropped component is left out.
 */
export function visibleRelations(
  detail: FlowMapDetailDto,
  collapsed: ReadonlySet<string>,
  showDropped: boolean,
): VisibleRelation[] {
  const lift = (id: string) =>
    [...ancestorsOf(detail, id)].reverse().find((a) => collapsed.has(a)) ?? id;
  const lines = new Map<string, VisibleRelation>();
  for (const relation of detail.relations) {
    const dropped =
      relation.droppedReason !== null ||
      isDropped(detail, relation.fromId) ||
      isDropped(detail, relation.toId);
    if (dropped && !showDropped) continue;
    const from = lift(relation.fromId);
    const to = lift(relation.toId);
    if (from === to) continue;
    const key = `${from}>${to}>${relation.type}`;
    const line = lines.get(key);
    if (line) {
      line.count += 1;
      line.dropped &&= dropped;
      line.ids.push(relation.id);
    } else
      lines.set(key, {
        key,
        type: relation.type,
        from,
        to,
        note: relation.note,
        count: 1,
        dropped,
        ids: [relation.id],
      });
  }
  return [...lines.values()];
}

/** The text on a relation line: its type, its note, and a count if merged. */
export const relationLabel = (line: VisibleRelation) =>
  [
    line.type,
    line.count > 1 ? null : line.note,
    line.count > 1 ? `×${line.count}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

export const relationsOf = (
  detail: FlowMapDetailDto,
  componentId: string,
): FlowRelationDto[] =>
  detail.relations.filter(
    (relation) =>
      relation.fromId === componentId || relation.toId === componentId,
  );

/** How the line into a stage looks: green up to the stage at work. */
export function segmentLook(
  shown: FlowShownStateDto,
): "lit" | "blocked" | "hold" | "dim" {
  if (shown === "running" || shown === "done" || shown === "skipped")
    return "lit";
  if (shown === "blocked") return "blocked";
  if (shown === "waiting") return "hold";
  return "dim";
}

/** What a session working on a stage is doing, as the stage needs it. */
export interface StageSession {
  id: string;
  workspaceId: string;
  name: string;
  provider: string;
  /** False once it ended, was lost or archived. */
  live: boolean;
  activity: AgentActivity | null;
  /** The newest thing it asked the user, while it waits on them. */
  question: string | null;
}

/**
 * The heartbeat on a running stage follows its agent: a steady green beat
 * while it works, amber and faster when it needs the user, and none, marked
 * stalled, when its session ended while the stage still runs. A running
 * stage nobody claimed (the user set it) beats as working.
 */
export function stageHeartbeat(
  stage: Pick<FlowStageDto, "shown" | "sessionId">,
  session: StageSession | undefined,
): "working" | "attention" | "stalled" | null {
  if (stage.shown !== "running") return null;
  if (!stage.sessionId) return "working";
  if (!session || !session.live) return "stalled";
  if (
    session.activity === "needs_input" ||
    session.activity === "needs_permission"
  )
    return "attention";
  return "working";
}

export const STAGE_STATE_WORDS: Readonly<Record<FlowShownStateDto, string>> = {
  todo: "not started",
  running: "running",
  done: "done",
  skipped: "skipped",
  blocked: "blocked",
  waiting: "waiting for the components inside",
};

export const STAGE_MODE_WORDS = {
  own: "Set by the agent",
  rollup: "Worked out from the components inside",
  after: "Starts when the components inside finish",
} as const;
