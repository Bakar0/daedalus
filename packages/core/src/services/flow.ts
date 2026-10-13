import {
  FLOW_RELATION_TYPES,
  FLOW_STAGE_KINDS,
  type AgentSession,
  type FlowComponent,
  type FlowHistoryEntry,
  type FlowMap,
  type FlowMapDetail,
  type FlowRelation,
  type FlowRelationType,
  type FlowShownStage,
  type FlowStage,
  type FlowStageKind,
  type FlowStageMode,
} from "../domain";
import { DaedalusError } from "../errors";
import type { SqliteRepositories } from "../repositories";
import type { AbilityService } from "./abilities";
import { liveComponentIds, shownStages } from "./flow-rollup";

/**
 * Who is changing a map: the user, from a terminal or the app, or a session.
 * A session needs the flow ability to change anything; reading is open.
 */
export type FlowActor =
  { kind: "user" } | { kind: "session"; session: AgentSession };

/** One stage in a flow as `flow stages` takes it. */
export interface FlowStageSpec {
  kind: FlowStageKind;
  mode: FlowStageMode;
  label: string | null;
}

/** What happens to the stages a new flow leaves out. */
export type FlowStageRemoval =
  { kind: "delete" } | { kind: "drop"; reason: string } | undefined;

export type FlowStageAction = "start" | "finish" | "block" | "skip" | "reset";

const LIMITS = {
  name: 80,
  deliverable: 300,
  doneWhen: 300,
  reason: 500,
  note: 120,
  label: 30,
  decision: 1_000,
};

const USER_AUTHOR = "user";

function text(
  value: string | undefined | null,
  what: string,
  limit: number,
  options: { required?: boolean } = {},
): string {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim();
  if (options.required && !trimmed)
    throw new DaedalusError("VALIDATION", `${what} is required`);
  if (trimmed.length > limit)
    throw new DaedalusError(
      "VALIDATION",
      `${what} is ${trimmed.length} characters; keep it to ${limit}`,
    );
  return trimmed;
}

/**
 * A component's name. Paths split on `/`, and a bare number or `r<n>` reads
 * as a component's or relation's number, so names cannot be either.
 */
function componentName(value: string | undefined): string {
  const name = text(value, "A component's name", LIMITS.name, {
    required: true,
  });
  if (name.includes("/"))
    throw new DaedalusError(
      "VALIDATION",
      `'${name}' has a '/', which separates a path; pick another name`,
    );
  if (/^(#?\d+|r\d+)$/i.test(name))
    throw new DaedalusError(
      "VALIDATION",
      `'${name}' reads as a number; pick a name with words`,
    );
  return name;
}

export function parseRelationType(value: string): FlowRelationType {
  const normalized = value.trim().toLowerCase().replace(/[-_]+/g, " ");
  const match = FLOW_RELATION_TYPES.find(
    (type) => type === normalized || type.split(" ")[0] === normalized,
  );
  if (!match)
    throw new DaedalusError(
      "VALIDATION",
      `Unknown relation type '${value}'; the types are: ${FLOW_RELATION_TYPES.join(", ")}`,
    );
  return match;
}

export function parseStageKind(value: string): FlowStageKind {
  const kind = value.trim().toLowerCase() as FlowStageKind;
  if (!FLOW_STAGE_KINDS.includes(kind))
    throw new DaedalusError(
      "VALIDATION",
      `Unknown stage '${value}'; the stages are: ${FLOW_STAGE_KINDS.join(", ")}`,
    );
  return kind;
}

/**
 * Parses a flow written as `research,plan,rollup:implement,after:validate=integration`.
 * Each entry is a stage kind, optionally led by its mode and followed by a
 * label shown instead of the kind.
 */
export function parseStageSpecs(value: string): FlowStageSpec[] {
  const specs = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry): FlowStageSpec => {
      const [head, ...labelParts] = entry.split("=");
      const label = labelParts.join("=").trim();
      const [first, second] = (head ?? "")
        .split(":")
        .map((part) => part.trim());
      const mode = second === undefined ? "own" : first;
      if (mode !== "own" && mode !== "rollup" && mode !== "after")
        throw new DaedalusError(
          "VALIDATION",
          `Unknown stage mode '${mode}' in '${entry}'; use own, rollup or after`,
        );
      return {
        kind: parseStageKind(second ?? first ?? ""),
        mode,
        label: label ? text(label, "A stage label", LIMITS.label) : null,
      };
    });
  const kinds = specs.map((spec) => spec.kind);
  const repeated = kinds.find((kind, index) => kinds.indexOf(kind) !== index);
  if (repeated)
    throw new DaedalusError(
      "VALIDATION",
      `'${repeated}' appears twice; a flow has each stage once`,
    );
  return specs;
}

const isLiveSession = (session: AgentSession | undefined) =>
  Boolean(
    session &&
    !session.archivedAt &&
    (session.status === "running" || session.status === "starting"),
  );

