import { Container, Graphics, Text } from "pixi.js";
import type { WorldCrate, WorldZone } from "../world-model";
import type { WorldPoint } from "../world-theme";

/**
 * Shipping, factory style, one crate per branch. A crate sits packed on its
 * room's bench against the back wall while the branch's commits are only
 * local. Once they are pushed, a conveyor carries it out through a hatch
 * into the cargo pipe on that side's outer edge, the pipe lifts it to the
 * surface, and it waits on the grass beside the Hermes Post with its pull
 * request's number, wrapped while the pull request is a draft. When the
 * pull request merges, the crate unfolds Daedalus's wings and flies off
 * into the sky, outward. A closed pull request or a removed worktree takes
 * its crate away quietly.
 *
 * The waiting crates are the point: they are what is about to land, and
 * every one of them is real.
 */

export interface DispatchPalette {
  brass: number;
  brassDark: number;
  marble: number;
  marbleShade: number;
  metal: number;
}

/** One side's cargo pipe, straight up the outer edge to its post. */
export interface DispatchLane {
  pipeX: number;
  /** The deepest point the pipe reaches. */
  bottom: number;
  /** The Hermes Post on the surface, on top of the pipe. */
  post: WorldPoint;
}

export interface DispatchGeometry {
  lanes: readonly DispatchLane[];
  /** For each zone, its lane and the crate's path out of its room. */
  routes: ReadonlyArray<{ lane: number; path: WorldPoint[] }>;
}

const BELT_SPEED = 110;
const PIPE_SPEED = 260;
const FLIGHT = 3.2;
const CRATE_SCALE = 1.6;
/** Half a crate's height in world pixels: it sits on things, not in them. */
export const CRATE_HALF = 13 * CRATE_SCALE;
const PAD_HEIGHT = 18;
/** Waiting crates stand in rows on the grass, inward from the post. */
// Five to a row, so the right yard stays clear of the Rebuilder.
const ROW = 5;
const YARD_GAP = 62;
const YARD_START = 90;
const GROUND = -6;
const FADE = 0.6;

const label = (value: string, size: number, fill: number) =>
  new Text({
    text: value,
    resolution: 6,
    style: {
      fill,
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'SF Pro Rounded', 'SF Pro Text', sans-serif",
      fontSize: size,
      fontWeight: "800",
    },
  });

/** A lane's pipe, from its deepest room up to the post. */
export function drawPipe(g: Graphics, lane: DispatchLane, p: DispatchPalette) {
  const { pipeX, bottom, post } = lane;
  const height = bottom - post.y;
  g.roundRect(pipeX - 13, post.y, 26, height, 12).fill({
    color: 0x9fd8ff,
    alpha: 0.16,
  });
  g.roundRect(pipeX - 13, post.y, 26, height, 12).stroke({
    width: 3,
    color: p.brass,
  });
  // Brass collars along the run.
  for (let y = post.y + 60; y < bottom; y += 90)
    g.rect(pipeX - 16, y, 32, 6).fill(p.brassDark);
}

/** The Hermes Post: a bronze launch pad under a little marble gate. */
export function drawPost(
  layer: Container,
  post: WorldPoint,
  p: DispatchPalette,
) {
  const g = new Graphics();
  const { x, y } = post;
  g.rect(x - 58, y - 16, 116, 16).fill(p.marbleShade);
  g.ellipse(x, y - 16, 44, 9).fill(p.brassDark);
  g.ellipse(x, y - 18, 38, 7).fill(p.brass);
  for (const cx of [x - 58, x + 44]) {
    g.rect(cx, y - 112, 14, 96).fill(p.marble);
    g.rect(cx + 4, y - 108, 2, 88).fill(p.marbleShade);
  }
  g.rect(x - 66, y - 126, 132, 16).fill(p.marbleShade);
  g.poly([x - 70, y - 126, x, y - 150, x + 70, y - 126]).fill(p.marble);
  // Hermes's wings over the lintel.
  g.moveTo(x - 6, y - 138)
    .bezierCurveTo(x - 26, y - 152, x - 46, y - 146, x - 52, y - 134)
    .bezierCurveTo(x - 36, y - 138, x - 22, y - 136, x - 8, y - 134)
    .fill(p.brass);
  g.moveTo(x + 6, y - 138)
    .bezierCurveTo(x + 26, y - 152, x + 46, y - 146, x + 52, y - 134)
    .bezierCurveTo(x + 36, y - 138, x + 22, y - 136, x + 8, y - 134)
    .fill(p.brass);
  g.circle(x, y - 137, 5).fill(p.brassDark);
  layer.addChild(g);
  const sign = label("HERMES POST", 9, 0x5a3a18);
  sign.anchor.set(0.5);
  sign.position.set(x, y - 118);
  layer.addChild(sign);
}

