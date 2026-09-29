import { Graphics } from "pixi.js";
import type { WorldPlace } from "../world-model";
import type { WorldPoint } from "../world-theme";

/**
 * How one labyrinth room is laid out and decorated. Every workspace gets its
 * own room, picked from its id, so it looks the same every time the World
 * opens and different from its neighbours: the order of its stations, the
 * wall, the floor, the colours, and what hangs on the walls.
 *
 * Coordinates are the room's design space: 900 by 300, centred on (0, 0),
 * the far wall on the left and the door on the right. The theme mirrors and
 * scales this to the world.
 */

export const ROOM_W = 900;
export const ROOM_H = 300;
/** Where a standing bot's feet are. */
export const FLOOR = 90;
/** The top of the floorboards. */
export const FLOOR_TOP = FLOOR + 8;
export const DOOR_X = ROOM_W / 2 - 24;

/** Colours a room draws with, from the theme's palette. */
export interface RoomPalette {
  wood: number;
  woodDark: number;
  metal: number;
  screen: number;
  brass: number;
  paper: number;
}

/** Deterministic randomness, the same sequence for the same seed. */
export function scatter(seed: number) {
  let value = (seed * 2654435761) >>> 0;
  return () => {
    value = Math.imul(value ^ (value >>> 15), 2246822507) >>> 0;
    value = Math.imul(value ^ (value >>> 13), 3266489909) >>> 0;
    return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
  };
}

export function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1)
    result = Math.imul(result ^ value.charCodeAt(index), 16777619) >>> 0;
  return result;
}

const pick = <T>(random: () => number, items: readonly T[]): T =>
  items[Math.floor(random() * items.length)]!;