/**
 * Flow maps: a workspace's components, their relations, their flows and the
 * decisions taken on them. Every change goes through here, in one write
 * transaction that also marks the map changed and adds its history line.
 */
export class FlowService {
  constructor(
    private readonly repositories: SqliteRepositories,
    private readonly abilities: AbilityService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // --------------------------------------------------------------- reads

  listMaps(workspaceId: string): FlowMap[] {
    return this.repositories.flow.listMaps(workspaceId);
  }

  getMap(mapId: string): FlowMap {
    const map = this.repositories.flow.findMap(mapId);
    if (!map)
      throw new DaedalusError("NOT_FOUND", `Flow map ${mapId} not found`);
    return map;
  }

  detail(mapId: string): FlowMapDetail {
    const map = this.getMap(mapId);
    const components = this.repositories.flow.listComponents(mapId);
    return {
      map,
      components,
      relations: this.repositories.flow.listRelations(mapId),
      stages: shownStages(components, this.repositories.flow.listStages(mapId)),
      decisions: this.repositories.flow.listDecisions(mapId),
    };
  }

  history(mapId: string, limit = 200): FlowHistoryEntry[] {
    this.getMap(mapId);
    return this.repositories.flow.listHistory(mapId, limit);
  }

  /** Where a task appears on maps, for the task's drawer. */
  linksForTask(
    taskId: string,
  ): Array<{ map: FlowMap; component: FlowComponent }> {
    return this.repositories.flow
      .componentsForTask(taskId)
      .flatMap((component) => {
        const map = this.repositories.flow.findMap(component.mapId);
        return map ? [{ map, component }] : [];
      });
  }

  /** The maps a session owns through its flow ability, held or revoked. */
  mapsOwnedBy(sessionId: string): FlowMap[] {
    const ability = this.repositories.abilities.findForSession(
      sessionId,
      "flow",
    );
    return ability ? this.repositories.flow.listOwnedMaps(ability.id) : [];
  }

  /**
   * A map in a workspace by number (`2`, `#2`), name, or id. With no
   * reference: the caller's only map, else the only map it holds a stage
   * on, else the workspace's only map.
   */
  resolveMap(
    workspaceId: string,
    reference?: string,
    caller?: AgentSession,
  ): FlowMap {
    const maps = this.repositories.flow.listMaps(workspaceId);
    if (reference === undefined) {
      if (caller) {
        const owned = this.mapsOwnedBy(caller.id).filter(
          (map) => map.workspaceId === workspaceId,
        );
        if (owned.length === 1) return owned[0]!;
        const working = new Set(
          this.repositories.flow
            .heldStages(caller.id)
            .flatMap(
              (stage) =>
                this.repositories.flow.findComponent(stage.componentId)
                  ?.mapId ?? [],
            ),
        );
        if (owned.length === 0 && working.size === 1) {
          const map = maps.find((candidate) => working.has(candidate.id));
          if (map) return map;
        }
      }
      if (maps.length === 1) return maps[0]!;
      throw new DaedalusError(
        maps.length ? "VALIDATION" : "NOT_FOUND",
        maps.length
          ? `This workspace has ${maps.length} flow maps (${maps.map((map) => `#${map.number} ${map.name}`).join(", ")}); pass --map <number|name>`
          : "This workspace has no flow map; make one with 'daedal flow new <name> --deliverable <text>'",
      );
    }
    const number = /^#?([1-9]\d*)$/.exec(reference.trim());
    const wanted = reference.trim().toLowerCase();
    const map =
      maps.find((candidate) => candidate.id === reference) ??
      (number
        ? maps.find((candidate) => candidate.number === Number(number[1]))
        : maps.find((candidate) => candidate.name.toLowerCase() === wanted));
    if (!map)
      throw new DaedalusError(
        "NOT_FOUND",
        `No flow map '${reference}' in this workspace${maps.length ? `; the maps are ${maps.map((m) => `#${m.number} ${m.name}`).join(", ")}` : ""}`,
      );
    return map;
  }

  /**
   * A component by number (`7`, `#7`), id, path of names from the root
   * (`API server/Orders API`, the root's name may lead), or a name only one
   * component has.
   */
  resolveComponent(mapId: string, reference: string): FlowComponent {
    const components = this.repositories.flow.listComponents(mapId);
    const trimmed = reference.trim();
    const byId = components.find((component) => component.id === trimmed);
    if (byId) return byId;
    const number = /^#?([1-9]\d*)$/.exec(trimmed);
    if (number) {
      const found = components.find((c) => c.number === Number(number[1]));
      if (found) return found;
      throw new DaedalusError(
        "NOT_FOUND",
        `No component #${number[1]} on this map`,
      );
    }
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const parts = trimmed
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length > 1) {
      const root = components.find((component) => component.parentId === null);
      let at: FlowComponent | undefined = root;
      const rest = root && same(root.name, parts[0]!) ? parts.slice(1) : parts;
      for (const part of rest) {
        const parent: FlowComponent | undefined = at;
        at = components.find(
          (component) =>
            component.parentId === parent?.id && same(component.name, part),
        );
        if (!at) break;
      }
      if (at) return at;
      throw new DaedalusError("NOT_FOUND", `No component at '${trimmed}'`);
    }
    const named = components.filter((component) =>
      same(component.name, trimmed),
    );
    if (named.length === 1) return named[0]!;
    if (named.length > 1)
      throw new DaedalusError(
        "VALIDATION",
        `${named.length} components are called '${trimmed}' (${named.map((c) => `#${c.number}`).join(", ")}); use the number or a path`,
      );
    throw new DaedalusError(
      "NOT_FOUND",
      `No component '${trimmed}' on this map`,
    );
  }

