import { Container, Graphics, Text } from "pixi.js";
import type { WorldPlace, WorldZone } from "../world-model";
import type { WorldLook, WorldPoint, WorldTheme } from "../world-theme";

/**
 * Each workspace is a room. Readers stand at the bookshelf, editors and
 * thinkers sit at the desks, shell commands go to the server racks, commits
 * and pushes go to the outbox, the web is the window, subagents meet at the
 * table, plans go on the whiteboard, idle agents sit on the couch, and a lost
 * session waits at the door. Everything is drawn from shapes, so there are no
 * asset files to load or license.
 */

const WIDTH = 560;
/** The room itself; the zone adds a header band above it for the name. */
const HEIGHT = 360;
const HEADER = 30;
const WALL = 84;

interface Palette {
  backdrop: number;
  wall: number;
  wallTrim: number;
  floor: number;
  floorAlt: number;
  wood: number;
  woodDark: number;
  metal: number;
  screen: number;
  paper: number;
  fabric: number;
  text: number;
  muted: number;
  plate: number;
}

const PALETTES: Record<WorldLook["appearance"], Palette> = {
  dark: {
    backdrop: 0x080c19,
    wall: 0x252d44,
    wallTrim: 0x333d5a,
    floor: 0x1a2032,
    floorAlt: 0x1d2437,
    wood: 0x6b4c35,
    woodDark: 0x4a3424,
    metal: 0x3a4460,
    screen: 0x5e8bff,
    paper: 0xe8ecf5,
    fabric: 0x4a5a8a,
    text: 0xeff4fc,
    muted: 0x8491a9,
    plate: 0x10152a,
  },
  light: {
    backdrop: 0xd9e3f1,
    wall: 0xe9e1d2,
    wallTrim: 0xd6ccb9,
    floor: 0xcfb28a,
    floorAlt: 0xc8aa80,
    wood: 0x8a6446,
    woodDark: 0x6b4c35,
    metal: 0x8b95ab,
    screen: 0x2f6fe8,
    paper: 0xffffff,
    fabric: 0x5f78b8,
    text: 0x111a2f,
    muted: 0x5d6b84,
    plate: 0xfdfaf3,
  },
};

const ATTENTION = 0xff5f5f;
const DONE = 0x3fbf88;
const ERROR = 0xffa53d;
const WORKING = 0xafbaff;

const DESKS = [60, 150, 240, 330, 420];

/** Standing spots per place, before overflow. */
const SPOTS: Record<WorldPlace, WorldPoint[]> = {
  read: [
    { x: 42, y: 122 },
    { x: 82, y: 126 },
    { x: 122, y: 122 },
  ],
  web: [{ x: 205, y: 120 }],
  plan: [
    { x: 305, y: 120 },
    { x: 345, y: 122 },
  ],
  run: [
    { x: 436, y: 122 },
    { x: 476, y: 126 },
    { x: 516, y: 122 },
  ],
  edit: DESKS.slice(0, 3).map((x) => ({ x, y: 236 })),
  think: DESKS.slice(3).map((x) => ({ x, y: 236 })),
  // Beside the outbox rather than in front of it, so its label stays clear.
  ship: [
    { x: 478, y: 234 },
    { x: 522, y: 252 },
  ],
  delegate: [
    { x: 70, y: 300 },
    { x: 150, y: 300 },
    { x: 110, y: 336 },
    { x: 110, y: 284 },
  ],
  lounge: [
    { x: 262, y: 318 },
    { x: 296, y: 318 },
    { x: 330, y: 318 },
    { x: 380, y: 330 },
    { x: 410, y: 318 },
  ],
  door: [{ x: 536, y: 336 }],
};

/**
 * More agents than spots stand in a loose queue beside the last one, so a
 * crowd still reads as a crowd rather than one figure drawn five times.
 */
function officeSpot(place: WorldPlace, slot: number): WorldPoint {
  const spots = SPOTS[place];
  const base = spots[Math.min(slot, spots.length - 1)]!;
  const extra = slot - (spots.length - 1);
  if (extra <= 0) return { x: base.x, y: base.y + HEADER };
  const direction = base.x > WIDTH / 2 ? -1 : 1;
  return {
    x: base.x + direction * 22 * extra,
    y: HEADER + Math.min(HEIGHT - 12, base.y + 10 * (extra % 2)),
  };
}

