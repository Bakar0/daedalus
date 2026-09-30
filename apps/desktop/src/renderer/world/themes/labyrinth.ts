import { Container, Graphics, Rectangle, Text } from "pixi.js";
import type { WorldPlace, WorldZone } from "../world-model";
import type {
  Waypoint,
  WorldArrangement,
  WorldLook,
  WorldPoint,
  WorldTheme,
  ZoneRef,
} from "../world-theme";
import { setTip } from "../world-theme";
import { roomTier, type WorldTrophy } from "../world-model";
import {
  createDispatch,
  type DispatchGeometry,
  drawPipe,
  drawPost,
} from "./labyrinth-dispatch";
import { drawObservatory, OBSERVATORY_SPOTS } from "./labyrinth-observatory";
import { createSky } from "./labyrinth-sky";
import {
  CRATE_PATH,
  DOOR_X,
  drawRoom,
  FLOOR,
  layoutFor,
  ROOM_H,
  ROOM_W,
  roomSpots,
  drawTrophy,
  roomTags,
  scatter,
} from "./labyrinth-rooms";

/**
 * Daedalus's Labyrinth, seen from the side like a cut-away ant farm.
 * Daedalus Works, a marble workshop-temple, stands on the surface and builds
 * the bots. A glass lift shaft runs straight down from its floor, and rooms
 * open off it two to a floor, one each side, doors facing it. The top left
 * room is the Observatory, the one room every workspace shares, for web
 * work; every workspace has a room of its own in the slots after it. Bots come out of the workshop, ride a car down,
 * and walk in through their room's door; inside, they move freely between
 * stations. A finished bot goes back up the same way.
 *
 * Each room is laid out and decorated from its workspace's id (see
 * `labyrinth-rooms.ts`), with the shipping bench always against the back
 * wall: its crates ride a conveyor out through a hatch into the cargo pipe
 * on that side's outer edge, up to a Hermes Post on the surface, and fly
 * away (see `labyrinth-dispatch.ts`). Every room is
 * the same size for now.
 */

const SHAFT_HALF = 45;
const CORRIDOR = 40;
const FLOOR_GAP = 60;
const FIRST_TOP = 80;
/**
 * Rooms are designed at 900 by 300 and drawn this much larger, and bots are
 * scaled up further, so a bot reads the way a dweller does in Fallout
 * Shelter: big beside the furniture, not lost in the room.
 */
const SCALE = 1.3;
const ACTOR_SCALE = 1.9;
const ROOM_X = SHAFT_HALF + CORRIDOR + (ROOM_W * SCALE) / 2;
const HOME: WorldPoint = { x: 0, y: -40 };
/**
 * Each side's cargo pipe runs up the labyrinth's outer edge, past the rooms'
 * back walls, to a Hermes Post on the surface: as far from the lift as the
 * world goes.
 */
const PIPE_OUTER = ROOM_X + (ROOM_W * SCALE) / 2 + 40;
/**
 * The Rebuilder on the surface, right of the workshop: two glass chambers
 * joined by a brass arc. A bot handing off waits by the first, steps in,
 * comes apart, and is put back together in the second as its successor.
 */
const REBUILDER = { from: 440, to: 700, ground: -6 };
const CHAMBER_W = 76;
const CHAMBER_H = 150;

/** Seconds of web work before a bot goes up to the Observatory, and back. */
const OBSERVATORY_DWELL = 4;

interface Palette {
  grass: number;
  rock: number;
  rockDark: number;
  rockLight: number;
  shaft: number;
  brass: number;
  brassDark: number;
  marble: number;
  marbleShade: number;
  wood: number;
  woodDark: number;
  floor: number;
  text: number;
  plate: number;
  metal: number;
  screen: number;
  paper: number;
  warm: number;
  dim: number;
}

