import { Graphics } from "pixi.js";
import type { WorldActor } from "../world-model";
import type { ActorFrame, WorldCharacter, WorldLook } from "../world-theme";
import { blinking, FigureBase, INK, providerColors } from "./parts";

/**
 * Jelly blobs. They squash and stretch, hop when they travel, melt into a
 * puddle when idle and stand up tall when they need you. The hat says what
 * they are doing: reading glasses, headphones, a hard hat, a courier cap.
 */

const WHITE = 0xffffff;

class Critter extends FigureBase {
  private readonly g = new Graphics();
  private readonly colors: { main: number; dark: number };

  constructor(actor: WorldActor, look: WorldLook) {
    super(actor, look, -34);
    this.colors = providerColors(actor.provider);
    this.body.addChild(this.g);
  }

  protected pose(t: number, { walking }: ActorFrame) {
    const { mood } = this.actor;
    const g = this.g.clear();
    let lift = 0;
    let sx = 1;
    let sy = 1;
    if (walking) {
      // Hop: stretch in the air, squash on landing.
      const phase = (t * 2.6) % 1;
      lift = Math.sin(phase * Math.PI) * 9;
      const landing = phase < 0.15 || phase > 0.9 ? 1 : 0;
      sx = landing ? 1.2 : 0.92;
      sy = landing ? 0.82 : 1.1;
    } else if (mood === "attention") {
      const bounce = Math.abs(Math.sin(t * 6));
      lift = bounce * 6;
      sx = 0.85 - bounce * 0.05;
      sy = 1.3 + bounce * 0.08;
    } else if (mood === "idle") {
      sx = 1.4 + Math.sin(t * 1.2) * 0.03;
      sy = 0.6 - Math.sin(t * 1.2) * 0.03;
    } else if (mood === "done") {
      const phase = t % 2.2;
      if (phase < 0.5) lift = Math.sin((phase / 0.5) * Math.PI) * 8;
      sx = 1 + Math.sin(t * 4) * 0.04;
      sy = 1 - Math.sin(t * 4) * 0.04;
    } else if (mood === "error") {
      sx = 1.05 + Math.sin(t * 40) * 0.05;
      sy = 0.95;
    } else {
      sx = 1 + Math.sin(t * 5) * 0.05;
      sy = 1 - Math.sin(t * 5) * 0.05;
    }

    g.ellipse(0, 0, 14 * sx - lift * 0.3, 3.5).fill({
      color: 0x000000,
      alpha: 0.22,
    });
    const w = 14 * sx;
    const h = 26 * sy;
    const base = -lift;
    const color = mood === "error" ? this.colors.dark : this.colors.main;

    // The body: a dome over a softly rounded base.
    if (mood === "lost") {
      const wave = Math.sin(t * 4) * 2;
      g.moveTo(-w, base - 4)
        .bezierCurveTo(-w, base - h * 1.25, w, base - h * 1.25, w, base - 4)
        .lineTo(w * 0.6, base + wave)
        .lineTo(w * 0.2, base - 4)
        .lineTo(-w * 0.2, base - wave)
        .lineTo(-w * 0.6, base - 4)
        .closePath()
        .fill(color);
    } else {
      g.moveTo(-w, base - 2)
        .bezierCurveTo(-w, base - h * 1.3, w, base - h * 1.3, w, base - 2)
        .quadraticCurveTo(w, base + 1, w - 4, base + 1)
        .lineTo(-w + 4, base + 1)
        .quadraticCurveTo(-w, base + 1, -w, base - 2)
        .fill(color);
    }
    // Shine.
    g.ellipse(-w * 0.45, base - h * 0.72, w * 0.22, h * 0.14).fill({
      color: WHITE,
      alpha: 0.45,
    });

    const top = base - h * 0.97;
    const eyeY = base - h * 0.55;
    this.eyes(g, t, eyeY, w);
    this.hat(g, t, top, w);
    if (mood === "attention") {
      // A tiny arm, waving from the side.
      const wave = Math.sin(t * 10) * 0.5;
      const ax = w - 2;
      const ay = base - h * 0.45;
      g.moveTo(ax, ay)
        .lineTo(ax + 7 * Math.cos(-1 + wave), ay + 7 * Math.sin(-1 + wave))
        .stroke({ width: 4, color, cap: "round" });
    }
    if (mood === "error") this.steam(g, t, top);
  }

