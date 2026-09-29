import { Graphics } from "pixi.js";
import type { WorldActor } from "../world-model";
import type { ActorFrame, WorldCharacter, WorldLook } from "../world-theme";
import { blinking, FigureBase, HAIR, INK, providerColors, SKIN } from "./parts";

/**
 * Big-headed people. The hoodie is the provider's colour, the hair and skin
 * are the agent's own, and whatever it is doing is in its hands: a book, a
 * laptop, a parcel, a magnifying glass, a clipboard.
 */

const HEAD_Y = -34;
const HEAD_R = 12;
const PANTS = 0x39405a;
const SHOES = 0x23263a;
const WHITE = 0xffffff;

class Chibi extends FigureBase {
  private readonly g = new Graphics();
  private readonly colors: { main: number; dark: number };
  private readonly skin: number;
  private readonly hair: number;
  private readonly hairStyle: number;

  constructor(actor: WorldActor, look: WorldLook) {
    super(actor, look, HEAD_Y - HEAD_R - 4);
    this.colors = providerColors(actor.provider);
    this.skin = SKIN[this.hashed % SKIN.length]!;
    this.hair = HAIR[(this.hashed >> 3) % HAIR.length]!;
    this.hairStyle = (this.hashed >> 6) % 5;
    this.body.addChild(this.g);
  }

  protected pose(t: number, { walking }: ActorFrame) {
    const { mood, place } = this.actor;
    const g = this.g.clear();
    const ghost = mood === "lost";
    const sitting = mood === "idle" && !walking;
    let lift = 0;
    let shake = 0;
    if (walking) lift = Math.abs(Math.sin(t * 12)) * 2.5;
    else if (mood === "attention") lift = Math.max(0, Math.sin(t * 7)) * 5;
    else if (mood === "done" && t % 2.6 < 0.5)
      lift = Math.sin(((t % 2.6) / 0.5) * Math.PI) * 7;
    else if (mood === "working") lift = Math.sin(t * 5) * 0.6;
    if (mood === "error") shake = Math.sin(t * 45) * 0.8;
    const y = -lift + (sitting ? 4 : 0);

    // Shadow stays on the floor while the body hops.
    g.ellipse(0, 0, 11 - lift * 0.4, 3).fill({ color: 0x000000, alpha: 0.22 });

    g.position.x = shake;
    const stride = walking ? Math.sin(t * 12) * 3 : 0;
    if (ghost) {
      // A ghost has a wavy hem instead of legs.
      const wave = Math.sin(t * 4) * 1.5;
      g.poly([
        -8,
        y - 20,
        8,
        y - 20,
        9,
        y - 4,
        5,
        y - 6 + wave,
        1,
        y - 3,
        -3,
        y - 6 - wave,
        -8,
        y - 4,
      ]).fill(this.colors.main);
    } else if (sitting) {
      g.roundRect(-7, y - 9, 6, 5, 2).fill(PANTS);
      g.roundRect(1, y - 9, 6, 5, 2).fill(PANTS);
      g.roundRect(-8, y - 5, 5, 3, 1.5).fill(SHOES);
      g.roundRect(2, y - 5, 5, 3, 1.5).fill(SHOES);
    } else {
      g.roundRect(-5.5 - stride * 0.4, y - 10, 5, 9, 2).fill(PANTS);
      g.roundRect(0.5 + stride * 0.4, y - 10, 5, 9, 2).fill(PANTS);
      g.roundRect(-7 - stride, y - 2.5, 7, 3.5, 1.7).fill(SHOES);
      g.roundRect(0.5 + stride, y - 2.5, 7, 3.5, 1.7).fill(SHOES);
    }

    // Hoodie, with a pocket and the drawstrings.
    if (!ghost) {
      g.roundRect(-9, y - 24, 18, 16, 7).fill(this.colors.main);
      g.roundRect(-5, y - 15, 10, 5, 2).fill(this.colors.dark);
      g.moveTo(-2, y - 22)
        .lineTo(-2.4, y - 18)
        .stroke({ width: 1, color: WHITE, alpha: 0.8 });
      g.moveTo(2, y - 22)
        .lineTo(2.4, y - 18)
        .stroke({ width: 1, color: WHITE, alpha: 0.8 });
    }

    this.arms(g, t, y, walking);
    this.head(g, t, y);
    if (!walking && mood === "working") this.prop(g, t, y, place);
    if (mood === "idle" && !walking) this.mug(g, t, y);
  }

