import { useEffect, useMemo, useRef, useState } from "react";
import { waitingLabel } from "../session-view";
import { WorldEngine } from "./world-engine";
import { milestonesBetween } from "./world-milestones";
import {
  CONTEXT_PREVIEWS,
  CRATE_STAGES,
  HANDOFF_STEPS,
  NO_PREVIEW,
  previewModel,
  type ContextPreview,
  type WorldPreview,
} from "./world-preview";
import type { WorldActor, WorldModel, WorldWeek } from "./world-model";
import { WORLD_CHARACTERS, worldCharacterById } from "./characters";
import { contextLevel } from "./characters/parts";
import type { WorldPoint } from "./world-theme";
import { WORLD_THEMES, worldThemeById } from "./themes";

/**
 * The World view (#44): the scope's agents drawn as figures moving between
 * stations. It is loaded on first open, so the app does not pay for Pixi
 * until someone looks. A click on a figure or a "Needs you" row opens that
 * session, exactly as a board card does.
 */

// Only a choice made in a picker is remembered, so a new default reaches
// everyone who never chose. The keys moved when that became true: the old
// ones held whatever the default was on the day, written on every open.
const THEME_STORAGE_KEY = "daedalus.world.picked-theme";
const CHARACTER_STORAGE_KEY = "daedalus.world.picked-agents";

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

/**
 * Each agent's latest progress, for the hover card, kept for as long as the
 * app runs so reopening the World does not forget it. Four each, newest
 * first; nothing adds them up.
 */
const recent = new Map<string, Array<{ text: string; at: string }>>();
const RECENT_SIZE = 4;

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
  /**
   * Offers the preview controls, for development builds: pretend context
   * levels, a pop and a crate, drawn over the real agents.
   */
  preview?: boolean;
  /** Opens the World in a window of its own; absent in that window. */
  onPopOut?(): void;
  appearance: "dark" | "light";
  now: number;
  onOpenSession(sessionId: string, workspaceId: string): void;
}

const count = (value: number, noun: string) =>
  `${value} ${noun}${value === 1 ? "" : "s"}`;

/**
 * How full an agent's context is, on its hover card: a bar with marks at
 * 30, 50 and 80%, the points where the figure starts to steam, sweat and
 * smoke.
 */
function ContextMeter(props: { percent: number }) {
  const level = contextLevel(props.percent);
  const note = ["", "warming up", "sweating", "about to run out"][level];
  return (
    <span className="world-context">
      <span
        aria-label={`${Math.round(props.percent)}% of context used`}
        className={`world-context-bar level-${level}`}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(props.percent)}
      >
        <span style={{ width: `${Math.min(100, props.percent)}%` }} />
        {[30, 50, 80].map((mark) => (
          <i key={mark} style={{ left: `${mark}%` }} />
        ))}
      </span>
      <small>
        {Math.round(props.percent)}% context{note ? ` · ${note}` : ""}
      </small>
    </span>
  );
}

/** The newest this many per workspace; the counts cover the rest. */
const WEEK_ROWS = 8;

/**
 * What shipped in the last seven days, per workspace: the scroll at the
 * Hermes Post. It lists outcomes and nothing else.
 */