const PALETTES: Record<WorldLook["appearance"], Palette> = {
  dark: {
    grass: 0x3f6b3c,
    rock: 0x3b2f27,
    rockDark: 0x2f261f,
    rockLight: 0x4b3d32,
    shaft: 0x161b2a,
    brass: 0xc08a3e,
    brassDark: 0x8a5a24,
    marble: 0xeee9df,
    marbleShade: 0xcfc8ba,
    wood: 0x6b4c35,
    woodDark: 0x4a3424,
    floor: 0x5a3f2c,
    text: 0xffffff,
    plate: 0x10152a,
    metal: 0x3a404c,
    screen: 0x0d1117,
    paper: 0xf1f3f8,
    warm: 0xffd27a,
    dim: 0x7fa6ff,
  },
  light: {
    grass: 0x6dbb5c,
    rock: 0x8a6d55,
    rockDark: 0x765b46,
    rockLight: 0x9c7f66,
    shaft: 0x2a3148,
    brass: 0xc99648,
    brassDark: 0x9c6a2c,
    marble: 0xffffff,
    marbleShade: 0xe2dccf,
    wood: 0x8a6446,
    woodDark: 0x6b4c35,
    floor: 0x7a5a40,
    text: 0xffffff,
    plate: 0x1b2238,
    metal: 0x4d5566,
    screen: 0x0d1117,
    paper: 0xffffff,
    warm: 0xffd27a,
    dim: 0x9fbaff,
  },
};

const ATTENTION = 0xff5f5f;

/**
 * Rooms go two to a floor, one each side of the shaft, doors facing it, as
 * in Fallout Shelter. Furniture is designed with the door on the right, so
 * rooms on the right of the shaft are drawn mirrored.
 */
const mirrorAt = (center: WorldPoint) => (center.x < 0 ? 1 : -1);

function spot(place: WorldPlace, slot: number, zone: ZoneRef): WorldPoint {
  const spots = roomSpots(layoutFor(zone.id), place);
  const base = spots[Math.min(slot, spots.length - 1)]!;
  const extra = slot - (spots.length - 1);
  let x = base.x;
  if (extra > 0) {
    // A queue forms toward the middle of the room and stays inside it.
    const direction = base.x > 0 ? -1 : 1;
    x = Math.max(-DOOR_X, Math.min(DOOR_X, base.x + direction * 40 * extra));
  }
  return {
    x: x * mirrorAt(roomCenter(zone.index)) * SCALE,
    y: base.y * SCALE,
  };
}

/**
 * The centre of the room in `slot`: slots fill each floor left then right.
 * Slot 0, top left, is the shared Observatory.
 */
function slotCenter(slot: number): WorldPoint {
  const floor = Math.floor(slot / 2);
  return {
    x: slot % 2 === 0 ? -ROOM_X : ROOM_X,
    y: FIRST_TOP + floor * (ROOM_H * SCALE + FLOOR_GAP) + (ROOM_H * SCALE) / 2,
  };
}

/** Workspace rooms take the slots after the Observatory's. */
function roomCenter(index: number): WorldPoint {
  return slotCenter(index + 1);
}
const OBSERVATORY = slotCenter(0);

/** Where bots handing off wait: a queue in front of the first chamber. */
function rebuilderSpot(slot: number): WorldPoint {
  return {
    x: REBUILDER.from - CHAMBER_W / 2 - 40 - slot * 56,
    y: REBUILDER.ground,
  };
}

function sharedSpot(place: WorldPlace, slot: number): WorldPoint {
  return place === "handoff"
    ? rebuilderSpot(slot)
    : observatorySpot(place, slot);
}

