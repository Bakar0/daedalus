import { Application, Container, type FederatedPointerEvent } from "pixi.js";
import type { WorldActor, WorldModel, WorldPlace } from "./world-model";
import type {
  ActorFigure,
  WorldCharacter,
  WorldLook,
  WorldPoint,
  WorldTheme,
} from "./world-theme";

/**
 * Runs one World: lays zones out in a grid scaled to the view, walks actors
 * to the spot their theme gives them, and reports clicks and hovers. It holds
 * no state the snapshot does not: every `setModel` is the whole truth, and an
 * actor missing from it walks out of the door.
 */

export interface WorldEngineOptions {
  onSelect(sessionId: string): void;
  /** `point` is in page (client) pixels, for an HTML hover card. */
  onHover(sessionId: string | null, point: WorldPoint | null): void;
}

/** World pixels per second. Slow enough to watch, quick enough to matter. */
const WALK_SPEED = 150;
/** Gap between zones, in world pixels. */
const ZONE_GAP = 24;
/**
 * The world is ambient: 30 frames a second looks the same for figures this
 * size and halves the cost of leaving the view open all day.
 */
const MAX_FPS = 30;

interface ZoneEntry {
  layer: Container;
  origin: WorldPoint;
}

interface ActorEntry {
  actor: WorldActor;
  figure: ActorFigure;
  position: WorldPoint;
  target: WorldPoint;
  facing: -1 | 0 | 1;
  /** Walking to the door on the way out; removed on arrival. */
  leaving: boolean;
}

export class WorldEngine {
  private readonly app = new Application();
  private readonly world = new Container();
  private readonly scenery = new Container();
  private readonly figures = new Container();
  private readonly zones = new Map<string, ZoneEntry>();
  private readonly actors = new Map<string, ActorEntry>();
  private model: WorldModel = { zones: [], actors: [] };
  private sceneryKey = "";
  private elapsed = 0;
  private destroyed = false;

  private constructor(
    private readonly host: HTMLElement,
    private theme: WorldTheme,
    private character: WorldCharacter,
    private look: WorldLook,
    private readonly options: WorldEngineOptions,
  ) {}

  /** Rejects when the view has no WebGL; the caller shows a fallback. */
  static async create(
    host: HTMLElement,
    theme: WorldTheme,
    character: WorldCharacter,
    look: WorldLook,
    options: WorldEngineOptions,
  ): Promise<WorldEngine> {
    const engine = new WorldEngine(host, theme, character, look, options);
    await engine.app.init({
      antialias: true,
      autoDensity: true,
      background: theme.backdrop(look),
      preference: "webgl",
      resizeTo: host,
      resolution: window.devicePixelRatio || 1,
    });
    engine.start();
    return engine;
  }

  private start() {
    const { app } = this;
    app.canvas.classList.add("world-canvas");
    this.host.append(app.canvas);
    this.figures.sortableChildren = true;
    this.world.addChild(this.scenery, this.figures);
    app.stage.addChild(this.world);
    app.ticker.maxFPS = MAX_FPS;
    app.ticker.add((ticker) => this.tick(ticker.deltaMS / 1000));
    app.renderer.on("resize", () => this.relayout(true));
    document.addEventListener("visibilitychange", this.visibility);
  }

  /** A hidden window draws nothing. */
  private readonly visibility = () => {
    if (document.hidden) this.app.ticker.stop();
    else this.app.ticker.start();
  };

  setModel(model: WorldModel) {
    this.model = model;
    this.relayout(false);
  }

  setTheme(theme: WorldTheme) {
    if (theme.id === this.theme.id) return;
    this.theme = theme;
    this.rebuild();
  }

  /** New figures for everyone, standing where they already were. */
  setCharacter(character: WorldCharacter) {
    if (character.id === this.character.id) return;
    this.character = character;
    for (const [id, entry] of this.actors) {
      const position = entry.position;
      this.remove(id);
      const zone = this.zones.get(entry.actor.zoneId);
      if (!zone || entry.leaving) continue;
      const replacement = this.enter(entry.actor, zone, entry.target, true);
      replacement.position = position;
      this.actors.set(id, replacement);
    }
    this.place();
  }

  setLook(look: WorldLook) {
    if (look.appearance === this.look.appearance) return;
    this.look = look;
    this.rebuild();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    document.removeEventListener("visibilitychange", this.visibility);
    this.app.destroy({ removeView: true }, { children: true });
  }

  /** A new theme or appearance redraws everything; positions restart. */
  private rebuild() {
    this.app.renderer.background.color = this.theme.backdrop(this.look);
    for (const entry of this.actors.values())
      entry.figure.view.destroy({ children: true });
    this.actors.clear();
    this.sceneryKey = "";
    this.relayout(true);
  }

  /**
   * Places zones and gives every actor its target. `snap` teleports actors
   * instead of walking them, for a resize or a redraw, where a walk would
   * show movement that did not happen.
   */
  private relayout(snap: boolean) {
    if (this.destroyed) return;
    this.layoutZones();
    const slots = new Map<string, number>();
    const present = new Set<string>();
    for (const actor of this.model.actors) {
      const zone = this.zones.get(actor.zoneId);
      if (!zone) continue;
      present.add(actor.sessionId);
      const key = `${actor.zoneId}\u0000${actor.place}`;
      const slot = slots.get(key) ?? 0;
      slots.set(key, slot + 1);
      const target = this.spot(zone, actor.place, slot);
      const existing = this.actors.get(actor.sessionId);
      if (existing) {
        existing.actor = actor;
        existing.target = target;
        existing.leaving = false;
        existing.figure.view.alpha = 1;
        existing.figure.update(actor);
        if (snap) existing.position = { ...target };
        continue;
      }
      this.actors.set(actor.sessionId, this.enter(actor, zone, target, snap));
    }
    for (const [id, entry] of this.actors) {
      if (present.has(id) || entry.leaving) continue;
      const zone = this.zones.get(entry.actor.zoneId);
      if (!zone || snap) {
        this.remove(id);
        continue;
      }
      entry.leaving = true;
      entry.target = this.spot(zone, "door", 0);
    }
    this.place();
  }

