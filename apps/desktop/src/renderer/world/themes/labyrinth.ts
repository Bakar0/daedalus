import { Container, Graphics, Text } from "pixi.js";
import type { WorldPlace, WorldZone } from "../world-model";
import type {
  WorldArrangement,
  WorldLook,
  WorldPoint,
  WorldTheme,
} from "../world-theme";

/**
 * Daedalus's Labyrinth, seen from the side like a cut-away ant farm.
 * Daedalus Works, a marble workshop-temple, stands on the surface and builds
 * the bots. A glass lift shaft runs straight down from its floor, and every
 * workspace is a room dug off the shaft, two to a floor, doors facing it.
 * Bots come out of the workshop, ride the shaft down, and fly through their
 * room's door; inside, they move freely between stations. A finished bot
 * goes back up the same way.
 *
 * Rooms are one open space. Stations are furniture along it, from the far
 * wall to the door: lounge, library, workbench under the war-room board,
 * terminal, observatory window over a thinking chair, round table, and the
 * shipping crates beside the pneumatic tube that carries pushes to the
 * surface. Rooms on the right of the shaft are mirror images, so every
 * door opens onto the shaft. Every room is the same size for now.
 */

const ROOM_W = 900;
const ROOM_H = 300;
const SHAFT_HALF = 45;
const CORRIDOR = 40;
const FLOOR_GAP = 60;
const FIRST_TOP = 80;
/** Where a standing bot's feet are, relative to the room's centre. */
const FLOOR = 90;
/** Where a room's door is, before mirroring. */
const DOOR_X = ROOM_W / 2 - 24;
const ROOM_X = SHAFT_HALF + CORRIDOR + ROOM_W / 2;
const HOME: WorldPoint = { x: 0, y: -40 };

