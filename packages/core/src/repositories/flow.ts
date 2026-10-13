import type { Database } from "bun:sqlite";
import type {
  FlowComponent,
  FlowDecision,
  FlowHistoryEntry,
  FlowMap,
  FlowRelation,
  FlowRelationType,
  FlowStage,
  FlowStageKind,
  FlowStageMode,
  FlowStageState,
} from "../domain";

interface MapRow {
  id: string;
  workspace_id: string;
  number: number;
  name: string;
  created_at: string;
  updated_at: string;
}

interface ComponentRow {
  id: string;
  map_id: string;
  parent_id: string | null;
  number: number;
  position: number;
  name: string;
  deliverable: string;
  done_when: string;
  task_id: string | null;
  dropped_reason: string | null;
  dropped_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RelationRow {
  id: string;
  map_id: string;
  number: number;
  from_id: string;
  to_id: string;
  type: FlowRelationType;
  note: string | null;
  dropped_reason: string | null;
  dropped_at: string | null;
  created_at: string;
}

interface StageRow {
  id: string;
  component_id: string;
  kind: FlowStageKind;
  position: number;
  mode: FlowStageMode;
  label: string | null;
  state: FlowStageState;
  note: string | null;
  session_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  dropped_reason: string | null;
  dropped_at: string | null;
}

interface DecisionRow {
  id: number;
  component_id: string;
  text: string;
  author: string;
  session_id: string | null;
  created_at: string;
}

interface HistoryRow {
  id: number;
  map_id: string;
  component_id: string | null;
  relation_id: string | null;
  text: string;
  author: string;
  created_at: string;
}

const mapFromRow = (row: MapRow): FlowMap => ({
  id: row.id,
  workspaceId: row.workspace_id,
  number: row.number,
  name: row.name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const componentFromRow = (row: ComponentRow): FlowComponent => ({
  id: row.id,
  mapId: row.map_id,
  parentId: row.parent_id,
  number: row.number,
  position: row.position,
  name: row.name,
  deliverable: row.deliverable,
  doneWhen: row.done_when,
  taskId: row.task_id,
  droppedReason: row.dropped_reason,
  droppedAt: row.dropped_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const relationFromRow = (row: RelationRow): FlowRelation => ({
  id: row.id,
  mapId: row.map_id,
  number: row.number,
  fromId: row.from_id,
  toId: row.to_id,
  type: row.type,
  note: row.note,
  droppedReason: row.dropped_reason,
  droppedAt: row.dropped_at,
  createdAt: row.created_at,
});

const stageFromRow = (row: StageRow): FlowStage => ({
  id: row.id,
  componentId: row.component_id,
  kind: row.kind,
  position: row.position,
  mode: row.mode,
  label: row.label,
  state: row.state,
  note: row.note,
  sessionId: row.session_id,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  droppedReason: row.dropped_reason,
  droppedAt: row.dropped_at,
});

const decisionFromRow = (row: DecisionRow): FlowDecision => ({
  id: row.id,
  componentId: row.component_id,
  text: row.text,
  author: row.author,
  sessionId: row.session_id,
  createdAt: row.created_at,
});

const historyFromRow = (row: HistoryRow): FlowHistoryEntry => ({
  id: row.id,
  mapId: row.map_id,
  componentId: row.component_id,
  relationId: row.relation_id,
  text: row.text,
  author: row.author,
  createdAt: row.created_at,
});

/**
 * Flow maps and everything on them. Shares the one connection
 * `SqliteRepositories` opens, so its writes join that class's transactions.
 */
export class FlowRepository {
  constructor(private readonly database: Database) {}

  // ---------------------------------------------------------------- maps

  listMaps(workspaceId: string): FlowMap[] {
    return this.database
      .query<MapRow, [string]>(
        "SELECT * FROM flow_maps WHERE workspace_id = ? ORDER BY number",
      )
      .all(workspaceId)
      .map(mapFromRow);
  }

  findMap(id: string): FlowMap | undefined {
    const row = this.database
      .query<MapRow, [string]>("SELECT * FROM flow_maps WHERE id = ?")
      .get(id);
    return row ? mapFromRow(row) : undefined;
  }

  nextMapNumber(workspaceId: string): number {
    const row = this.database
      .query<{ next: number }, [string]>(
        "SELECT coalesce(max(number), 0) + 1 AS next FROM flow_maps WHERE workspace_id = ?",
      )
      .get(workspaceId);
    return row?.next ?? 1;
  }

  createMap(map: FlowMap): void {
    this.database
      .query(
        `INSERT INTO flow_maps (id, workspace_id, number, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        map.id,
        map.workspaceId,
        map.number,
        map.name,
        map.createdAt,
        map.updatedAt,
      );
  }

  /** Marks the map changed, so the app redraws it; renames it if asked. */
  touchMap(id: string, at: string, name?: string): void {
    if (name === undefined)
      this.database
        .query("UPDATE flow_maps SET updated_at = ? WHERE id = ?")
        .run(at, id);
    else
      this.database
        .query("UPDATE flow_maps SET updated_at = ?, name = ? WHERE id = ?")
        .run(at, name, id);
  }

  deleteMap(id: string): void {
    this.database.query("DELETE FROM flow_maps WHERE id = ?").run(id);
  }

  /**
   * One value per workspace that changes with every change to any of its
   * maps, including a map deleted. The app compares it to redraw.
   */
  fingerprint(): Array<{
    workspaceId: string;
    count: number;
    updatedAt: string;
  }> {
    return this.database
      .query<
        { workspace_id: string; count: number; updated_at: string },
        []
      >(
        `SELECT workspace_id, count(*) AS count, max(updated_at) AS updated_at
         FROM flow_maps GROUP BY workspace_id ORDER BY workspace_id`,
      )
      .all()
      .map((row) => ({
        workspaceId: row.workspace_id,
        count: row.count,
        updatedAt: row.updated_at,
      }));
  }

  // ---------------------------------------------------------- components

  listComponents(mapId: string): FlowComponent[] {
    return this.database
      .query<ComponentRow, [string]>(
        "SELECT * FROM flow_components WHERE map_id = ? ORDER BY position, number",
      )
      .all(mapId)
      .map(componentFromRow);
  }

  findComponent(id: string): FlowComponent | undefined {
    const row = this.database
      .query<ComponentRow, [string]>(
        "SELECT * FROM flow_components WHERE id = ?",
      )
      .get(id);
    return row ? componentFromRow(row) : undefined;
  }

  /** Components linked to a task, across every map. */
  componentsForTask(taskId: string): FlowComponent[] {
    return this.database
      .query<ComponentRow, [string]>(
        "SELECT * FROM flow_components WHERE task_id = ? ORDER BY created_at",
      )
      .all(taskId)
      .map(componentFromRow);
  }

  nextComponentNumber(mapId: string): number {
    const row = this.database
      .query<{ next: number }, [string]>(
        "SELECT coalesce(max(number), 0) + 1 AS next FROM flow_components WHERE map_id = ?",
      )
      .get(mapId);
    return row?.next ?? 1;
  }

  /** The position after the last component inside this parent. */
  nextPosition(mapId: string, parentId: string | null): number {
    const row = this.database
      .query<{ next: number }, [string, string | null]>(
        "SELECT coalesce(max(position), -1) + 1 AS next FROM flow_components WHERE map_id = ? AND parent_id IS ?",
      )
      .get(mapId, parentId);
    return row?.next ?? 0;
  }

  createComponent(component: FlowComponent): void {
    this.database
      .query(
        `INSERT INTO flow_components
         (id, map_id, parent_id, number, position, name, deliverable, done_when,
          task_id, dropped_reason, dropped_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        component.id,
        component.mapId,
        component.parentId,
        component.number,
        component.position,
        component.name,
        component.deliverable,
        component.doneWhen,
        component.taskId,
        component.droppedReason,
        component.droppedAt,
        component.createdAt,
        component.updatedAt,
      );
  }

  updateComponent(component: FlowComponent): void {
    this.database
      .query(
        `UPDATE flow_components SET parent_id = ?, position = ?, name = ?,
         deliverable = ?, done_when = ?, task_id = ?, dropped_reason = ?,
         dropped_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        component.parentId,
        component.position,
        component.name,
        component.deliverable,
        component.doneWhen,
        component.taskId,
        component.droppedReason,
        component.droppedAt,
        component.updatedAt,
        component.id,
      );
  }

  /** Deletes the component; what it contains and its relations go with it. */
  deleteComponent(id: string): void {
    this.database.query("DELETE FROM flow_components WHERE id = ?").run(id);
  }

  // ----------------------------------------------------------- relations

  listRelations(mapId: string): FlowRelation[] {
    return this.database
      .query<RelationRow, [string]>(
        "SELECT * FROM flow_relations WHERE map_id = ? ORDER BY number",
      )
      .all(mapId)
      .map(relationFromRow);
  }

  findRelation(id: string): FlowRelation | undefined {
    const row = this.database
      .query<RelationRow, [string]>("SELECT * FROM flow_relations WHERE id = ?")
      .get(id);
    return row ? relationFromRow(row) : undefined;
  }

  nextRelationNumber(mapId: string): number {
    const row = this.database
      .query<{ next: number }, [string]>(
        "SELECT coalesce(max(number), 0) + 1 AS next FROM flow_relations WHERE map_id = ?",
      )
      .get(mapId);
    return row?.next ?? 1;
  }

  createRelation(relation: FlowRelation): void {
    this.database
      .query(
        `INSERT INTO flow_relations
         (id, map_id, number, from_id, to_id, type, note, dropped_reason,
          dropped_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        relation.id,
        relation.mapId,
        relation.number,
        relation.fromId,
        relation.toId,
        relation.type,
        relation.note,
        relation.droppedReason,
        relation.droppedAt,
        relation.createdAt,
      );
  }

  updateRelation(relation: FlowRelation): void {
    this.database
      .query(
        `UPDATE flow_relations SET type = ?, note = ?, dropped_reason = ?,
         dropped_at = ? WHERE id = ?`,
      )
      .run(
        relation.type,
        relation.note,
        relation.droppedReason,
        relation.droppedAt,
        relation.id,
      );
  }

  deleteRelation(id: string): void {
    this.database.query("DELETE FROM flow_relations WHERE id = ?").run(id);
  }

  // -------------------------------------------------------------- stages

  /** Every stage on a map, in component then position order. */
  listStages(mapId: string): FlowStage[] {
    return this.database
      .query<StageRow, [string]>(
        `SELECT flow_stages.* FROM flow_stages
         JOIN flow_components ON flow_components.id = flow_stages.component_id
         WHERE flow_components.map_id = ?
         ORDER BY flow_components.number, flow_stages.position`,
      )
      .all(mapId)
      .map(stageFromRow);
  }

  listComponentStages(componentId: string): FlowStage[] {
    return this.database
      .query<StageRow, [string]>(
        "SELECT * FROM flow_stages WHERE component_id = ? ORDER BY position",
      )
      .all(componentId)
      .map(stageFromRow);
  }

  /** Stages a session claimed that are still in its hands. */
  heldStages(sessionId: string): FlowStage[] {
    return this.database
      .query<StageRow, [string]>(
        "SELECT * FROM flow_stages WHERE session_id = ? AND state IN ('running', 'blocked') AND dropped_at IS NULL",
      )
      .all(sessionId)
      .map(stageFromRow);
  }

  createStage(stage: FlowStage): void {
    this.database
      .query(
        `INSERT INTO flow_stages
         (id, component_id, kind, position, mode, label, state, note,
          session_id, started_at, finished_at, dropped_reason, dropped_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stage.id,
        stage.componentId,
        stage.kind,
        stage.position,
        stage.mode,
        stage.label,
        stage.state,
        stage.note,
        stage.sessionId,
        stage.startedAt,
        stage.finishedAt,
        stage.droppedReason,
        stage.droppedAt,
      );
  }

  updateStage(stage: FlowStage): void {
    this.database
      .query(
        `UPDATE flow_stages SET position = ?, mode = ?, label = ?, state = ?,
         note = ?, session_id = ?, started_at = ?, finished_at = ?,
         dropped_reason = ?, dropped_at = ? WHERE id = ?`,
      )
      .run(
        stage.position,
        stage.mode,
        stage.label,
        stage.state,
        stage.note,
        stage.sessionId,
        stage.startedAt,
        stage.finishedAt,
        stage.droppedReason,
        stage.droppedAt,
        stage.id,
      );
  }

  deleteStage(id: string): void {
    this.database.query("DELETE FROM flow_stages WHERE id = ?").run(id);
  }

  /**
   * Hands a session's unfinished stages to its rebirth successor and marks
   * their maps changed. Finished stages keep the session that did them.
   */
  moveHeldStages(fromSessionId: string, toSessionId: string, at: string): void {
    const moved = this.heldStages(fromSessionId);
    if (!moved.length) return;
    this.database
      .query(
        "UPDATE flow_stages SET session_id = ? WHERE session_id = ? AND state IN ('running', 'blocked') AND dropped_at IS NULL",
      )
      .run(toSessionId, fromSessionId);
    const maps = new Set(
      moved.flatMap((stage) => this.findComponent(stage.componentId)?.mapId ?? []),
    );
    for (const mapId of maps) this.touchMap(mapId, at);
  }

  // ----------------------------------------------------------- decisions

  listDecisions(mapId: string): FlowDecision[] {
    return this.database
      .query<DecisionRow, [string]>(
        `SELECT flow_decisions.* FROM flow_decisions
         JOIN flow_components ON flow_components.id = flow_decisions.component_id
         WHERE flow_components.map_id = ? ORDER BY flow_decisions.id`,
      )
      .all(mapId)
      .map(decisionFromRow);
  }

  addDecision(decision: Omit<FlowDecision, "id">): FlowDecision {
    const row = this.database
      .query<DecisionRow, [string, string, string, string | null, string]>(
        `INSERT INTO flow_decisions (component_id, text, author, session_id, created_at)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        decision.componentId,
        decision.text,
        decision.author,
        decision.sessionId,
        decision.createdAt,
      );
    if (!row) throw new Error("The decision was not stored");
    return decisionFromRow(row);
  }

  // ------------------------------------------------------------- history

  /** The newest lines first. */
  listHistory(mapId: string, limit: number): FlowHistoryEntry[] {
    return this.database
      .query<HistoryRow, [string, number]>(
        "SELECT * FROM flow_history WHERE map_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(mapId, limit)
      .map(historyFromRow);
  }

  addHistory(entry: Omit<FlowHistoryEntry, "id">): void {
    this.database
      .query(
        `INSERT INTO flow_history (map_id, component_id, relation_id, text, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.mapId,
        entry.componentId,
        entry.relationId,
        entry.text,
        entry.author,
        entry.createdAt,
      );
  }
}
