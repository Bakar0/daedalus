import type { Graphics } from "pixi.js";
import type { SessionTone } from "../../session-view";
import type { PersonaId } from "./personas";

/**
 * The costumes a bot wears, one per persona. Each draws into layers the bot
 * provides, in its own coordinates: the body spans x -13..13 and y y-38..y-10,
 * where `y` is the hover height (negative is up), the antenna light sits at
 * y-46.5, and `hand` is where the right hand is this frame. Nothing here may
 * cover the screen face or the antenna light: those carry the agent's state.
 *
 * Pixi joins `arc()` to wherever the pen last was, so this file draws curves
 * with polygons and beziers only.
 */

export interface CostumeFrame {
  g: Graphics;
  t: number;
  y: number;
  mood: SessionTone;
  walking: boolean;
  landed: boolean;
  hand: { x: number; y: number };
}

export interface Costume {
  /** Behind the body: wings, halos. */
  back?(frame: CostumeFrame): void;
  /** Over the body, under the face: aprons, beards. */
  front?(frame: CostumeFrame): void;
  /** In the right hand. */
  held?(frame: CostumeFrame): void;
  /** On the head, around the antenna. */
  head?(frame: CostumeFrame): void;
  /** Around the bot: companions. */
  near?(frame: CostumeFrame): void;
}

const GOLD = 0xe6b94a;
const GOLD_DARK = 0xb8862f;
const BRONZE = 0xc08a3e;
const WOOD = 0x8b5a2b;
const IVORY = 0xefe3c8;
const IRON = 0x5a6275;

/** Rotates points given as a flat [x, y, …] list about a pivot. */
function rotated(points: number[], px: number, py: number, angle: number) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const out: number[] = [];
  for (let index = 0; index < points.length; index += 2) {
    const dx = points[index]! - px;
    const dy = points[index + 1]! - py;
    out.push(px + dx * cos - dy * sin, py + dx * sin + dy * cos);
  }
  return out;
}

/** A filled circle approximated by a polygon, safe to mix with other paths. */
function ring(g: Graphics, x: number, y: number, r: number) {
  const points: number[] = [];
  for (let step = 0; step < 16; step += 1) {
    const angle = (step / 16) * Math.PI * 2;
    points.push(x + Math.cos(angle) * r, y + Math.sin(angle) * r);
  }
  return g.poly(points);
}

function staff(
  g: Graphics,
  x: number,
  top: number,
  bottom: number,
  color: number,
  width = 2,
) {
  g.moveTo(x, bottom).lineTo(x, top).stroke({ width, color, cap: "round" });
}

function wing(
  g: Graphics,
  x: number,
  y: number,
  side: -1 | 1,
  flap: number,
  span: number,
  color: number,
  tip: number,
) {
  const points = [
    x,
    y,
    x + side * span * 0.55,
    y - span * 0.7,
    x + side * span,
    y - span * 0.55,
    x + side * span * 0.9,
    y - span * 0.2,
    x + side * span * 0.75,
    y + span * 0.05,
    x + side * span * 0.45,
    y + span * 0.12,
  ];
  g.poly(rotated(points, x, y, side * flap)).fill(color);
  // Feather tips along the trailing edge.
  const tips = [
    x + side * span * 0.9,
    y - span * 0.2,
    x + side * span * 1.02,
    y - span * 0.05,
    x + side * span * 0.75,
    y + span * 0.05,
    x + side * span * 0.82,
    y + span * 0.2,
    x + side * span * 0.45,
    y + span * 0.12,
  ];
  g.poly(rotated(tips, x, y, side * flap)).fill(tip);
}