interface Palette {
  skyTop: number;
  skyBottom: number;
  star: number;
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
    skyTop: 0x0f1a36,
    skyBottom: 0x2c4775,
    star: 0xffffff,
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
    skyTop: 0x7fc0ec,
    skyBottom: 0xcfe9f7,
    star: 0xffffff,
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

/** Wall colours, picked per workspace so neighbouring rooms differ. */
const WALLS = [0x314670, 0x245555, 0x4c375a, 0x4a4a2c, 0x5a3530, 0x2e4a3a];

const ATTENTION = 0xff5f5f;

/** Standing spots per place, before mirroring, relative to the room centre. */
const SPOTS: Record<WorldPlace, WorldPoint[]> = {
  lounge: [
    { x: -415, y: FLOOR },
    { x: -385, y: FLOOR },
    { x: -400, y: FLOOR - 16 },
  ],
  read: [
    { x: -250, y: FLOOR },
    { x: -222, y: FLOOR },
    { x: -286, y: -6 },
  ],
  plan: [
    { x: -180, y: -12 },
    { x: -128, y: -16 },
  ],
  edit: [
    { x: -176, y: FLOOR },
    { x: -128, y: FLOOR },
  ],
  run: [
    { x: -8, y: FLOOR },
    { x: 34, y: FLOOR },
  ],
  web: [
    { x: 136, y: 6 },
    { x: 178, y: 12 },
  ],
  think: [
    { x: 138, y: FLOOR },
    { x: 178, y: FLOOR },
  ],
  delegate: [
    { x: 242, y: FLOOR },
    { x: 298, y: FLOOR },
    { x: 270, y: FLOOR - 18 },
  ],
  ship: [
    { x: 342, y: FLOOR },
    { x: 374, y: FLOOR },
  ],
  door: [{ x: DOOR_X - 4, y: FLOOR }],
};

/** Rooms on the right of the shaft are mirrored so their doors face it. */
const mirrorOf = (zone: number) => (zone % 2 === 0 ? 1 : -1);

function spot(place: WorldPlace, slot: number, zone: number): WorldPoint {
  const spots = SPOTS[place];
  const base = spots[Math.min(slot, spots.length - 1)]!;
  const extra = slot - (spots.length - 1);
  let x = base.x;
  if (extra > 0) {
    // A queue forms toward the middle of the room and stays inside it.
    const direction = base.x > 0 ? -1 : 1;
    x = Math.max(-DOOR_X, Math.min(DOOR_X, base.x + direction * 26 * extra));
  }
  return { x: x * mirrorOf(zone), y: base.y };
}

function roomCenter(index: number): WorldPoint {
  const floor = Math.floor(index / 2);
  return {
    x: mirrorOf(index) === 1 ? -ROOM_X : ROOM_X,
    y: FIRST_TOP + floor * (ROOM_H + FLOOR_GAP) + ROOM_H / 2,
  };
}

function doorOf(center: WorldPoint, index: number): WorldPoint {
  return { x: center.x + DOOR_X * mirrorOf(index), y: center.y + FLOOR };
}

function arrange(zones: readonly WorldZone[]): WorldArrangement {
  const origins = zones.map((_, index) => roomCenter(index));
  const floors = Math.max(1, Math.ceil(zones.length / 2));
  const bottom = FIRST_TOP + floors * (ROOM_H + FLOOR_GAP) + 40;
  const half = ROOM_X + ROOM_W / 2 + 70;
  const roomAt = (point: WorldPoint) =>
    origins.findIndex(
      (origin) =>
        Math.abs(point.x - origin.x) <= ROOM_W / 2 &&
        Math.abs(point.y - origin.y) <= ROOM_H / 2 + 20,
    );
  return {
    origins,
    bounds: { x: -half, y: -340, width: half * 2, height: bottom + 340 },
    route: (from, to) => {
      const start = roomAt(from);
      const end = roomAt(to);
      if (start !== -1 && start === end) return [to];
      const points: WorldPoint[] = [];
      if (start !== -1) {
        const door = doorOf(origins[start]!, start);
        points.push(door, { x: 0, y: door.y });
      } else points.push({ x: 0, y: from.y });
      if (end !== -1) {
        const door = doorOf(origins[end]!, end);
        points.push({ x: 0, y: door.y }, door, to);
      } else points.push({ x: 0, y: to.y }, to);
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

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1)
    result = Math.imul(result ^ value.charCodeAt(index), 16777619) >>> 0;
  return result;
}

/** Deterministic noise for stones and stars, the same on every draw. */
function scatter(seed: number) {
  let value = (seed * 2654435761) >>> 0;
  return () => {
    value = Math.imul(value ^ (value >>> 15), 2246822507) >>> 0;
    value = Math.imul(value ^ (value >>> 13), 3266489909) >>> 0;
    return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
  };
}

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

  // The crane on the right lowers a finished bot's frame toward the shaft.
  const crane = new Graphics();
  crane.rect(360, -300, 12, 300).fill(p.metal);
  crane.rect(200, -306, 190, 12).fill(p.metal);
  crane
    .moveTo(236, -294)
    .lineTo(366, -200)
    .stroke({ width: 5, color: p.metal });
  layer.addChild(crane);
  const hook = new Graphics();
  layer.addChild(hook);

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
    // The hook swings gently with a crate of parts.
    const sway = Math.sin(time * 0.9) * 6;
    hook.clear();
    hook
      .moveTo(214, -294)
      .lineTo(214 + sway, -200)
      .stroke({ width: 2, color: 0x8a92a6 });
    hook.roundRect(202 + sway, -200, 24, 18, 3).fill(0xc8914d);
    hook.rect(212 + sway, -200, 4, 18).fill(0xe8d3a8);
  };
}