  /** Arrives through the door and walks to its spot. */
  private enter(
    actor: WorldActor,
    zone: ZoneEntry,
    target: WorldPoint,
    snap: boolean,
  ): ActorEntry {
    const figure = this.character.create(actor, this.look);
    figure.update(actor);
    const { view } = figure;
    view.eventMode = "static";
    view.cursor = "pointer";
    view.on("pointertap", () => this.options.onSelect(actor.sessionId));
    view.on("pointerover", (event: FederatedPointerEvent) =>
      this.options.onHover(actor.sessionId, this.clientPoint(event)),
    );
    view.on("pointermove", (event: FederatedPointerEvent) =>
      this.options.onHover(actor.sessionId, this.clientPoint(event)),
    );
    view.on("pointerout", () => this.options.onHover(null, null));
    this.figures.addChild(view);
    const start = snap ? target : this.spot(zone, "door", 0);
    return {
      actor,
      figure,
      position: { ...start },
      target,
      facing: 0,
      leaving: false,
    };
  }

  private remove(id: string) {
    const entry = this.actors.get(id);
    if (!entry) return;
    entry.figure.view.destroy({ children: true });
    this.actors.delete(id);
  }

  private clientPoint(event: FederatedPointerEvent): WorldPoint {
    const bounds = this.app.canvas.getBoundingClientRect();
    return { x: bounds.left + event.global.x, y: bounds.top + event.global.y };
  }

  private spot(zone: ZoneEntry, place: WorldPlace, slot: number): WorldPoint {
    const local = this.theme.spot(place, slot);
    return { x: zone.origin.x + local.x, y: zone.origin.y + local.y };
  }

  /**
   * A grid as close to the view's shape as the zone count allows, scaled to
   * fit and centred. Scenery is redrawn only when what it shows changes.
   */
  private layoutZones() {
    const { width, height } = this.theme.zoneSize;
    const count = Math.max(1, this.model.zones.length);
    const screen = this.app.screen;
    const padding = 16;
    // Every column count is tried; the one that draws the zones largest wins.
    const fit = (columns: number) => {
      const rows = Math.ceil(count / columns);
      const worldWidth = columns * width + (columns - 1) * ZONE_GAP;
      const worldHeight = rows * height + (rows - 1) * ZONE_GAP;
      const scale = Math.min(
        (screen.width - padding * 2) / worldWidth,
        (screen.height - padding * 2) / worldHeight,
      );
      return { columns, worldWidth, worldHeight, scale };
    };
    let best = fit(1);
    for (let columns = 2; columns <= count; columns += 1) {
      const candidate = fit(columns);
      if (candidate.scale > best.scale) best = candidate;
    }
    const { columns, worldWidth, worldHeight, scale } = best;
    this.world.scale.set(Math.max(0.1, scale));
    this.world.position.set(
      (screen.width - worldWidth * this.world.scale.x) / 2,
      (screen.height - worldHeight * this.world.scale.y) / 2,
    );
    const key = JSON.stringify([
      this.theme.id,
      this.look.appearance,
      columns,
      this.model.zones,
    ]);
    if (key === this.sceneryKey) return;
    this.sceneryKey = key;
    for (const child of this.scenery.removeChildren())
      child.destroy({ children: true });
    this.zones.clear();
    this.model.zones.forEach((zone, index) => {
      const layer = new Container();
      const origin = {
        x: (index % columns) * (width + ZONE_GAP),
        y: Math.floor(index / columns) * (height + ZONE_GAP),
      };
      layer.position.set(origin.x, origin.y);
      this.theme.drawZone(layer, zone, this.look);
      this.scenery.addChild(layer);
      this.zones.set(zone.id, { layer, origin });
    });
  }

  private tick(seconds: number) {
    this.elapsed += seconds;
    const step = WALK_SPEED * Math.min(seconds, 0.1);
    for (const [id, entry] of this.actors) {
      const dx = entry.target.x - entry.position.x;
      const dy = entry.target.y - entry.position.y;
      const distance = Math.hypot(dx, dy);
      const walking = distance > 0.5;
      if (walking) {
        const move = Math.min(step, distance);
        entry.position.x += (dx / distance) * move;
        entry.position.y += (dy / distance) * move;
        if (Math.abs(dx) > 0.5) entry.facing = dx < 0 ? -1 : 1;
      } else {
        entry.position = { ...entry.target };
        entry.facing = 0;
        if (entry.leaving) {
          this.remove(id);
          continue;
        }
      }
      if (entry.leaving) entry.figure.view.alpha = Math.min(1, distance / 60);
      entry.figure.animate({
        time: this.elapsed,
        walking,
        facing: entry.facing,
      });
    }
    this.place();
  }

  /** Nearer the bottom draws in front, so figures overlap like people do. */
  private place() {
    for (const entry of this.actors.values()) {
      const { view } = entry.figure;
      view.position.set(entry.position.x, entry.position.y);
      view.zIndex = entry.position.y;
    }
  }
}