export const COSTUMES: Record<PersonaId, Costume> = {
  daedalus: {
    // Brass goggles pushed up, and the wrench he built everything with.
    head: ({ g, y }) => {
      g.rect(-13, y - 38, 26, 3).fill(0x6b4226);
      for (const x of [-5, 5]) {
        ring(g, x, y - 38.5, 4).fill(BRONZE);
        ring(g, x, y - 38.5, 2.6).fill({ color: 0x9fd8ff, alpha: 0.9 });
      }
    },
    held: ({ g, hand }) => {
      staff(g, hand.x, hand.y - 12, hand.y + 4, 0x9aa3b5, 2.4);
      g.poly([
        hand.x - 4,
        hand.y - 12,
        hand.x + 4,
        hand.y - 12,
        hand.x + 3,
        hand.y - 17,
        hand.x + 1,
        hand.y - 14,
        hand.x - 1,
        hand.y - 14,
        hand.x - 3,
        hand.y - 17,
      ]).fill(0x9aa3b5);
    },
    front: ({ g, y }) => {
      // A cog on the chest band.
      ring(g, 0, y - 13, 2.6).fill(BRONZE);
      for (let tooth = 0; tooth < 6; tooth += 1) {
        const angle = (tooth / 6) * Math.PI * 2;
        g.rect(
          Math.cos(angle) * 3 - 0.8,
          y - 13 + Math.sin(angle) * 3 - 0.8,
          1.6,
          1.6,
        ).fill(BRONZE);
      }
    },
  },
  icarus: {
    // Wax wings, singed at the tips. They beat harder in flight.
    back: ({ g, t, y, walking, landed }) => {
      const flap = landed ? -0.25 : Math.sin(t * (walking ? 14 : 5)) * 0.35;
      wing(g, -9, y - 28, -1, flap, 24, 0xf5e6c4, 0xe8a33d);
      wing(g, 9, y - 28, 1, flap, 24, 0xf5e6c4, 0xe8a33d);
    },
  },
  hermes: {
    // Winged helmet, and the caduceus.
    head: ({ g, t, y }) => {
      g.poly([-11, y - 36, -8, y - 41, 0, y - 43, 8, y - 41, 11, y - 36]).fill(
        GOLD,
      );
      const flutter = Math.sin(t * 14) * 0.25;
      wing(g, -11, y - 37, -1, flutter, 9, 0xffffff, 0xdfe6f0);
      wing(g, 11, y - 37, 1, flutter, 9, 0xffffff, 0xdfe6f0);
    },
    held: ({ g, t, hand }) => {
      staff(g, hand.x, hand.y - 22, hand.y + 10, GOLD, 1.8);
      for (const phase of [0, Math.PI]) {
        let first = true;
        for (let step = 0; step <= 12; step += 1) {
          const sy = hand.y + 8 - step * 2.3;
          const sx = hand.x + Math.sin(step * 0.9 + phase + t * 2) * 3;
          if (first) g.moveTo(sx, sy);
          else g.lineTo(sx, sy);
          first = false;
        }
        g.stroke({ width: 1.2, color: 0x3fae5a });
      }
      wing(g, hand.x - 1, hand.y - 21, -1, 0.2, 5, 0xffffff, 0xdfe6f0);
      wing(g, hand.x + 1, hand.y - 21, 1, 0.2, 5, 0xffffff, 0xdfe6f0);
    },
  },
  athena: {
    // Crested bronze helmet, a round shield, and her owl.
    head: ({ g, t, y }) => {
      const sway = Math.sin(t * 3) * 1;
      g.poly([
        -11,
        y - 38,
        -6,
        y - 47,
        0 + sway,
        y - 52,
        6,
        y - 47,
        11,
        y - 38,
        6,
        y - 42,
        0,
        y - 44,
        -6,
        y - 42,
      ]).fill(0xc0392b);
      g.roundRect(-13, y - 41, 26, 6, 3).fill(BRONZE);
    },
    front: ({ g, y }) => {
      ring(g, -17, y - 21, 7).fill(BRONZE);
      ring(g, -17, y - 21, 5).fill(0xd9a95a);
      ring(g, -17, y - 21, 1.8).fill(BRONZE);
    },
    near: ({ g, t, y }) => {
      const ox = -26 + Math.sin(t * 1.3) * 3;
      const oy = y - 44 + Math.cos(t * 2.1) * 3;
      const flap = Math.sin(t * 12) * 3;
      g.poly([ox - 3, oy, ox - 10, oy - 3 + flap, ox - 5, oy + 3]).fill(
        0x7a5a3a,
      );
      g.poly([ox + 3, oy, ox + 10, oy - 3 + flap, ox + 5, oy + 3]).fill(
        0x7a5a3a,
      );
      g.ellipse(ox, oy, 5, 6).fill(0x9a7248);
      g.poly([ox - 4.5, oy - 4, ox - 3, oy - 8, ox - 1.5, oy - 4.5]).fill(
        0x9a7248,
      );
      g.poly([ox + 4.5, oy - 4, ox + 3, oy - 8, ox + 1.5, oy - 4.5]).fill(
        0x9a7248,
      );
      for (const ex of [-2, 2]) {
        ring(g, ox + ex, oy - 1.5, 1.9).fill(0xffffff);
        ring(g, ox + ex, oy - 1.5, 0.9).fill(0x1b1d2a);
      }
      g.poly([ox - 0.8, oy + 0.5, ox + 0.8, oy + 0.5, ox, oy + 2]).fill(
        0xe8a33d,
      );
    },
  },
  zeus: {
    // Gold crown, a cloud of beard, and the thunderbolt, crackling.
    head: ({ g, y }) => {
      g.poly([
        -11,
        y - 36,
        -11,
        y - 44,
        -6,
        y - 40,
        -3,
        y - 46,
        0,
        y - 41,
        3,
        y - 46,
        6,
        y - 40,
        11,
        y - 44,
        11,
        y - 36,
      ]).fill(GOLD);
    },
    front: ({ g, y }) => {
      for (const [x, dy, r] of [
        [-7, 0, 4],
        [-2.5, 2, 4.5],
        [2.5, 2, 4.5],
        [7, 0, 4],
        [0, 5, 3.5],
      ] as const)
        ring(g, x, y - 16 + dy, r).fill(0xf4f4f4);
    },
    held: ({ g, t, hand, mood }) => {
      const x = hand.x;
      const top = hand.y - 18;
      const flash =
        mood === "attention" || mood === "error"
          ? t % 0.4 < 0.2
            ? 1
            : 0.5
          : 0.35 + Math.sin(t * 6) * 0.1;
      g.poly([
        x + 3,
        top,
        x - 3,
        top + 9,
        x + 1,
        top + 9,
        x - 3,
        top + 19,
        x + 6,
        top + 6,
        x + 2,
        top + 6,
        x + 6,
        top,
      ]).fill(flash > 0.6 ? 0xfff6c0 : 0xffd84d);
    },
  },
  poseidon: {
    // Coral crown and the trident.
    head: ({ g, y }) => {
      g.poly([
        -11,
        y - 36,
        -9,
        y - 44,
        -6,
        y - 39,
        -2,
        y - 45,
        2,
        y - 39,
        6,
        y - 45,
        9,
        y - 39,
        11,
        y - 44,
        11,
        y - 36,
      ]).fill(0x2bb3a3);
      for (const x of [-9, -2, 6, 11]) ring(g, x, y - 44.5, 1.3).fill(0xffffff);
    },
    held: ({ g, hand }) => {
      staff(g, hand.x, hand.y - 20, hand.y + 16, GOLD, 2);
      g.moveTo(hand.x - 5, hand.y - 26)
        .lineTo(hand.x - 5, hand.y - 20)
        .lineTo(hand.x + 5, hand.y - 20)
        .lineTo(hand.x + 5, hand.y - 26)
        .stroke({ width: 1.8, color: GOLD });
      staff(g, hand.x, hand.y - 29, hand.y - 20, GOLD, 1.8);
      for (const x of [-5, 0, 5])
        g.poly([
          hand.x + x - 1.6,
          hand.y - (x ? 26 : 29),
          hand.x + x + 1.6,
          hand.y - (x ? 26 : 29),
          hand.x + x,
          hand.y - (x ? 30 : 33),
        ]).fill(GOLD);
    },
  },
  hephaestus: {
    // Leather apron, and a hammer that swings while he works.
    front: ({ g, y }) => {
      g.roundRect(-9, y - 24, 18, 15, 3).fill(0x7a4a2a);
      g.rect(-9, y - 24, 18, 2).fill(0x5a341c);
      g.roundRect(-3, y - 20, 6, 4, 1).fill(0x5a341c);
    },
    held: ({ g, t, hand, mood }) => {
      const swing =
        mood === "working" ? Math.max(0, Math.sin(t * 7)) * 0.9 : 0.2;
      const handle = rotated(
        [hand.x, hand.y + 4, hand.x, hand.y - 12],
        hand.x,
        hand.y + 4,
        -swing,
      );
      g.moveTo(handle[0]!, handle[1]!)
        .lineTo(handle[2]!, handle[3]!)
        .stroke({ width: 2.2, color: WOOD, cap: "round" });
      g.poly(
        rotated(
          [
            hand.x - 5,
            hand.y - 16,
            hand.x + 5,
            hand.y - 16,
            hand.x + 5,
            hand.y - 11,
            hand.x - 5,
            hand.y - 11,
          ],
          hand.x,
          hand.y + 4,
          -swing,
        ),
      ).fill(0x3a404c);
      if (mood === "working" && swing < 0.1)
        for (let spark = 0; spark < 3; spark += 1)
          ring(g, hand.x - 8 + spark * 3, hand.y - 12 - spark * 2, 0.9).fill(
            0xffd84d,
          );
    },
  },
  apollo: {
    // A slow-turning sun behind him, a laurel wreath, and the lyre.
    back: ({ g, t, y }) => {
      const cy = y - 28;
      for (let ray = 0; ray < 12; ray += 1) {
        const angle = (ray / 12) * Math.PI * 2 + t * 0.3;
        const inner = 16;
        const outer = 23;
        g.poly([
          Math.cos(angle - 0.12) * inner,
          cy + Math.sin(angle - 0.12) * inner,
          Math.cos(angle) * outer,
          cy + Math.sin(angle) * outer,
          Math.cos(angle + 0.12) * inner,
          cy + Math.sin(angle + 0.12) * inner,
        ]).fill({ color: GOLD, alpha: 0.7 });
      }
      ring(g, 0, cy, 17).fill({ color: 0xffe08a, alpha: 0.35 });
    },
    head: ({ g, y }) => {
      for (let leaf = 0; leaf < 7; leaf += 1) {
        const x = -11 + leaf * 3.7;
        g.ellipse(
          x,
          y - 38 - Math.sin((leaf / 6) * Math.PI) * 2,
          2.4,
          1.3,
        ).fill(leaf % 2 ? 0x5fae4a : 0x4a9a3a);
      }
    },
    held: ({ g, hand }) => {
      const x = hand.x;
      const top = hand.y - 14;
      g.moveTo(x - 4, top)
        .bezierCurveTo(x - 6, top + 8, x - 2, top + 12, x, top + 12)
        .bezierCurveTo(x + 2, top + 12, x + 6, top + 8, x + 4, top)
        .stroke({ width: 2, color: GOLD });
      g.rect(x - 4.5, top - 1, 9, 2).fill(GOLD_DARK);
      for (const sx of [-1.8, 0, 1.8])
        g.moveTo(x + sx, top + 1)
          .lineTo(x + sx, top + 10)
          .stroke({ width: 0.5, color: 0xffffff });
    },
  },
  artemis: {
    // Silver crescent moon, and a hunting bow.
    head: ({ g, y }) => {
      const points: number[] = [];
      for (let step = 0; step <= 12; step += 1) {
        const angle = Math.PI * 0.15 + (step / 12) * Math.PI * 0.7;
        points.push(-Math.cos(angle) * 8, y - 40 - Math.sin(angle) * 8);
      }
      for (let step = 12; step >= 0; step -= 1) {
        const angle = Math.PI * 0.15 + (step / 12) * Math.PI * 0.7;
        points.push(-Math.cos(angle) * 6.5, y - 42 - Math.sin(angle) * 4.5);
      }
      g.poly(points).fill(0xe8edf7);
    },
    held: ({ g, hand }) => {
      const x = hand.x + 2;
      g.moveTo(x, hand.y - 16)
        .bezierCurveTo(x + 9, hand.y - 8, x + 9, hand.y + 4, x, hand.y + 12)
        .stroke({ width: 2, color: WOOD });
      g.moveTo(x, hand.y - 16)
        .lineTo(x, hand.y + 12)
        .stroke({ width: 0.6, color: 0xffffff });
    },
  },
  hades: {
    // A dark hood, and a blue flame for hair.
    back: ({ g, y }) => {
      g.roundRect(-18, y - 44, 36, 32, 13).fill(0x2d1f3d);
      g.roundRect(-18, y - 44, 36, 32, 13).stroke({
        width: 1,
        color: 0x4a3566,
      });
    },
    head: ({ g, t, y }) => {
      g.roundRect(-14, y - 42, 28, 6, 3).fill(0x3a2850);
      for (let tongue = 0; tongue < 5; tongue += 1) {
        const x = -8 + tongue * 4;
        const height =
          7 + Math.sin(t * 9 + tongue * 1.7) * 3 + (tongue === 2 ? 4 : 0);
        g.poly([
          x - 3,
          y - 41,
          x + 3,
          y - 41,
          x + Math.sin(t * 7 + tongue) * 1.5,
          y - 41 - height,
        ]).fill({ color: tongue % 2 ? 0x4fc3ff : 0x9be7ff, alpha: 0.9 });
      }
    },
  },
  medusa: {
    // Snakes for hair, each wriggling on its own beat.
    head: ({ g, t, y }) => {
      for (let snake = 0; snake < 5; snake += 1) {
        const baseX = -10 + snake * 5;
        let x = baseX;
        let sy = y - 37;
        g.moveTo(x, sy);
        for (let step = 1; step <= 6; step += 1) {
          sy -= 1.8;
          x =
            baseX +
            Math.sin(t * 5 + snake * 1.3 + step * 0.9) * 2.4 +
            (snake - 2) * step * 0.5;
          g.lineTo(x, sy);
        }
        g.stroke({
          width: 2.4,
          color: snake % 2 ? 0x3fae5a : 0x2e8a47,
          cap: "round",
        });
        ring(g, x, sy - 1, 1.9).fill(0x3fae5a);
        ring(g, x + 0.8, sy - 1.4, 0.5).fill(0xffd84d);
      }
    },
  },
  heracles: {
    // The Nemean lion's pelt as a hood, and a knotted club.
    back: ({ g, y }) => {
      for (let tuft = 0; tuft < 11; tuft += 1) {
        const angle = Math.PI * 1.05 + (tuft / 10) * Math.PI * 0.9;
        ring(g, Math.cos(angle) * 15, y - 26 + Math.sin(angle) * 17, 5).fill(
          tuft % 2 ? 0xc98a2c : 0xb07424,
        );
      }
    },
    head: ({ g, y }) => {
      g.roundRect(-12, y - 42, 24, 7, 3.5).fill(0xd69a3a);
      ring(g, -9, y - 42, 2.6).fill(0xd69a3a);
      ring(g, 9, y - 42, 2.6).fill(0xd69a3a);
      ring(g, -9, y - 42, 1.2).fill(0x8a5a1c);
      ring(g, 9, y - 42, 1.2).fill(0x8a5a1c);
    },
    held: ({ g, hand }) => {
      g.poly([
        hand.x - 1.5,
        hand.y + 6,
        hand.x + 1.5,
        hand.y + 6,
        hand.x + 4.5,
        hand.y - 18,
        hand.x - 2.5,
        hand.y - 18,
      ]).fill(WOOD);
      ring(g, hand.x + 2.5, hand.y - 12, 1.3).fill(0x6b4226);
      ring(g, hand.x, hand.y - 4, 1.1).fill(0x6b4226);
    },
  },
  odysseus: {
    // A sailor's felt cap, and an oar from the long way home.
    head: ({ g, y }) => {
      g.poly([-10, y - 37, 10, y - 37, 5, y - 49, -5, y - 49]).fill(0x8b5a2b);
      g.roundRect(-12, y - 39, 24, 3.5, 1.5).fill(0x6b4226);
    },
    held: ({ g, hand }) => {
      staff(g, hand.x, hand.y - 22, hand.y + 14, 0xb07a3a, 2);
      g.ellipse(hand.x, hand.y + 17, 3, 7).fill(0xb07a3a);
    },
  },
  minotaur: {
    // Bull horns and a nose ring: the labyrinth's own.
    head: ({ g, y }) => {
      for (const side of [-1, 1] as const) {
        g.moveTo(side * 11, y - 33)
          .bezierCurveTo(
            side * 20,
            y - 34,
            side * 23,
            y - 40,
            side * 20,
            y - 48,
          )
          .bezierCurveTo(
            side * 19,
            y - 42,
            side * 16,
            y - 38,
            side * 11,
            y - 38,
          )
          .fill(IVORY);
        g.poly([
          side * 20,
          y - 48,
          side * 21.5,
          y - 44,
          side * 19,
          y - 44,
        ]).fill(0x5a4a3a);
      }
    },
    front: ({ g, y }) => {
      g.moveTo(-2.8, y - 18)
        .bezierCurveTo(-2.8, y - 13, 2.8, y - 13, 2.8, y - 18)
        .stroke({ width: 1.3, color: GOLD });
    },
  },
  ariadne: {
    // The ball of red thread. The bot unwinds it wherever it flies.
    head: ({ g, y }) => {
      g.poly([-10, y - 37, -6, y - 40, 0, y - 41, 6, y - 40, 10, y - 37]).fill(
        0x7a3b8f,
      );
      ring(g, 8, y - 39, 2).fill(0xe0506a);
    },
    held: ({ g, hand }) => {
      ring(g, hand.x, hand.y - 2, 4.5).fill(0xd6334a);
      g.moveTo(hand.x - 3.5, hand.y - 4)
        .bezierCurveTo(
          hand.x - 1,
          hand.y - 6,
          hand.x + 2,
          hand.y - 2,
          hand.x + 3.5,
          hand.y - 3,
        )
        .moveTo(hand.x - 3.5, hand.y)
        .bezierCurveTo(
          hand.x - 1,
          hand.y - 2,
          hand.x + 2,
          hand.y + 2,
          hand.x + 3.5,
          hand.y + 1,
        )
        .stroke({ width: 0.7, color: 0xff8a9a });
    },
  },
  prometheus: {
    // The stolen fire, on a torch.
    held: ({ g, t, hand }) => {
      g.moveTo(hand.x, hand.y + 6)
        .lineTo(hand.x + 1, hand.y - 12)
        .stroke({ width: 2.4, color: WOOD, cap: "round" });
      g.roundRect(hand.x - 2, hand.y - 14, 6, 3, 1).fill(IRON);
      for (let tongue = 0; tongue < 3; tongue += 1) {
        const height = 8 + Math.sin(t * 11 + tongue * 2) * 2.5 - tongue * 2;
        const color = [0xff6a2a, 0xffb347, 0xfff2b0][tongue]!;
        const width = 4 - tongue;
        g.poly([
          hand.x + 1 - width,
          hand.y - 14,
          hand.x + 1 + width,
          hand.y - 14,
          hand.x + 1 + Math.sin(t * 8 + tongue) * 1.2,
          hand.y - 14 - height,
        ]).fill(color);
      }
    },
  },
};

/** Personas whose bot leaves a trail behind it as it flies. */
export const TRAILS: Partial<Record<PersonaId, number>> = {
  ariadne: 0xd6334a,
};
