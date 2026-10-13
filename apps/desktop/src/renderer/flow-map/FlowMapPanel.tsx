import { useEffect, useMemo, useRef, useState } from "react";
import type {
  FlowMapDetailDto,
  FlowMapSummaryDto,
  SessionColorDto,
  TaskDto,
} from "@daedalus/protocol";
import type { DesktopClient } from "../client-types";
import { FlowCanvas } from "./FlowCanvas";
import { RELATION_STYLES, type StageSession } from "./model";
import "./flow-map.css";

/**
 * The bar above a session's terminal when the session owns a flow map or
 * holds a stage on one. Sessions with neither show nothing.
 */
export function FlowMapBar({
  maps,
  owns,
  color,
  open,
  onOpenPanel,
}: {
  maps: FlowMapSummaryDto[];
  /** True when the session owns these maps; false when it works on them. */
  owns: boolean;
  color: SessionColorDto | null;
  open: boolean;
  onOpenPanel: () => void;
}) {
  const names = maps.map((map) => map.name).join(", ");
  return (
    <section
      aria-label="Flow map"
      className="routine-bar flow-map-bar"
      data-color={color ?? undefined}
    >
      <div className="routine-bar-row">
        <span className="routine-bar-text">
          {owns
            ? `${maps.length === 1 ? "Map" : `${maps.length} maps`} · ${names}`
            : `Works on a stage of ${names}`}
        </span>
        <span className="routine-bar-actions">
          <button
            aria-pressed={open}
            className="quiet"
            data-panel-toggle
            onClick={onOpenPanel}
            type="button"
          >
            Map
          </button>
        </span>
      </div>
    </section>
  );
}

/**
 * A session's flow map drawn as the architecture canvas, over the session's
 * terminal. Agents change the map through `daedal flow`; the panel reads it
 * again on every data change, so it follows them live. The app only reads.
 */
export function FlowMapPanel({
  client,
  maps,
  mapId,
  onSelectMap,
  dataRevision,
  sessions,
  tasks,
  onOpenSession,
  onOpenTask,
  onError,
  onClose,
  onPopOut,
  windowed = false,
}: {
  client: DesktopClient;
  /** The maps this session owns or works on. */
  maps: FlowMapSummaryDto[];
  mapId: string;
  onSelectMap: (mapId: string) => void;
  dataRevision: number;
  sessions: ReadonlyMap<string, StageSession>;
  tasks: ReadonlyMap<string, TaskDto>;
  onOpenSession: (session: StageSession) => void;
  onOpenTask: (task: TaskDto) => void;
  onError: (message: string) => void;
  /** Absent in a map window, which the system closes. */
  onClose?: () => void;
  /** Opens the map in a window of its own, as the World does. */
  onPopOut?: () => void;
  /** Fills a window of its own rather than sitting over a terminal. */
  windowed?: boolean;
}) {
  const [detail, setDetail] = useState<FlowMapDetailDto | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [showDropped, setShowDropped] = useState(false);
  const [showRelations, setShowRelations] = useState(true);
  const [legendOpen, setLegendOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  // Kept in a ref so a caller's new function each render does not refetch.
  const reportError = useRef(onError);
  reportError.current = onError;

  useEffect(() => {
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

  useEffect(() => {
    setCollapsed(new Set());
    panel.current?.focus();
  }, [mapId]);

  const dropped = useMemo(
    () =>
      detail
        ? detail.components.filter((c) => c.droppedReason !== null).length +
          detail.relations.filter((r) => r.droppedReason !== null).length +
          detail.stages.filter((s) => s.droppedReason !== null).length
        : 0,
    [detail],
  );
  const current = maps.find((map) => map.id === mapId);

  return (
    <aside
      aria-label={`Flow map ${current?.name ?? ""}`}
      className={`flow-map-panel flow-map-view ${windowed ? "flow-map-windowed" : ""}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !onClose) return;
        event.preventDefault();
        onClose();
      }}
      ref={panel}
      role="dialog"
      tabIndex={-1}
    >
      <div className="flow-toolbar">
        <div className="flow-map-title">
          <span className="eyebrow">Flow map</span>
          {maps.length > 1 ? (
            <select
              aria-label="Map"
              onChange={(event) => onSelectMap(event.target.value)}
              value={mapId}
            >
              {maps.map((map) => (
                <option key={map.id} value={map.id}>
                  #{map.number} {map.name}
                </option>
              ))}
            </select>
          ) : (
            <h2>{current?.name ?? "Map"}</h2>
          )}
        </div>
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
        <div className="flow-toolbar-end">
          <button
            aria-expanded={legendOpen}
            className={`quiet flow-tool ${legendOpen ? "active" : ""}`}
            onClick={() => setLegendOpen((open) => !open)}
            type="button"
          >
            Legend
          </button>
          <button
            aria-pressed={historyOpen}
            className={`quiet flow-tool ${historyOpen ? "active" : ""}`}
            onClick={() => setHistoryOpen((open) => !open)}
            type="button"
          >
            History
          </button>
          {onPopOut ? (
            <button
              className="quiet flow-tool"
              onClick={onPopOut}
              title="Open the map in a window of its own"
              type="button"
            >
              Pop out
            </button>
          ) : null}
          {onClose ? (
            <button className="quiet flow-tool" onClick={onClose} type="button">
              Close
            </button>
          ) : null}
        </div>
        {legendOpen ? (
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
      </div>
      <div className="flow-body">
        <div className="flow-scroll">
          {detail && detail.map.id === mapId ? (
            <FlowCanvas
              collapsed={collapsed}
              detail={detail}
              onOpenSession={onOpenSession}
              onOpenTask={onOpenTask}
              onToggleCollapse={(id) =>
                setCollapsed((existing) => {
                  const next = new Set(existing);
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
    </aside>
  );
}
