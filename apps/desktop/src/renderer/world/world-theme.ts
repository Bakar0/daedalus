import type { Container } from "pixi.js";
import type { WorldActor, WorldPlace, WorldZone } from "./world-model";

/**
 * What a world concept has to provide. The engine owns the Pixi application,
 * the camera, movement, input and the frame budget; a theme decides where
 * zones go and draws the scenery. A new concept is one file implementing this
 * and one line in `themes/index.ts`. The agents are a separate choice,
 * `WorldCharacter`, so any character style flies around any world.
 *
 * Coordinates are world pixels. The engine fits the world to the view and
 * lets the user zoom and pan it, so a theme never deals with the window size
 * or the display's pixel density.
 */
export interface WorldTheme {
  id: string;
  /** Shown in the picker: "Island". */
  label: string;
  /** One line for the picker's tooltip. */
  description: string;
  /** Behind everything: the colour past the edge of the world. */
  backdrop(look: WorldLook): number;
  /**
   * Where each zone's centre goes, in order, and the rectangle the whole
   * world occupies. Called again whenever the zones change, so the world can
   * grow and shrink with them.
   */
  arrange(zones: readonly WorldZone[]): WorldArrangement;
  /**
   * Draws what is not a zone: ground, roads, the place agents come from.
   * The returned function, when there is one, animates it each frame.
   */
  drawWorld(
    layer: Container,
    arrangement: WorldArrangement,
    look: WorldLook,
  ): ((time: number) => void) | void;
  /** Draws the `index`th zone's scenery into `layer`, centred on (0, 0). */
  drawZone(
    layer: Container,
    zone: WorldZone,
    look: WorldLook,
    index: number,
  ): ((time: number) => void) | void;
  /**
   * Where the `slot`th actor at `place` stands, relative to the centre of
   * the `zone`th zone. Slots count from 0 in a stable order, so two agents at
   * the terminal never stand on each other and never swap places when a
   * third arrives.
   */
  spot(place: WorldPlace, slot: number, zone: ZoneRef): WorldPoint;
  /** Where new agents come from and finished ones go back to, in world pixels. */
  home: WorldPoint;
  /** How much larger than their natural size agents are drawn; 1 if unset. */
  actorScale?: number;
  /**
   * What carries an agent along a route leg marked `ride`: an elevator car,
   * a cart. Drawn behind the agent, feet at (0, 0), in world pixels.
   */
  createVehicle?(look: WorldLook): Container;
  /**
   * How the camera frames the world at rest. "all" fits the whole world;
   * "width" fills the view's width and starts at the top, for a world that
   * grows downward and is scrolled, like Fallout Shelter. "all" if unset.
   */
  fit?: "all" | "width";
}

export interface WorldArrangement {
  origins: WorldPoint[];
  bounds: { x: number; y: number; width: number; height: number };
  /**
   * The waypoints from one world point to another, ending at `to`, for a
   * world where agents cannot fly straight: through a door, along a shaft.
   * Without it the engine flies in a straight line.
   */
  route?(from: WorldPoint, to: WorldPoint): Waypoint[];
}

/** A point on a route; `ride` means the leg that ends here is ridden. */
export interface Waypoint extends WorldPoint {
  ride?: boolean;
}

/** Which zone a spot is asked for: its place in order, and its id. */
export interface ZoneRef {
  index: number;
  id: string;
}

/**
 * How agents look. A style is one file in `characters/` and one line in
 * `characters/index.ts`. Figures stand with their feet at (0, 0) and are
 * about 50 world pixels tall, which is what every theme's spots assume.
 */
export interface WorldCharacter {
  id: string;
  /** Shown in the picker: "Bots". */
  label: string;
  description: string;
  /** Builds the figure for one actor. It is placed and moved by the engine. */
  create(actor: WorldActor, look: WorldLook): ActorFigure;
  /** An extra line for the hover card, when the style gives agents a role. */
  caption?(actor: WorldActor): string | null;
}

export interface WorldLook {
  appearance: "dark" | "light";
}

export interface WorldPoint {
  x: number;
  y: number;
}

/** Everything the figure needs to animate one frame. */
export interface ActorFrame {
  /** Seconds since the world started; drive loops from this. */
  time: number;
  /** True while the engine is walking the figure to a new spot. */
  walking: boolean;
  /** -1 walking left, 1 walking right, 0 standing. */
  facing: -1 | 0 | 1;
}

export interface ActorFigure {
  /** Placed at the actor's feet; the engine sets its position. */
  view: Container;
  /** Called when the snapshot changes what the actor is doing. */
  update(actor: WorldActor): void;
  /** Called every frame the world draws. */
  animate(frame: ActorFrame): void;
}
