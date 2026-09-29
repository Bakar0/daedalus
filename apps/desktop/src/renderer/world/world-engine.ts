import { Application, Container, type FederatedPointerEvent } from "pixi.js";
import type {
  WorldActor,
  WorldModel,
  WorldPlace,
  WorldZone,
} from "./world-model";
import type {
  ActorFigure,
  WorldArrangement,
  WorldCharacter,
  WorldLook,
  Waypoint,
  WorldPoint,
  WorldAction,
  WorldTheme,
} from "./world-theme";
import { tipOf } from "./world-theme";

/**
 * Sessions the World has already shown, for as long as the app runs. A
 * session it has not shown yet arrives from the theme's home even on the
 * first draw, so an agent started while the World was closed still comes
 * out of the workshop and rides down, rather than appearing in its room.
 */
const shown = new Set<string>();
/** Seconds between arrivals, so a crowd comes down one after another. */
const ARRIVAL_GAP = 0.9;

/**
 * Runs one World: asks the theme where zones go, flies actors to the spot
 * the theme gives them, and owns the camera. It holds no state the snapshot
 * does not: every `setModel` is the whole truth, a new actor flies out from
 * the theme's home, and an actor missing from it flies back there.
 *
 * The camera is one continuous view. It starts fitted to the whole world;
 * pinching, Cmd-scrolling or the zoom buttons move closer, dragging or
 * two-finger scrolling pans, and nothing ever swaps the scene for another.
 */

export interface WorldEngineOptions {
  onSelect(sessionId: string): void;
  /** `point` is in page (client) pixels, for an HTML hover card. */
  onHover(sessionId: string | null, point: WorldPoint | null): void;
  /** Scenery the pointer is over that has something to say (see `setTip`). */
  onTip?(text: string | null, point: WorldPoint | null): void;
  /** Scenery that was clicked and names an action. */
  onAction?(action: WorldAction): void;
}

/** World pixels per second: a trip across the first ring takes a few seconds. */
const FLY_SPEED = 210;
/**
 * The world is ambient: 30 frames a second looks the same for figures this
 * size and halves the cost of leaving the view open all day.
 */
const MAX_FPS = 30;
/** Closest the camera goes, in screen pixels per world pixel. */
const MAX_SCALE = 2.6;
/** Pointer travel, in screen pixels, past which a press is a drag. */
const DRAG_THRESHOLD = 5;

interface ZoneEntry {
  id: string;
  layer: Container;
  index: number;
  origin: WorldPoint;
  key: string;
  animate?: (time: number) => void;
}

interface ActorEntry {
  actor: WorldActor;
  figure: ActorFigure;
  position: WorldPoint;
  target: WorldPoint;
  /** Waypoints still to fly through, ending at `target`. */
  path: Waypoint[];
  /** Seconds to wait at home before setting off; hidden meanwhile. */
  wait: number;
  /** The car carrying it along a ridden leg, made when first needed. */
  vehicle?: Container;
  facing: -1 | 0 | 1;
  /** Flying home on the way out; removed on arrival. */
  leaving: boolean;
  /** The place it is at, which lags `actor.place` across a shared room. */
  effective: WorldPlace;
  /** A move to or from a shared room that is waiting out the dwell. */
  pending?: { place: WorldPlace; since: number };
}