const label = (
  text: string,
  size: number,
  fill: number,
  weight: "400" | "600" = "400",
) =>
  new Text({
    text,
    resolution: 3,
    style: {
      fill,
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
      fontSize: size,
      fontWeight: weight,
    },
  });

const truncate = (value: string, length: number) =>
  value.length > length ? `${value.slice(0, length - 1)}…` : value;

function drawRoom(g: Graphics, p: Palette) {
  // Floor planks, then the wall with a skirting board.
  g.rect(0, WALL, WIDTH, HEIGHT - WALL).fill(p.floor);
  for (let y = WALL; y < HEIGHT; y += 24)
    g.rect(0, y, WIDTH, 12).fill(p.floorAlt);
  g.roundRect(0, 0, WIDTH, WALL, 0).fill(p.wall);
  g.rect(0, WALL - 6, WIDTH, 6).fill(p.wallTrim);
  g.rect(0, 0, WIDTH, HEIGHT).stroke({ width: 3, color: p.wallTrim });
}

function drawBookshelf(g: Graphics, p: Palette) {
  g.rect(16, 18, 124, 76).fill(p.woodDark);
  const books = [0xc0504d, 0x4f81bd, 0x9bbb59, 0xf2c14e, 0x8064a2, 0x4bacc6];
  for (let shelf = 0; shelf < 3; shelf += 1) {
    const y = 24 + shelf * 24;
    g.rect(20, y + 18, 116, 3).fill(p.wood);
    for (let book = 0; book < 11; book += 1) {
      const height = 14 + ((book * 7 + shelf * 3) % 5);
      g.rect(23 + book * 10, y + 18 - height, 8, height).fill(
        books[(book + shelf * 2) % books.length]!,
      );
    }
  }
}

function drawWindow(g: Graphics, p: Palette) {
  g.roundRect(160, 14, 90, 56, 4).fill(p.wallTrim);
  g.rect(165, 19, 80, 46).fill(0x7fb4ff);
  g.circle(226, 32, 7).fill(0xfff1a8);
  g.rect(203, 19, 4, 46).fill(p.wallTrim);
  g.rect(165, 40, 80, 4).fill(p.wallTrim);
  // Telescope on its tripod, pointed at the sky.
  g.moveTo(222, 108).lineTo(230, 88).stroke({ width: 2, color: p.metal });
  g.moveTo(238, 108).lineTo(230, 88).stroke({ width: 2, color: p.metal });
  g.poly([222, 90, 244, 76, 247, 81, 225, 95]).fill(p.metal);
}

function drawWhiteboard(g: Graphics, p: Palette) {
  g.roundRect(274, 12, 104, 62, 3).fill(p.metal);
  g.rect(278, 16, 96, 54).fill(p.paper);
  const ink = [0x4f81bd, 0xc0504d, 0x3fbf88];
  for (let line = 0; line < 4; line += 1)
    g.rect(284, 24 + line * 11, 40 + ((line * 23) % 40), 3).fill(
      ink[line % ink.length]!,
    );
  g.roundRect(346, 22, 20, 20, 3).fill(0xf7e36b);
}

function drawServers(g: Graphics, p: Palette) {
  for (let rack = 0; rack < 3; rack += 1) {
    const x = 414 + rack * 42;
    g.roundRect(x, 16, 36, 82, 3).fill(p.metal);
    for (let unit = 0; unit < 6; unit += 1) {
      g.rect(x + 4, 22 + unit * 12, 28, 8).fill(p.plate);
      g.circle(x + 28, 26 + unit * 12, 1.6).fill(
        unit % 3 === rack % 3 ? DONE : WORKING,
      );
    }
  }
}

function drawDesks(g: Graphics, p: Palette) {
  for (const x of DESKS) {
    // Monitor behind the desk top, keyboard on it, chair in front.
    g.roundRect(x - 14, 190, 28, 20, 2).fill(p.plate);
    g.rect(x - 12, 192, 24, 15).fill(p.screen);
    g.rect(x - 2, 210, 4, 4).fill(p.metal);
    g.roundRect(x - 26, 212, 52, 14, 3).fill(p.wood);
    g.rect(x - 24, 226, 4, 10).fill(p.woodDark);
    g.rect(x + 20, 226, 4, 10).fill(p.woodDark);
    g.roundRect(x - 9, 215, 18, 4, 1).fill(p.muted);
  }
}