/** The Rebuilder's two chambers and the arc between them. */
function drawRebuilder(layer: Container, p: Palette) {
  const g = new Graphics();
  const { from, to, ground } = REBUILDER;
  // The brass arc the pieces stream along, and its supports.
  g.moveTo(from, ground - CHAMBER_H + 6)
    .bezierCurveTo(
      from + 60,
      ground - CHAMBER_H - 90,
      to - 60,
      ground - CHAMBER_H - 90,
      to,
      ground - CHAMBER_H + 6,
    )
    .stroke({ width: 12, color: p.brassDark });
  g.moveTo(from, ground - CHAMBER_H + 6)
    .bezierCurveTo(
      from + 60,
      ground - CHAMBER_H - 90,
      to - 60,
      ground - CHAMBER_H - 90,
      to,
      ground - CHAMBER_H + 6,
    )
    .stroke({ width: 5, color: 0x9fd8ff, alpha: 0.5 });
  for (const x of [from, to]) {
    // Base, glass tube, cap.
    g.roundRect(
      x - CHAMBER_W / 2 - 10,
      ground - 16,
      CHAMBER_W + 20,
      16,
      4,
    ).fill(p.brassDark);
    g.roundRect(
      x - CHAMBER_W / 2,
      ground - CHAMBER_H,
      CHAMBER_W,
      CHAMBER_H - 16,
      10,
    ).fill({
      color: 0x9fd8ff,
      alpha: 0.16,
    });
    g.roundRect(
      x - CHAMBER_W / 2,
      ground - CHAMBER_H,
      CHAMBER_W,
      CHAMBER_H - 16,
      10,
    ).stroke({
      width: 3,
      color: p.brass,
    });
    g.rect(
      x - CHAMBER_W / 2 + 8,
      ground - CHAMBER_H + 10,
      5,
      CHAMBER_H - 36,
    ).fill({
      color: 0xffffff,
      alpha: 0.25,
    });
    g.roundRect(
      x - CHAMBER_W / 2 - 8,
      ground - CHAMBER_H - 12,
      CHAMBER_W + 16,
      16,
      5,
    ).fill(p.brass);
    g.circle(x, ground - CHAMBER_H - 16, 7).fill(p.brassDark);
  }
  layer.addChild(g);
  const sign = label("REBUILDER", 11, 0xffe7b0, "800");
  sign.anchor.set(0.5);
  sign.position.set((from + to) / 2, ground - 10);
  const plate = new Graphics()
    .roundRect(-sign.width / 2 - 8, -9, sign.width + 16, 18, 5)
    .fill(p.brassDark);
  plate.position.set(sign.x, sign.y);
  layer.addChild(plate, sign);
}

function observatorySpot(_place: WorldPlace, slot: number): WorldPoint {
  const base = OBSERVATORY_SPOTS[slot % OBSERVATORY_SPOTS.length]!;
  const crowd = Math.floor(slot / OBSERVATORY_SPOTS.length);
  return {
    x: OBSERVATORY.x + (base.x + crowd * 22) * mirrorAt(OBSERVATORY) * SCALE,
    y: OBSERVATORY.y + base.y * SCALE,
  };
}

function doorOf(center: WorldPoint): WorldPoint {
  return {
    x: center.x + DOOR_X * SCALE * mirrorAt(center),
    y: center.y + FLOOR * SCALE,
  };
}

function arrange(zones: readonly WorldZone[]): WorldArrangement {
  const origins = zones.map((_, index) => roomCenter(index));
  const floors = Math.ceil((zones.length + 1) / 2);
  const bottom = FIRST_TOP + floors * (ROOM_H * SCALE + FLOOR_GAP) + 40;
  // From the steam pipes left of the workshop to past the rooms' far wall.
  const right = PIPE_OUTER + 110;
  const left = -right;
  // Every room a bot can be in: the Observatory first, then the zones.
  const rooms = [OBSERVATORY, ...origins];
  const roomAt = (point: WorldPoint) =>
    rooms.findIndex(
      (origin) =>
        Math.abs(point.x - origin.x) <= (ROOM_W * SCALE) / 2 &&
        Math.abs(point.y - origin.y) <= (ROOM_H * SCALE) / 2 + 20,
    );
  return {
    origins,
    bounds: { x: left, y: -340, width: right - left, height: bottom + 340 },
    route: (from, to) => {
      const start = roomAt(from);
      const end = roomAt(to);
      if (start !== -1 && start === end) return [to];
      // Along the surface, from one spot on the grass to another.
      if (start === -1 && end === -1 && from.y <= 0 && to.y <= 0) return [to];
      // Out through the door to the shaft, ride the car to the other floor,
      // and in through that floor's door.
      const points: Waypoint[] = [];
      if (start !== -1) {
        const door = doorOf(rooms[start]!);
        points.push(door, { x: 0, y: door.y });
      } else points.push({ x: 0, y: from.y });
      if (end !== -1) {
        const door = doorOf(rooms[end]!);
        points.push({ x: 0, y: door.y, ride: true }, door, to);
      } else points.push({ x: 0, y: to.y, ride: true }, to);
      return points.filter(
        (point, index) =>
          index === 0 ||
          point.x !== points[index - 1]!.x ||
          point.y !== points[index - 1]!.y,
      );
    },
  };
}