  private arm(g: Graphics, fromX: number, fromY: number, angle: number) {
    const x = fromX + Math.cos(angle) * 7;
    const y = fromY + Math.sin(angle) * 7;
    g.moveTo(fromX, fromY)
      .lineTo(x, y)
      .stroke({ width: 4.5, color: this.colors.main, cap: "round" });
    g.circle(x, y, 2.4).fill(this.skin);
  }

  private arms(g: Graphics, t: number, y: number, walking: boolean) {
    const { mood, place } = this.actor;
    const shoulder = y - 20;
    const down = Math.PI / 2;
    if (mood === "lost") return;
    if (mood === "attention") {
      // Both arms up, waving: the thing to spot from across the room.
      const wave = Math.sin(t * 9) * 0.35;
      this.arm(g, -7, shoulder, -Math.PI / 2 - 0.5 + wave);
      this.arm(g, 7, shoulder, -Math.PI / 2 + 0.5 - wave);
      return;
    }
    if (mood === "done" && t % 2.6 < 0.5) {
      this.arm(g, -7, shoulder, -Math.PI / 2 - 0.6);
      this.arm(g, 7, shoulder, -Math.PI / 2 + 0.6);
      return;
    }
    if (walking) {
      const swing = Math.sin(t * 12) * 0.5;
      this.arm(g, -7, shoulder, down + swing);
      this.arm(g, 7, shoulder, down - swing);
      return;
    }
    if (mood === "working") {
      if (place === "think") {
        // Hand on chin.
        this.arm(g, -7, shoulder, down + 0.2);
        this.arm(g, 7, shoulder, -0.9);
        return;
      }
      if (place === "delegate") {
        // Pointing someone at the work.
        this.arm(g, -7, shoulder, down + 0.2);
        this.arm(g, 7, shoulder, -0.25 + Math.sin(t * 3) * 0.15);
        return;
      }
      // Holding the prop out in front.
      this.arm(g, -7, shoulder, 0.5);
      this.arm(g, 7, shoulder, 0.35);
      return;
    }
    if (mood === "idle") {
      this.arm(g, -7, shoulder, down + 0.1);
      this.arm(g, 7, shoulder, 0.6);
      return;
    }
    this.arm(g, -7, shoulder, down + 0.15);
    this.arm(g, 7, shoulder, down - 0.15);
  }