export class WorldEngine {
  private readonly app = new Application();
  private readonly world = new Container();
  private readonly ground = new Container();
  private readonly plots = new Container();
  private readonly effects = new Container();
  private animateEffects?: (time: number, zones: readonly WorldZone[]) => void;
  private readonly figures = new Container();
  private readonly zones = new Map<string, ZoneEntry>();
  private readonly actors = new Map<string, ActorEntry>();
  private model: WorldModel = { zones: [], actors: [], week: [] };
  private arrangement: WorldArrangement = {
    origins: [],
    bounds: { x: -400, y: -300, width: 800, height: 600 },
  };
  private worldKey = "";
  private animateWorld?: (time: number) => void;
  private elapsed = 0;
  private destroyed = false;
  private placedOnce = false;
  /** 1 is fitted to the world; larger is closer. */
  private zoom = 1;
  /** The world point at the centre of the view. */
  private center: WorldPoint = { x: 0, y: 0 };
  /** False until the user zooms or pans; until then the view follows the fit. */
  private moved = false;
  private press: { x: number; y: number; travel: number } | null = null;
  private lastTravel = 0;
  private gestureScale = 1;
  private readonly cleanups: Array<() => void> = [];

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
    this.world.addChild(this.ground, this.plots, this.effects, this.figures);
    app.stage.addChild(this.world);
    app.ticker.maxFPS = MAX_FPS;
    app.ticker.add((ticker) => this.tick(ticker.deltaMS / 1000));
    app.renderer.on("resize", () => this.applyCamera());
    this.listen(document, "visibilitychange", this.visibility);
    this.listenToCamera(app.canvas);
    // A passive container hears nothing, not even what bubbles up from its
    // children, so the scenery layers listen for their children's tips.
    for (const layer of [this.ground, this.plots]) {
      layer.eventMode = "static";
      layer.on("pointerover", (event: FederatedPointerEvent) => {
        const tip = tipOf(event.target as Container);
        if (tip) this.options.onTip?.(tip.text, this.clientPoint(event));
      });
      layer.on("pointerout", () => this.options.onTip?.(null, null));
      layer.on("pointertap", (event: FederatedPointerEvent) => {
        const action = tipOf(event.target as Container)?.action;
        if (action && this.lastTravel <= DRAG_THRESHOLD)
          this.options.onAction?.(action);
      });
    }
  }

  private listen<T extends Event>(
    target: EventTarget,
    type: string,
    handler: (event: T) => void,
    options?: AddEventListenerOptions,
  ) {
    const listener = handler as EventListener;
    target.addEventListener(type, listener, options);
    this.cleanups.push(() =>
      target.removeEventListener(type, listener, options),
    );
  }

  /** A hidden window draws nothing. */
  private readonly visibility = () => {
    if (document.hidden) this.app.ticker.stop();
    else this.app.ticker.start();
  };

  setModel(model: WorldModel) {
    this.model = model;
    this.relayout(!this.placedOnce);
    this.placedOnce = true;
  }

  setTheme(theme: WorldTheme) {
    if (theme.id === this.theme.id) return;
    this.theme = theme;
    this.rebuild();
  }

  setLook(look: WorldLook) {
    if (look.appearance === this.look.appearance) return;
    this.look = look;
    this.rebuild();
  }

  /** New figures for everyone, standing where they already were. */
  setCharacter(character: WorldCharacter) {
    if (character.id === this.character.id) return;
    this.character = character;
    for (const [id, entry] of this.actors) {
      const position = entry.position;
      this.remove(id);
      if (entry.leaving) continue;
      const replacement = this.enter(entry.actor, entry.target, true);
      replacement.position = position;
      replacement.path = entry.path;
      replacement.wait = entry.wait;
      this.actors.set(id, replacement);
    }
    this.place();
  }

  /** Back to the whole world in view. */
  fit() {
    this.zoom = 1;
    this.center = this.boundsCenter();
    this.moved = false;
    this.applyCamera();
  }

  /** Zoom about the middle of the view; `factor` above 1 moves closer. */
  zoomBy(factor: number) {
    const screen = this.app.screen;
    this.zoomAt(factor, { x: screen.width / 2, y: screen.height / 2 });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const cleanup of this.cleanups) cleanup();
    this.app.destroy({ removeView: true }, { children: true });
  }

  // Camera.

  /** The scale that shows the whole world. */
  private allScale() {
    const { width, height } = this.arrangement.bounds;
    const screen = this.app.screen;
    return Math.min(screen.width / width, screen.height / height);
  }

  /** The scale at rest: the whole world, or its full width for "width". */
  private fitScale() {
    if (this.theme.fit !== "width") return this.allScale();
    return this.app.screen.width / this.arrangement.bounds.width;
  }

  /** Where the camera rests: the middle, or the top for "width". */
  private boundsCenter(): WorldPoint {
    const { x, y, width, height } = this.arrangement.bounds;
    if (this.theme.fit !== "width")
      return { x: x + width / 2, y: y + height / 2 };
    const visible = this.app.screen.height / this.fitScale();
    return { x: x + width / 2, y: y + Math.min(height, visible) / 2 };
  }

  private scale() {
    return this.fitScale() * this.zoom;
  }

  private zoomLimits() {
    const fit = this.fitScale();
    // Zooming out may always reach the whole world, and a little beyond.
    const min = Math.min(0.85, (this.allScale() / fit) * 0.95);
    return { min, max: Math.max(1, MAX_SCALE / fit) };
  }

  /** Keeps the world point under `screenPoint` where it is while zooming. */
  private zoomAt(factor: number, screenPoint: WorldPoint) {
    const before = this.toWorld(screenPoint);
    const { min, max } = this.zoomLimits();
    this.zoom = Math.min(max, Math.max(min, this.zoom * factor));
    const scale = this.scale();
    const screen = this.app.screen;
    this.center = {
      x: before.x - (screenPoint.x - screen.width / 2) / scale,
      y: before.y - (screenPoint.y - screen.height / 2) / scale,
    };
    this.moved = true;
    this.applyCamera();
  }

  private panBy(dx: number, dy: number) {
    const scale = this.scale();
    this.center = {
      x: this.center.x - dx / scale,
      y: this.center.y - dy / scale,
    };
    this.moved = true;
    this.applyCamera();
  }

  private toWorld(point: WorldPoint): WorldPoint {
    const scale = this.scale();
    const screen = this.app.screen;
    return {
      x: this.center.x + (point.x - screen.width / 2) / scale,
      y: this.center.y + (point.y - screen.height / 2) / scale,
    };
  }

  private applyCamera() {
    if (this.destroyed) return;
    if (!this.moved) {
      this.zoom = 1;
      this.center = this.boundsCenter();
    }
    // The view stays on the world: along an axis the world is larger than
    // the view, its edges stop the pan; along one it is smaller, it centres.
    const { x, y, width, height } = this.arrangement.bounds;
    const scale = this.scale();
    const clamp = (value: number, start: number, size: number, view: number) =>
      view >= size
        ? start + size / 2
        : Math.min(start + size - view / 2, Math.max(start + view / 2, value));
    this.center = {
      x: clamp(this.center.x, x, width, this.app.screen.width / scale),
      y: clamp(this.center.y, y, height, this.app.screen.height / scale),
    };
    const screen = this.app.screen;
    this.world.scale.set(scale);
    this.world.position.set(
      screen.width / 2 - this.center.x * scale,
      screen.height / 2 - this.center.y * scale,
    );
  }

  private listenToCamera(canvas: HTMLCanvasElement) {
    const local = (event: { clientX: number; clientY: number }) => {
      const bounds = canvas.getBoundingClientRect();
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };
    // A trackpad pinch arrives as a Ctrl-wheel in most engines and as
    // gesture events in WebKit; Cmd-wheel zooms too. A plain wheel pans.
    this.listen<WheelEvent>(
      canvas,
      "wheel",
      (event) => {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey)
          this.zoomAt(Math.exp(-event.deltaY * 0.01), local(event));
        else this.panBy(-event.deltaX, -event.deltaY);
      },
      { passive: false },
    );
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    this.listen<Gesture>(canvas, "gesturestart", (event) => {
      event.preventDefault();
      this.gestureScale = 1;
    });
    this.listen<Gesture>(canvas, "gesturechange", (event) => {
      event.preventDefault();
      this.zoomAt(event.scale / this.gestureScale, local(event));
      this.gestureScale = event.scale;
    });
    this.listen<PointerEvent>(canvas, "pointerdown", (event) => {
      this.press = { ...local(event), travel: 0 };
      this.lastTravel = 0;
    });
    this.listen<PointerEvent>(window, "pointermove", (event) => {
      if (!this.press || !(event.buttons & 1)) return;
      const point = local(event);
      const dx = point.x - this.press.x;
      const dy = point.y - this.press.y;
      this.press.travel += Math.hypot(dx, dy);
      this.lastTravel = this.press.travel;
      this.press.x = point.x;
      this.press.y = point.y;
      if (this.press.travel > DRAG_THRESHOLD) {
        canvas.style.cursor = "grabbing";
        this.options.onHover(null, null);
        this.panBy(dx, dy);
      }
    });
    this.listen<PointerEvent>(window, "pointerup", () => {
      this.press = null;
      canvas.style.cursor = "";
    });
    this.listen<MouseEvent>(canvas, "dblclick", (event) =>
      this.zoomAt(1.8, local(event)),
    );
  }

  // Layout.

  /** A new theme or appearance redraws everything; positions restart. */
  private rebuild() {
    this.app.renderer.background.color = this.theme.backdrop(this.look);
    for (const entry of this.actors.values())
      entry.figure.view.destroy({ children: true });
    this.actors.clear();
    this.worldKey = "";
    for (const zone of this.zones.values())
      zone.layer.destroy({ children: true });
    this.zones.clear();
    this.relayout(true);
  }

  /**
   * Places zones and gives every actor its target. `snap` places actors
   * without flying, for the first draw and a redraw, where a flight would
   * show movement that did not happen.
   */
  private relayout(snap: boolean) {
    if (this.destroyed) return;
    this.layoutZones();
    const slots = new Map<string, number>();
    const present = new Set<string>();
    let arrivals = 0;
    for (const actor of this.model.actors) {
      const zone = this.zones.get(actor.zoneId);
      if (!zone) continue;
      present.add(actor.sessionId);
      const existing = this.actors.get(actor.sessionId);
      const place = existing ? this.settle(existing, actor.place) : actor.place;
      const shared = this.theme.shared?.places.includes(place) ?? false;
      // A shared place counts slots across every zone: it is one room.
      const key = shared
        ? `shared\u0000${place}`
        : `${actor.zoneId}\u0000${place}`;
      const slot = slots.get(key) ?? 0;
      slots.set(key, slot + 1);
      const target = shared
        ? { ...this.theme.shared!.spot(place, slot) }
        : this.spot(zone, place, slot);
      if (existing) {
        existing.actor = actor;
        existing.leaving = false;
        existing.figure.view.alpha = 1;
        existing.figure.update(actor);
        if (snap) {
          existing.position = { ...target };
          existing.target = target;
          existing.path = [];
        } else if (
          target.x !== existing.target.x ||
          target.y !== existing.target.y
        ) {
          existing.target = target;
          existing.path = this.route(existing.position, target);
        }
        continue;
      }
      // Placed directly only when this app has shown it before; anything
      // new arrives from home, queued behind the others arriving with it.
      const arrive = !(snap && shown.has(actor.sessionId));
      shown.add(actor.sessionId);
      const entry = this.enter(actor, target, !arrive);
      entry.effective = place;
      if (arrive) entry.wait = arrivals++ * ARRIVAL_GAP;
      this.actors.set(actor.sessionId, entry);
    }
    for (const [id, entry] of this.actors) {
      if (present.has(id) || entry.leaving) continue;
      if (snap) {
        this.remove(id);
        continue;
      }
      entry.leaving = true;
      entry.target = { ...this.theme.home };
      entry.path = this.route(entry.position, entry.target);
    }
    this.place();
  }

  /** Flies out of the theme's home to its spot. */
  private enter(
    actor: WorldActor,
    target: WorldPoint,
    snap: boolean,
  ): ActorEntry {
    const figure = this.character.create(actor, this.look);
    figure.update(actor);
    const { view } = figure;
    view.scale.set(this.theme.actorScale ?? 1);
    view.eventMode = "static";
    view.cursor = "pointer";
    // A press that turned into a drag is a pan, not a click.
    view.on("pointertap", () => {
      if (this.lastTravel <= DRAG_THRESHOLD)
        this.options.onSelect(actor.sessionId);
    });
    view.on("pointerover", (event: FederatedPointerEvent) =>
      this.options.onHover(actor.sessionId, this.clientPoint(event)),
    );
    view.on("pointermove", (event: FederatedPointerEvent) => {
      if (!this.press || this.press.travel <= DRAG_THRESHOLD)
        this.options.onHover(actor.sessionId, this.clientPoint(event));
    });
    view.on("pointerout", () => this.options.onHover(null, null));
    this.figures.addChild(view);
    const start = snap ? target : this.theme.home;
    return {
      actor,
      figure,
      position: { ...start },
      target,
      path: snap ? [] : this.route(start, target),
      wait: 0,
      facing: 0,
      leaving: false,
      effective: actor.place,
    };
  }

  /**
   * The place an actor should be at now. A move into or out of a shared
   * room waits until the new work has lasted the theme's dwell; any other
   * move, inside the actor's own zone, happens at once.
   */
  private settle(entry: ActorEntry, desired: WorldPlace): WorldPlace {
    const shared = this.theme.shared;
    if (desired === entry.effective) {
      entry.pending = undefined;
      return desired;
    }
    const crossing =
      shared &&
      (shared.places.includes(desired) ||
        shared.places.includes(entry.effective));
    if (!crossing) {
      entry.pending = undefined;
      entry.effective = desired;
      return desired;
    }
    if (entry.pending?.place !== desired)
      entry.pending = { place: desired, since: this.elapsed };
    if (this.elapsed - entry.pending.since >= shared.dwell) {
      entry.pending = undefined;
      entry.effective = desired;
    }
    return entry.effective;
  }

  /** The theme's way from one point to another, or a straight line. */
  private route(from: WorldPoint, to: WorldPoint): Waypoint[] {
    const path = this.arrangement.route?.(from, to) ?? [to];
    return path.length ? path.map((point) => ({ ...point })) : [{ ...to }];
  }

  private remove(id: string) {
    const entry = this.actors.get(id);
    if (!entry) return;
    entry.vehicle?.destroy({ children: true });
    entry.figure.view.destroy({ children: true });
    this.actors.delete(id);
  }

  private clientPoint(event: FederatedPointerEvent): WorldPoint {
    const bounds = this.app.canvas.getBoundingClientRect();
    return { x: bounds.left + event.global.x, y: bounds.top + event.global.y };
  }

  private spot(zone: ZoneEntry, place: WorldPlace, slot: number): WorldPoint {
    const local = this.theme.spot(place, slot, {
      index: zone.index,
      id: zone.id,
    });
    return { x: zone.origin.x + local.x, y: zone.origin.y + local.y };
  }

  /**
   * Asks the theme for the arrangement, redraws the ground only when the set
   * of zones changes, and redraws a zone only when what it shows changes.
   */
  private layoutZones() {
    const zones = this.model.zones;
    const worldKey = JSON.stringify([
      this.theme.id,
      this.look.appearance,
      zones.map((zone) => zone.id),
    ]);
    if (worldKey !== this.worldKey) {
      this.worldKey = worldKey;
      this.arrangement = this.theme.arrange(zones);
      for (const child of this.ground.removeChildren())
        child.destroy({ children: true });
      this.animateWorld =
        this.theme.drawWorld(this.ground, this.arrangement, this.look) ??
        undefined;
      for (const child of this.effects.removeChildren())
        child.destroy({ children: true });
      this.animateEffects =
        this.theme.drawEffects?.(this.effects, this.arrangement, this.look) ??
        undefined;
      this.applyCamera();
    }
    const seen = new Set<string>();
    zones.forEach((zone, index) => {
      seen.add(zone.id);
      const origin = this.arrangement.origins[index] ?? { x: 0, y: 0 };
      const key = JSON.stringify([worldKey, zone, origin]);
      const existing = this.zones.get(zone.id);
      if (existing?.key === key) return;
      existing?.layer.destroy({ children: true });
      const layer = new Container();
      layer.position.set(origin.x, origin.y);
      const animate =
        this.theme.drawZone(layer, zone, this.look, index) ?? undefined;
      this.plots.addChild(layer);
      this.zones.set(zone.id, {
        id: zone.id,
        layer,
        index,
        origin,
        key,
        animate,
      });
    });
    for (const [id, entry] of this.zones) {
      if (seen.has(id)) continue;
      entry.layer.destroy({ children: true });
      this.zones.delete(id);
    }
  }

  private tick(seconds: number) {
    this.elapsed += seconds;
    this.animateWorld?.(this.elapsed);
    this.animateEffects?.(this.elapsed, this.model.zones);
    // A move waiting out a shared room's dwell happens once it has.
    const dwell = this.theme.shared?.dwell;
    if (
      dwell !== undefined &&
      [...this.actors.values()].some(
        (entry) => entry.pending && this.elapsed - entry.pending.since >= dwell,
      )
    )
      this.relayout(false);
    for (const zone of this.zones.values()) zone.animate?.(this.elapsed);
    for (const [id, entry] of this.actors) {
      if (entry.wait > 0) {
        entry.wait -= seconds;
        entry.figure.view.visible = false;
        continue;
      }
      entry.figure.view.visible = true;
      // Fly through the waypoints in order, carrying leftover distance on.
      let budget = FLY_SPEED * Math.min(seconds, 0.1);
      while (budget > 0 && entry.path.length) {
        const next = entry.path[0]!;
        const dx = next.x - entry.position.x;
        const dy = next.y - entry.position.y;
        const distance = Math.hypot(dx, dy);
        if (Math.abs(dx) > 0.5) entry.facing = dx < 0 ? -1 : 1;
        if (distance <= budget) {
          entry.position = { ...next };
          entry.path.shift();
          budget -= distance;
        } else {
          entry.position.x += (dx / distance) * budget;
          entry.position.y += (dy / distance) * budget;
          budget = 0;
        }
      }
      const walking = entry.path.length > 0;
      this.carry(entry, walking && entry.path[0]!.ride === true);
      if (!walking) {
        entry.facing = 0;
        if (entry.leaving) {
          this.remove(id);
          continue;
        }
      }
      if (entry.leaving) {
        const left = Math.hypot(
          entry.target.x - entry.position.x,
          entry.target.y - entry.position.y,
        );
        entry.figure.view.alpha = Math.min(1, left / 60);
      }
      entry.figure.animate({
        time: this.elapsed,
        walking,
        facing: entry.facing,
      });
    }
    this.place();
  }

  /** Shows the theme's vehicle around an agent on a ridden leg. */
  private carry(entry: ActorEntry, riding: boolean) {
    if (!riding) {
      if (entry.vehicle) entry.vehicle.visible = false;
      return;
    }
    if (!entry.vehicle) {
      const vehicle = this.theme.createVehicle?.(this.look);
      if (!vehicle) return;
      entry.vehicle = vehicle;
      this.figures.addChild(vehicle);
    }
    entry.vehicle.visible = true;
  }

  /** Nearer the bottom draws in front, so figures overlap the way they would. */
  private place() {
    for (const entry of this.actors.values()) {
      const { view } = entry.figure;
      view.position.set(entry.position.x, entry.position.y);
      view.zIndex = entry.position.y;
      // The car sits just behind its rider.
      entry.vehicle?.position.set(entry.position.x, entry.position.y);
      if (entry.vehicle) entry.vehicle.zIndex = entry.position.y - 0.5;
    }
  }
}