const label = (
  value: string,
  size: number,
  fill: number,
  weight: "600" | "700" | "800" = "700",
) =>
  new Text({
    text: value,
    resolution: 6,
    style: {
      fill,
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'SF Pro Rounded', 'SF Pro Text', sans-serif",
      fontSize: size,
      fontWeight: weight,
    },
  });

const truncate = (value: string, length: number) =>
  value.length > length ? `${value.slice(0, length - 1)}…` : value;

function gear(g: Graphics, radius: number, color: number, hub: number) {
  const points: number[] = [];
  for (let tooth = 0; tooth < 24; tooth += 1) {
    const angle = (tooth / 24) * Math.PI * 2;
    const r = tooth % 2 ? radius : radius + radius * 0.3;
    points.push(Math.cos(angle) * r, Math.sin(angle) * r);
  }
  g.poly(points).fill(color);
  g.circle(0, 0, radius * 0.38).fill(hub);
}

function drawWorkshop(layer: Container, p: Palette) {
  const g = new Graphics();
  // Steam pipes on the left.
  g.roundRect(-300, -170, 18, 170, 5).fill(p.brass);
  g.roundRect(-272, -140, 14, 140, 5).fill(p.brassDark);
  // Steps.
  g.rect(-240, -18, 480, 18).fill(p.marbleShade);
  g.rect(-222, -32, 444, 14).fill(p.marble);
  // The forge glowing between the columns.
  g.rect(-200, -142, 400, 110).fill(0xd9531e);
  g.rect(-200, -142, 400, 60).fill(0xff8a3a);
  g.rect(-200, -142, 400, 26).fill(0xffb347);
  layer.addChild(g);

  const glow = new Graphics();
  layer.addChild(glow);

  const front = new Graphics();
  // Columns with flutes.
  for (let column = 0; column < 6; column += 1) {
    const x = -200 + column * 76;
    front.rect(x, -146, 28, 114).fill(p.marble);
    front.rect(x + 8, -142, 2, 106).fill(p.marbleShade);
    front.rect(x + 18, -142, 2, 106).fill(p.marbleShade);
    front.rect(x - 3, -150, 34, 6).fill(p.marbleShade);
  }
  // Beam, sign and pediment.
  front.rect(-222, -172, 444, 24).fill(p.marbleShade);
  front.roundRect(-120, -168, 240, 16, 4).fill(p.brassDark);
  front.poly([-236, -172, 0, -250, 236, -172]).fill(p.marble);
  front.poly([-206, -176, 0, -238, 206, -176]).fill(p.marbleShade);
  // Daedalus's wings either side of the gear.
  front
    .moveTo(-14, -206)
    .bezierCurveTo(-60, -232, -110, -222, -136, -190)
    .bezierCurveTo(-100, -198, -64, -194, -24, -190)
    .fill(p.brass);
  front
    .moveTo(14, -206)
    .bezierCurveTo(60, -232, 110, -222, 136, -190)
    .bezierCurveTo(100, -198, 64, -194, 24, -190)
    .fill(p.brass);
  layer.addChild(front);
  const sign = label("DAEDALUS WORKS", 12, 0xffe7b0, "800");
  sign.anchor.set(0.5);
  sign.position.set(0, -160);
  layer.addChild(sign);

  const wheel = new Graphics();
  gear(wheel, 17, p.brass, p.brassDark);
  wheel.position.set(0, -204);
  layer.addChild(wheel);

  const steam = new Graphics();
  layer.addChild(steam);

  return (time: number) => {
    wheel.rotation = time * 0.6;
    glow.clear();
    for (let ember = 0; ember < 5; ember += 1) {
      const flicker = 0.45 + Math.sin(time * 3 + ember * 1.7) * 0.2;
      glow
        .circle(-160 + ember * 80, -56 + Math.sin(ember) * 10, 22)
        .fill({ color: 0xfff2b0, alpha: flicker * 0.6 });
    }
    steam.clear();
    for (const [x, top] of [
      [-291, -170],
      [-265, -140],
    ] as const)
      for (let puff = 0; puff < 4; puff += 1) {
        const rise = (time * 0.22 + puff / 4) % 1;
        steam
          .circle(
            x + rise * 22 + Math.sin(time + puff) * 5,
            top - rise * 110,
            10 + rise * 16,
          )
          .fill({ color: 0xc7ccd6, alpha: 0.42 * (1 - rise) });
      }
  };
}