  private head(g: Graphics, t: number, y: number) {
    const { mood } = this.actor;
    const cy = y + HEAD_Y;
    const tilt =
      mood === "attention" && this.actor.label !== "needs permission";
    const hx = tilt ? 1.5 : 0;
    g.circle(hx, cy, HEAD_R).fill(this.skin);
    this.hairOn(g, hx, cy);

    // Eyes sit a little to the right: the figure faces the way it walks.
    const eyes = [hx - 3, hx + 5];
    const ey = cy + 1.5;
    const blink = blinking(t, this.seed);
    for (const ex of eyes) {
      if (mood === "done") {
        g.moveTo(ex - 2.2, ey + 0.8)
          .lineTo(ex, ey - 1.6)
          .lineTo(ex + 2.2, ey + 0.8)
          .stroke({ width: 1.4, color: INK, cap: "round", join: "round" });
      } else if (mood === "error") {
        g.moveTo(ex - 2, ey - 2)
          .lineTo(ex + 2, ey + 2)
          .moveTo(ex + 2, ey - 2)
          .lineTo(ex - 2, ey + 2)
          .stroke({ width: 1.4, color: INK, cap: "round" });
      } else if (mood === "idle" || blink) {
        g.moveTo(ex - 2.2, ey)
          .lineTo(ex + 2.2, ey)
          .stroke({ width: 1.4, color: INK, cap: "round" });
      } else if (mood === "lost") {
        g.circle(ex, ey, 2.2).stroke({ width: 1.2, color: INK });
      } else {
        const wide = mood === "attention" ? 1.25 : 1;
        g.ellipse(ex, ey, 2.6 * wide, 3.2 * wide).fill(WHITE);
        const look =
          mood === "working" && this.actor.place === "think" ? -1.4 : 0;
        g.circle(ex + 0.6, ey + 0.3 + look, 1.7).fill(INK);
        g.circle(ex + 1.1, ey - 0.5 + look, 0.6).fill(WHITE);
      }
    }
    g.ellipse(hx - 7, ey + 4, 2.2, 1.3).fill({ color: 0xff7a8a, alpha: 0.4 });
    g.ellipse(hx + 9, ey + 4, 2, 1.2).fill({ color: 0xff7a8a, alpha: 0.4 });

    const mx = hx + 1.5;
    const my = cy + 7;
    if (mood === "attention") g.ellipse(mx, my, 1.6, 2).fill(INK);
    else if (mood === "error")
      g.moveTo(mx - 3, my)
        .lineTo(mx - 1.5, my - 1)
        .lineTo(mx, my)
        .lineTo(mx + 1.5, my - 1)
        .lineTo(mx + 3, my)
        .stroke({ width: 1.1, color: INK, cap: "round" });
    else if (mood === "done")
      // `arc` joins from the pen's position, which starts at the feet, so
      // every arc here begins with a `moveTo` its own start point.
      g.moveTo(
        mx + 3 * Math.cos(0.1 * Math.PI),
        my - 1 + 3 * Math.sin(0.1 * Math.PI),
      )
        .arc(mx, my - 1, 3, 0.1 * Math.PI, 0.9 * Math.PI)
        .fill(INK);
    else if (mood === "idle")
      g.moveTo(mx - 1.5, my)
        .lineTo(mx + 1.5, my)
        .stroke({ width: 1, color: INK });
    else
      g.moveTo(
        mx + 2.4 * Math.cos(0.2 * Math.PI),
        my - 1.4 + 2.4 * Math.sin(0.2 * Math.PI),
      )
        .arc(mx, my - 1.4, 2.4, 0.2 * Math.PI, 0.8 * Math.PI)
        .stroke({
          width: 1.2,
          color: INK,
          cap: "round",
        });
  }

  private hairOn(g: Graphics, hx: number, cy: number) {
    const hair = this.hair;
    switch (this.hairStyle) {
      case 0: // Bob.
        g.ellipse(hx, cy - 6, 12.8, 7.5).fill(hair);
        g.roundRect(hx - 13, cy - 7, 5, 12, 2.5).fill(hair);
        g.roundRect(hx + 8.5, cy - 7, 4, 8, 2).fill(hair);
        return;
      case 1: // Spiky.
        g.ellipse(hx, cy - 6, 12.5, 6.5).fill(hair);
        g.poly([
          hx - 12,
          cy - 5,
          hx - 10,
          cy - 16,
          hx - 5,
          cy - 10,
          hx - 2,
          cy - 18,
          hx + 2,
          cy - 11,
          hx + 6,
          cy - 17,
          hx + 8,
          cy - 9,
          hx + 12,
          cy - 13,
          hx + 12,
          cy - 5,
        ]).fill(hair);
        return;
      case 2: // Bun.
        g.ellipse(hx, cy - 6, 12.6, 7).fill(hair);
        g.circle(hx - 2, cy - 15, 5).fill(hair);
        return;
      case 3: // Cap in the provider's colour, brim forward.
        g.ellipse(hx, cy - 6, 12.8, 7.5).fill(this.colors.dark);
        g.ellipse(hx + 9, cy - 3, 8, 2.6).fill(this.colors.dark);
        g.circle(hx, cy - 13, 1.6).fill(this.colors.main);
        return;
      default: // Curly.
        for (let curl = 0; curl < 7; curl += 1) {
          const angle = Math.PI + (curl / 6) * Math.PI;
          g.circle(
            hx + Math.cos(angle) * 10,
            cy - 2 + Math.sin(angle) * 9,
            4.6,
          ).fill(hair);
        }
        return;
    }
  }

