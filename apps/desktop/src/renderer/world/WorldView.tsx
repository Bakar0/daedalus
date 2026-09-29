import { useEffect, useRef, useState } from "react";
import { waitingLabel } from "../session-view";
import { WorldEngine } from "./world-engine";
import type { WorldActor, WorldModel } from "./world-model";
import type { WorldPoint } from "./world-theme";
import { WORLD_THEMES, worldThemeById } from "./themes";

/**
 * The World view (#44): the scope's agents drawn as figures moving between
 * stations. It is loaded on first open, so the app does not pay for Pixi
 * until someone looks. A click on a figure or a "Needs you" row opens that
 * session, exactly as a board card does.
 */

const THEME_STORAGE_KEY = "daedalus.world.theme";

const storedThemeId = () => {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
};

const storeThemeId = (id: string) => {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // A remembered picker choice is a convenience; the default still works.
  }
};

export interface WorldViewProps {
  model: WorldModel;
  appearance: "dark" | "light";
  now: number;
  /** True when every workspace is showing, for the empty-state wording. */
  showingAll: boolean;
  onOpenSession(sessionId: string, workspaceId: string): void;
}

const count = (value: number, noun: string) =>
  `${value} ${noun}${value === 1 ? "" : "s"}`;

export default function WorldView(props: WorldViewProps) {
  const { model, appearance, now } = props;
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<WorldEngine | null>(null);
  const [themeId, setThemeId] = useState(
    () => worldThemeById(storedThemeId()).id,
  );
  const [failure, setFailure] = useState<string>();
  // The place is kept so the card closes when the agent walks off: a figure
  // moving out from under a still pointer fires no pointer event.
  const [hover, setHover] = useState<{
    id: string;
    point: WorldPoint;
    place: string;
  }>();
  // The engine's callbacks outlive renders; they read the latest props here.
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let cancelled = false;
    let created: WorldEngine | undefined;
    WorldEngine.create(
      element,
      worldThemeById(themeId),
      { appearance: latest.current.appearance },
      {
        onSelect: (sessionId) => {
          const actor = latest.current.model.actors.find(
            (item) => item.sessionId === sessionId,
          );
          if (actor)
            latest.current.onOpenSession(actor.sessionId, actor.zoneId);
        },
        onHover: (id, point) => {
          const actor = latest.current.model.actors.find(
            (item) => item.sessionId === id,
          );
          setHover(
            actor && point
              ? { id: actor.sessionId, point, place: actor.place }
              : undefined,
          );
        },
      },
    ).then(
      (instance) => {
        if (cancelled) return instance.destroy();
        created = instance;
        engine.current = instance;
        instance.setModel(latest.current.model);
      },
      (cause: unknown) => {
        if (!cancelled)
          setFailure(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
      created?.destroy();
      engine.current = null;
    };
    // One engine per mount; theme and appearance changes go through setters.
  }, []);

  useEffect(() => engine.current?.setModel(model), [model]);
  useEffect(() => engine.current?.setLook({ appearance }), [appearance]);
  useEffect(() => {
    engine.current?.setTheme(worldThemeById(themeId));
    storeThemeId(themeId);
  }, [themeId]);

  const waiting = model.actors.filter((actor) => actor.mood === "attention");
  const working = model.actors.filter((actor) => actor.mood === "working");
  const hovered = hover
    ? model.actors.find(
        (actor) => actor.sessionId === hover.id && actor.place === hover.place,
      )
    : undefined;
  const zoneName = (actor: WorldActor) =>
    model.zones.find((zone) => zone.id === actor.zoneId)?.name ?? "";
  const open = (actor: WorldActor) =>
    props.onOpenSession(actor.sessionId, actor.zoneId);

  return (
    <div className="world-view">
      <div className="world-toolbar">
        <div>
          <strong>World</strong>
          <span className="count-badge">{model.actors.length}</span>
          <small className="world-summary">
            {working.length} working ·{" "}
            <span className={waiting.length ? "world-waiting" : undefined}>
              {waiting.length} need{waiting.length === 1 ? "s" : ""} you
            </span>
          </small>
        </div>
        {WORLD_THEMES.length > 1 && (
          <label className="world-theme-picker">
            <span>Theme</span>
            <select
              onChange={(event) => setThemeId(event.target.value)}
              title={worldThemeById(themeId).description}
              value={themeId}
            >
              {WORLD_THEMES.map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {theme.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="world-body">
        <div
          aria-label={`${count(model.actors.length, "agent")} in ${count(model.zones.length, "workspace")}`}
          className="world-stage"
          ref={host}
          role="img"
        >
          {failure && (
            <div className="empty large world-overlay">
              <strong>The World view could not start</strong>
              <span>{failure}</span>
            </div>
          )}
          {!failure && model.actors.length === 0 && (
            <div className="world-overlay world-quiet">
              <strong>Nobody is in</strong>
              <span>
                Start a session from the board and it walks in here.
                {props.showingAll ? "" : " Every workspace shows in All."}
              </span>
            </div>
          )}
        </div>
        {waiting.length > 0 && (
          <aside aria-label="Needs you" className="world-needs">
            <span className="eyebrow">Needs you</span>
            {waiting.map((actor) => (
              <button key={actor.sessionId} onClick={() => open(actor)}>
                <span className="agent-dot tone-attention" aria-hidden="true" />
                <span className="world-needs-copy">
                  <strong>{actor.name}</strong>
                  <small>
                    {actor.label} · {waitingLabel(actor.since, now)}
                    {props.showingAll ? ` · ${zoneName(actor)}` : ""}
                  </small>
                  {actor.detail && <span>{actor.detail}</span>}
                </span>
              </button>
            ))}
          </aside>
        )}
      </div>
      {/* The canvas is a picture; this list is the same information for a
          screen reader, and a keyboard way into each session. */}
      <ul className="world-accessible-list">
        {model.actors.map((actor) => (
          <li key={actor.sessionId}>
            <button onClick={() => open(actor)}>
              {actor.name}: {actor.label}
              {actor.detail ? `, ${actor.detail}` : ""}
            </button>
          </li>
        ))}
      </ul>
      {hovered && hover && (
        <div
          className="world-card"
          role="tooltip"
          style={{ left: hover.point.x + 14, top: hover.point.y + 14 }}
        >
          <strong>{hovered.name}</strong>
          {hovered.taskLabel && <span>{hovered.taskLabel}</span>}
          <small>
            {hovered.label}
            {hovered.unconfirmed ? " (unconfirmed)" : ""}
            {hovered.since ? ` · ${waitingLabel(hovered.since, now)}` : ""}
            {props.showingAll ? ` · ${zoneName(hovered)}` : ""}
          </small>
          {hovered.detail && <code>{hovered.detail}</code>}
          {(hovered.model || hovered.contextPercent !== null) && (
            <small>
              {[
                hovered.model,
                hovered.contextPercent !== null
                  ? `${Math.round(hovered.contextPercent)}% context`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </small>
          )}
          <small className="world-card-hint">Click to open the session</small>
        </div>
      )}
    </div>
  );
}