function drawWorld(
  layer: Container,
  arrangement: WorldArrangement,
  look: WorldLook,
) {
  const p = PALETTES[look.appearance];
  const { x, y, width, height } = arrangement.bounds;
  // The sky follows the local clock; the rest is drawn once.
  const sky = new Graphics();
  layer.addChild(sky);
  const animateSky = createSky(sky, arrangement);
  const g = new Graphics();
  const random = scatter(arrangement.origins.length + 3);
  // Sky and rock run well past the world's edges, so a letterboxed view
  // shows more of them rather than the backdrop.
  const bleed = 3000;
  // Ground and rock.
  g.rect(x, -6, width, 26).fill(p.grass);
  g.rect(x - bleed, 20, width + bleed * 2, height + y - 20 + bleed).fill(
    p.rock,
  );
  g.rect(x - bleed, -6, width + bleed * 2, 26).fill(p.grass);
  // Rock layers and stones run past the edges too, a screen's width each way.
  const spread = 1200;
  const rockLeft = x - spread;
  const rockWidth = width + spread * 2;
  for (let stratum = 0; stratum < (height + spread) / 70; stratum += 1) {
    const sy = 60 + stratum * 70 + random() * 20;
    g.moveTo(rockLeft, sy);
    for (let step = 1; step <= 48; step += 1)
      g.lineTo(
        rockLeft + (rockWidth * step) / 48,
        sy + Math.sin(step * 1.3 + stratum) * 8,
      );
    g.stroke({
      width: 4,
      color: stratum % 2 ? p.rockDark : p.rockLight,
      alpha: 0.7,
    });
  }
  const rockHeight = height + y - 30 + spread;
  for (let stone = 0; stone < (rockWidth * rockHeight) / 9000; stone += 1)
    g.circle(
      rockLeft + random() * rockWidth,
      30 + random() * rockHeight,
      3 + random() * 6,
    ).fill(random() > 0.5 ? p.rockDark : p.rockLight);
  // Corridors from every door, the Observatory's too, to the shaft.
  [OBSERVATORY, ...arrangement.origins].forEach((origin) => {
    const door = doorOf(origin);
    const left = Math.min(door.x, 0);
    const right = Math.max(door.x, 0);
    g.rect(left, door.y - 64, right - left, 72).fill(p.rockDark);
    g.rect(left, door.y + 8, right - left, 10).fill(p.floor);
  });
  // The shaft: a glass tube with brass rails, running down from the workshop.
  const bottom = y + height - 30;
  g.rect(-SHAFT_HALF, -30, SHAFT_HALF * 2, bottom + 30).fill(p.shaft);
  g.rect(-SHAFT_HALF + 6, -30, 10, bottom + 30).fill({
    color: 0x9fd8ff,
    alpha: 0.12,
  });
  g.rect(SHAFT_HALF - 16, -30, 10, bottom + 30).fill({
    color: 0x9fd8ff,
    alpha: 0.12,
  });
  g.rect(-SHAFT_HALF, -30, 4, bottom + 30).fill(p.brass);
  g.rect(SHAFT_HALF - 4, -30, 4, bottom + 30).fill(p.brass);
  layer.addChild(g);

  // The Observatory, which is everyone's and so is no zone.
  const observatory = new Container();
  observatory.position.set(OBSERVATORY.x, OBSERVATORY.y);
  observatory.scale.set(SCALE);
  drawObservatory(
    observatory,
    { ...p, screen: p.screen, floor: p.floor, rock: p.rockDark },
    mirrorAt(OBSERVATORY),
  );
  layer.addChild(observatory);

  // Each side's cargo pipe and the post on top of it.
  const pipe = new Graphics();
  const dispatch = dispatchGeometry(arrangement);
  for (const lane of dispatch.lanes) {
    drawPipe(pipe, lane, p);
    drawPost(layer, lane.post, p);
  }
  layer.addChild(pipe);
  layer.addChild(weekScroll(dispatch.lanes[0]!.post));

  drawRebuilder(layer, p);

  const lights = new Graphics();
  layer.addChild(lights);
  const workshop = new Container();
  const animateWorkshop = drawWorkshop(workshop, p);
  layer.addChild(workshop);

  return (time: number) => {
    animateSky();
    animateWorkshop(time);
    // Lights chase down the shaft, the way the bots go.
    lights.clear();
    for (let light = 0; light * 40 < bottom; light += 1) {
      const ly = 10 + light * 40;
      const on = (light - time * 6) % 8;
      const alpha = on > -1 && on < 1 ? 1 : 0.35;
      lights.circle(-SHAFT_HALF + 2, ly, 2.6).fill({ color: p.warm, alpha });
      lights.circle(SHAFT_HALF - 2, ly, 2.6).fill({ color: p.warm, alpha });
    }
  };
}