interface Crate {
  id: string;
  zone: number;
  stage: WorldCrate["stage"];
  view: Container;
  wings: Graphics;
  wrap: Graphics;
  tag: Text;
  /** Points still to travel through; empty when it has arrived. */
  path: WorldPoint[];
  /** How many of the path's points are inside the room, for the slower belt. */
  beltPoints: number;
  position: WorldPoint;
  /** Seconds since take-off, or -1 while it is on the ground. */
  flying: number;
  from: WorldPoint;
  /** -1 flies off to the left, 1 to the right: away from the workshop. */
  heading: number;
  /** Seconds since it started fading out, or -1. */
  fading: number;
  /** True once it has left the room for the yard. */
  outside: boolean;
}

function crateView(): {
  view: Container;
  wings: Graphics;
  wrap: Graphics;
  tag: Text;
} {
  const view = new Container();
  const wings = new Graphics();
  for (const side of [-1, 1]) {
    wings
      .moveTo(side * 13, -14)
      .bezierCurveTo(side * 30, -34, side * 52, -26, side * 58, -10)
      .bezierCurveTo(side * 44, -14, side * 30, -10, side * 14, -6)
      .fill(0xf5e6c4);
    wings
      .moveTo(side * 58, -10)
      .lineTo(side * 52, -2)
      .lineTo(side * 44, -12)
      .fill(0xe8a33d);
  }
  wings.scale.set(0);
  const box = new Graphics();
  box.roundRect(-15, -26, 30, 26, 3).fill(0xc8914d);
  box.rect(-15, -26, 30, 6).fill(0xb07a3a);
  box.rect(-3, -26, 6, 26).fill(0xe8d3a8);
  box.roundRect(-12, -14, 9, 7, 1).fill(0xffffff);
  box.rect(-11, -12, 7, 1.2).fill(0x8a92a6);
  box.rect(-11, -9.5, 5, 1.2).fill(0x8a92a6);
  // A draft is wrapped in cloth and tied: not ready to go yet.
  const wrap = new Graphics();
  wrap.roundRect(-17, -28, 34, 29, 5).fill({ color: 0xe9e4d8, alpha: 0.92 });
  wrap.moveTo(-17, -12).lineTo(17, -16).stroke({ width: 2, color: 0xa08a6a });
  wrap.circle(0, -14, 3).fill(0xa08a6a);
  wrap.visible = false;
  // Centred on its path, so it rides the middle of the pipe.
  const body = new Container();
  body.addChild(wings, box, wrap);
  body.y = 13;
  // Outlined, so it reads against a day sky and a night one alike.
  const tag = new Text({
    text: "",
    resolution: 6,
    style: {
      fill: 0xffffff,
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'SF Pro Rounded', 'SF Pro Text', sans-serif",
      fontSize: 8,
      fontWeight: "800",
      stroke: { color: 0x1b1d2a, width: 3, join: "round" },
    },
  });
  tag.anchor.set(0.5, 1);
  tag.y = -16;
  view.addChild(body, tag);
  // Big enough to read beside the scaled-up bots.
  view.scale.set(CRATE_SCALE);
  return { view, wings, wrap, tag };
}

