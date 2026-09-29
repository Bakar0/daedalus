import type { Container } from "pixi.js";
import type { WorldActor, WorldPlace, WorldZone } from "./world-model";

/**
 * What a world concept has to provide: the rooms. The engine owns the Pixi
 * application, layout, movement, input and the frame budget; a theme only
 * draws scenery. A new concept is one file implementing this and one line in
 * `themes/index.ts`. The agents are a separate choice, `WorldCharacter`, so
 * any character style walks around any world.
 *
 * Coordinates are world pixels inside one zone, with the origin at the zone's
 * top-left corner. The engine scales the whole world to fit the view, so a
 * theme never deals with the window size or the display's pixel density.
 */
export interface WorldTheme {
  id: string;
  /** Shown in the picker: "Office". */
  label: string;
  /** One line for the picker's tooltip. */
  description: string;
  /** Every zone is this size. */
  zoneSize: { width: number; height: number };
  /** Behind and between zones. */
  backdrop(look: WorldLook): number;
  /** Draws one zone's scenery into `layer`. */
  drawZone(layer: Container, zone: WorldZone, look: WorldLook): void;
  /**
   * Where the `slot`th actor at `place` stands, inside a zone. Slots count
   * from 0 in a stable order, so two agents at the terminal never stand on
   * each other and never swap places when a third arrives.
   */
  spot(place: WorldPlace, slot: number): WorldPoint;
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