function drawOutbox(g: Graphics, p: Palette) {
  g.roundRect(496, 190, 50, 34, 4).fill(0x3a6fd9);
  g.rect(500, 186, 42, 6).fill(0x2c56ad);
  g.roundRect(504, 176, 16, 12, 2).fill(0xc79a5b);
  g.roundRect(520, 172, 18, 16, 2).fill(0xd8ac6b);
  const out = label("OUT", 9, 0xffffff, "600");
  out.position.set(509, 200);
  return out;
}

function drawMeeting(g: Graphics, p: Palette) {
  g.ellipse(110, 312, 44, 20).fill(p.woodDark);
  g.ellipse(110, 308, 44, 20).fill(p.wood);
  g.roundRect(96, 300, 12, 8, 1).fill(p.paper);
  g.roundRect(114, 304, 10, 7, 1).fill(p.paper);
}

function drawLounge(g: Graphics, p: Palette) {
  // Couch.
  g.roundRect(240, 300, 112, 16, 6).fill(p.fabric);
  g.roundRect(236, 312, 120, 20, 6).fill(p.fabric);
  g.roundRect(232, 306, 12, 28, 5).fill(p.fabric);
  g.roundRect(348, 306, 12, 28, 5).fill(p.fabric);
  // Rug, plant and coffee machine.
  g.ellipse(330, 346, 90, 10).fill({ color: p.fabric, alpha: 0.25 });
  g.roundRect(440, 292, 22, 30, 3).fill(p.metal);
  g.rect(444, 298, 14, 8).fill(p.plate);
  g.circle(451, 314, 3).fill(ERROR);
  g.roundRect(470, 312, 16, 18, 3).fill(0xb5643a);
  g.circle(478, 304, 11).fill(0x3f9f5a);
  g.circle(471, 298, 7).fill(0x4fb36a);
}

function drawDoor(g: Graphics, p: Palette) {
  g.roundRect(522, 284, 34, 58, 3).fill(p.woodDark);
  g.roundRect(526, 288, 26, 52, 2).fill(p.wood);
  g.circle(547, 316, 2.2).fill(0xf2c14e);
  g.rect(516, 342, 44, 6).fill({ color: p.muted, alpha: 0.5 });
}

function drawZone(layer: Container, zone: WorldZone, look: WorldLook): void {
  const p = PALETTES[look.appearance];
  const g = new Graphics();
  drawRoom(g, p);
  drawBookshelf(g, p);
  drawWindow(g, p);
  drawWhiteboard(g, p);
  drawServers(g, p);
  drawDesks(g, p);
  const out = drawOutbox(g, p);
  drawMeeting(g, p);
  drawLounge(g, p);
  drawDoor(g, p);
  const room = new Container();
  room.position.set(0, HEADER);
  room.addChild(g, out);
  layer.addChild(room);

  // The name goes above the room, like a label on a floor plan, where no
  // agent can stand on it.
  const name = label(truncate(zone.name, 40), 16, p.text, "600");
  name.position.set(4, 3);
  layer.addChild(name);
  if (zone.attention > 0) {
    const text = label(
      `${zone.attention} need${zone.attention === 1 ? "s" : ""} you`,
      11,
      0xffffff,
      "600",
    );
    const badge = new Graphics()
      .roundRect(0, 0, text.width + 14, 20, 10)
      .fill(ATTENTION);
    const group = new Container();
    group.addChild(badge, text);
    text.position.set(7, 3);
    group.position.set(name.x + name.width + 10, 4);
    layer.addChild(group);
  }
}

export const officeTheme: WorldTheme = {
  id: "office",
  label: "Office",
  description:
    "Each workspace is a room. Agents walk to the desk, shelf, servers or outbox for the tool they are using.",
  zoneSize: { width: WIDTH, height: HEIGHT + HEADER },
  backdrop: (look) => PALETTES[look.appearance].backdrop,
  drawZone,
  spot: officeSpot,
};