interface Block {
  id: string;
  tag: string;
  /** Standing spots, relative to the block's centre. */
  places: Partial<Record<WorldPlace, WorldPoint[]>>;
  /** True when the wall above it is free for a decoration. */
  wallFree: boolean;
  draw(g: Graphics, p: RoomPalette, random: () => number): void;
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

const COUCHES = [0x4a5a8a, 0x8a4a4a, 0x3f7a5a, 0x7a5a8a, 0x9a7a3a];
const CHAIRS = [0x8a3a5a, 0x3a5a8a, 0x5a7a3a, 0x8a6a3a];

const BLOCKS: readonly Block[] = [
  {
    id: "lounge",
    tag: "LOUNGE",
    places: {
      lounge: [
        { x: -30, y: FLOOR },
        { x: 14, y: FLOOR },
        { x: -8, y: FLOOR - 24 },
      ],
    },
    wallFree: true,
    draw(g, p, random) {
      const couch = pick(random, COUCHES);
      g.roundRect(-52, FLOOR_TOP - 38, 90, 20, 8).fill(couch);
      g.roundRect(-56, FLOOR_TOP - 24, 98, 24, 8).fill(couch);
      g.roundRect(-60, FLOOR_TOP - 30, 12, 30, 5).fill(couch);
      g.roundRect(30, FLOOR_TOP - 30, 12, 30, 5).fill(couch);
      g.rect(50, FLOOR_TOP - 70, 3, 70).fill(p.metal);
      g.poly([
        40,
        FLOOR_TOP - 70,
        64,
        FLOOR_TOP - 70,
        58,
        FLOOR_TOP - 86,
        46,
        FLOOR_TOP - 86,
      ]).fill(0xe8d3a8);
    },
  },
  {
    id: "library",
    tag: "LIBRARY",
    places: {
      read: [
        { x: 30, y: FLOOR },
        { x: -16, y: FLOOR },
        { x: -12, y: -10 },
      ],
    },
    wallFree: false,
    draw(g, p, random) {
      const seed = Math.floor(random() * 20);
      g.rect(-52, -70, 64, FLOOR_TOP + 70).fill(p.woodDark);
      for (let shelf = 0; shelf < 5; shelf += 1) {
        const sy = -44 + shelf * 30;
        books(g, -48, sy, 56, seed + shelf * 3);
        g.rect(-50, sy, 60, 3).fill(p.wood);
      }
      g.moveTo(-20, -64)
        .lineTo(2, FLOOR_TOP)
        .stroke({ width: 3, color: p.wood });
      g.moveTo(-8, -64)
        .lineTo(14, FLOOR_TOP)
        .stroke({ width: 3, color: p.wood });
      for (let rung = 0; rung < 6; rung += 1) {
        const t = rung / 6 + 0.08;
        g.moveTo(-20 + 22 * t, -64 + (FLOOR_TOP + 64) * t)
          .lineTo(-8 + 22 * t, -64 + (FLOOR_TOP + 64) * t)
          .stroke({ width: 2, color: p.wood });
      }
    },
  },
  {
    id: "work",
    tag: "WORKBENCH",
    places: {
      edit: [
        { x: -26, y: FLOOR },
        { x: 30, y: FLOOR },
      ],
      plan: [
        { x: -26, y: -14 },
        { x: 32, y: -20 },
      ],
    },
    wallFree: false,
    draw(g, p, random) {
      // The war-room board above the bench.
      g.roundRect(-62, -104, 124, 62, 4).fill(0xb07a3a);
      g.rect(-56, -98, 112, 50).fill(0xd9b27b);
      const notes = [0xfff3a0, 0xffc2d1, 0xb8e8ff, 0xc8f7c5];
      for (let note = 0; note < 6; note += 1)
        g.rect(
          -50 + (note % 4) * 24 + random() * 4,
          -92 + Math.floor(note / 4) * 22,
          18,
          16,
        ).fill(pick(random, notes));
      g.moveTo(22, -64)
        .lineTo(30, -58)
        .lineTo(42, -72)
        .stroke({ width: 2, color: 0x3fbf88 });
      g.roundRect(-62, FLOOR_TOP - 36, 124, 10, 3).fill(p.wood);
      g.rect(-56, FLOOR_TOP - 26, 6, 26).fill(p.woodDark);
      g.rect(50, FLOOR_TOP - 26, 6, 26).fill(p.woodDark);
      for (const mx of [-52, 2]) {
        g.roundRect(mx, FLOOR_TOP - 78, 50, 36, 3).fill(0x1d2233);
        const code = [0xc792ea, 0x82aaff, 0xc3e88d, 0xf78c6c, 0x82aaff];
        code.forEach((color, line) =>
          g
            .rect(
              mx + 5 + (line % 2) * 5,
              FLOOR_TOP - 72 + line * 6,
              14 + random() * 24,
              2.5,
            )
            .fill(color),
        );
        g.rect(mx + 22, FLOOR_TOP - 42, 6, 6).fill(p.metal);
      }
    },
  },
  {
    id: "terminal",
    tag: "TERMINAL",
    places: {
      run: [
        { x: -8, y: FLOOR },
        { x: 44, y: FLOOR },
      ],
    },
    wallFree: true,
    draw(g, p, random) {
      g.roundRect(-54, -6, 28, FLOOR_TOP + 6, 3).fill(p.metal);
      for (let unit = 0; unit < 6; unit += 1) {
        g.rect(-50, unit * 16, 20, 9).fill(0x1d2233);
        g.circle(-34, 4 + unit * 16, 1.6).fill(
          random() > 0.3 ? 0x3fdc8b : 0xffd27a,
        );
      }
      g.roundRect(-20, 0, 74, 56, 5).fill(p.screen);
      g.roundRect(-20, 0, 74, 56, 5).stroke({ width: 3, color: p.metal });
      g.rect(-14, 10, 34, 3).fill(0x3fdc8b);
      g.rect(-14, 18, 44, 3).fill(0xc3e88d);
      g.rect(-14, 26, 28, 3).fill(0x8a97ad);
      g.rect(12, 56, 10, FLOOR_TOP - 56).fill(p.metal);
    },
  },
  {
    // Web work happens in the shared Observatory; this is a quiet corner
    // with a window onto the world above, for thinking.
    id: "thinking",
    tag: "THINKING",
    places: {
      think: [
        { x: -22, y: FLOOR },
        { x: 30, y: FLOOR },
      ],
    },
    wallFree: false,
    draw(g, p, random) {
      g.circle(0, -50, 48).fill(p.brass);
      g.circle(0, -50, 42).fill(0x12223f);
      g.circle(0, -50, 28).fill(0x4fa3f7);
      g.poly([-17, -62, -3, -68, 3, -58, -7, -50, -13, -44, -21, -52]).fill(
        0x5fcf7a,
      );
      g.poly([7, -46, 19, -50, 23, -38, 11, -32, 5, -38]).fill(0x5fcf7a);
      const chair = pick(random, CHAIRS);
      g.roundRect(-29, FLOOR_TOP - 42, 58, 24, 8).fill(chair);
      g.roundRect(-33, FLOOR_TOP - 22, 66, 22, 8).fill(chair);
      g.rect(40, FLOOR_TOP - 60, 3, 60).fill(p.metal);
      g.circle(41, FLOOR_TOP - 64, 8).fill(0xffe08a);
    },
  },
  {
    id: "table",
    tag: "ROUND TABLE",
    places: {
      delegate: [
        { x: -38, y: FLOOR },
        { x: 38, y: FLOOR },
        { x: 0, y: FLOOR - 26 },
      ],
    },
    wallFree: true,
    draw(g, p) {
      g.ellipse(0, FLOOR_TOP - 38, 38, 8).fill(p.wood);
      g.rect(-4, FLOOR_TOP - 36, 8, 36).fill(p.woodDark);
      g.ellipse(0, FLOOR_TOP - 2, 18, 4).fill(p.woodDark);
      g.rect(-40, FLOOR_TOP - 18, 14, 18).fill(p.woodDark);
      g.rect(26, FLOOR_TOP - 18, 14, 18).fill(p.woodDark);
    },
  },
  {
    // Always the block by the door: a packing bench, and a conveyor that
    // carries each crate out of the room toward the surface.
    id: "ship",
    tag: "SHIPPING",
    places: {
      ship: [
        { x: -24, y: FLOOR },
        { x: 20, y: FLOOR },
      ],
    },
    wallFree: false,
    draw(g, p) {
      // Flattened boxes waiting on the wall, and a roll of tape.
      g.rect(-50, -40, 40, 50).fill(0xc8914d);
      g.rect(-46, -36, 32, 42).fill(0xd9a86b);
      g.rect(-30, -36, 4, 42).fill(0xe8d3a8);
      // The bench.
      g.roundRect(-56, FLOOR_TOP - 42, 76, 10, 3).fill(p.wood);
      g.rect(-50, FLOOR_TOP - 32, 6, 32).fill(p.woodDark);
      g.rect(10, FLOOR_TOP - 32, 6, 32).fill(p.woodDark);
      g.circle(-34, FLOOR_TOP - 48, 6).fill(0xe8d3a8);
      g.circle(-34, FLOOR_TOP - 48, 2.5).fill(p.woodDark);
      // The conveyor, out through the doorway.
      const beltLeft = BELT_START;
      const beltRight = ROOM_W / 2 - SHIP_BLOCK_X;
      g.roundRect(beltLeft, FLOOR_TOP - 14, beltRight - beltLeft, 10, 5).fill(
        0x2a2f3f,
      );
      for (let x = beltLeft + 8; x < beltRight - 4; x += 16)
        g.circle(x, FLOOR_TOP - 9, 3).fill(0x8a92a6);
      g.rect(beltLeft + 4, FLOOR_TOP - 4, 5, 4).fill(p.metal);
      g.rect(beltRight - 30, FLOOR_TOP - 4, 5, 4).fill(p.metal);
    },
  },
];

const BLOCK_STEP = 117;
const FIRST_BLOCK = -ROOM_W / 2 + 67;
/** The shipping block is always the last, beside the door. */
const SHIP_BLOCK_X = FIRST_BLOCK + 6 * BLOCK_STEP;
/** Where the conveyor starts, relative to the shipping block. */
const BELT_START = 24;
/**
 * Crates are drawn centred on their path; in design units (the room is drawn
 * 1.3 times larger) this lifts the centre by half a 1.6-scale crate.
 */
const CRATE_LIFT = 16;

type Decoration =
  "painting" | "clock" | "banner" | "amphora" | "plant" | "poster";
const DECORATIONS: readonly Decoration[] = [
  "painting",
  "clock",
  "banner",
  "amphora",
  "plant",
  "poster",
];

export interface RoomLayout {
  blocks: Array<{ block: Block; x: number }>;
  wallColor: number;
  wallStyle: number;
  floorColor: number;
  floorStyle: number;
  decorations: Array<{ kind: Decoration; x: number; y: number; tint: number }>;
}

const WALL_COLORS = [
  0x314670, 0x245555, 0x4c375a, 0x4a4a2c, 0x5a3530, 0x2e4a3a, 0x3a3f5a,
  0x55402a,
];
const FLOOR_COLORS = [0x5a3f2c, 0x4a3a30, 0x6a4a30, 0x3f3a3a, 0x5a4a3a];
const TINTS = [0xc0392b, 0x2f6fbf, 0x3fbf88, 0xe6b94a, 0x8e44ad];

const layouts = new Map<string, RoomLayout>();

export function layoutFor(id: string): RoomLayout {
  const cached = layouts.get(id);
  if (cached) return cached;
  const random = scatter(hash(id));
  // Shuffle every station but shipping, which stays beside the door so its
  // conveyor has somewhere to run.
  const order = BLOCKS.filter((block) => block.id !== "ship");
  for (let index = order.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [order[index], order[other]] = [order[other]!, order[index]!];
  }
  order.push(BLOCKS.find((block) => block.id === "ship")!);
  const blocks = order.map((block, index) => ({
    block,
    x: FIRST_BLOCK + index * BLOCK_STEP,
  }));
  const decorations: RoomLayout["decorations"] = [];
  for (const { block, x } of blocks)
    if (block.wallFree && random() < 0.8)
      decorations.push({
        kind: pick(random, DECORATIONS),
        x: x + (random() - 0.5) * 20,
        y: -66 + (random() - 0.5) * 16,
        tint: pick(random, TINTS),
      });
  const layout: RoomLayout = {
    blocks,
    wallColor: pick(random, WALL_COLORS),
    wallStyle: Math.floor(random() * 5),
    floorColor: pick(random, FLOOR_COLORS),
    floorStyle: Math.floor(random() * 3),
    decorations,
  };
  layouts.set(id, layout);
  return layout;
}

/** Standing spots for a place in this room, before mirroring and scaling. */
export function roomSpots(layout: RoomLayout, place: WorldPlace): WorldPoint[] {
  if (place === "door") return [{ x: DOOR_X - 8, y: FLOOR }];
  for (const { block, x } of layout.blocks) {
    const spots = block.places[place];
    if (spots) return spots.map((spot) => ({ x: spot.x + x, y: spot.y }));
  }
  return [{ x: 0, y: FLOOR }];
}

/**
 * Where a crate goes in this room, before mirroring and scaling: packed on
 * the bench, dropped on the belt, and carried out of the door.
 */
export const CRATE_PATH: readonly WorldPoint[] = [
  { x: SHIP_BLOCK_X - 20, y: FLOOR_TOP - 42 - CRATE_LIFT },
  { x: SHIP_BLOCK_X + BELT_START + 14, y: FLOOR_TOP - 14 - CRATE_LIFT },
  { x: ROOM_W / 2 + 2, y: FLOOR_TOP - 14 - CRATE_LIFT },
];

export function roomTags(layout: RoomLayout) {
  return layout.blocks.map(({ block, x }) => ({ text: block.tag, x }));
}

function drawWall(g: Graphics, layout: RoomLayout, random: () => number) {
  const top = -ROOM_H / 2;
  const line = { color: 0x000000, alpha: 0.13 };
  g.roundRect(-ROOM_W / 2, top, ROOM_W, ROOM_H, 12).fill(layout.wallColor);
  switch (layout.wallStyle) {
    case 0: // Tiles.
      for (let x = -ROOM_W / 2 + 32; x < ROOM_W / 2; x += 32)
        g.rect(x, top, 1.5, FLOOR_TOP - top).fill(line);
      for (let y = top + 32; y < FLOOR_TOP; y += 32)
        g.rect(-ROOM_W / 2, y, ROOM_W, 1.5).fill(line);
      return;
    case 1: // Bricks.
      for (let row = 0, y = top + 12; y < FLOOR_TOP; row += 1, y += 22) {
        g.rect(-ROOM_W / 2, y, ROOM_W, 1.5).fill(line);
        for (let x = -ROOM_W / 2 + (row % 2) * 22; x < ROOM_W / 2; x += 44)
          g.rect(x, y, 1.5, 22).fill(line);
      }
      return;
    case 2: // Stripes.
      for (let x = -ROOM_W / 2; x < ROOM_W / 2; x += 48)
        g.rect(x, top, 24, FLOOR_TOP - top).fill({
          color: 0xffffff,
          alpha: 0.05,
        });
      return;
    case 3: // Wood panels under plaster.
      g.rect(-ROOM_W / 2, 10, ROOM_W, FLOOR_TOP - 10).fill({
        color: 0x000000,
        alpha: 0.18,
      });
      for (let x = -ROOM_W / 2 + 40; x < ROOM_W / 2; x += 60)
        g.rect(x, 18, 36, FLOOR_TOP - 26).stroke({ width: 1.5, ...line });
      g.rect(-ROOM_W / 2, 8, ROOM_W, 4).fill({ color: 0xffffff, alpha: 0.12 });
      return;
    default: {
      // Plaster with a Greek key border under the ceiling, and a few cracks.
      const y = top + 18;
      for (let x = -ROOM_W / 2 + 6; x < ROOM_W / 2 - 20; x += 20)
        g.moveTo(x, y + 10)
          .lineTo(x, y)
          .lineTo(x + 14, y)
          .lineTo(x + 14, y + 7)
          .lineTo(x + 6, y + 7)
          .lineTo(x + 6, y + 4)
          .stroke({ width: 2, color: 0xffffff, alpha: 0.18 });
      for (let crack = 0; crack < 3; crack += 1) {
        let cx = -ROOM_W / 2 + random() * ROOM_W;
        let cy = top + 40 + random() * 60;
        g.moveTo(cx, cy);
        for (let step = 0; step < 4; step += 1) {
          cx += (random() - 0.5) * 20;
          cy += 8 + random() * 10;
          g.lineTo(cx, cy);
        }
        g.stroke({ width: 1.2, ...line });
      }
    }
  }
}

function drawFloor(g: Graphics, layout: RoomLayout) {
  const height = ROOM_H / 2 - FLOOR_TOP;
  g.rect(-ROOM_W / 2, FLOOR_TOP, ROOM_W, height).fill(layout.floorColor);
  const line = { color: 0x000000, alpha: 0.2 };
  switch (layout.floorStyle) {
    case 0: // Planks.
      for (let row = 0; row < 3; row += 1) {
        const y = FLOOR_TOP + (row * height) / 3;
        g.rect(-ROOM_W / 2, y, ROOM_W, 1.5).fill(line);
        for (let x = -ROOM_W / 2 + ((row * 37) % 90); x < ROOM_W / 2; x += 90)
          g.rect(x, y, 1.5, height / 3).fill(line);
      }
      break;
    case 1: // Checkerboard.
      for (
        let x = -ROOM_W / 2, column = 0;
        x < ROOM_W / 2;
        x += 26, column += 1
      )
        for (let row = 0; row < 2; row += 1)
          if ((column + row) % 2)
            g.rect(x, FLOOR_TOP + row * (height / 2), 26, height / 2).fill({
              color: 0xffffff,
              alpha: 0.08,
            });
      break;
    default: // Flagstones.
      for (let x = -ROOM_W / 2, index = 0; x < ROOM_W / 2; index += 1) {
        const width = 50 + ((index * 37) % 40);
        g.roundRect(x + 2, FLOOR_TOP + 4, width - 4, height - 8, 4).fill({
          color: 0xffffff,
          alpha: 0.06,
        });
        x += width;
      }
  }
  g.rect(-ROOM_W / 2, FLOOR_TOP, ROOM_W, 4).fill({
    color: 0xffffff,
    alpha: 0.12,
  });
}

function drawDecoration(
  g: Graphics,
  decoration: RoomLayout["decorations"][number],
  p: RoomPalette,
) {
  const { kind, x, y, tint } = decoration;
  switch (kind) {
    case "painting":
      // Daedalus's wings, framed.
      g.rect(x - 34, y - 26, 68, 52).fill(p.brass);
      g.rect(x - 29, y - 21, 58, 42).fill(0x1b2a4a);
      g.moveTo(x - 3, y - 2)
        .bezierCurveTo(x - 14, y - 16, x - 26, y - 10, x - 26, y + 4)
        .bezierCurveTo(x - 18, y, x - 10, y + 2, x - 3, y + 4)
        .fill(0xf5e6c4);
      g.moveTo(x + 3, y - 2)
        .bezierCurveTo(x + 14, y - 16, x + 26, y - 10, x + 26, y + 4)
        .bezierCurveTo(x + 18, y, x + 10, y + 2, x + 3, y + 4)
        .fill(0xf5e6c4);
      g.circle(x, y + 1, 4).fill(p.brass);
      return;
    case "clock":
      g.circle(x, y, 24).fill(p.brass);
      g.circle(x, y, 20).fill(p.paper);
      for (let hour = 0; hour < 12; hour += 1) {
        const angle = (hour / 12) * Math.PI * 2;
        g.circle(x + Math.cos(angle) * 16, y + Math.sin(angle) * 16, 1.2).fill(
          0x1b1d2a,
        );
      }
      g.moveTo(x, y)
        .lineTo(x + 8, y - 6)
        .stroke({ width: 2, color: 0x1b1d2a });
      g.moveTo(x, y)
        .lineTo(x - 2, y - 14)
        .stroke({ width: 1.5, color: 0x1b1d2a });
      return;
    case "banner":
      g.rect(x - 30, y - 42, 60, 4).fill(p.woodDark);
      g.poly([
        x - 22,
        y - 38,
        x + 22,
        y - 38,
        x + 22,
        y + 30,
        x,
        y + 44,
        x - 22,
        y + 30,
      ]).fill(tint);
      for (let band = 0; band < 3; band += 1)
        g.rect(x - 22, y - 26 + band * 22, 44, 3).fill({
          color: 0xffffff,
          alpha: 0.5,
        });
      g.circle(x, y + 8, 7).fill(p.brass);
      return;
    case "amphora":
      // A black-figure amphora on a wall shelf.
      g.rect(x - 32, y + 30, 64, 5).fill(p.woodDark);
      g.ellipse(x, y + 6, 16, 22).fill(0xc9743a);
      g.rect(x - 6, y - 26, 12, 12).fill(0xc9743a);
      g.ellipse(x, y - 27, 10, 3).fill(0xc9743a);
      g.rect(x - 16, y + 2, 32, 6).fill(0x1b1d2a);
      g.moveTo(x - 6, y - 20)
        .bezierCurveTo(x - 18, y - 22, x - 18, y - 8, x - 12, y - 6)
        .stroke({ width: 2.5, color: 0xc9743a });
      g.moveTo(x + 6, y - 20)
        .bezierCurveTo(x + 18, y - 22, x + 18, y - 8, x + 12, y - 6)
        .stroke({ width: 2.5, color: 0xc9743a });
      g.ellipse(x, y + 28, 9, 3).fill(0xa85a2a);
      return;
    case "plant":
      g.moveTo(x, y - 44)
        .lineTo(x, y - 10)
        .stroke({ width: 1.5, color: 0x8a92a6 });
      g.poly([
        x - 16,
        y - 10,
        x + 16,
        y - 10,
        x + 11,
        y + 12,
        x - 11,
        y + 12,
      ]).fill(0xb5643a);
      for (let leaf = 0; leaf < 6; leaf += 1) {
        const angle = Math.PI * (0.15 + leaf * 0.14);
        g.ellipse(
          x + Math.cos(angle) * 18 * (leaf % 2 ? 1 : -1),
          y + 6 + Math.sin(angle) * 20,
          6,
          12,
        ).fill(leaf % 2 ? 0x3f9f5a : 0x4fb36a);
      }
      return;
    default:
      // A poster of the workshop's first bot.
      g.rect(x - 24, y - 32, 48, 64).fill(tint);
      g.rect(x - 20, y - 28, 40, 56).fill({ color: 0xffffff, alpha: 0.15 });
      g.roundRect(x - 12, y - 14, 24, 20, 7).fill(0xf1e8dc);
      g.roundRect(x - 9, y - 11, 18, 11, 4).fill(0x2a1f1c);
      g.moveTo(x, y - 14)
        .lineTo(x, y - 20)
        .stroke({ width: 1.5, color: 0xf1e8dc });
      g.rect(x - 14, y + 14, 28, 3).fill(0xffffff);
  }
}

/** Draws the whole room, far wall on the left, door on the right. */
export function drawRoom(
  g: Graphics,
  layout: RoomLayout,
  p: RoomPalette,
  seed: string,
  rock: number,
) {
  const random = scatter(hash(`${seed}:draw`));
  drawWall(g, layout, random);
  drawFloor(g, layout);
  for (const decoration of layout.decorations) drawDecoration(g, decoration, p);
  for (const { block, x } of layout.blocks) {
    const local = new Graphics();
    block.draw(local, p, random);
    local.position.x = x;
    g.addChild(local);
  }
  g.rect(-ROOM_W / 2, -ROOM_H / 2, ROOM_W, 12).fill({
    color: 0x000000,
    alpha: 0.3,
  });
  // The doorway onto the corridor.
  g.rect(ROOM_W / 2 - 12, FLOOR_TOP - 86, 12, 86).fill(rock);
}
