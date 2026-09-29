import { Container, Graphics, Text } from "pixi.js";
import type { WorldPlace, WorldZone } from "../world-model";
import type {
  WorldArrangement,
  WorldLook,
  WorldPoint,
  WorldTheme,
} from "../world-theme";

/**
 * Daedalus's island. The workshop that builds the bots stands in the middle;
 * every workspace is a plot on a ring around it, joined to it by a road. New
 * agents fly out of the workshop door to their plot and fly back when they
 * finish. A plot's building grows with the number of agents in it: a dark
 * cottage when nobody is home, a workshop, then a tower. The island grows a
 * ring at a time as workspaces are added and shrinks when they go.
 *
 * Inside a plot, each tool has its station: scrolls for reading, benches for
 * editing and thinking, the forge for the shell, crates for shipping, the
 * telescope for the web, the round table for subagents, the notice board for
 * plans, a garden bench to rest on and the gate for a lost session. They are
 * drawn small so the island reads from far away and still has something to
 * see when zoomed in.
 */

const PLOT_W = 360;
const PLOT_H = 280;
const RING_FIRST = 480;
const RING_STEP = 390;
/** Rings are wider than tall, because windows are. */
const RING_X = 1.3;
const RING_Y = 0.85;
const HOME: WorldPoint = { x: 0, y: 118 };
const GATE: WorldPoint = { x: 40, y: PLOT_H / 2 };

interface Palette {
  sea: number;
  foam: number;
  sand: number;
  grass: number;
  grassDark: number;
  plot: number;
  road: number;
  roadEdge: number;
  wood: number;
  woodDark: number;
  stone: number;
  stoneDark: number;
  roof: number;
  wall: number;
  window: number;
  windowLit: number;
  leaf: number;
  leafDark: number;
  text: number;
  plate: number;
  paper: number;
}

const PALETTES: Record<WorldLook["appearance"], Palette> = {
  // Night on the island: the lit windows are the busy plots.
  dark: {
    sea: 0x0a1a2e,
    foam: 0x2f5a80,
    sand: 0x6f6446,
    grass: 0x234632,
    grassDark: 0x1c3a29,
    plot: 0x2a5238,
    road: 0x5b523b,
    roadEdge: 0x4a4230,
    wood: 0x6b4c35,
    woodDark: 0x4a3424,
    stone: 0x6f7790,
    stoneDark: 0x4d546a,
    roof: 0x8a3a2e,
    wall: 0xb9ad96,
    window: 0x2a3148,
    windowLit: 0xffd27a,
    leaf: 0x2f6b45,
    leafDark: 0x245638,
    text: 0xeff4fc,
    plate: 0x10152a,
    paper: 0xd9dde8,
  },
  light: {
    sea: 0x5fb3d9,
    foam: 0xd8f1ff,
    sand: 0xf0dca6,
    grass: 0x86c96f,
    grassDark: 0x74b85e,
    plot: 0x96d27c,
    road: 0xe2c98f,
    roadEdge: 0xcdb277,
    wood: 0x8a6446,
    woodDark: 0x6b4c35,
    stone: 0xb8bfd0,
    stoneDark: 0x8e97ab,
    roof: 0xc0503c,
    wall: 0xf6eedd,
    window: 0x5a6a86,
    windowLit: 0xffd27a,
    leaf: 0x4c9e4a,
    leafDark: 0x3d8a3c,
    text: 0x111a2f,
    plate: 0xfffdf6,
    paper: 0xffffff,
  },
};

const ATTENTION = 0xff5f5f;

/** Standing spots per place, relative to the plot's centre. */
const SPOTS: Record<WorldPlace, WorldPoint[]> = {
  read: [
    { x: -140, y: -48 },
    { x: -108, y: -44 },
    { x: -124, y: -30 },
  ],
  web: [
    { x: 124, y: -56 },
    { x: 150, y: -46 },
  ],
  run: [
    { x: 116, y: 26 },
    { x: 150, y: 30 },
    { x: 132, y: 44 },
  ],
  plan: [
    { x: -128, y: 30 },
    { x: -156, y: 38 },
  ],
  edit: [
    { x: -60, y: 72 },
    { x: 0, y: 72 },
  ],
  think: [
    { x: 60, y: 72 },
    { x: 92, y: 84 },
  ],
  delegate: [
    { x: -150, y: 108 },
    { x: -92, y: 108 },
    { x: -121, y: 126 },
  ],
  ship: [
    { x: 110, y: 110 },
    { x: 150, y: 118 },
  ],
  lounge: [
    { x: -52, y: 124 },
    { x: -24, y: 124 },
    { x: -38, y: 136 },
  ],
  door: [{ x: GATE.x, y: GATE.y - 8 }],
};