function drawZone(
  layer: Container,
  zone: WorldZone,
  look: WorldLook,
  index: number,
) {
  const p = PALETTES[look.appearance];
  const mirror = mirrorAt(roomCenter(index));
  // Drawn at design size and scaled up, so the numbers stay readable.
  const inner = new Container();
  inner.scale.set(SCALE);
  layer.addChild(inner);
  const busy = zone.busy > 0;
  const layout = layoutFor(zone.id);
  // Lamps: warm light when anyone is in, dim blue when it is empty.
  const lamps = new Graphics();
  for (const lx of [-260, 0, 260]) {
    lamps
      .poly([
        lx - 12,
        -ROOM_H / 2 + 14,
        lx + 12,
        -ROOM_H / 2 + 14,
        lx + 90,
        FLOOR + 8,
        lx - 90,
        FLOOR + 8,
      ])
      .fill({ color: busy ? p.warm : p.dim, alpha: busy ? 0.12 : 0.06 });
    lamps.rect(lx - 12, -ROOM_H / 2, 24, 10).fill(0x8a92a6);
    lamps.circle(lx, -ROOM_H / 2 + 14, 6).fill(busy ? p.warm : p.dim);
  }
  inner.addChild(lamps);

  // The room is designed door-right and mirrored so the door faces the
  // shaft. The lamps go on top of it, below the text.
  const room = new Graphics();
  drawRoom(room, layout, p, zone.id, p.rockDark, roomTier(zone.wins));
  room.scale.x = mirror;
  inner.addChildAt(room, 0);

  if (!busy)
    inner.addChild(
      new Graphics()
        .roundRect(-ROOM_W / 2, -ROOM_H / 2, ROOM_W, ROOM_H, 12)
        .fill({ color: 0x0a1020, alpha: 0.35 }),
    );

  for (const { text, x: tx } of roomTags(layout)) {
    const tag = label(text, 10, 0x1b1d2a, "800");
    const pill = new Graphics()
      .roundRect(-tag.width / 2 - 6, -2, tag.width + 12, 16, 5)
      .fill({ color: 0xffffff, alpha: 0.88 });
    tag.anchor.set(0.5, 0);
    const holder = new Container();
    holder.addChild(pill, tag);
    // On the floorboards, below the bots' name tags.
    holder.position.set(tx * mirror, FLOOR + 38);
    inner.addChild(holder);
  }

  // Header: the workspace's name and how it is doing.
  const name = label(truncate(zone.name, 22), 20, p.text, "800");
  const chipText =
    zone.attention > 0
      ? `${zone.attention} waiting`
      : busy
        ? `${zone.busy} ${zone.busy === 1 ? "agent" : "agents"}`
        : "idle";
  const chipColor = zone.attention > 0 ? ATTENTION : busy ? 0x2f6b5a : 0x4b5160;
  const chip = label(chipText, 12, 0xffffff, "800");
  const header = new Container();
  const plate = new Graphics();
  header.addChild(plate, name, chip);
  name.position.set(14, 6);
  const chipX = name.width + 26;
  const pill = new Graphics()
    .roundRect(chipX, 9, chip.width + 16, 20, 10)
    .fill(chipColor);
  header.addChildAt(pill, 1);
  chip.position.set(chipX + 8, 11);
  plate
    .roundRect(0, 0, chipX + chip.width + 28, 38, 10)
    .fill({ color: p.plate, alpha: 0.9 });
  const farWall =
    mirror === 1
      ? -ROOM_W / 2 + 14
      : ROOM_W / 2 - 14 - (chipX + chip.width + 28);
  header.position.set(farWall, -ROOM_H / 2 + 22);
  inner.addChild(header);
  drawShelf(inner, zone.trophies, chipX + chip.width + 28, mirror, p);

  inner.addChild(
    new Graphics()
      .roundRect(-ROOM_W / 2, -ROOM_H / 2, ROOM_W, ROOM_H, 12)
      .stroke({ width: 6, color: zone.attention > 0 ? ATTENTION : p.brass }),
  );

  // The siren when someone is waiting.
  const siren = new Graphics();
  inner.addChild(siren);
  return (time: number) => {
    siren.clear();
    if (zone.attention === 0) return;
    const sx = -60 * mirror;
    const on = time % 0.8 < 0.45;
    siren
      .moveTo(sx - 14, -ROOM_H / 2)
      .lineTo(sx + 14, -ROOM_H / 2)
      .lineTo(sx + 12, -ROOM_H / 2 + 12)
      .bezierCurveTo(
        sx + 10,
        -ROOM_H / 2 + 26,
        sx - 10,
        -ROOM_H / 2 + 26,
        sx - 12,
        -ROOM_H / 2 + 12,
      )
      .fill(on ? ATTENTION : 0xa83a3a);
    if (on)
      for (const side of [-1, 1])
        siren
          .poly([
            sx + side * 12,
            -ROOM_H / 2 + 12,
            sx + side * 120,
            -ROOM_H / 2 + 60,
            sx + side * 120,
            -ROOM_H / 2 + 100,
          ])
          .fill({ color: ATTENTION, alpha: 0.16 });
  };
}

