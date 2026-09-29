import { Container, Graphics, Text } from "pixi.js";
import type { WorldZone } from "../world-model";
import type { WorldPoint } from "../world-theme";

/**
 * Shipping, factory style. When an agent pushes or opens a pull request, it
 * packs a crate at its room's bench against the back wall; a conveyor
 * carries the crate out through a hatch into the cargo pipe on that side's
 * outer edge, far from the lift, the pipe lifts it to the surface, and at
 * the Hermes Post on top the crate unfolds Daedalus's wings and flies off
 * into the sky, outward. While an agent keeps shipping, crates keep coming.
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

/** A second crate follows this long after the first while shipping goes on. */
const REPEAT = 5;
/** The agent needs a moment to reach the bench before the first crate. */
const FIRST_DELAY = 1.2;
const BELT_SPEED = 110;
const PIPE_SPEED = 260;
const FLIGHT = 3.2;
const CRATE_SCALE = 1.6;
/** Half a crate's height in world pixels: it sits on things, not in them. */
export const CRATE_HALF = 13 * CRATE_SCALE;
const PAD_HEIGHT = 18;

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
  view: Container;
  wings: Graphics;
  path: WorldPoint[];
  /** How many of the path's points are inside the room, for the slower belt. */
  beltPoints: number;
  position: WorldPoint;
  /** Seconds since take-off, or -1 while it is still travelling. */
  flying: number;
  from: WorldPoint;
  /** -1 flies off to the left, 1 to the right: away from the workshop. */
  heading: number;
}

function crateView(): { view: Container; wings: Graphics } {
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
  // Centred on its path, so it rides the middle of the pipe.
  const body = new Container();
  body.addChild(wings, box);
  body.y = 13;
  view.addChild(body);
  // Big enough to read beside the scaled-up bots.
  view.scale.set(CRATE_SCALE);
  return { view, wings };
}

/** Moves crates along the line; returns the effects animator. */
export function createDispatch(layer: Container, geometry: DispatchGeometry) {
  const crates: Crate[] = [];
  const previous = new Map<number, number>();
  const nextAt = new Map<number, number>();
  const launch = (index: number) => {
    const route = geometry.routes[index];
    const lane = route && geometry.lanes[route.lane];
    if (!route || !lane || route.path.length === 0) return;
    const exit = route.path.at(-1)!;
    const pad = { x: lane.post.x, y: lane.post.y - PAD_HEIGHT - CRATE_HALF };
    const path = [...route.path.slice(1), { x: lane.pipeX, y: exit.y }, pad];
    const { view, wings } = crateView();
    layer.addChild(view);
    crates.push({
      view,
      wings,
      path,
      beltPoints: route.path.length - 1,
      position: { ...route.path[0]! },
      flying: -1,
      from: pad,
      heading: Math.sign(lane.post.x) || 1,
    });
  };
  let last = 0;
  return (time: number, zones: readonly WorldZone[]) => {
    const seconds = Math.min(0.1, Math.max(0, time - last));
    last = time;
    zones.forEach((zone, index) => {
      const before = previous.get(index) ?? 0;
      previous.set(index, zone.shipping);
      if (zone.shipping > before) nextAt.set(index, time + FIRST_DELAY);
      if (zone.shipping === 0) nextAt.delete(index);
      const due = nextAt.get(index);
      if (due !== undefined && time >= due) {
        launch(index);
        nextAt.set(index, time + REPEAT);
      }
    });
    for (let index = crates.length - 1; index >= 0; index -= 1) {
      const crate = crates[index]!;
      if (crate.flying < 0) {
        let budget = seconds * (crate.beltPoints > 0 ? BELT_SPEED : PIPE_SPEED);
        while (budget > 0 && crate.path.length) {
          const next = crate.path[0]!;
          const dx = next.x - crate.position.x;
          const dy = next.y - crate.position.y;
          const distance = Math.hypot(dx, dy);
          if (distance <= budget) {
            crate.position = { ...next };
            crate.path.shift();
            if (crate.beltPoints > 0) crate.beltPoints -= 1;
            budget -= distance;
          } else {
            crate.position.x += (dx / distance) * budget;
            crate.position.y += (dy / distance) * budget;
            budget = 0;
          }
        }
        if (!crate.path.length) crate.flying = 0;
      } else {
        // Wings unfold on the pad, then it climbs away toward the sky.
        crate.flying += seconds;
        const t = crate.flying;
        const unfold = Math.min(1, t / 0.4);
        const airborne = Math.max(0, t - 0.4);
        crate.wings.scale.set(unfold, unfold * (1 + Math.sin(t * 22) * 0.35));
        crate.position = {
          x:
            crate.from.x +
            crate.heading * (airborne * 70 + airborne * airborne * 26),
          y:
            crate.from.y -
            airborne * 120 -
            airborne * airborne * 30 +
            Math.sin(t * 22) * 2,
        };
        crate.view.alpha = Math.min(1, Math.max(0, (FLIGHT - t) / 0.8));
        if (t >= FLIGHT) {
          crate.view.destroy({ children: true });
          crates.splice(index, 1);
          continue;
        }
      }
      crate.view.position.set(crate.position.x, crate.position.y);
    }
  };
}