  private prop(g: Graphics, t: number, y: number, place: WorldActor["place"]) {
    const px = 10;
    const py = y - 15;
    switch (place) {
      case "read":
        g.poly([px - 7, py - 4, px, py - 2, px, py + 5, px - 7, py + 3]).fill(
          0x4f81bd,
        );
        g.poly([px + 7, py - 4, px, py - 2, px, py + 5, px + 7, py + 3]).fill(
          0x3a6aa3,
        );
        g.poly([
          px - 5.5,
          py - 3.2,
          px - 0.8,
          py - 1.8,
          px - 0.8,
          py + 3.6,
          px - 5.5,
          py + 2.2,
        ]).fill(WHITE);
        g.poly([
          px + 5.5,
          py - 3.2,
          px + 0.8,
          py - 1.8,
          px + 0.8,
          py + 3.6,
          px + 5.5,
          py + 2.2,
        ]).fill(0xf1f3f8);
        return;
      case "edit": {
        // Laptop, screen flickering as it types.
        g.roundRect(px - 7, py - 9, 14, 10, 1.5).fill(0x9aa3b5);
        g.rect(px - 5.5, py - 7.5, 11, 7).fill(0x7fb4ff);
        for (let line = 0; line < 3; line += 1)
          g.rect(
            px - 4.5,
            py - 6.5 + line * 2,
            3 + ((t * 6 + line * 2) % 6),
            0.9,
          ).fill(WHITE);
        g.roundRect(px - 9, py + 1, 18, 2.5, 1).fill(0xc5ccd8);
        return;
      }
      case "run":
        g.roundRect(px - 6, py - 7, 12, 10, 1.5).fill(0x1d2233);
        g.moveTo(px - 4, py - 4)
          .lineTo(px - 2, py - 2.5)
          .lineTo(px - 4, py - 1)
          .stroke({ width: 1, color: 0x3fdc8b });
        if (t % 1 < 0.5) g.rect(px - 1, py - 1.6, 3, 1).fill(0x3fdc8b);
        return;
      case "ship":
        g.poly([
          px,
          py - 8,
          px + 7,
          py - 4.5,
          px,
          py - 1,
          px - 7,
          py - 4.5,
        ]).fill(0xe0b070);
        g.poly([
          px - 7,
          py - 4.5,
          px,
          py - 1,
          px,
          py + 6,
          px - 7,
          py + 2.5,
        ]).fill(0xc8914d);
        g.poly([
          px + 7,
          py - 4.5,
          px,
          py - 1,
          px,
          py + 6,
          px + 7,
          py + 2.5,
        ]).fill(0xb07a3a);
        return;
      case "web": {
        // A magnifying glass, sweeping.
        const sweep = Math.sin(t * 2) * 2;
        g.moveTo(px - 2, py + 3)
          .lineTo(px + 2 + sweep, py - 3)
          .stroke({ width: 2, color: 0x6b4c35, cap: "round" });
        g.circle(px + 4.5 + sweep, py - 6.5, 4.5).fill({
          color: 0xbfe3ff,
          alpha: 0.7,
        });
        g.circle(px + 4.5 + sweep, py - 6.5, 4.5).stroke({
          width: 1.4,
          color: 0x9aa3b5,
        });
        return;
      }
      case "plan":
        g.roundRect(px - 5, py - 8, 10, 12, 1.5).fill(0xb07a3a);
        g.rect(px - 3.8, py - 6.5, 7.6, 9.5).fill(WHITE);
        for (let line = 0; line < 3; line += 1)
          g.rect(px - 2.8, py - 5 + line * 2.8, line === 2 ? 3 : 5.5, 0.9).fill(
            0x9aa3b5,
          );
        return;
      default:
        return;
    }
  }

  private mug(g: Graphics, t: number, y: number) {
    const mx = 13;
    const my = y - 15;
    g.roundRect(mx - 3, my - 3, 6, 7, 1.5).fill(WHITE);
    g.circle(mx + 3.5, my + 0.5, 1.8).stroke({ width: 1, color: WHITE });
    for (let wisp = 0; wisp < 2; wisp += 1) {
      const rise = (t * 0.7 + wisp * 0.5) % 1;
      g.circle(mx - 1 + wisp * 2, my - 5 - rise * 8, 1.2 + rise).fill({
        color: WHITE,
        alpha: 0.5 * (1 - rise),
      });
    }
  }
}

export const chibiCharacter: WorldCharacter = {
  id: "chibi",
  label: "Chibi",
  description:
    "Big-headed people in the provider's hoodie, holding the tool they are using.",
  create: (actor, look) => new Chibi(actor, look),
};