/** Moves crates along the line; returns the effects animator. */
export function createDispatch(layer: Container, geometry: DispatchGeometry) {
  const crates = new Map<string, Crate>();
  let last = 0;
  let startedAt: number | undefined;

  const laneOf = (zone: number) => {
    const route = geometry.routes[zone];
    const lane = route && geometry.lanes[route.lane];
    return route && lane && route.path.length ? { route, lane } : undefined;
  };
  const bench = (zone: number) => laneOf(zone)?.route.path[0];
  /** Where the `slot`th waiting crate on a lane stands. */
  const yard = (lane: DispatchLane, slot: number): WorldPoint => {
    const inward = -(Math.sign(lane.post.x) || 1);
    return {
      x: lane.post.x + inward * (YARD_START + (slot % ROW) * YARD_GAP),
      y: GROUND - CRATE_HALF - Math.floor(slot / ROW) * CRATE_HALF * 2,
    };
  };
  /** Out of the room, up the pipe, onto the pad, then to its yard spot. */
  const outward = (zone: number, to: WorldPoint): WorldPoint[] => {
    const found = laneOf(zone);
    if (!found) return [to];
    const { route, lane } = found;
    const exit = route.path.at(-1)!;
    const pad = { x: lane.post.x, y: lane.post.y - PAD_HEIGHT - CRATE_HALF };
    return [...route.path.slice(1), { x: lane.pipeX, y: exit.y }, pad, to];
  };

  const add = (zone: number, crate: WorldCrate, snap: boolean) => {
    const start = bench(zone);
    if (!start) return;
    const { view, wings, wrap, tag } = crateView();
    layer.addChild(view);
    const entry: Crate = {
      id: crate.id,
      zone,
      stage: "packing",
      view,
      wings,
      wrap,
      tag,
      path: [],
      beltPoints: 0,
      position: { ...start },
      flying: -1,
      from: { ...start },
      heading: Math.sign(laneOf(zone)!.lane.post.x) || 1,
      fading: -1,
      outside: false,
    };
    crates.set(crate.id, entry);
    // Already outside when first seen at startup: it stands in the yard
    // rather than replaying a trip that happened while nobody watched.
    if (snap && crate.stage !== "packing") entry.outside = true;
  };

  return (time: number, zones: readonly WorldZone[]) => {
    const seconds = Math.min(0.1, Math.max(0, time - last));
    last = time;
    startedAt ??= time;
    // What is there as the World opens was there before: it is placed, not
    // replayed.
    const snapping = time - startedAt < 1.5;
    const present = new Set<string>();
    zones.forEach((zone, index) => {
      for (const crate of zone.crates ?? []) {
        present.add(crate.id);
        let entry = crates.get(crate.id);
        if (!entry) {
          // A branch that had merged before anyone looked has nothing to
          // show; only a merge seen happening flies.
          if (crate.stage === "merged") continue;
          add(index, crate, snapping);
          entry = crates.get(crate.id);
          if (!entry) continue;
        }
        entry.tag.text = crate.stage === "packing" ? "" : crate.label;
        entry.wrap.visible = crate.stage === "draft";
        if (entry.stage === crate.stage) continue;
        entry.stage = crate.stage;
        if (crate.stage !== "packing" && !entry.outside) {
          entry.outside = true;
          const found = laneOf(entry.zone);
          entry.beltPoints = found ? found.route.path.length - 1 : 0;
          // The last point is its yard spot, settled below with the others';
          // everything before it is the belt, the pipe and the pad.
          entry.path = outward(entry.zone, entry.position);
        }
      }
    });
    for (const entry of crates.values())
      if (!present.has(entry.id) && entry.fading < 0 && entry.flying < 0)
        entry.fading = 0;

    // Waiting crates take yard spots per lane, in the order they arrived.
    const slots = new Map<number, number>();
    for (const entry of crates.values()) {
      if (!entry.outside || entry.flying >= 0 || entry.fading >= 0) continue;
      const found = laneOf(entry.zone);
      if (!found) continue;
      const lane = geometry.routes[entry.zone]!.lane;
      const slot = slots.get(lane) ?? 0;
      slots.set(lane, slot + 1);
      const spot = yard(found.lane, slot);
      if (entry.path.length === 0) {
        const away = Math.hypot(
          spot.x - entry.position.x,
          spot.y - entry.position.y,
        );
        // Snapped in at startup, or shuffled along when one ahead left.
        if (snapping || away > 400) entry.position = spot;
        else if (away > 0.5) entry.path = [spot];
      } else entry.path[entry.path.length - 1] = spot;
      if (entry.stage === "merged" && entry.path.length === 0) entry.flying = 0;
    }

    for (const [id, entry] of crates) {
      if (entry.fading >= 0) {
        entry.fading += seconds;
        entry.view.alpha = Math.max(0, 1 - entry.fading / FADE);
        if (entry.fading >= FADE) {
          entry.view.destroy({ children: true });
          crates.delete(id);
          continue;
        }
      } else if (entry.flying < 0) {
        let budget = seconds * (entry.beltPoints > 0 ? BELT_SPEED : PIPE_SPEED);
        while (budget > 0 && entry.path.length) {
          const next = entry.path[0]!;
          const dx = next.x - entry.position.x;
          const dy = next.y - entry.position.y;
          const distance = Math.hypot(dx, dy);
          if (distance <= budget) {
            entry.position = { ...next };
            entry.path.shift();
            if (entry.beltPoints > 0) entry.beltPoints -= 1;
            budget -= distance;
          } else {
            entry.position.x += (dx / distance) * budget;
            entry.position.y += (dy / distance) * budget;
            budget = 0;
          }
        }
        entry.from = { ...entry.position };
      } else {
        // Wings unfold where it stands, then it climbs away toward the sky.
        entry.flying += seconds;
        const t = entry.flying;
        const unfold = Math.min(1, t / 0.4);
        const airborne = Math.max(0, t - 0.4);
        entry.wings.scale.set(unfold, unfold * (1 + Math.sin(t * 22) * 0.35));
        entry.position = {
          x:
            entry.from.x +
            entry.heading * (airborne * 70 + airborne * airborne * 26),
          y:
            entry.from.y -
            airborne * 120 -
            airborne * airborne * 30 +
            Math.sin(t * 22) * 2,
        };
        entry.view.alpha = Math.min(1, Math.max(0, (FLIGHT - t) / 0.8));
        if (t >= FLIGHT) {
          entry.view.destroy({ children: true });
          crates.delete(id);
          continue;
        }
      }
      entry.view.position.set(entry.position.x, entry.position.y);
    }
  };
}