/**
 * The week's scroll, pinned to the left Hermes Post's column: click it for
 * what every workspace finished in the last seven days.
 */
function weekScroll(post: WorldPoint) {
  const scroll = new Graphics();
  scroll.roundRect(-13, -2, 26, 34, 3).fill(0xf1e3c0);
  scroll.roundRect(-16, -6, 32, 7, 3).fill(0xe0cc9a);
  scroll.roundRect(-16, 29, 32, 7, 3).fill(0xe0cc9a);
  for (let line = 0; line < 4; line += 1)
    scroll.rect(-8, 5 + line * 6, line === 3 ? 10 : 16, 1.6).fill(0x8a6a4a);
  scroll.circle(0, -8, 2.5).fill(0x8a5a24);
  scroll.position.set(post.x + 51, post.y - 92);
  scroll.hitArea = new Rectangle(-18, -10, 36, 48);
  setTip(scroll, "This week in the Labyrinth\nClick for what shipped", "week");
  return scroll;
}

const SHELF_Y = -ROOM_H / 2 + 34;
const SHELF_STEP = 24;
const LAMPS = [-260, 0, 260];

/**
 * The room's shelf under the ceiling, from the header toward the door: one
 * trophy per thing the workspace finished, newest nearest the door. It
 * skips the lamps and the siren, and hovering a trophy names what it was.
 */
function drawShelf(
  inner: Container,
  trophies: readonly WorldTrophy[],
  headerWidth: number,
  mirror: number,
  p: Palette,
) {
  if (trophies.length === 0) return;
  // In the unmirrored room: the far wall is on the left, the door right.
  const slots: number[] = [];
  for (
    let x = -ROOM_W / 2 + 14 + headerWidth + 22;
    x < DOOR_X - 60 && slots.length < trophies.length;
    x += SHELF_STEP
  ) {
    const blocked = [...LAMPS, -60].some((lx) => Math.abs(x - lx) < 26);
    if (!blocked) slots.push(x);
  }
  const shown = trophies.slice(-slots.length);
  const plank = new Graphics();
  const first = slots[0]!;
  const last = slots[shown.length - 1]!;
  const left = Math.min(first * mirror, last * mirror) - 16;
  const right = Math.max(first * mirror, last * mirror) + 16;
  plank.rect(left, SHELF_Y, right - left, 4).fill(p.woodDark);
  plank.rect(left, SHELF_Y + 4, right - left, 2).fill({
    color: 0x000000,
    alpha: 0.25,
  });
  inner.addChild(plank);
  shown.forEach((trophy, index) => {
    const item = new Graphics();
    drawTrophy(item, trophy.kind);
    item.position.set(slots[index]! * mirror, SHELF_Y);
    item.hitArea = new Rectangle(-11, -22, 22, 24);
    setTip(
      item,
      [trophy.label, trophy.detail, `Done ${shortDate(trophy.at)}`]
        .filter(Boolean)
        .join("\n"),
    );
    inner.addChild(item);
  });
}