function WeekScroll(props: { week: WorldWeek[]; onClose(): void }) {
  const tasks = (item: WorldWeek) =>
    item.trophies.filter((trophy) => trophy.kind !== "pull-request").length;
  const pulls = (item: WorldWeek) =>
    item.trophies.filter((trophy) => trophy.kind !== "task").length;
  return (
    <section aria-label="This week" className="world-week">
      <header>
        <strong>This week in the Labyrinth</strong>
        <button aria-label="Close" onClick={props.onClose} type="button">
          ×
        </button>
      </header>
      {props.week.length === 0 && (
        <p className="world-week-empty">
          Nothing finished in the last seven days yet.
        </p>
      )}
      {props.week.map((item) => (
        <div className="world-week-zone" key={item.zoneId}>
          <div className="world-week-head">
            <span>{item.name}</span>
            <small>
              {[
                tasks(item) ? `${tasks(item)} done` : null,
                pulls(item) ? `${count(pulls(item), "PR")} merged` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </small>
          </div>
          <ul>
            {item.trophies.slice(0, WEEK_ROWS).map((trophy) => (
              <li key={trophy.id}>
                <span>{trophy.label}</span>
                {trophy.detail && <small>{trophy.detail}</small>}
              </li>
            ))}
            {item.trophies.length > WEEK_ROWS && (
              <li>
                <small>and {item.trophies.length - WEEK_ROWS} more</small>
              </li>
            )}
          </ul>
        </div>
      ))}
    </section>
  );
}

export default function WorldView(props: WorldViewProps) {
  const { appearance, now } = props;
  const [preview, setPreview] = useState<WorldPreview>(NO_PREVIEW);
  // What is drawn: the real model, or it with the preview applied.
  const model = useMemo(
    () => previewModel(props.model, preview),
    [props.model, preview],
  );
  const drawn = useRef(model);
  drawn.current = model;
  // The pretend crate moves on a stage every few seconds, then is gone.
  useEffect(() => {
    if (preview.crateStep === null) return;
    const timer = setTimeout(
      () =>
        setPreview((current) => ({
          ...current,
          crateStep:
            current.crateStep === null ||
            current.crateStep + 1 > CRATE_STAGES.length
              ? null
              : current.crateStep + 1,
        })),
      3500,
    );
    return () => clearTimeout(timer);
  }, [preview.crateStep]);
  // The pretend handoff: writing, then replaced, then back to real.
  useEffect(() => {
    const step = preview.handoffStep;
    if (step === null || step === undefined) return;
    const timer = setTimeout(
      () =>
        setPreview((current) => ({
          ...current,
          handoffStep: current.handoffStep === 0 ? 1 : null,
        })),
      HANDOFF_STEPS[step]! * 1000,
    );
    return () => clearTimeout(timer);
  }, [preview.handoffStep]);
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
  // Scenery with something to say, such as a trophy on a shelf.
  const [tip, setTip] = useState<{ text: string; point: WorldPoint }>();
  const [weekOpen, setWeekOpen] = useState(false);
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
        onTip: (text, point) =>
          setTip(text && point ? { text, point } : undefined),
        onAction: (action) => {
          if (action === "week") setWeekOpen((open) => !open);
        },
      },
    ).then(
      (instance) => {
        if (cancelled) return instance.destroy();
        created = instance;
        engine.current = instance;
        instance.setModel(drawn.current);
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

  // Progress is a change between two snapshots, so the first one shows none.
  const previous = useRef<WorldModel | null>(null);
  useEffect(() => {
    engine.current?.setModel(model);
    if (previous.current) {
      const at = new Date().toISOString();
      for (const milestone of milestonesBetween(previous.current, model)) {
        engine.current?.celebrate(milestone.sessionId, milestone.text);
        recent.set(
          milestone.sessionId,
          [
            { text: milestone.text, at },
            ...(recent.get(milestone.sessionId) ?? []),
          ].slice(0, RECENT_SIZE),
        );
      }
    }
    previous.current = model;
  }, [model]);
  useEffect(() => engine.current?.setLook({ appearance }), [appearance]);
  useEffect(() => {
    engine.current?.setTheme(worldThemeById(themeId));
  }, [themeId]);
  useEffect(() => {
    engine.current?.setCharacter(worldCharacterById(characterId));
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
          {props.preview && (
            <div className="world-preview" aria-label="Preview">
              <select
                aria-label="Preview context"
                onChange={(event) => {
                  const value = event.target.value;
                  setPreview((current) => ({
                    ...current,
                    context: (value === "off" || value === "spread"
                      ? value
                      : Number(value)) as ContextPreview,
                  }));
                }}
                title="Pretend context levels, on this screen only"
                value={String(preview.context)}
              >
                {CONTEXT_PREVIEWS.map((option) => (
                  <option key={option.value} value={String(option.value)}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  for (const actor of model.actors)
                    engine.current?.celebrate(
                      actor.sessionId,
                      "✓ Preview: a turn finished",
                    );
                }}
                title="Pop a pretend milestone over every agent"
                type="button"
              >
                Pop
              </button>
              <button
                disabled={preview.crateStep !== null || !model.actors.length}
                onClick={() =>
                  setPreview((current) => ({ ...current, crateStep: 0 }))
                }
                title="Send a pretend crate from commit to merge"
                type="button"
              >
                Ship a crate
              </button>
              <button
                disabled={
                  (preview.handoffStep ?? null) !== null ||
                  !props.model.actors.length
                }
                onClick={() =>
                  setPreview((current) => ({ ...current, handoffStep: 0 }))
                }
                title="The first agent hands off through the Rebuilder"
                type="button"
              >
                Hand off
              </button>
            </div>
          )}
          {props.onPopOut && (
            <button
              className="world-week-button"
              onClick={props.onPopOut}
              title="Open the World in a window of its own, to keep beside your work"
              type="button"
            >
              Open in window ↗
            </button>
          )}
          <button
            aria-expanded={weekOpen}
            className="world-week-button"
            onClick={() => setWeekOpen((open) => !open)}
            title="What every workspace finished in the last seven days"
            type="button"
          >
            This week
          </button>
          <Picker
            label="Agents"
            onChange={(id) => {
              setCharacterId(id);
              store(CHARACTER_STORAGE_KEY, id);
            }}
            options={WORLD_CHARACTERS}
            value={characterId}
          />
          <Picker
            label="World"
            onChange={(id) => {
              setThemeId(id);
              store(THEME_STORAGE_KEY, id);
            }}
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
          {!failure && (
            <div className="world-zoom" aria-label="Zoom">
              <button
                aria-label="Zoom out"
                onClick={() => engine.current?.zoomBy(1 / 1.5)}
                title="Zoom out"
                type="button"
              >
                −
              </button>
              <button
                onClick={() => engine.current?.fit()}
                title="Show the whole world"
                type="button"
              >
                Fit
              </button>
              <button
                aria-label="Zoom in"
                onClick={() => engine.current?.zoomBy(1.5)}
                title="Zoom in (or pinch, or Cmd-scroll; drag to move)"
                type="button"
              >
                +
              </button>
            </div>
          )}
          {weekOpen && (
            <WeekScroll onClose={() => setWeekOpen(false)} week={model.week} />
          )}
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
      {tip && !hovered && (
        <div
          className="world-card"
          role="tooltip"
          style={{ left: tip.point.x + 14, top: tip.point.y + 14 }}
        >
          {tip.text
            .split("\n")
            .map((line, index) =>
              index === 0 ? (
                <strong key={line}>{line}</strong>
              ) : (
                <small key={line}>{line}</small>
              ),
            )}
        </div>
      )}
      {hovered && hover && (
        <div
          className="world-card"
          role="tooltip"
          style={{ left: hover.point.x + 14, top: hover.point.y + 14 }}
        >
          <strong>{hovered.name}</strong>
          {worldCharacterById(characterId).caption?.(hovered) && (
            <em className="world-card-persona">
              {worldCharacterById(characterId).caption?.(hovered)}
            </em>
          )}
          {hovered.taskLabel && <span>{hovered.taskLabel}</span>}
          <small>
            {hovered.label}
            {hovered.unconfirmed ? " (unconfirmed)" : ""}
            {hovered.since ? ` · ${waitingLabel(hovered.since, now)}` : ""}
            {` · ${zoneName(hovered)}`}
          </small>
          {hovered.detail && <code>{hovered.detail}</code>}
          {recent.get(hovered.sessionId)?.map((item) => (
            <small className="world-card-progress" key={item.at + item.text}>
              {item.text} · {waitingLabel(item.at, now)}
            </small>
          ))}
          {hovered.model && <small>{hovered.model}</small>}
          {hovered.contextPercent !== null && (
            <ContextMeter percent={hovered.contextPercent} />
          )}
          <small className="world-card-hint">Click to open the session</small>
        </div>
      )}
    </div>
  );
}