  /** A relation by number (`3`, `r3`, `#3`) or id. */
  resolveRelation(mapId: string, reference: string): FlowRelation {
    const relations = this.repositories.flow.listRelations(mapId);
    const number = /^(?:r|#)?([1-9]\d*)$/i.exec(reference.trim());
    const relation = relations.find(
      (candidate) =>
        candidate.id === reference ||
        (number !== null && candidate.number === Number(number[1])),
    );
    if (!relation)
      throw new DaedalusError(
        "NOT_FOUND",
        `No relation '${reference}' on this map`,
      );
    return relation;
  }

  /** A stage of a component by kind. */
  resolveStage(componentId: string, kind: string): FlowStage {
    const wanted = parseStageKind(kind);
    const stage = this.repositories.flow
      .listComponentStages(componentId)
      .find((candidate) => candidate.kind === wanted);
    if (!stage) {
      const component = this.repositories.flow.findComponent(componentId);
      throw new DaedalusError(
        "NOT_FOUND",
        `'${component?.name ?? componentId}' has no ${wanted} stage; set its flow with 'daedal flow stages'`,
      );
    }
    return stage;
  }

  // ---------------------------------------------------------------- maps

  /**
   * Starts a map owned by a session that holds the flow ability: the calling
   * session, or for the user the one named as `ownerSessionId`. The map is
   * in the owner's workspace.
   */
  createMap(
    actor: FlowActor,
    input: {
      name: string;
      deliverable: string;
      doneWhen?: string;
      ownerSessionId?: string;
    },
  ): FlowMapDetail {
    const ownerId =
      actor.kind === "session" ? actor.session.id : input.ownerSessionId;
    if (!ownerId)
      throw new DaedalusError(
        "VALIDATION",
        "A map belongs to a session that holds the flow ability; pass --session <session>",
      );
    const ability = this.abilities.require(ownerId, "flow");
    const owner = this.repositories.findAgent(ownerId);
    if (!owner)
      throw new DaedalusError("NOT_FOUND", `Session ${ownerId} not found`);
    const workspaceId = owner.workspaceId;
    const workspace = this.repositories.findWorkspace(workspaceId);
    if (!workspace)
      throw new DaedalusError(
        "NOT_FOUND",
        `Workspace ${workspaceId} not found`,
      );
    if (workspace.archivedAt)
      throw new DaedalusError(
        "CONFLICT",
        `Workspace '${workspace.name}' is archived`,
      );
    const name = componentName(input.name);
    const deliverable = text(
      input.deliverable,
      "The deliverable",
      LIMITS.deliverable,
      {
        required: true,
      },
    );
    const doneWhen = text(input.doneWhen, "Done when", LIMITS.doneWhen);
    const at = this.at();
    const mapId = this.repositories.immediateTransaction(() => {
      if (
        this.repositories.flow
          .listMaps(workspaceId)
          .some((map) => map.name.toLowerCase() === name.toLowerCase())
      )
        throw new DaedalusError(
          "CONFLICT",
          `A flow map called '${name}' already exists here`,
        );
      const map: FlowMap = {
        id: crypto.randomUUID(),
        workspaceId,
        abilityId: ability.id,
        number: this.repositories.flow.nextMapNumber(workspaceId),
        name,
        createdAt: at,
        updatedAt: at,
      };
      this.repositories.flow.createMap(map);
      const root = this.newComponent(
        map.id,
        null,
        { name, deliverable, doneWhen },
        at,
      );
      this.repositories.flow.createComponent(root);
      this.log(map.id, actor, `Started the map '${name}'`, {
        componentId: root.id,
      });
      return map.id;
    });
    return this.detail(mapId);
  }

  deleteMap(actor: FlowActor, mapId: string): FlowMap {
    this.authorize(actor, mapId);
    const map = this.getMap(mapId);
    this.repositories.flow.deleteMap(map.id);
    return map;
  }

  // ---------------------------------------------------------- components

  addComponent(
    actor: FlowActor,
    mapId: string,
    input: {
      parentId: string;
      name: string;
      deliverable: string;
      doneWhen?: string;
      stages?: FlowStageSpec[];
    },
  ): FlowComponent {
    this.authorize(actor, mapId);
    const name = componentName(input.name);
    const deliverable = text(
      input.deliverable,
      "The deliverable",
      LIMITS.deliverable,
      {
        required: true,
      },
    );
    const doneWhen = text(input.doneWhen, "Done when", LIMITS.doneWhen);
    const at = this.at();
    return this.repositories.immediateTransaction(() => {
      const parent = this.componentOn(mapId, input.parentId);
      if (parent.droppedReason !== null)
        throw new DaedalusError(
          "CONFLICT",
          `'${parent.name}' is dropped; restore it before adding to it`,
        );
      this.refuseSiblingName(mapId, parent.id, name);
      const component = this.newComponent(
        mapId,
        parent.id,
        { name, deliverable, doneWhen },
        at,
      );
      this.repositories.flow.createComponent(component);
      if (input.stages) this.writeStages(component.id, input.stages, undefined);
      this.log(mapId, actor, `Added '${name}' in '${parent.name}'`, {
        componentId: component.id,
      });
      return component;
    });
  }

  editComponent(
    actor: FlowActor,
    componentId: string,
    input: {
      name?: string;
      deliverable?: string;
      doneWhen?: string;
      parentId?: string;
      position?: number;
    },
  ): FlowComponent {
    this.authorize(actor, this.component(componentId).mapId);
    return this.repositories.immediateTransaction(() => {
      const component = this.component(componentId);
      const next: FlowComponent = { ...component, updatedAt: this.at() };
      const changes: string[] = [];
      if (input.name !== undefined) {
        next.name = componentName(input.name);
        if (next.name !== component.name) {
          if (component.parentId !== null)
            this.refuseSiblingName(
              component.mapId,
              component.parentId,
              next.name,
              component.id,
            );
          changes.push(`renamed to '${next.name}'`);
        }
      }
      if (input.deliverable !== undefined) {
        next.deliverable = text(
          input.deliverable,
          "The deliverable",
          LIMITS.deliverable,
          {
            required: true,
          },
        );
        if (next.deliverable !== component.deliverable)
          changes.push("new deliverable");
      }
      if (input.doneWhen !== undefined)
        next.doneWhen = text(input.doneWhen, "Done when", LIMITS.doneWhen);
      if (
        input.parentId !== undefined &&
        input.parentId !== component.parentId
      ) {
        if (component.parentId === null)
          throw new DaedalusError(
            "VALIDATION",
            "The root of a map cannot move",
          );
        const parent = this.componentOn(component.mapId, input.parentId);
        if (this.contains(component.id, parent.id))
          throw new DaedalusError(
            "VALIDATION",
            `'${parent.name}' is inside '${component.name}'; a component cannot move into itself`,
          );
        this.refuseSiblingName(
          component.mapId,
          parent.id,
          next.name,
          component.id,
        );
        next.parentId = parent.id;
        next.position = this.repositories.flow.nextPosition(
          component.mapId,
          parent.id,
        );
        changes.push(`moved into '${parent.name}'`);
      }
      if (input.position !== undefined) {
        if (!Number.isInteger(input.position) || input.position < 0)
          throw new DaedalusError(
            "VALIDATION",
            "--position takes a whole number from 0",
          );
        next.position = input.position;
      }
      this.repositories.flow.updateComponent(next);
      if (next.parentId === null && next.name !== component.name)
        this.repositories.flow.touchMap(
          component.mapId,
          next.updatedAt,
          next.name,
        );
      if (changes.length)
        this.log(
          component.mapId,
          actor,
          `'${component.name}' ${changes.join(", ")}`,
          {
            componentId: component.id,
          },
        );
      else this.repositories.flow.touchMap(component.mapId, next.updatedAt);
      return next;
    });
  }

  /** Marks a component considered and dropped; it stays on the map, faint. */
  dropComponent(
    actor: FlowActor,
    componentId: string,
    reason: string,
  ): FlowComponent {
    this.authorize(actor, this.component(componentId).mapId);
    const why = text(reason, "The reason", LIMITS.reason, { required: true });
    return this.repositories.immediateTransaction(() => {
      const component = this.component(componentId);
      if (component.parentId === null)
        throw new DaedalusError(
          "VALIDATION",
          "The root of a map cannot be dropped; delete the map instead",
        );
      const at = this.at();
      const dropped = {
        ...component,
        droppedReason: why,
        droppedAt: at,
        updatedAt: at,
      };
      this.repositories.flow.updateComponent(dropped);
      this.log(component.mapId, actor, `Dropped '${component.name}': ${why}`, {
        componentId: component.id,
      });
      return dropped;
    });
  }

  restoreComponent(actor: FlowActor, componentId: string): FlowComponent {
    this.authorize(actor, this.component(componentId).mapId);
    return this.repositories.immediateTransaction(() => {
      const component = this.component(componentId);
      if (component.droppedReason === null)
        throw new DaedalusError(
          "CONFLICT",
          `'${component.name}' is not dropped`,
        );
      if (component.parentId !== null)
        this.refuseSiblingName(
          component.mapId,
          component.parentId,
          component.name,
          component.id,
        );
      const restored = {
        ...component,
        droppedReason: null,
        droppedAt: null,
        updatedAt: this.at(),
      };
      this.repositories.flow.updateComponent(restored);
      this.log(component.mapId, actor, `Restored '${component.name}'`, {
        componentId: component.id,
      });
      return restored;
    });
  }

  /**
   * Deletes a component with no trace: its stages, decisions, relations and
   * history lines go too. One that contains others needs `withContents`.
   */
  deleteComponent(
    actor: FlowActor,
    componentId: string,
    options: { withContents?: boolean } = {},
  ): FlowComponent {
    this.authorize(actor, this.component(componentId).mapId);
    return this.repositories.immediateTransaction(() => {
      const component = this.component(componentId);
      if (component.parentId === null)
        throw new DaedalusError(
          "VALIDATION",
          "The root of a map cannot be deleted on its own; delete the map with 'daedal flow remove-map'",
        );
      const inside = this.repositories.flow
        .listComponents(component.mapId)
        .filter((candidate) => candidate.parentId === component.id);
      if (inside.length && !options.withContents)
        throw new DaedalusError(
          "CONFLICT",
          `'${component.name}' contains ${inside.length} component${inside.length === 1 ? "" : "s"} (${inside.map((c) => c.name).join(", ")}); pass --with-contents to delete them too`,
        );
      this.repositories.flow.deleteComponent(component.id);
      this.repositories.flow.touchMap(component.mapId, this.at());
      return component;
    });
  }

  linkTask(
    actor: FlowActor,
    componentId: string,
    taskId: string | null,
  ): FlowComponent {
    this.authorize(actor, this.component(componentId).mapId);
    return this.repositories.immediateTransaction(() => {
      const component = this.component(componentId);
      const map = this.getMap(component.mapId);
      if (taskId !== null) {
        const task = this.repositories.findTask(taskId);
        if (!task)
          throw new DaedalusError("NOT_FOUND", `Task ${taskId} not found`);
        if (task.workspaceId !== map.workspaceId)
          throw new DaedalusError(
            "VALIDATION",
            "A component links only to a task in the map's workspace",
          );
      }
      const linked = { ...component, taskId, updatedAt: this.at() };
      this.repositories.flow.updateComponent(linked);
      const task = taskId ? this.repositories.findTask(taskId) : undefined;
      this.log(
        component.mapId,
        actor,
        task
          ? `Linked '${component.name}' to task #${task.number}`
          : `Unlinked '${component.name}' from its task`,
        { componentId: component.id },
      );
      return linked;
    });
  }

  // ----------------------------------------------------------- relations

  relate(
    actor: FlowActor,
    mapId: string,
    input: {
      fromId: string;
      toId: string;
      type: FlowRelationType;
      note?: string;
    },
  ): FlowRelation {
    this.authorize(actor, mapId);
    const note = text(input.note, "A relation's note", LIMITS.note) || null;
    return this.repositories.immediateTransaction(() => {
      const from = this.componentOn(mapId, input.fromId);
      const to = this.componentOn(mapId, input.toId);
      if (from.id === to.id)
        throw new DaedalusError(
          "VALIDATION",
          "A relation links two different components",
        );
      const existing = this.repositories.flow
        .listRelations(mapId)
        .find(
          (relation) =>
            relation.fromId === from.id &&
            relation.toId === to.id &&
            relation.type === input.type &&
            relation.droppedReason === null,
        );
      if (existing)
        throw new DaedalusError(
          "CONFLICT",
          `'${from.name}' already ${input.type} '${to.name}' (relation r${existing.number})`,
        );
      const relation: FlowRelation = {
        id: crypto.randomUUID(),
        mapId,
        number: this.repositories.flow.nextRelationNumber(mapId),
        fromId: from.id,
        toId: to.id,
        type: input.type,
        note,
        droppedReason: null,
        droppedAt: null,
        createdAt: this.at(),
      };
      this.repositories.flow.createRelation(relation);
      this.log(
        mapId,
        actor,
        `'${from.name}' ${input.type} '${to.name}'${note ? ` (${note})` : ""}`,
        {
          relationId: relation.id,
        },
      );
      return relation;
    });
  }

  dropRelation(
    actor: FlowActor,
    relationId: string,
    reason: string,
  ): FlowRelation {
    this.authorize(actor, this.relation(relationId).mapId);
    const why = text(reason, "The reason", LIMITS.reason, { required: true });
    return this.repositories.immediateTransaction(() => {
      const relation = this.relation(relationId);
      const dropped = { ...relation, droppedReason: why, droppedAt: this.at() };
      this.repositories.flow.updateRelation(dropped);
      this.log(
        relation.mapId,
        actor,
        `Dropped ${this.relationText(relation)}: ${why}`,
        {
          relationId: relation.id,
        },
      );
      return dropped;
    });
  }

  restoreRelation(actor: FlowActor, relationId: string): FlowRelation {
    this.authorize(actor, this.relation(relationId).mapId);
    return this.repositories.immediateTransaction(() => {
      const relation = this.relation(relationId);
      if (relation.droppedReason === null)
        throw new DaedalusError(
          "CONFLICT",
          `Relation r${relation.number} is not dropped`,
        );
      const restored = { ...relation, droppedReason: null, droppedAt: null };
      this.repositories.flow.updateRelation(restored);
      this.log(
        relation.mapId,
        actor,
        `Restored ${this.relationText(relation)}`,
        {
          relationId: relation.id,
        },
      );
      return restored;
    });
  }

  deleteRelation(actor: FlowActor, relationId: string): FlowRelation {
    this.authorize(actor, this.relation(relationId).mapId);
    return this.repositories.immediateTransaction(() => {
      const relation = this.relation(relationId);
      this.repositories.flow.deleteRelation(relation.id);
      this.repositories.flow.touchMap(relation.mapId, this.at());
      return relation;
    });
  }

  // -------------------------------------------------------------- stages

  /**
   * Sets a component's flow. Stages already there keep their state and move
   * to their new place. A left-out stage that never started is deleted; one
   * that started needs `removal`: dropped with a reason, kept faint, or
   * deleted. A kind that was dropped and comes back is restored.
   */
  setStages(
    actor: FlowActor,
    componentId: string,
    specs: FlowStageSpec[],
    removal?: FlowStageRemoval,
  ): FlowShownStage[] {
    this.authorize(actor, this.component(componentId).mapId);
    if (removal?.kind === "drop")
      text(removal.reason, "The reason", LIMITS.reason, { required: true });
    const component = this.repositories.immediateTransaction(() => {
      const component = this.component(componentId);
      const summary = this.writeStages(component.id, specs, removal);
      this.log(
        component.mapId,
        actor,
        `Flow of '${component.name}': ${specs.map((spec) => spec.label ?? spec.kind).join(" → ") || "none"}${summary}`,
        { componentId: component.id },
      );
      return component;
    });
    return this.detail(component.mapId).stages.filter(
      (stage) => stage.componentId === component.id,
    );
  }

  /**
   * Moves a stage. `start` claims it for the calling session: another live
   * session's claim is a conflict, so two agents never run one stage. A
   * computed `rollup` stage cannot be set, and an `after` stage cannot start
   * while its components have not reached it.
   */
  moveStage(
    actor: FlowActor,
    componentId: string,
    kind: string,
    action: FlowStageAction,
    note?: string,
  ): FlowShownStage {
    this.authorizeStage(actor, this.component(componentId).mapId, action);
    const reason = text(note, "The reason", LIMITS.reason, {
      required: action === "block",
    });
    const stageId = this.repositories.immediateTransaction(() => {
      const component = this.component(componentId);
      if (component.droppedReason !== null)
        throw new DaedalusError("CONFLICT", `'${component.name}' is dropped`);
      const stage = this.resolveStage(component.id, kind);
      if (stage.droppedReason !== null)
        throw new DaedalusError(
          "CONFLICT",
          `The ${stage.kind} stage of '${component.name}' is dropped; set the flow again to bring it back`,
        );
      if (stage.mode === "rollup")
        throw new DaedalusError(
          "VALIDATION",
          `The ${stage.kind} stage of '${component.name}' is worked out from the components inside it and cannot be set`,
        );
      const shown = this.detail(component.mapId).stages.find(
        (s) => s.id === stage.id,
      );
      if (
        shown?.shown === "waiting" &&
        (action === "start" || action === "finish")
      )
        throw new DaedalusError(
          "CONFLICT",
          `The ${stage.label ?? stage.kind} stage of '${component.name}' waits for the components inside it to finish their ${stage.kind}`,
        );
      const caller = actor.kind === "session" ? actor.session : undefined;
      const holder = stage.sessionId
        ? this.repositories.findAgent(stage.sessionId)
        : undefined;
      const heldByOther =
        (stage.state === "running" || stage.state === "blocked") &&
        holder !== undefined &&
        holder.id !== caller?.id &&
        isLiveSession(holder);
      // The user may move any stage; a session may not take one from another
      // live session.
      if (heldByOther && caller)
        throw new DaedalusError(
          "CONFLICT",
          `The ${stage.kind} stage of '${component.name}' is held by '${holder.name}' (${holder.id}), which is still running`,
        );
      const at = this.at();
      const next: FlowStage = { ...stage };
      let line: string;
      const label = `${stage.label ?? stage.kind}`;
      switch (action) {
        case "start":
          next.state = "running";
          next.note = null;
          next.startedAt =
            stage.state === "blocked" && stage.startedAt ? stage.startedAt : at;
          next.finishedAt = null;
          if (caller) next.sessionId = caller.id;
          line = `Started ${label} on '${component.name}'`;
          break;
        case "finish":
          next.state = "done";
          next.note = reason || null;
          next.finishedAt = at;
          next.startedAt ??= at;
          if (caller && !next.sessionId) next.sessionId = caller.id;
          line = `Finished ${label} on '${component.name}'`;
          break;
        case "block":
          next.state = "blocked";
          next.note = reason;
          if (caller) next.sessionId = caller.id;
          line = `Blocked ${label} on '${component.name}': ${reason}`;
          break;
        case "skip":
          next.state = "skipped";
          next.note = reason || null;
          next.finishedAt = at;
          line = `Skipped ${label} on '${component.name}'${reason ? `: ${reason}` : ""}`;
          break;
        case "reset":
          next.state = "todo";
          next.note = null;
          next.startedAt = null;
          next.finishedAt = null;
          next.sessionId = null;
          line = `Reset ${label} on '${component.name}'`;
          break;
      }
      this.repositories.flow.updateStage(next);
      this.log(component.mapId, actor, line, { componentId: component.id });
      return stage.id;
    });
    const component = this.component(componentId);
    const shown = this.detail(component.mapId).stages.find(
      (stage) => stage.id === stageId,
    );
    if (!shown) throw new DaedalusError("INTERNAL", "The stage was not stored");
    return shown;
  }

  // ----------------------------------------------------------- decisions

  decide(actor: FlowActor, componentId: string, decision: string) {
    this.authorize(actor, this.component(componentId).mapId);
    const body = text(decision, "A decision", LIMITS.decision, {
      required: true,
    });
    return this.repositories.immediateTransaction(() => {
      const component = this.component(componentId);
      const stored = this.repositories.flow.addDecision({
        componentId: component.id,
        text: body,
        author: this.author(actor),
        sessionId: actor.kind === "session" ? actor.session.id : null,
        createdAt: this.at(),
      });
      this.log(
        component.mapId,
        actor,
        `Decided on '${component.name}': ${body}`,
        {
          componentId: component.id,
        },
      );
      return stored;
    });
  }

  // ------------------------------------------------------------- helpers

  /**
   * Only the session that owns a map, while it holds the flow ability, or
   * the user changes the map's shape.
   */
  private authorize(actor: FlowActor, mapId: string): void {
    if (actor.kind === "user") return;
    const map = this.getMap(mapId);
    const ability = this.abilities.require(actor.session.id, "flow");
    if (ability.id === map.abilityId) return;
    const owner = this.ownerOf(map);
    throw new DaedalusError(
      "CONFLICT",
      `The map '${map.name}' belongs to ${owner ? `'${owner.name}' (${owner.id})` : "another session"}; only it or the user changes its shape. You can start and finish its stages.`,
    );
  }

  /**
   * Any session in the map's workspace may move a stage, so agents the owner
   * hands work to need no ability. Resetting one is the owner's or the
   * user's call.
   */
  private authorizeStage(
    actor: FlowActor,
    mapId: string,
    action: FlowStageAction,
  ): void {
    if (actor.kind === "user") return;
    if (action === "reset") return this.authorize(actor, mapId);
    const map = this.getMap(mapId);
    if (actor.session.workspaceId !== map.workspaceId)
      throw new DaedalusError(
        "CONFLICT",
        `The map '${map.name}' is in another workspace`,
      );
  }

  /** The session that owns a map now. */
  ownerOf(map: FlowMap): AgentSession | undefined {
    const ability = this.repositories.abilities.find(map.abilityId);
    return ability ? this.repositories.findAgent(ability.sessionId) : undefined;
  }

  private author(actor: FlowActor): string {
    return actor.kind === "session" ? actor.session.name : USER_AUTHOR;
  }

  private at(): string {
    return this.now().toISOString();
  }

  private component(componentId: string): FlowComponent {
    const component = this.repositories.flow.findComponent(componentId);
    if (!component)
      throw new DaedalusError(
        "NOT_FOUND",
        `Component ${componentId} not found`,
      );
    return component;
  }

  private componentOn(mapId: string, componentId: string): FlowComponent {
    const component = this.component(componentId);
    if (component.mapId !== mapId)
      throw new DaedalusError(
        "VALIDATION",
        `'${component.name}' is on another map; relations and nesting stay within one map`,
      );
    return component;
  }

  private relation(relationId: string): FlowRelation {
    const relation = this.repositories.flow.findRelation(relationId);
    if (!relation)
      throw new DaedalusError("NOT_FOUND", `Relation ${relationId} not found`);
    return relation;
  }

  private relationText(relation: FlowRelation): string {
    const name = (id: string) =>
      this.repositories.flow.findComponent(id)?.name ?? id;
    return `'${name(relation.fromId)}' ${relation.type} '${name(relation.toId)}'`;
  }

  /** Whether `inner` is `outer` or sits somewhere inside it. */
  private contains(outer: string, inner: string): boolean {
    let at: FlowComponent | undefined =
      this.repositories.flow.findComponent(inner);
    const seen = new Set<string>();
    while (at && !seen.has(at.id)) {
      if (at.id === outer) return true;
      seen.add(at.id);
      at = at.parentId
        ? this.repositories.flow.findComponent(at.parentId)
        : undefined;
    }
    return false;
  }

  /** Paths address components by name, so live siblings need distinct names. */
  private refuseSiblingName(
    mapId: string,
    parentId: string,
    name: string,
    except?: string,
  ): void {
    const live = liveComponentIds(this.repositories.flow.listComponents(mapId));
    const clash = this.repositories.flow
      .listComponents(mapId)
      .find(
        (component) =>
          component.parentId === parentId &&
          component.id !== except &&
          live.has(component.id) &&
          component.name.toLowerCase() === name.toLowerCase(),
      );
    if (clash)
      throw new DaedalusError(
        "CONFLICT",
        `'${clash.name}' (#${clash.number}) is already in that component; pick another name`,
      );
  }

  private newComponent(
    mapId: string,
    parentId: string | null,
    input: { name: string; deliverable: string; doneWhen: string },
    at: string,
  ): FlowComponent {
    return {
      id: crypto.randomUUID(),
      mapId,
      parentId,
      number: this.repositories.flow.nextComponentNumber(mapId),
      position: this.repositories.flow.nextPosition(mapId, parentId),
      name: input.name,
      deliverable: input.deliverable,
      doneWhen: input.doneWhen,
      taskId: null,
      droppedReason: null,
      droppedAt: null,
      createdAt: at,
      updatedAt: at,
    };
  }

  /** Writes a flow inside the caller's transaction; returns a history note. */
  private writeStages(
    componentId: string,
    specs: FlowStageSpec[],
    removal: FlowStageRemoval,
  ): string {
    const existing = this.repositories.flow.listComponentStages(componentId);
    const wanted = new Set(specs.map((spec) => spec.kind));
    const leaving = existing.filter(
      (stage) => !wanted.has(stage.kind) && stage.droppedReason === null,
    );
    const started = leaving.filter((stage) => stage.state !== "todo");
    if (started.length && !removal)
      throw new DaedalusError(
        "CONFLICT",
        `This flow leaves out ${started.map((s) => `${s.kind} (${s.state})`).join(", ")}, which already started; pass --drop "<reason>" to keep ${started.length === 1 ? "it" : "them"} faint on the map, or --delete to remove ${started.length === 1 ? "it" : "them"}`,
      );
    const at = this.at();
    for (const stage of leaving) {
      if (removal?.kind === "drop" && stage.state !== "todo")
        this.repositories.flow.updateStage({
          ...stage,
          droppedReason: removal.reason.trim(),
          droppedAt: at,
          position: 1_000 + stage.position,
        });
      else this.repositories.flow.deleteStage(stage.id);
    }
    specs.forEach((spec, position) => {
      const stage = existing.find((candidate) => candidate.kind === spec.kind);
      if (stage)
        this.repositories.flow.updateStage({
          ...stage,
          position,
          mode: spec.mode,
          label: spec.label,
          droppedReason: null,
          droppedAt: null,
        });
      else
        this.repositories.flow.createStage({
          id: crypto.randomUUID(),
          componentId,
          kind: spec.kind,
          position,
          mode: spec.mode,
          label: spec.label,
          state: "todo",
          note: null,
          sessionId: null,
          startedAt: null,
          finishedAt: null,
          droppedReason: null,
          droppedAt: null,
        });
    });
    const dropped = removal?.kind === "drop" ? started : [];
    return dropped.length
      ? `; dropped ${dropped.map((s) => s.kind).join(", ")}: ${removal?.kind === "drop" ? removal.reason.trim() : ""}`
      : "";
  }

  /** Adds a history line and marks the map changed. */
  private log(
    mapId: string,
    actor: FlowActor,
    line: string,
    about: { componentId?: string; relationId?: string } = {},
  ): void {
    const at = this.at();
    this.repositories.flow.addHistory({
      mapId,
      componentId: about.componentId ?? null,
      relationId: about.relationId ?? null,
      text: line,
      author: this.author(actor),
      createdAt: at,
    });
    this.repositories.flow.touchMap(mapId, at);
  }
}