function spot(place: WorldPlace, slot: number): WorldPoint {
  const spots = SPOTS[place];
  const base = spots[Math.min(slot, spots.length - 1)]!;
  const extra = slot - (spots.length - 1);
  if (extra <= 0) return base;
  const direction = base.x > 0 ? -1 : 1;
  // A long queue stays inside the fence.
  const limit = PLOT_W / 2 - 16;
  return {
    x: Math.max(-limit, Math.min(limit, base.x + direction * 22 * extra)),
    y: Math.min(PLOT_H / 2 - 4, base.y + 8 * (extra % 2)),
  };
}

/** Deterministic noise, so the island keeps its shape between frames. */
const wobble = (angle: number) =>
  1 + 0.05 * Math.sin(3 * angle + 1) + 0.03 * Math.sin(7 * angle + 2);

/**
 * The island hugs the plots it holds: two plots beside the workshop make a
 * long, low island, a full ring a rounder one. It grows until every plot
 * corner, and the workshop, sits well inside the wobbliest part of the coast.
 */
function islandRadii(origins: readonly WorldPoint[]) {
  const corners: WorldPoint[] = [
    { x: 220, y: 200 },
    { x: -220, y: 200 },
    { x: 220, y: -200 },
    { x: -220, y: -200 },
  ];
  for (const origin of origins)
    for (const sx of [-1, 1])
      for (const sy of [-1, 1])
        corners.push({
          x: origin.x + (sx * PLOT_W) / 2,
          y: origin.y + (sy * (PLOT_H + 70)) / 2,
        });
  let rx = Math.max(...corners.map((corner) => Math.abs(corner.x))) + 60;
  let ry = Math.max(...corners.map((corner) => Math.abs(corner.y))) + 60;
  const inside = () =>
    corners.every(
      (corner) => (corner.x / rx) ** 2 + (corner.y / ry) ** 2 <= 0.8,
    );
  while (!inside()) {
    rx *= 1.03;
    ry *= 1.03;
  }
  return { rx, ry };
}

function arrange(zones: readonly WorldZone[]): WorldArrangement {
  const origins: WorldPoint[] = [];
  let index = 0;
  let ring = 1;
  while (index < zones.length) {
    const count = Math.min(6 * ring, zones.length - index);
    // One or two plots come in close, so a small world draws large.
    const radius =
      ring === 1 && count <= 2 ? 340 : RING_FIRST + (ring - 1) * RING_STEP;
    // One or two plots sit beside the workshop, not above it: windows are
    // wide. From three on, the ring starts at the top.
    const start =
      count <= 2 ? 0 : -Math.PI / 2 + (ring % 2 ? 0 : Math.PI / count);
    for (let step = 0; step < count; step += 1) {
      const angle = start + (step / count) * Math.PI * 2;
      origins.push({
        x: Math.round(Math.cos(angle) * radius * RING_X),
        y: Math.round(Math.sin(angle) * radius * RING_Y),
      });
    }
    index += count;
    ring += 1;
  }
  const { rx, ry } = islandRadii(origins);
  const margin = 70;
  return {
    origins,
    bounds: {
      x: -rx * 1.1 - margin,
      y: -ry * 1.1 - margin,
      width: (rx * 1.1 + margin) * 2,
      height: (ry * 1.1 + margin) * 2,
    },
  };
}