const shortDate = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

/**
 * Where the crates go, for this arrangement of rooms: out of each room's
 * back wall into its side's pipe. Lane 0 is the left edge, lane 1 the right.
 */
function dispatchGeometry(arrangement: WorldArrangement): DispatchGeometry {
  const routes = arrangement.origins.map((origin) => {
    const mirror = mirrorAt(origin);
    return {
      lane: origin.x < 0 ? 0 : 1,
      path: CRATE_PATH.map((point) => ({
        x: origin.x + point.x * mirror * SCALE,
        y: origin.y + point.y * SCALE,
      })),
    };
  });
  const deepest = (lane: number) =>
    Math.max(
      FIRST_TOP + 60,
      ...routes
        .filter((route) => route.lane === lane)
        .map((route) => route.path.at(-1)!.y + 13),
    );
  return {
    lanes: [-1, 1].map((side, lane) => ({
      pipeX: side * PIPE_OUTER,
      bottom: deepest(lane),
      post: { x: side * PIPE_OUTER, y: 0 },
    })),
    routes,
  };
}

function drawEffects(layer: Container, arrangement: WorldArrangement) {
  return createDispatch(layer, dispatchGeometry(arrangement));
}

/**
 * The lift car: a brass cage a bot rides between the workshop and its floor.
 * Feet at (0, 0), in world pixels, sized for the scaled-up bots.
 */
function createVehicle(look: WorldLook) {
  const p = PALETTES[look.appearance];
  const car = new Graphics();
  // A short run of cable and the pulley; the cable itself would cross the
  // workshop above, so it fades out just over the car.
  for (let step = 0; step < 6; step += 1)
    car
      .rect(-2, -146 - (step + 1) * 14, 4, 14)
      .fill({ color: 0x8a92a6, alpha: 0.7 - step * 0.12 });
  car.roundRect(-42, -136, 84, 146, 8).fill({ color: 0x1d2233, alpha: 0.85 });
  car.roundRect(-42, -136, 84, 146, 8).stroke({ width: 4, color: p.brass });
  car.rect(-42, 2, 84, 8).fill(p.brassDark);
  car.rect(-30, -146, 60, 10).fill(p.brass);
  for (const x of [-26, -13, 0, 13, 26])
    car.rect(x - 1, -130, 2, 128).fill({ color: p.brass, alpha: 0.35 });
  car.circle(0, -124, 4).fill(p.warm);
  return car;
}

export const labyrinthTheme: WorldTheme = {
  id: "labyrinth",
  label: "Labyrinth",
  description:
    "Daedalus's Labyrinth: bots ride the lift from Daedalus Works down to their workspace's room and move freely inside it.",
  backdrop: (look) => PALETTES[look.appearance].rock,
  arrange,
  drawWorld,
  drawZone,
  spot,
  home: HOME,
  actorScale: ACTOR_SCALE,
  fit: "width",
  createVehicle,
  shared: {
    places: ["web", "handoff"],
    dwell: OBSERVATORY_DWELL,
    spot: sharedSpot,
  },
  handoff: {
    from: { x: REBUILDER.from, y: REBUILDER.ground - 16 },
    to: { x: REBUILDER.to, y: REBUILDER.ground - 16 },
    // The control point of the stream's curve: its top runs along the arc.
    arc: { x: (REBUILDER.from + REBUILDER.to) / 2, y: REBUILDER.ground - 374 },
  },
  drawEffects,
};

export const LABYRINTH_ROOM = {
  width: ROOM_W * SCALE,
  height: ROOM_H * SCALE,
};
