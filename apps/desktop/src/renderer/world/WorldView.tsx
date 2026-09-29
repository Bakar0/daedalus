import { useEffect, useRef, useState } from "react";
import { waitingLabel } from "../session-view";
import { WorldEngine } from "./world-engine";
import type { WorldActor, WorldModel } from "./world-model";
import { WORLD_CHARACTERS, worldCharacterById } from "./characters";
import type { WorldPoint } from "./world-theme";
import { WORLD_THEMES, worldThemeById } from "./themes";

/**
 * The World view (#44): the scope's agents drawn as figures moving between
 * stations. It is loaded on first open, so the app does not pay for Pixi
 * until someone looks. A click on a figure or a "Needs you" row opens that
 * session, exactly as a board card does.
 */

const THEME_STORAGE_KEY = "daedalus.world.theme";
const CHARACTER_STORAGE_KEY = "daedalus.world.character";

const stored = (key: string) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const store = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A remembered picker choice is a convenience; the default still works.
  }
};

/** A labelled select, shown only when there is more than one choice. */
function Picker(props: {
  label: string;
  options: ReadonlyArray<{ id: string; label: string; description: string }>;
  value: string;
  onChange(id: string): void;
}) {
  if (props.options.length < 2) return null;
  return (
    <label className="world-theme-picker">
      <span>{props.label}</span>
      <select
        onChange={(event) => props.onChange(event.target.value)}
        title={
          props.options.find((item) => item.id === props.value)?.description
        }
        value={props.value}
      >
        {props.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface WorldViewProps {
  model: WorldModel;
  appearance: "dark" | "light";
  now: number;
  onOpenSession(sessionId: string, workspaceId: string): void;
}

const count = (value: number, noun: string) =>
  `${value} ${noun}${value === 1 ? "" : "s"}`;

export default function WorldView(props: WorldViewProps) {
  const { model, appearance, now } = props;
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<WorldEngine | null>(null);
  const [themeId, setThemeId] = useState(
    () => worldThemeById(stored(THEME_STORAGE_KEY)).id,
  );
  const [characterId, setCharacterId] = useState(
    () => worldCharacterById(stored(CHARACTER_STORAGE_KEY)).id,
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
      worldCharacterById(characterId),
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
    store(THEME_STORAGE_KEY, themeId);
  }, [themeId]);
  useEffect(() => {
    engine.current?.setCharacter(worldCharacterById(characterId));
    store(CHARACTER_STORAGE_KEY, characterId);
  }, [characterId]);

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
        <div className="world-pickers">
          <Picker
            label="Agents"
            onChange={setCharacterId}
            options={WORLD_CHARACTERS}
            value={characterId}
          />
          <Picker
            label="World"
            onChange={setThemeId}
            options={WORLD_THEMES}
            value={themeId}
          />
        </div>
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
              <span>Start a session from any board and it walks in here.</span>
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
                    {` · ${zoneName(actor)}`}
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
            {` · ${zoneName(hovered)}`}
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