const label = (
  value: string,
  size: number,
  fill: number,
  weight: "600" | "800" = "600",
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

/** A small hash for placing trees the same way every time. */
function scatter(seed: number) {
  let value = seed * 2654435761;
  return () => {
    value = Math.imul(value ^ (value >>> 15), 2246822507) >>> 0;
    value = Math.imul(value ^ (value >>> 13), 3266489909) >>> 0;
    return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
  };
}

function tree(g: Graphics, x: number, y: number, size: number, p: Palette) {
  g.ellipse(x, y + 2, size * 0.8, size * 0.28).fill({
    color: 0x000000,
    alpha: 0.18,
  });
  g.rect(x - size * 0.12, y - size * 0.6, size * 0.24, size * 0.62).fill(
    p.woodDark,
  );
  g.circle(x, y - size * 0.95, size * 0.62).fill(p.leafDark);
  g.circle(x - size * 0.28, y - size * 1.1, size * 0.45).fill(p.leaf);
  g.circle(x + size * 0.3, y - size * 1.2, size * 0.4).fill(p.leaf);
}

function road(g: Graphics, from: WorldPoint, to: WorldPoint, p: Palette) {
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  // A gentle curve: the control point bends toward the island's centre line.
  const control = { x: mid.x * 0.85, y: mid.y * 1.15 + 30 };
  g.moveTo(from.x, from.y)
    .quadraticCurveTo(control.x, control.y, to.x, to.y)
    .stroke({ width: 26, color: p.roadEdge, cap: "round" });
  g.moveTo(from.x, from.y)
    .quadraticCurveTo(control.x, control.y, to.x, to.y)
    .stroke({ width: 18, color: p.road, cap: "round" });
}

function drawWorkshop(layer: Container, p: Palette) {
  const g = new Graphics();
  // Yard and assembly line.
  g.roundRect(-170, 40, 340, 90, 18).fill({ color: p.stoneDark, alpha: 0.5 });
  g.roundRect(-150, 70, 110, 16, 5).fill(0x3a404c);
  for (let roller = 0; roller < 7; roller += 1)
    g.circle(-142 + roller * 16, 86, 3).fill(0x8a92a6);
  // Hall: stone walls under a sawtooth roof.
  g.rect(-150, -70, 300, 150).fill(p.stone);
  g.rect(-150, 60, 300, 20).fill(p.stoneDark);
  for (let tooth = 0; tooth < 5; tooth += 1) {
    const x = -150 + tooth * 60;
    g.poly([x, -70, x + 60, -70, x + 60, -110]).fill(p.roof);
    g.poly([x + 44, -70, x + 60, -70, x + 60, -100]).fill({
      color: p.windowLit,
      alpha: 0.5,
    });
  }
  // Chimneys.
  g.rect(-120, -150, 22, 60).fill(p.stoneDark);
  g.rect(-86, -134, 18, 44).fill(p.stoneDark);
  // Big door, lit from inside: this is where the bots come out.
  g.roundRect(-38, 0, 76, 80, 10).fill(0x2b1d14);
  g.roundRect(-32, 6, 64, 74, 8).fill({ color: p.windowLit, alpha: 0.85 });
  g.rect(-34, 0, 68, 6).fill(p.woodDark);
  // Windows.
  for (const x of [-120, -80, 50, 90])
    g.roundRect(x, -40, 26, 30, 4).fill(p.windowLit);
  // Sign.
  g.roundRect(-78, -64, 156, 26, 6).fill(p.woodDark);
  layer.addChild(g);
  const sign = label("DAEDALUS WORKS", 13, 0xffe7b0, "800");
  sign.anchor.set(0.5);
  sign.position.set(0, -51);
  layer.addChild(sign);

  // The moving parts, redrawn each frame.
  const gear = new Graphics();
  gear.position.set(96, -2);
  const smoke = new Graphics();
  const belt = new Graphics();
  layer.addChild(gear, smoke, belt);
  const teeth: number[] = [];
  for (let tooth = 0; tooth < 16; tooth += 1) {
    const angle = (tooth / 16) * Math.PI * 2;
    const radius = tooth % 2 ? 18 : 23;
    teeth.push(Math.cos(angle) * radius, Math.sin(angle) * radius);
  }
  gear.poly(teeth).fill(0xc08a3e);
  gear.circle(0, 0, 7).fill(p.stoneDark);
  return (time: number) => {
    gear.rotation = time * 0.8;
    smoke.clear();
    for (const [x, top] of [
      [-109, -150],
      [-77, -134],
    ] as const)
      for (let puff = 0; puff < 4; puff += 1) {
        const rise = (time * 0.25 + puff / 4) % 1;
        smoke
          .circle(
            x + Math.sin(time + puff) * 6 + rise * 18,
            top - rise * 70,
            8 + rise * 12,
          )
          .fill({
            color: 0xc7ccd6,
            alpha: 0.4 * (1 - rise),
          });
      }
    // Parts ride the belt toward the door.
    belt.clear();
    for (let part = 0; part < 3; part += 1) {
      const x = -150 + ((((time * 22 + part * 36) % 108) + 108) % 108);
      belt.roundRect(x, 58, 12, 12, 3).fill(part % 2 ? 0xe07a5f : 0x2fbf8f);
    }
  };
}

function drawWorld(
  layer: Container,
  arrangement: WorldArrangement,
  look: WorldLook,
) {
  const p = PALETTES[look.appearance];
  const { rx, ry } = islandRadii(arrangement.origins);
  const g = new Graphics();
  const shape = (scale: number) => {
    const points: number[] = [];
    for (let step = 0; step < 96; step += 1) {
      const angle = (step / 96) * Math.PI * 2;
      const factor = wobble(angle) * scale;
      points.push(Math.cos(angle) * rx * factor, Math.sin(angle) * ry * factor);
    }
    return points;
  };
  g.poly(shape(1.1)).fill({ color: p.foam, alpha: 0.25 });
  g.poly(shape(1.06)).fill(p.sand);
  g.poly(shape(1)).fill(p.grass);
  // Meadow patches for texture.
  const random = scatter(arrangement.origins.length + 7);
  for (let patch = 0; patch < 18; patch += 1) {
    const angle = random() * Math.PI * 2;
    const distance = Math.sqrt(random()) * 0.85;
    g.ellipse(
      Math.cos(angle) * rx * distance,
      Math.sin(angle) * ry * distance,
      60 + random() * 90,
      30 + random() * 40,
    ).fill({
      color: p.grassDark,
      alpha: 0.5,
    });
  }
  for (const origin of arrangement.origins)
    road(g, HOME, { x: origin.x + GATE.x, y: origin.y + GATE.y }, p);
  // Trees wherever there is no plot, road end or workshop.
  const clear = (x: number, y: number) =>
    Math.abs(x) < 210 && Math.abs(y) < 190
      ? false
      : arrangement.origins.every(
          (origin) =>
            Math.abs(x - origin.x) > PLOT_W / 2 + 30 ||
            Math.abs(y - origin.y) > PLOT_H / 2 + 50,
        );
  const trees: Array<[number, number, number]> = [];
  for (let attempt = 0; attempt < 220; attempt += 1) {
    const angle = random() * Math.PI * 2;
    const distance = 0.2 + Math.sqrt(random()) * 0.72;
    const x = Math.cos(angle) * rx * distance * wobble(angle);
    const y = Math.sin(angle) * ry * distance * wobble(angle);
    if (clear(x, y)) trees.push([x, y, 16 + random() * 12]);
  }
  trees.sort((a, b) => a[1] - b[1]);
  for (const [x, y, size] of trees) tree(g, x, y, size, p);
  layer.addChild(g);

  const workshop = new Container();
  const animateWorkshop = drawWorkshop(workshop, p);
  layer.addChild(workshop);

  // Waves just off the beach.
  const waves = new Graphics();
  layer.addChild(waves);
  const wavePoints = Array.from({ length: 28 }, (_, index) => {
    const angle = (index / 28) * Math.PI * 2 + 0.1;
    return { angle, phase: index * 0.7 };
  });
  return (time: number) => {
    animateWorkshop(time);
    waves.clear();
    for (const wave of wavePoints) {
      const out = 1.13 + ((time * 0.05 + wave.phase) % 1) * 0.06;
      const factor = wobble(wave.angle) * out;
      const x = Math.cos(wave.angle) * rx * factor;
      const y = Math.sin(wave.angle) * ry * factor;
      const alpha = 0.6 * (1 - ((time * 0.05 + wave.phase) % 1));
      const tangent = wave.angle + Math.PI / 2;
      waves
        .moveTo(x - Math.cos(tangent) * 14, y - Math.sin(tangent) * 14)
        .quadraticCurveTo(
          x + Math.cos(wave.angle) * 4,
          y + Math.sin(wave.angle) * 4,
          x + Math.cos(tangent) * 14,
          y + Math.sin(tangent) * 14,
        )
        .stroke({ width: 2, color: p.foam, alpha });
    }
  };
}

function drawBuilding(g: Graphics, busy: number, p: Palette) {
  const lit = busy > 0 ? p.windowLit : p.window;
  if (busy >= 3) {
    // Tower beside a workshop.
    g.rect(-70, -100, 110, 70).fill(p.wall);
    g.poly([-80, -100, -15, -140, 50, -100]).fill(p.roof);
    g.rect(40, -170, 44, 140).fill(p.wall);
    g.poly([34, -170, 62, -214, 90, -170]).fill(p.roof);
    for (const y of [-155, -125, -95]) g.roundRect(54, y, 16, 18, 3).fill(lit);
    for (const x of [-56, -28, 0]) g.roundRect(x, -84, 18, 20, 3).fill(lit);
    g.roundRect(-40, -62, 26, 32, 4).fill(p.woodDark);
    return { eave: { x: 86, y: -170 } };
  }
  if (busy >= 1) {
    g.rect(-70, -96, 140, 66).fill(p.wall);
    g.poly([-82, -96, 0, -142, 82, -96]).fill(p.roof);
    g.rect(38, -150, 16, 34).fill(p.stoneDark);
    for (const x of [-56, -24, 30]) g.roundRect(x, -82, 20, 22, 3).fill(lit);
    g.roundRect(-4, -64, 26, 34, 4).fill(p.woodDark);
    return { eave: { x: 78, y: -98 } };
  }
  // Cottage, lights out.
  g.rect(-44, -80, 88, 50).fill(p.wall);
  g.poly([-54, -80, 0, -116, 54, -80]).fill(p.roof);
  g.roundRect(-30, -68, 16, 16, 3).fill(lit);
  g.roundRect(8, -62, 20, 32, 4).fill(p.woodDark);
  return { eave: { x: 50, y: -82 } };
}

function drawStations(g: Graphics, p: Palette) {
  // Scroll rack (read).
  g.rect(-160, -110, 60, 50).fill(p.woodDark);
  for (let shelf = 0; shelf < 3; shelf += 1)
    for (let scroll = 0; scroll < 5; scroll += 1)
      g.circle(-152 + scroll * 11, -100 + shelf * 15, 4.5).fill(
        scroll % 2 ? p.paper : 0xe8d3a8,
      );
  // Telescope (web).
  g.moveTo(132, -70).lineTo(140, -92).stroke({ width: 2.5, color: p.woodDark });
  g.moveTo(148, -70).lineTo(140, -92).stroke({ width: 2.5, color: p.woodDark });
  g.poly([128, -96, 160, -114, 164, -106, 132, -88]).fill(0xc08a3e);
  // Forge (run): stone hearth, fire, anvil.
  g.roundRect(118, -20, 54, 36, 6).fill(p.stoneDark);
  g.ellipse(145, -18, 18, 6).fill(0xff7a2a);
  g.ellipse(145, -20, 11, 4).fill(0xffd27a);
  g.poly([96, 8, 116, 8, 112, 14, 100, 14]).fill(0x3a404c);
  g.rect(103, 14, 6, 10).fill(0x3a404c);
  // Notice board (plan).
  g.rect(-150, -18, 4, 38).fill(p.woodDark);
  g.rect(-116, -18, 4, 38).fill(p.woodDark);
  g.rect(-156, -24, 50, 30).fill(p.wood);
  for (const [x, y, color] of [
    [-150, -20, 0xfff3a0],
    [-136, -18, p.paper],
    [-124, -21, 0xffc2d1],
  ] as const)
    g.rect(x, y, 11, 11).fill(color);
  // Workbenches (edit, think).
  for (const x of [-60, 0, 60]) {
    g.roundRect(x - 26, 40, 52, 14, 3).fill(p.wood);
    g.rect(x - 22, 54, 5, 10).fill(p.woodDark);
    g.rect(x + 17, 54, 5, 10).fill(p.woodDark);
    g.rect(x - 8, 34, 16, 6).fill(p.paper);
  }
  // Round table (delegate).
  g.ellipse(-121, 96, 26, 10).fill(p.stoneDark);
  g.ellipse(-121, 93, 26, 10).fill(p.stone);
  // Crates and a cart (ship).
  g.rect(122, 78, 22, 20).fill(0xc8914d);
  g.rect(146, 82, 18, 16).fill(0xb07a3a);
  g.rect(130, 64, 16, 14).fill(0xd9a86b);
  g.moveTo(122, 88).lineTo(144, 88).stroke({ width: 1, color: 0x6b4c35 });
  // Garden bench and a flower bed (lounge).
  g.roundRect(-66, 110, 56, 8, 3).fill(p.wood);
  g.rect(-62, 118, 4, 8).fill(p.woodDark);
  g.rect(-18, 118, 4, 8).fill(p.woodDark);
  for (let flower = 0; flower < 6; flower += 1)
    g.circle(-78 + flower * 6, 132 + (flower % 2) * 3, 2.4).fill(
      [0xff8fab, 0xffd84d, 0xb58cff][flower % 3]!,
    );
}

function drawFence(g: Graphics, p: Palette) {
  const left = -PLOT_W / 2;
  const top = -PLOT_H / 2;
  const posts: WorldPoint[] = [];
  for (let x = left; x <= -left; x += 30) {
    posts.push({ x, y: top });
    if (Math.abs(x - GATE.x) > 26) posts.push({ x, y: -top });
  }
  for (let y = top + 30; y < -top; y += 30) {
    posts.push({ x: left, y });
    posts.push({ x: -left, y });
  }
  g.rect(left, top - 2, PLOT_W, 3).fill(p.woodDark);
  g.rect(left, -top - 2, GATE.x - 26 - left, 3).fill(p.woodDark);
  g.rect(GATE.x + 26, -top - 2, -left - GATE.x - 26, 3).fill(p.woodDark);
  g.rect(left - 1, top, 3, PLOT_H).fill(p.woodDark);
  g.rect(-left - 2, top, 3, PLOT_H).fill(p.woodDark);
  for (const post of posts) g.rect(post.x - 2, post.y - 7, 4, 9).fill(p.wood);
  // Gate posts.
  g.rect(GATE.x - 28, -top - 14, 5, 16).fill(p.woodDark);
  g.rect(GATE.x + 23, -top - 14, 5, 16).fill(p.woodDark);
}

function drawZone(layer: Container, zone: WorldZone, look: WorldLook) {
  const p = PALETTES[look.appearance];
  const g = new Graphics();
  g.roundRect(-PLOT_W / 2, -PLOT_H / 2, PLOT_W, PLOT_H, 18).fill(p.plot);
  g.moveTo(GATE.x, PLOT_H / 2)
    .bezierCurveTo(GATE.x, 60, 10, 20, 8, -30)
    .stroke({ width: 16, color: p.road, cap: "round" });
  drawFence(g, p);
  drawStations(g, p);
  const { eave } = drawBuilding(g, zone.busy, p);
  layer.addChild(g);

  // The name sign sits above the plot's top-left corner, with a red count
  // beside it when agents are waiting. The flag goes on the roof's edge, so
  // neither covers the other at any building size.
  const sign = new Container();
  const name = label(truncate(zone.name, 18), 26, p.text, "800");
  name.position.set(12, 4);
  let width = name.width + 24;
  const plate = new Graphics();
  sign.addChild(plate, name);
  if (zone.attention > 0) {
    const waiting = label(`${zone.attention} waiting`, 16, 0xffffff, "800");
    const pill = new Graphics()
      .roundRect(0, 0, waiting.width + 18, 26, 13)
      .fill(ATTENTION);
    const badge = new Container();
    badge.addChild(pill, waiting);
    waiting.position.set(9, 3);
    badge.position.set(width, 5);
    sign.addChild(badge);
    width += waiting.width + 26;
  }
  plate
    .roundRect(0, 0, width, name.height + 8, 10)
    .fill({ color: p.plate, alpha: 0.85 });
  sign.position.set(-PLOT_W / 2, -PLOT_H / 2 - name.height - 16);
  layer.addChild(sign);

  if (zone.attention === 0) return;
  const flag = new Graphics();
  layer.addChild(flag);
  return (time: number) => {
    flag.clear();
    const { x, y } = eave;
    flag
      .moveTo(x, y)
      .lineTo(x, y - 36)
      .stroke({ width: 2.5, color: p.woodDark });
    const wave = Math.sin(time * 5) * 3;
    flag
      .poly([
        x,
        y - 36,
        x + 30,
        y - 32 + wave,
        x + 26,
        y - 24 + wave,
        x,
        y - 20,
      ])
      .fill(ATTENTION);
  };
}

export const islandTheme: WorldTheme = {
  id: "island",
  label: "Island",
  description:
    "Daedalus's island: bots fly out of the workshop to their workspace's plot, and plots grow with the agents in them.",
  backdrop: (look) => PALETTES[look.appearance].sea,
  arrange,
  drawWorld,
  drawZone,
  spot,
  home: HOME,
};

export const ISLAND_PLOT = { width: PLOT_W, height: PLOT_H };
