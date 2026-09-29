import { Container, Graphics, Text } from "pixi.js";
import type { WorldPoint } from "../world-theme";
import { FLOOR, FLOOR_TOP, ROOM_H, ROOM_W, scatter } from "./labyrinth-rooms";

/**
 * The Observatory: the one room every workspace shares. Bots come up here
 * for web work, from every floor, so it is where agents from different
 * workspaces meet. Designed like a workspace room, 900 by 300 with the door
 * on the right, and mirrored by the theme.
 */

export interface ObservatoryPalette {
  brass: number;
  brassDark: number;
  wood: number;
  woodDark: number;
  metal: number;
  screen: number;
  floor: number;
  rock: number;
  plate: number;
}

/** Where web workers stand, before mirroring: at consoles, then the scope. */
export const OBSERVATORY_SPOTS: readonly WorldPoint[] = [
  { x: -360, y: FLOOR },
  { x: -300, y: FLOOR },
  { x: -230, y: FLOOR },
  { x: -170, y: FLOOR },
  { x: -100, y: FLOOR },
  { x: -40, y: FLOOR },
  { x: 120, y: -24 },
  { x: 200, y: FLOOR },
  { x: 262, y: FLOOR },
  { x: 330, y: FLOOR },
];

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

/** Draws the room into `layer`; `mirror` is -1 when the door faces left. */
export function drawObservatory(
  layer: Container,
  p: ObservatoryPalette,
  mirror: number,
) {
  const room = new Graphics();
  const top = -ROOM_H / 2;
  const random = scatter(7);
  room.roundRect(-ROOM_W / 2, top, ROOM_W, ROOM_H, 12).fill(0x141d3a);
  // A great arched window onto the night sky, with a constellation.
  room
    .moveTo(-320, 60)
    .lineTo(-320, -60)
    .bezierCurveTo(-320, -150, 80, -150, 80, -60)
    .lineTo(80, 60)
    .closePath()
    .fill(0x0b1330);
  for (let star = 0; star < 40; star += 1)
    room
      .circle(
        -310 + random() * 380,
        -120 + random() * 170,
        0.8 + random() * 1.4,
      )
      .fill({
        color: 0xffffff,
        alpha: 0.4 + random() * 0.6,
      });
  const constellation: Array<[number, number]> = [
    [-240, -70],
    [-190, -96],
    [-140, -80],
    [-100, -104],
    [-60, -70],
  ];
  constellation.forEach(([x, y], index) => {
    room.circle(x, y, 3).fill(0xfff3b0);
    const next = constellation[index + 1];
    if (next)
      room
        .moveTo(x, y)
        .lineTo(next[0], next[1])
        .stroke({ width: 1, color: 0xfff3b0, alpha: 0.5 });
  });
  room.circle(30, -96, 18).fill(0xf4e7b8);
  room.circle(40, -102, 16).fill(0x0b1330);
  room
    .moveTo(-320, 60)
    .lineTo(-320, -60)
    .bezierCurveTo(-320, -150, 80, -150, 80, -60)
    .lineTo(80, 60)
    .stroke({ width: 8, color: p.brass });
  room.rect(-122, -128, 6, 188).fill(p.brass);
  // The floor.
  room
    .rect(-ROOM_W / 2, FLOOR_TOP, ROOM_W, ROOM_H / 2 - FLOOR_TOP)
    .fill(p.floor);
  room
    .rect(-ROOM_W / 2, FLOOR_TOP, ROOM_W, 4)
    .fill({ color: 0xffffff, alpha: 0.12 });
  // Consoles along the window, each showing a globe: the web.
  for (const x of [-330, -200, -70]) {
    room.roundRect(x - 44, FLOOR_TOP - 34, 88, 10, 3).fill(p.wood);
    room.rect(x - 38, FLOOR_TOP - 24, 6, 24).fill(p.woodDark);
    room.rect(x + 32, FLOOR_TOP - 24, 6, 24).fill(p.woodDark);
    room.roundRect(x - 26, FLOOR_TOP - 76, 52, 38, 4).fill(p.screen);
    room.circle(x, FLOOR_TOP - 57, 13).fill(0x4fa3f7);
    room
      .poly([
        x - 7,
        FLOOR_TOP - 64,
        x + 1,
        FLOOR_TOP - 67,
        x + 4,
        FLOOR_TOP - 60,
        x - 2,
        FLOOR_TOP - 55,
        x - 8,
        FLOOR_TOP - 58,
      ])
      .fill(0x5fcf7a);
  }
  // The great telescope on its tripod, aimed at the window.
  room
    .moveTo(150, FLOOR_TOP)
    .lineTo(172, 0)
    .stroke({ width: 5, color: p.metal });
  room
    .moveTo(196, FLOOR_TOP)
    .lineTo(172, 0)
    .stroke({ width: 5, color: p.metal });
  room
    .moveTo(172, FLOOR_TOP)
    .lineTo(172, 0)
    .stroke({ width: 4, color: p.metal });
  room.poly([150, 10, 60, -64, 72, -80, 168, -8]).fill(p.brass);
  room.poly([60, -64, 44, -78, 58, -94, 72, -80]).fill(p.brassDark);
  room.circle(166, 0, 10).fill(p.brassDark);
  // A globe on a stand, and a star chart on the wall.
  room.rect(282, FLOOR_TOP - 40, 6, 40).fill(p.woodDark);
  room.ellipse(285, FLOOR_TOP - 2, 16, 4).fill(p.woodDark);
  room.circle(285, FLOOR_TOP - 62, 22).fill(0x4fa3f7);
  room.circle(285, FLOOR_TOP - 62, 22).stroke({ width: 3, color: p.brass });
  room
    .poly([
      272,
      FLOOR_TOP - 70,
      286,
      FLOOR_TOP - 76,
      292,
      FLOOR_TOP - 64,
      280,
      FLOOR_TOP - 58,
    ])
    .fill(0x5fcf7a);
  room.circle(330, -70, 40).fill(0xe8e0c8);
  room.circle(330, -70, 40).stroke({ width: 3, color: p.brass });
  for (let ring = 1; ring <= 3; ring += 1)
    room
      .circle(330, -70, ring * 12)
      .stroke({ width: 1, color: 0x8a6446, alpha: 0.6 });
  for (let spoke = 0; spoke < 8; spoke += 1) {
    const angle = (spoke / 8) * Math.PI * 2;
    room
      .moveTo(330, -70)
      .lineTo(330 + Math.cos(angle) * 40, -70 + Math.sin(angle) * 40)
      .stroke({ width: 1, color: 0x8a6446, alpha: 0.6 });
  }
  room.rect(-ROOM_W / 2, top, ROOM_W, 12).fill({ color: 0x000000, alpha: 0.3 });
  room.rect(ROOM_W / 2 - 12, FLOOR_TOP - 86, 12, 86).fill(p.rock);
  room.scale.x = mirror;
  layer.addChild(room);

  const lamps = new Graphics();
  for (const lx of [-260, 0, 260])
    lamps
      .poly([
        lx - 12,
        top + 14,
        lx + 12,
        top + 14,
        lx + 90,
        FLOOR_TOP,
        lx - 90,
        FLOOR_TOP,
      ])
      .fill({ color: 0x9fbaff, alpha: 0.08 });
  layer.addChild(lamps);

  // The header, on the far wall, with a tag saying it is everyone's.
  const name = label("Observatory", 20, 0xffffff);
  const kind = label("SHARED · THE WEB", 11, 0x1b1d2a);
  const header = new Container();
  const plate = new Graphics();
  header.addChild(plate, name);
  name.position.set(14, 6);
  const pillX = name.width + 26;
  const pill = new Graphics()
    .roundRect(pillX, 9, kind.width + 16, 20, 10)
    .fill(0xe6b94a);
  header.addChild(pill, kind);
  kind.position.set(pillX + 8, 12);
  const width = pillX + kind.width + 28;
  plate.roundRect(0, 0, width, 38, 10).fill({ color: p.plate, alpha: 0.9 });
  header.position.set(
    mirror === 1 ? -ROOM_W / 2 + 14 : ROOM_W / 2 - 14 - width,
    top + 22,
  );
  layer.addChild(header);
  layer.addChild(
    new Graphics()
      .roundRect(-ROOM_W / 2, top, ROOM_W, ROOM_H, 12)
      .stroke({ width: 6, color: 0xe6b94a }),
  );
}
