import { Graphics } from "pixi.js";
import type { WorldActor } from "../world-model";
import type { ActorFrame, WorldCharacter, WorldLook } from "../world-theme";
import { COSTUMES, type Costume, type CostumeFrame } from "./costumes";
import { ATTENTION, blinking, DONE, ERROR, FigureBase } from "./parts";
import { personaFor, type Persona } from "./personas";
import { SESSION_COLOR_HEX } from "../session-color";

/**
 * Little hovering robots. The screen is the face, the antenna light is the
 * state, and the thruster cuts out when the bot is idle and lands. Claude's
 * are cream with coral trim, Codex's are graphite with a green glow. A
 * session given a color wears it as its trim, the band and arms, so it is
 * the same color as its card's edge; the shell keeps the provider's. Each
 * one is dressed as a figure from Greek myth (see `personas.ts`), and the
 * costume never covers the face or the light.
 */

interface Finish {
  shell: number;
  trim: number;
  screen: number;
  glow: number;
}

const FINISHES: Record<string, Finish> = {
  claude: { shell: 0xf1e8dc, trim: 0xe07a5f, screen: 0x2a1f1c, glow: 0xffb38a },
  codex: { shell: 0x3a404c, trim: 0x2fbf8f, screen: 0x0d1512, glow: 0x5cf2b0 },
};
const OTHER: Finish = {
  shell: 0xdde3f0,
  trim: 0x6c8cff,
  screen: 0x141a2e,
  glow: 0x9fb5ff,
};

const TOP = -56;

class Bot extends FigureBase {
  private readonly g = new Graphics();
  private readonly base: Finish;
  readonly persona: Persona;
  private readonly costume: Costume;

  constructor(actor: WorldActor, look: WorldLook, persona?: Persona) {
    super(actor, look, TOP);
    this.base = FINISHES[actor.provider] ?? OTHER;
    this.persona = persona ?? personaFor(actor.sessionId);
    this.costume = COSTUMES[this.persona.id];
    this.body.addChild(this.g);
  }

  /** Read every frame, so a color picked on the card shows at once. */
  private get finish(): Finish {
    const color = this.actor.color;
    return color ? { ...this.base, trim: SESSION_COLOR_HEX[color] } : this.base;
  }

  protected pose(t: number, { walking }: ActorFrame) {
    const { mood } = this.actor;
    const f = this.finish;
    const g = this.g.clear();
    const landed = (mood === "idle" || mood === "lost") && !walking;
    const hover = landed
      ? 0
      : mood === "attention"
        ? 8 + Math.abs(Math.sin(t * 6)) * 5
        : 7 + Math.sin(t * 3) * 1.8;
    const y = -hover;
    const shake = mood === "error" ? Math.sin(t * 50) * 0.9 : 0;
    g.position.x = shake;
    g.rotation = walking ? 0.12 : mood === "error" ? Math.sin(t * 3) * 0.05 : 0;

    g.ellipse(0, 0, 12 - hover * 0.35, 3).fill({
      color: 0x000000,
      alpha: 0.25 - hover * 0.008,
    });
    if (!landed) {
      // Thruster flame, longer while travelling.
      const length = (walking ? 10 : 6) + Math.sin(t * 30) * 1.5;
      g.poly([-4, y - 6, 4, y - 6, 0, y - 6 + length]).fill({
        color: 0xffb347,
        alpha: 0.9,
      });
      g.poly([-2, y - 6, 2, y - 6, 0, y - 6 + length * 0.6]).fill(0xfff2b0);
    }
    const busy = mood === "working" ? Math.sin(t * 8) * 1.5 : 0;
    const wave = Math.sin(t * 10) * 3;
    const costume: CostumeFrame = {
      g,
      t,
      y,
      mood,
      walking,
      landed,
      hand:
        mood === "attention"
          ? { x: 15, y: y - 41 + wave }
          : { x: 16, y: y - 20 - busy },
    };
    this.costume.back?.(costume);
    // Thruster, body, side arms.
    g.roundRect(-7, y - 10, 14, 5, 2).fill(0x5a6275);
    g.roundRect(-13, y - 38, 26, 28, 9).fill(f.shell);
    g.roundRect(-13, y - 16, 26, 6, 3).fill(f.trim);
    this.costume.front?.(costume);
    this.arms(g, t, y);
    this.costume.held?.(costume);

    // Screen face.
    g.roundRect(-10, y - 35, 20, 16, 5).fill(f.screen);
    this.face(g, t, y);
    g.roundRect(-9, y - 34, 7, 3, 1.5).fill({ color: 0xffffff, alpha: 0.12 });
    this.costume.head?.(costume);

    // Antenna and its light.
    g.moveTo(0, y - 38)
      .lineTo(0, y - 45)
      .stroke({ width: 1.6, color: 0x8a92a6 });
    const light =
      mood === "attention"
        ? ATTENTION
        : mood === "done"
          ? DONE
          : mood === "error"
            ? ERROR
            : mood === "working"
              ? f.glow
              : 0x6b7280;
    const on = mood === "attention" ? t % 0.5 < 0.3 : mood !== "lost";
    if (on) g.circle(0, y - 46.5, 5).fill({ color: light, alpha: 0.25 });
    g.circle(0, y - 46.5, 2.6).fill(on ? light : 0x4b5160);

    this.costume.near?.(costume);
    if (mood === "error") this.sparks(g, t, y);
  }

