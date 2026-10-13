import { useEffect, useMemo, useRef, useState } from "react";
import type {
  FlowMapDetailDto,
  FlowMapSummaryDto,
  TaskDto,
  WorkspaceDto,
} from "@daedalus/protocol";
import type { DesktopClient } from "../client-types";
import { FlowCanvas } from "./FlowCanvas";
import { RELATION_STYLES, type StageSession } from "./model";
import "./flow-map.css";

const mapStorageKey = (workspaceId: string) =>
  `daedalus.flowMap.selected.${workspaceId}`;

const readStored = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** Makes the Map tab open on this map next time it opens for the workspace. */
export const rememberFlowMap = (workspaceId: string, mapId: string) =>
  writeStored(mapStorageKey(workspaceId), mapId);

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A private window or blocked storage only forgets the choice.
  }
}

/**
 * The Map tab: a workspace's flow maps drawn as the architecture canvas.
 * Agents change the map through `daedal flow`; the tab reads it again on
 * every data change, so it follows them live. The app only reads: the user
 * edits by asking an agent or with `daedal flow` in a terminal.
 */
export function FlowMapView({
  client,
  workspace,
  dataRevision,
  sessions,
  tasks,
  onOpenSession,
  onOpenTask,
  onError,
}: {
  client: DesktopClient;
  workspace: WorkspaceDto;
  dataRevision: number;
  sessions: ReadonlyMap<string, StageSession>;
  tasks: ReadonlyMap<string, TaskDto>;
  onOpenSession: (session: StageSession) => void;
  onOpenTask: (task: TaskDto) => void;
  onError: (message: string) => void;
}) {
  const [maps, setMaps] = useState<FlowMapSummaryDto[] | null>(null);
  const [selected, setSelected] = useState<string | null>(() =>
    readStored(mapStorageKey(workspace.id)),
  );
  const [detail, setDetail] = useState<FlowMapDetailDto | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [showDropped, setShowDropped] = useState(false);
  const [showRelations, setShowRelations] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Kept in a ref so a caller's new function each render does not refetch.
  const reportError = useRef(onError);
  reportError.current = onError;

  useEffect(() => {
    setMaps(null);
    setDetail(null);
    setSelected(readStored(mapStorageKey(workspace.id)));
  }, [workspace.id]);

  useEffect(() => {
    let cancelled = false;
    void client.request
      .flowMaps({ workspaceId: workspace.id })
      .then((response) => {
        if (cancelled) return;
        if (!response.ok) return reportError.current(response.error.message);
        setMaps(response.data);
      });
    return () => {
      cancelled = true;
    };
  }, [client, dataRevision, workspace.id]);

  // The stored choice, or the newest map when that one is gone.
  const mapId =
    maps?.find((map) => map.id === selected)?.id ?? maps?.at(-1)?.id ?? null;

  useEffect(() => {
    if (!mapId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void client.request.flowMap({ mapId }).then((response) => {
      if (cancelled) return;
      if (!response.ok) return reportError.current(response.error.message);
      setDetail(response.data);
    });
    return () => {
      cancelled = true;
    };
  }, [client, dataRevision, mapId]);

  const dropped = useMemo(
    () =>
      detail
        ? detail.components.filter((c) => c.droppedReason !== null).length +
          detail.relations.filter((r) => r.droppedReason !== null).length +
          detail.stages.filter((s) => s.droppedReason !== null).length
        : 0,
    [detail],
  );

  if (maps === null)
    return <div className="empty large">Loading flow maps…</div>;
  if (!maps.length)
    return (
      <div className="flow-map-empty empty large">
        <strong>No flow map in this workspace yet</strong>
        <span>
          A session with the Flow map ability breaks an idea or a task into
          components and draws it here. Turn it on in a session&apos;s menu and
          ask it to map the work, or run{" "}
          <code>daedal flow new &lt;name&gt; --deliverable &lt;text&gt;</code>.
        </span>
      </div>
    );

  return (
    <div className="flow-map-view">
      <div className="flow-toolbar">
        <label className="flow-map-picker">
          <span>Map</span>
          <select
            onChange={(event) => {
              setSelected(event.target.value);
              writeStored(mapStorageKey(workspace.id), event.target.value);
              setCollapsed(new Set());
            }}
            value={mapId ?? ""}
          >
            {maps.map((map) => (
              <option key={map.id} value={map.id}>
                #{map.number} {map.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flow-toggle">
          <input
            checked={showRelations}
            onChange={(event) => setShowRelations(event.target.checked)}
            type="checkbox"
          />
          Relations
        </label>
        <label className="flow-toggle">
          <input
            checked={showDropped}
            disabled={!dropped}
            onChange={(event) => setShowDropped(event.target.checked)}
            type="checkbox"
          />
          Dropped{dropped ? ` (${dropped})` : ""}
        </label>
        <button
          aria-pressed={historyOpen}
          className={`quiet flow-history-toggle ${historyOpen ? "active" : ""}`}
          onClick={() => setHistoryOpen((open) => !open)}
          type="button"
        >
          History
        </button>
      </div>
      {showRelations ? (
        <div className="flow-legend" aria-label="Relation types">
          {RELATION_STYLES.map((style) => (
            <div className="flow-legend-row" key={style.type}>
              <svg aria-hidden="true" height="12" width="56">
                <line
                  className={`flow-edge flow-edge-${style.pattern}`}
                  x1="2"
                  x2="46"
                  y1="6"
                  y2="6"
                  markerEnd={`url(#flow-arrow-${style.pattern})`}
                />
              </svg>
              <b className={`flow-legend-${style.pattern}`}>{style.type}</b>
              <span>{style.meaning}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flow-body">
        <div className="flow-scroll">
          {detail && detail.map.id === mapId ? (
            <FlowCanvas
              collapsed={collapsed}
              detail={detail}
              onOpenSession={onOpenSession}
              onOpenTask={onOpenTask}
              onToggleCollapse={(id) =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              sessions={sessions}
              showDropped={showDropped}
              showRelations={showRelations}
              tasks={tasks}
            />
          ) : (
            <div className="empty large">Loading the map…</div>
          )}
        </div>
        {historyOpen && detail ? (
          <aside className="flow-history" aria-label="Map history">
            <strong>History</strong>
            <ol>
              {detail.history.map((entry) => (
                <li key={entry.id}>
                  <span>{entry.text}</span>
                  <small>
                    {entry.author} ·{" "}
                    {new Date(entry.createdAt).toLocaleString()}
                  </small>
                </li>
              ))}
            </ol>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