function drawWorld(
  layer: Container,
  arrangement: WorldArrangement,
  look: WorldLook,
) {
  const p = PALETTES[look.appearance];
  const { x, y, width, height } = arrangement.bounds;
  const g = new Graphics();
  // Sky in bands, stars, the moon or the sun.
  // Sky and rock run well past the world's edges, so a letterboxed view
  // shows more of them rather than the backdrop.
  const bleed = 3000;
  g.rect(x - bleed, y - bleed, width + bleed * 2, bleed).fill(p.skyTop);
  g.rect(x - bleed, y, bleed, -y).fill(p.skyTop);
  g.rect(x + width, y, bleed, -y).fill(p.skyTop);
  const bands = 8;
  for (let band = 0; band < bands; band += 1) {
    const mix = band / (bands - 1);
    const channel = (shift: number) =>
      Math.round(
        ((p.skyTop >> shift) & 255) * (1 - mix) +
          ((p.skyBottom >> shift) & 255) * mix,
      );
    const color = (channel(16) << 16) | (channel(8) << 8) | channel(0);
    g.rect(x, y + (band * -y) / bands, width, -y / bands + 1).fill(color);
  }
  const random = scatter(arrangement.origins.length + 3);
  if (look.appearance === "dark")
    for (let star = 0; star < 60; star += 1)
      g.circle(
        x + random() * width,
        y + random() * -y * 0.8,
        0.8 + random() * 1.2,
      ).fill({
        color: p.star,
        alpha: 0.4 + random() * 0.5,
      });
  g.circle(x + width * 0.86, y + 90, 34).fill(
    look.appearance === "dark" ? 0xf4e7b8 : 0xfff3b0,
  );
  // Ground and rock.
  g.rect(x, -6, width, 26).fill(p.grass);
  g.rect(x - bleed, 20, width + bleed * 2, height + y - 20 + bleed).fill(
    p.rock,
  );
  g.rect(x - bleed, -6, width + bleed * 2, 26).fill(p.grass);
  for (let stratum = 0; stratum < height / 70; stratum += 1) {
    const sy = 60 + stratum * 70 + random() * 20;
    g.moveTo(x, sy);
    for (let step = 1; step <= 24; step += 1)
      g.lineTo(
        x + (width * step) / 24,
        sy + Math.sin(step * 1.3 + stratum) * 8,
      );
    g.stroke({
      width: 4,
      color: stratum % 2 ? p.rockDark : p.rockLight,
      alpha: 0.7,
    });
  }
  for (let stone = 0; stone < (width * height) / 9000; stone += 1)
    g.circle(
      x + random() * width,
      30 + random() * (height + y - 30),
      3 + random() * 6,
    ).fill(random() > 0.5 ? p.rockDark : p.rockLight);
  // Corridors from every door to the shaft.
  arrangement.origins.forEach((origin, index) => {
    const door = doorOf(origin, index);
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

  const lights = new Graphics();
  layer.addChild(lights);
  const workshop = new Container();
  const animateWorkshop = drawWorkshop(workshop, p);
  layer.addChild(workshop);

  return (time: number) => {
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

function books(g: Graphics, x: number, y: number, width: number, seed: number) {
  const colors = [
    0xc0504d, 0x4f81bd, 0x9bbb59, 0xf2c14e, 0x8064a2, 0x4bacc6, 0xf79646,
  ];
  let cursor = x;
  let index = seed;
  while (cursor < x + width - 6) {
    const bookWidth = 6 + (index % 3);
    const bookHeight = 18 + ((index * 7) % 7);
    g.rect(cursor, y - bookHeight, bookWidth, bookHeight).fill(
      colors[index % colors.length]!,
    );
    cursor += bookWidth + 1.5;
    index += 1;
  }
}

/** The furniture, drawn facing the far wall on the left; mirrored for right rooms. */
function drawFurniture(g: Graphics, p: Palette) {
  const floorTop = FLOOR + 8;
  // Lounge: couch and a floor lamp.
  g.roundRect(-440, floorTop - 38, 90, 20, 8).fill(0x4a5a8a);
  g.roundRect(-444, floorTop - 24, 98, 24, 8).fill(0x556aa0);
  g.roundRect(-448, floorTop - 30, 12, 30, 5).fill(0x4a5a8a);
  g.roundRect(-358, floorTop - 30, 12, 30, 5).fill(0x4a5a8a);
  g.rect(-338, floorTop - 70, 3, 70).fill(p.metal);
  g.poly([
    -348,
    floorTop - 70,
    -324,
    floorTop - 70,
    -330,
    floorTop - 86,
    -342,
    floorTop - 86,
  ]).fill(0xe8d3a8);
  // Library: tall shelf and a ladder.
  g.rect(-332, -70, 72, floorTop + 70).fill(p.woodDark);
  for (let shelf = 0; shelf < 5; shelf += 1) {
    const sy = -44 + shelf * 30;
    books(g, -328, sy, 64, shelf * 3);
    g.rect(-330, sy, 68, 3).fill(p.wood);
  }
  g.moveTo(-300, -64)
    .lineTo(-278, floorTop)
    .stroke({ width: 3, color: p.wood });
  g.moveTo(-288, -64)
    .lineTo(-266, floorTop)
    .stroke({ width: 3, color: p.wood });
  for (let rung = 0; rung < 6; rung += 1) {
    const t = rung / 6 + 0.08;
    g.moveTo(-300 + 22 * t, -64 + (floorTop + 64) * t)
      .lineTo(-288 + 22 * t, -64 + (floorTop + 64) * t)
      .stroke({ width: 2, color: p.wood });
  }
  // War-room board on the wall above the workbench.
  g.roundRect(-212, -104, 124, 62, 4).fill(0xb07a3a);
  g.rect(-206, -98, 112, 50).fill(0xd9b27b);
  const notes: Array<[number, number, number]> = [
    [-200, -92, 0xfff3a0],
    [-176, -90, 0xffc2d1],
    [-152, -93, 0xb8e8ff],
    [-128, -90, 0xfff3a0],
    [-190, -70, 0xc8f7c5],
    [-164, -68, 0xfff3a0],
  ];
  for (const [nx, ny, color] of notes) g.rect(nx, ny, 18, 16).fill(color);
  g.moveTo(-130, -64)
    .lineTo(-122, -58)
    .lineTo(-110, -72)
    .stroke({ width: 2, color: 0x3fbf88 });
  // Workbench with two monitors.
  g.roundRect(-214, floorTop - 36, 124, 10, 3).fill(p.wood);
  g.rect(-208, floorTop - 26, 6, 26).fill(p.woodDark);
  g.rect(-102, floorTop - 26, 6, 26).fill(p.woodDark);
  for (const mx of [-204, -150]) {
    g.roundRect(mx, floorTop - 78, 50, 36, 3).fill(0x1d2233);
    const code = [0xc792ea, 0x82aaff, 0xc3e88d, 0xf78c6c, 0x82aaff];
    code.forEach((color, line) =>
      g
        .rect(
          mx + 5 + (line % 2) * 5,
          floorTop - 72 + line * 6,
          20 + ((line * 13) % 18),
          2.5,
        )
        .fill(color),
    );
    g.rect(mx + 22, floorTop - 42, 6, 6).fill(p.metal);
  }
  // Terminal: a server rack and a console.
  g.roundRect(-60, -6, 28, floorTop + 6, 3).fill(p.metal);
  for (let unit = 0; unit < 6; unit += 1)
    g.rect(-56, 0 + unit * 16, 20, 9).fill(0x1d2233);
  g.roundRect(-26, 0, 78, 56, 5).fill(p.screen);
  g.roundRect(-26, 0, 78, 56, 5).stroke({ width: 3, color: p.metal });
  g.rect(-20, 10, 34, 3).fill(0x3fdc8b);
  g.rect(-20, 18, 44, 3).fill(0xc3e88d);
  g.rect(-20, 26, 28, 3).fill(0x8a97ad);
  g.rect(8, 56, 10, floorTop - 56).fill(p.metal);
  // Observatory: a round window onto a globe, over a thinking chair.
  g.circle(157, -50, 48).fill(p.brass);
  g.circle(157, -50, 42).fill(0x12223f);
  g.circle(157, -50, 28).fill(0x4fa3f7);
  g.poly([140, -62, 154, -68, 160, -58, 150, -50, 144, -44, 136, -52]).fill(
    0x5fcf7a,
  );
  g.poly([164, -46, 176, -50, 180, -38, 168, -32, 162, -38]).fill(0x5fcf7a);
  g.roundRect(128, floorTop - 42, 58, 24, 8).fill(0x8a3a5a);
  g.roundRect(124, floorTop - 22, 66, 22, 8).fill(0xa04a6a);
  // Round table for subagents, with two stools.
  g.ellipse(270, floorTop - 38, 38, 8).fill(p.wood);
  g.rect(266, floorTop - 36, 8, 36).fill(p.woodDark);
  g.ellipse(270, floorTop - 2, 18, 4).fill(p.woodDark);
  g.rect(230, floorTop - 18, 14, 18).fill(p.woodDark);
  g.rect(296, floorTop - 18, 14, 18).fill(p.woodDark);
  // Shipping: crates and the tube up to the surface.
  g.rect(326, floorTop - 34, 34, 34).fill(0xc8914d);
  g.rect(358, floorTop - 26, 26, 26).fill(0xb07a3a);
  g.rect(334, floorTop - 58, 26, 24).fill(0xd9a86b);
  g.roundRect(392, -ROOM_H / 2, 26, ROOM_H / 2 + 60, 11).fill({
    color: 0x9fd8ff,
    alpha: 0.18,
  });
  g.roundRect(392, -ROOM_H / 2, 26, ROOM_H / 2 + 60, 11).stroke({
    width: 3,
    color: p.brass,
  });
  // The doorway onto the corridor.
  g.rect(ROOM_W / 2 - 12, floorTop - 86, 12, 86).fill(p.rockDark);
}

const TAGS: Array<[string, number]> = [
  ["LOUNGE", -400],
  ["LIBRARY", -296],
  ["WORKBENCH", -152],
  ["TERMINAL", 0],
  ["OBSERVATORY", 157],
  ["ROUND TABLE", 270],
  ["SHIPPING", 356],
];

function drawZone(
  layer: Container,
  zone: WorldZone,
  look: WorldLook,
  index: number,
) {
  const p = PALETTES[look.appearance];
  const mirror = mirrorOf(index);
  const busy = zone.busy > 0;
  const room = new Graphics();
  const wall = WALLS[hash(zone.id) % WALLS.length]!;
  // Wall tiles, wainscot and floor.
  room.roundRect(-ROOM_W / 2, -ROOM_H / 2, ROOM_W, ROOM_H, 12).fill(wall);
  for (let tx = -ROOM_W / 2 + 32; tx < ROOM_W / 2; tx += 32)
    room
      .rect(tx, -ROOM_H / 2, 1.5, ROOM_H)
      .fill({ color: 0x000000, alpha: 0.12 });
  for (let ty = -ROOM_H / 2 + 32; ty < FLOOR; ty += 32)
    room
      .rect(-ROOM_W / 2, ty, ROOM_W, 1.5)
      .fill({ color: 0x000000, alpha: 0.12 });
  room
    .rect(-ROOM_W / 2, FLOOR + 8, ROOM_W, ROOM_H / 2 - FLOOR - 8)
    .fill(p.floor);
  room.rect(-ROOM_W / 2, FLOOR + 8, ROOM_W, 4).fill(p.wood);
  room
    .rect(-ROOM_W / 2, -ROOM_H / 2, ROOM_W, 12)
    .fill({ color: 0x000000, alpha: 0.3 });
  layer.addChild(room);

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
  layer.addChild(lamps);

  const furniture = new Graphics();
  drawFurniture(furniture, p);
  furniture.scale.x = mirror;
  layer.addChild(furniture);

  if (!busy)
    layer.addChild(
      new Graphics()
        .roundRect(-ROOM_W / 2, -ROOM_H / 2, ROOM_W, ROOM_H, 12)
        .fill({ color: 0x0a1020, alpha: 0.35 }),
    );

  for (const [text, tx] of TAGS) {
    const tag = label(text, 10, 0x1b1d2a, "800");
    const pill = new Graphics()
      .roundRect(-tag.width / 2 - 6, -2, tag.width + 12, 16, 5)
      .fill({ color: 0xffffff, alpha: 0.88 });
    tag.anchor.set(0.5, 0);
    const holder = new Container();
    holder.addChild(pill, tag);
    // On the floorboards, below the bots' name tags.
    holder.position.set(tx * mirror, FLOOR + 38);
    layer.addChild(holder);
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
  layer.addChild(header);

  layer.addChild(
    new Graphics()
      .roundRect(-ROOM_W / 2, -ROOM_H / 2, ROOM_W, ROOM_H, 12)
      .stroke({ width: 6, color: zone.attention > 0 ? ATTENTION : p.brass }),
  );

  // The siren when someone is waiting, and a parcel riding the tube.
  const siren = new Graphics();
  const parcel = new Graphics();
  layer.addChild(parcel, siren);
  return (time: number) => {
    parcel.clear();
    if (busy) {
      const rise = (time * 0.35 + (hash(zone.id) % 100) / 100) % 1;
      const py = FLOOR + 30 - rise * (ROOM_H / 2 + FLOOR + 30);
      parcel
        .roundRect(395 * mirror - (mirror === -1 ? 20 : 0), py, 20, 18, 3)
        .fill(0xc8914d);
    }
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
};

export const LABYRINTH_ROOM = { width: ROOM_W, height: ROOM_H };