  private eyes(g: Graphics, t: number, y: number, w: number) {
    const { mood } = this.actor;
    const xs = [-w * 0.3 + 2, w * 0.3 + 2];
    for (const x of xs) {
      if (mood === "idle" || (blinking(t, this.seed) && mood !== "attention")) {
        g.moveTo(x - 2.5, y)
          .quadraticCurveTo(x, y + 2, x + 2.5, y)
          .stroke({ width: 1.4, color: INK, cap: "round" });
      } else if (mood === "done") {
        g.moveTo(x - 2.5, y + 1)
          .quadraticCurveTo(x, y - 3, x + 2.5, y + 1)
          .stroke({ width: 1.6, color: INK, cap: "round" });
      } else if (mood === "error") {
        g.moveTo(x - 2, y - 2)
          .lineTo(x + 2, y + 2)
          .moveTo(x + 2, y - 2)
          .lineTo(x - 2, y + 2)
          .stroke({ width: 1.5, color: INK, cap: "round" });
      } else {
        const size = mood === "attention" ? 4.4 : 3.6;
        g.ellipse(x, y, size * 0.85, size).fill(WHITE);
        g.circle(x + 1, y + 0.5, size * 0.5).fill(INK);
        g.circle(x + 1.6, y - 0.6, size * 0.2).fill(WHITE);
      }
    }
    // Mouth.
    const mx = 2;
    const my = y + 5.5;
    if (mood === "attention") g.ellipse(mx, my, 2, 2.4).fill(INK);
    else if (mood !== "idle" && mood !== "lost")
      g.moveTo(mx - 2.5, my - 0.5)
        .quadraticCurveTo(
          mx,
          my + (mood === "error" ? -2 : 2),
          mx + 2.5,
          my - 0.5,
        )
        .stroke({ width: 1.2, color: INK, cap: "round" });
  }

  private hat(g: Graphics, t: number, top: number, w: number) {
    const { mood, place } = this.actor;
    if (mood !== "working" && !(mood === "attention" && place !== "think"))
      return;
    switch (place) {
      case "read": {
        // Round reading glasses over the eyes.
        const y = top + 11;
        for (const x of [-w * 0.3 + 2, w * 0.3 + 2])
          g.circle(x, y, 4.2).stroke({ width: 1.2, color: 0x3a2a20 });
        g.moveTo(-w * 0.3 + 6.2, y)
          .lineTo(w * 0.3 - 2.2, y)
          .stroke({ width: 1.2, color: 0x3a2a20 });
        return;
      }
      case "edit":
        // Headphones.
        g.moveTo(-w + 2, top + 10)
          .bezierCurveTo(-w + 2, top - 6, w - 2, top - 6, w - 2, top + 10)
          .stroke({ width: 2.2, color: 0x2a2f3f });
        g.roundRect(-w - 1, top + 6, 5, 9, 2).fill(0x2a2f3f);
        g.roundRect(w - 4, top + 6, 5, 9, 2).fill(0x2a2f3f);
        return;
      case "run":
        // Hard hat.
        g.moveTo(-10, top + 3)
          .bezierCurveTo(-10, top - 9, 10, top - 9, 10, top + 3)
          .fill(0xffc53d);
        g.roundRect(-13, top + 1.5, 26, 3.5, 1.5).fill(0xe0a82e);
        g.rect(-1.5, top - 6, 3, 8).fill(0xe0a82e);
        return;
      case "ship":
        // Courier cap and a parcel balanced on top.
        g.moveTo(-9, top + 3)
          .bezierCurveTo(-9, top - 5, 9, top - 5, 9, top + 3)
          .fill(0x6b4c35);
        g.roundRect(3, top + 1, 12, 3, 1.5).fill(0x4a3424);
        g.roundRect(-6, top - 13, 12, 9, 1.5).fill(0xc8914d);
        g.rect(-1, top - 13, 2, 9).fill(0xe8d3a8);
        return;
      case "web":
        // Explorer hat.
        g.ellipse(0, top + 1, 14, 3.5).fill(0xc9a26b);
        g.moveTo(-8, top + 1)
          .bezierCurveTo(-8, top - 9, 8, top - 9, 8, top + 1)
          .fill(0xd9b27b);
        g.rect(-8, top - 2, 16, 2).fill(0x6b4c35);
        return;
      case "delegate": {
        // A party hat: it is making friends.
        g.poly([-6, top + 2, 6, top + 2, 0, top - 14]).fill(0x6c8cff);
        g.circle(0, top - 14, 2.4).fill(0xffd84d);
        g.circle(-2, top - 3, 1).fill(WHITE);
        g.circle(2, top - 7, 1).fill(WHITE);
        return;
      }
      case "plan":
        // Mortarboard.
        g.poly([-12, top - 2, 0, top - 7, 12, top - 2, 0, top + 3]).fill(
          0x2a2f3f,
        );
        g.roundRect(-6, top - 1, 12, 5, 1.5).fill(0x2a2f3f);
        g.moveTo(10, top - 2)
          .lineTo(11, top + 6 + Math.sin(t * 3))
          .stroke({ width: 1, color: 0xffd84d });
        return;
      default:
        return;
    }
  }

  private steam(g: Graphics, t: number, top: number) {
    for (let puff = 0; puff < 3; puff += 1) {
      const rise = (t * 0.7 + puff / 3) % 1;
      g.circle(-6 + puff * 6, top - 4 - rise * 16, 2.5 + rise * 3).fill({
        color: 0x9aa0aa,
        alpha: 0.5 * (1 - rise),
      });
    }
  }
}

export const crittersCharacter: WorldCharacter = {
  id: "critters",
  label: "Critters",
  description:
    "Jelly blobs that hop, melt when idle, and wear a hat for the tool they are using.",
  create: (actor, look) => new Critter(actor, look),
};