  private arms(g: Graphics, t: number, y: number) {
    const { mood } = this.actor;
    const f = this.finish;
    const left = { x: -15, y: y - 26 };
    const right = { x: 15, y: y - 26 };
    if (mood === "attention") {
      const wave = Math.sin(t * 10) * 3;
      g.roundRect(right.x - 2.5, right.y - 14 + wave, 5, 12, 2.5).fill(f.trim);
      g.circle(right.x, right.y - 15 + wave, 3).fill(f.shell);
      g.roundRect(left.x - 2.5, left.y - 3, 5, 10, 2.5).fill(f.trim);
      return;
    }
    const busy = mood === "working" ? Math.sin(t * 8) * 1.5 : 0;
    g.roundRect(left.x - 2.5, left.y - 3 + busy, 5, 10, 2.5).fill(f.trim);
    g.roundRect(right.x - 2.5, right.y - 3 - busy, 5, 10, 2.5).fill(f.trim);
  }

  private face(g: Graphics, t: number, y: number) {
    const { mood } = this.actor;
    const glow = this.finish.glow;
    const cy = y - 27;
    const eye = (x: number, width: number, height: number, color = glow) =>
      g
        .roundRect(x - width / 2, cy - height / 2, width, height, width / 2)
        .fill(color);
    switch (mood) {
      case "working": {
        // Eyes scan side to side, like reading a line.
        const scan = Math.sin(t * 2.5) * 2;
        if (blinking(t, this.seed)) {
          eye(-4 + scan, 4, 1.2);
          eye(4 + scan, 4, 1.2);
        } else {
          eye(-4 + scan, 3.4, 5);
          eye(4 + scan, 3.4, 5);
        }
        return;
      }
      case "attention":
        if (this.actor.label === "needs permission") {
          g.roundRect(-1.4, cy - 6, 2.8, 8, 1.4).fill(ATTENTION);
          g.circle(0, cy + 4.5, 1.6).fill(ATTENTION);
        } else {
          eye(-4, 4.5, 6.5);
          eye(4, 4.5, 6.5);
          g.circle(-4, cy, 1).fill(this.finish.screen);
          g.circle(4, cy, 1).fill(this.finish.screen);
        }
        return;
      case "done":
        for (const x of [-4, 4])
          g.moveTo(x - 2.5, cy + 1)
            .lineTo(x, cy - 2)
            .lineTo(x + 2.5, cy + 1)
            .stroke({ width: 1.6, color: DONE, cap: "round", join: "round" });
        return;
      case "error":
        for (const x of [-4, 4])
          g.moveTo(x - 2.2, cy - 2.2)
            .lineTo(x + 2.2, cy + 2.2)
            .moveTo(x + 2.2, cy - 2.2)
            .lineTo(x - 2.2, cy + 2.2)
            .stroke({ width: 1.5, color: ERROR, cap: "round" });
        return;
      case "idle":
        // Powered down: two dim bars.
        eye(-4, 4, 1.2, 0x5a6275);
        eye(4, 4, 1.2, 0x5a6275);
        return;
      case "lost":
        // Static.
        for (let line = 0; line < 5; line += 1) {
          const width = 4 + (((this.hashed >> line) + Math.floor(t * 12)) % 10);
          g.rect(-8 + ((line * 3) % 6), cy - 6 + line * 2.8, width, 1).fill({
            color: 0xffffff,
            alpha: 0.35,
          });
        }
        return;
      default:
        eye(-4, 3.4, 5);
        eye(4, 3.4, 5);
    }
  }

  private sparks(g: Graphics, t: number, y: number) {
    for (let spark = 0; spark < 3; spark += 1) {
      const phase = (t * 1.6 + spark / 3) % 1;
      const x = -10 + spark * 10 + Math.sin(spark * 7) * 3;
      g.circle(x, y - 40 - phase * 10, 1.2 * (1 - phase) + 0.4).fill({
        color: 0xffd84d,
        alpha: 1 - phase,
      });
      g.circle(x + 4, y - 44 - phase * 14, 2.5 + phase * 3).fill({
        color: 0x8a8f99,
        alpha: 0.4 * (1 - phase),
      });
    }
  }
}

export const botsCharacter: WorldCharacter = {
  id: "bots",
  label: "Bots",
  description:
    "Hovering robots dressed as figures from Greek myth, with a screen for a face and an antenna light that shows their state.",
  create: (actor, look) => new Bot(actor, look),
  caption: (actor) => {
    const persona = personaFor(actor.sessionId);
    return `as ${persona.name}, ${persona.epithet}`;
  },
};

/** For the gallery: a bot in a chosen costume, whatever its session id. */
export const createBot = (
  actor: WorldActor,
  look: WorldLook,
  persona: Persona,
) => new Bot(actor, look, persona);
