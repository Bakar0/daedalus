import { Container, Graphics, Text } from "pixi.js";
import type { WorldActor, WorldStation } from "../world-model";
import type { ActorFigure, ActorFrame, WorldLook } from "../world-theme";
import { hash } from "./personas";

/**
 * What every character style shares: the name tag, the ring on the floor when
 * an agent is waiting on you, and the speech bubble that says what it is
 * doing. A style only draws the body, in `pose`, once per frame.
 */

export const ATTENTION = 0xff5f5f;
export const DONE = 0x3fbf88;
export const ERROR = 0xffa53d;
export const INK = 0x1b1d2a;

export const PROVIDER_COLORS: Record<string, { main: number; dark: number }> = {
  claude: { main: 0xe07a5f, dark: 0xa8513a },
  codex: { main: 0x2fbf8f, dark: 0x1d7f5f },
};
export const OTHER_PROVIDER = { main: 0x6c8cff, dark: 0x4058b8 };

export const providerColors = (provider: string) =>
  PROVIDER_COLORS[provider] ?? OTHER_PROVIDER;

export const SKIN = [0xf6d2b0, 0xe8b48a, 0xc68a5e, 0x94603c, 0x6b4428];
export const HAIR = [
  0x2b1d14, 0x6b4226, 0xd4a24c, 0x1a1a24, 0xa8452c, 0x9aa3b5,
];

/** Stable per session, so an agent keeps its looks across snapshots. */
export { hash };

export const text = (
  value: string,
  size: number,
  fill: number,
  weight: "400" | "600" | "800" = "600",
) =>
  new Text({
    text: value,
    // Sharp at the closest zoom, where a name tag is several times its size.
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

/** Blinks for a tenth of a second every few seconds, out of step per agent. */
export const blinking = (time: number, seed: number) =>
  (time + seed * 7) % (3.2 + seed * 2) < 0.12;

/**
 * How full an agent's context is, as the figure shows it: 0 below 30%,
 * then steady white steam (1), sweat and grey steam (2), and from 80% black
 * smoke pouring out of its head (3). Unknown context shows nothing.
 */
export function contextLevel(percent: number | null): 0 | 1 | 2 | 3 {
  if (percent === null) return 0;
  return percent >= 80 ? 3 : percent >= 50 ? 2 : percent >= 30 ? 1 : 0;
}

/**
 * Steam, sweat or smoke over a head at `top`, for a context `level`. Drawn
 * from the clock alone, so it needs no state and never piles up.
 */
function drawFumes(g: Graphics, level: number, t: number, top: number) {
  if (level === 0) return;
  const puffs = level === 3 ? 9 : level === 2 ? 4 : 2;
  const rate = level === 3 ? 0.6 : level === 2 ? 0.45 : 0.32;
  const height = level === 3 ? 80 : 46;
  for (let puff = 0; puff < puffs; puff += 1) {
    const phase = (t * rate + puff / puffs) % 1;
    const rise = phase;
    // Out of the top of the head, drifting and spreading as it rises.
    const x = Math.sin(t * 1.3 + puff * 2.1) * 5 * rise - 6 * rise;
    const y = top + 6 - rise * height;
    if (level === 3) {
      const radius = 6 + rise * 14;
      const alpha = Math.min(1, (1 - rise) * 1.4);
      // A light rim, so it reads on a dark wall as well as a pale one.
      g.circle(x, y, radius + 1.5).fill({
        color: 0x9a9aa6,
        alpha: alpha * 0.7,
      });
      g.circle(x, y, radius).fill({ color: 0x16161a, alpha });
      g.circle(x - radius * 0.3, y - radius * 0.3, radius * 0.45).fill({
        color: 0x3a3a44,
        alpha,
      });
      continue;
    }
    const radius = 5 + rise * (level === 2 ? 8 : 7);
    const alpha = Math.min(1, (1 - rise) * 1.3) * 0.85;
    // A faint grey edge, so white steam still reads on a pale wall.
    g.circle(x, y, radius + 1).fill({ color: 0x9aa0ad, alpha: alpha * 0.5 });
    g.circle(x, y, radius).fill({
      color: level === 2 ? 0xdfe3ea : 0xffffff,
      alpha,
    });
  }
  if (level === 3)
    // Embers spitting out of the head.
    for (let spark = 0; spark < 3; spark += 1) {
      const phase = (t * 1.4 + spark / 3) % 1;
      const side = spark % 2 ? 1 : -1;
      g.circle(
        side * phase * 14,
        top + 4 - phase * 22 + phase * phase * 16,
        1.8,
      ).fill({ color: 0xffa53d, alpha: 1 - phase });
    }
  if (level < 2) return;
  // Sweat flying off either side of the head.
  for (const side of [-1, 1]) {
    const phase = (t * 0.9 + (side === 1 ? 0.5 : 0)) % 1;
    const x = side * (10 + phase * 16);
    const y = top + 10 - phase * 10 + phase * phase * 30;
    const alpha = 1 - phase;
    g.moveTo(x, y - 6)
      .quadraticCurveTo(x + side * 4.5, y + 1.5, x, y + 3)
      .quadraticCurveTo(x - side * 4.5, y + 1.5, x, y - 6)
      .fill({ color: 0x6ec0ff, alpha });
    g.circle(x - side, y - 1, 1).fill({ color: 0xffffff, alpha });
  }
}

/** What the bubble over an agent's head shows. */
type Bubble =
  | { kind: "tool"; station: WorldStation }
  | { kind: "mark"; mark: string; color: number };

function bubbleFor(actor: WorldActor): Bubble | null {
  switch (actor.mood) {
    case "working":
      // Handing off, it is writing its note: the clipboard.
      return actor.place === "handoff"
        ? { kind: "tool", station: "plan" }
        : actor.place === "lounge" || actor.place === "door"
          ? { kind: "tool", station: "think" }
          : { kind: "tool", station: actor.place };
    case "attention":
      return {
        kind: "mark",
        mark: actor.label === "needs permission" ? "!" : "?",
        color: ATTENTION,
      };
    case "done":
      return { kind: "mark", mark: "✓", color: DONE };
    case "error":
      return { kind: "mark", mark: "!", color: ERROR };
    case "idle":
      return { kind: "mark", mark: "z", color: 0x8a97ad };
    case "lost":
      return { kind: "mark", mark: "?", color: 0x8a97ad };
    default:
      return null;
  }
}

/** Tool icons, about 14 pixels, centred on (0, 0). */
export function drawToolIcon(g: Graphics, station: WorldStation) {
  switch (station) {
    case "read":
      // An open book.
      g.poly([-7, -4, 0, -2, 0, 6, -7, 4]).fill(0x4f81bd);
      g.poly([7, -4, 0, -2, 0, 6, 7, 4]).fill(0x3a6aa3);
      g.poly([-5.5, -3.2, -0.8, -1.8, -0.8, 4.4, -5.5, 3]).fill(0xffffff);
      g.poly([5.5, -3.2, 0.8, -1.8, 0.8, 4.4, 5.5, 3]).fill(0xf1f3f8);
      for (let line = 0; line < 3; line += 1) {
        g.moveTo(-4.6, -1 + line * 1.8)
          .lineTo(-1.8, -0.2 + line * 1.8)
          .stroke({ width: 0.6, color: 0x9aa3b5 });
        g.moveTo(4.6, -1 + line * 1.8)
          .lineTo(1.8, -0.2 + line * 1.8)
          .stroke({ width: 0.6, color: 0x9aa3b5 });
      }
      return;
    case "edit":
      // A pencil, point down to the left.
      g.poly([-6, 6, -4, 1, 3, -6, 6, -3, -1, 4]).fill(0xffc53d);
      g.poly([3, -6, 4.6, -7.6, 7.6, -4.6, 6, -3]).fill(0xf08a9a);
      g.poly([-6, 6, -4, 1, -1, 4]).fill(0xf3d9b1);
      g.poly([-6, 6, -5.2, 3.9, -3.9, 5.2]).fill(INK);
      return;
    case "run":
      // A terminal window with a prompt.
      g.roundRect(-8, -6, 16, 12, 2).fill(0x1d2233);
      g.rect(-8, -6, 16, 3).fill(0x3a4460);
      g.circle(-6.2, -4.5, 0.7).fill(0xff5f57);
      g.circle(-4.2, -4.5, 0.7).fill(0xfebc2e);
      g.moveTo(-5.5, -1)
        .lineTo(-3, 1)
        .lineTo(-5.5, 3)
        .stroke({ width: 1.2, color: 0x3fdc8b, cap: "round", join: "round" });
      g.rect(-1.5, 2.2, 4, 1.2).fill(0x3fdc8b);
      return;
    case "ship":
      // A parcel with tape.
      g.poly([0, -7, 7, -3.5, 0, 0, -7, -3.5]).fill(0xe0b070);
      g.poly([-7, -3.5, 0, 0, 0, 7.5, -7, 4]).fill(0xc8914d);
      g.poly([7, -3.5, 0, 0, 0, 7.5, 7, 4]).fill(0xb07a3a);
      g.poly([-3.5, -5.2, 3.5, -1.7, 3.5, 1.2, -3.5, -2.3]).fill({
        color: 0xffffff,
        alpha: 0.35,
      });
      return;
    case "web":
      // A globe.
      g.circle(0, 0, 7).fill(0x4fa3f7);
      g.poly([-4, -5, 0, -6, 2, -3, -1, -1, -3, 1, -5, -1]).fill(0x5fcf7a);
      g.poly([2, 1, 5, 0, 6, 3, 3, 5, 1, 3]).fill(0x5fcf7a);
      g.ellipse(0, 0, 3, 7).stroke({ width: 0.6, color: 0xffffff, alpha: 0.6 });
      g.moveTo(-7, 0)
        .lineTo(7, 0)
        .stroke({ width: 0.6, color: 0xffffff, alpha: 0.6 });
      return;
    case "delegate":
      // Two people, one handing work to the other.
      g.circle(-3.5, -3, 2.6).fill(0xe07a5f);
      g.roundRect(-7, 0, 7, 6, 3).fill(0xe07a5f);
      g.circle(3.8, -1.5, 2.2).fill(0x6c8cff);
      g.roundRect(0.8, 1.5, 6, 5, 2.5).fill(0x6c8cff);
      return;
    case "plan":
      // A clipboard with ticks.
      g.roundRect(-6, -6, 12, 14, 2).fill(0xb07a3a);
      g.rect(-4.5, -4, 9, 10.5).fill(0xffffff);
      g.roundRect(-2.5, -7.5, 5, 3, 1).fill(0x8a97ad);
      for (let line = 0; line < 3; line += 1) {
        const y = -1.8 + line * 3;
        g.moveTo(-3.4, y)
          .lineTo(-2.5, y + 0.9)
          .lineTo(-1, y - 0.9)
          .stroke({ width: 0.9, color: DONE, cap: "round" });
        g.rect(0, y - 0.4, 3, 0.9).fill(0x9aa3b5);
      }
      return;
    case "think":
      // A light bulb.
      g.circle(0, -1.5, 5).fill(0xffd84d);
      g.rect(-2.2, 3, 4.4, 2.2).fill(0xb7bfcc);
      g.rect(-1.6, 5.2, 3.2, 1.2).fill(0x8a97ad);
      g.circle(-1.6, -3, 1.3).fill({ color: 0xffffff, alpha: 0.7 });
      return;
  }
}

/**
 * The shared frame of a figure. Subclasses fill `body` in `pose` and set
 * `headTop`, the height the bubble floats above.
 */
export abstract class FigureBase implements ActorFigure {
  readonly view = new Container();
  /** Flipped with `facing` by the base class; draw facing right. */
  protected readonly body = new Container();
  protected actor: WorldActor;
  protected readonly seed: number;
  protected readonly hashed: number;
  private readonly ring = new Graphics();
  private readonly fumes = new Graphics();
  private readonly bubble = new Container();
  private readonly bubbleBack = new Graphics();
  private readonly bubbleIcon = new Graphics();
  private readonly bubbleMark = text("", 13, 0xffffff, "800");
  private readonly tag = new Container();
  private readonly tagBack = new Graphics();
  private readonly tagText: Text;
  private bubbleKey = "";

  constructor(
    actor: WorldActor,
    protected readonly look: WorldLook,
    /** Negative: how far above the feet the top of the head is. */
    private readonly headTop: number,
  ) {
    this.actor = actor;
    this.hashed = hash(actor.sessionId);
    this.seed = (this.hashed % 1000) / 1000;
    this.tagText = text(
      "",
      9,
      look.appearance === "dark" ? 0xeff4fc : 0x111a2f,
      "600",
    );
    this.tagText.anchor.set(0.5, 0);
    this.bubbleMark.anchor.set(0.5);
    this.bubble.addChild(this.bubbleBack, this.bubbleIcon, this.bubbleMark);
    this.tag.addChild(this.tagBack, this.tagText);
    this.tag.position.set(0, 5);
    this.view.addChild(this.ring, this.body, this.fumes, this.bubble, this.tag);
    this.view.hitArea = {
      contains: (x, y) => x > -20 && x < 20 && y > headTop - 6 && y < 18,
    };
  }

  update(actor: WorldActor) {
    this.actor = actor;
    const name = truncate(actor.name, 18);
    if (this.tagText.text !== name) {
      this.tagText.text = name;
      this.tagBack
        .clear()
        .roundRect(
          -this.tagText.width / 2 - 5,
          -1,
          this.tagText.width + 10,
          14,
          7,
        )
        .fill({
          color: this.look.appearance === "dark" ? 0x10152a : 0xffffff,
          alpha: 0.82,
        });
    }
    this.drawBubble();
    this.view.alpha =
      actor.mood === "lost" ? 0.5 : actor.unconfirmed ? 0.72 : 1;
  }

  private drawBubble() {
    const bubble = bubbleFor(this.actor);
    const key = JSON.stringify(bubble);
    if (key === this.bubbleKey) return;
    this.bubbleKey = key;
    this.bubble.visible = bubble !== null;
    const back = this.bubbleBack.clear();
    this.bubbleIcon.clear();
    this.bubbleMark.text = "";
    if (!bubble) return;
    if (bubble.kind === "tool") {
      // A white speech bubble holding the tool's icon.
      back.roundRect(-11, -11, 22, 20, 7).fill(0xffffff);
      back.poly([-3, 8, 3, 8, -1, 13]).fill(0xffffff);
      back
        .roundRect(-11, -11, 22, 20, 7)
        .stroke({ width: 1, color: 0x000000, alpha: 0.12 });
      drawToolIcon(this.bubbleIcon, bubble.station);
      this.bubbleIcon.y = -1;
    } else {
      back.circle(0, -1, 9.5).fill(bubble.color);
      back.poly([-3, 6.5, 3, 6.5, 0, 12]).fill(bubble.color);
      this.bubbleMark.text = bubble.mark;
      this.bubbleMark.y = -1.5;
    }
  }

  animate(frame: ActorFrame) {
    const t = frame.time + this.seed * 10;
    this.body.scale.x = frame.facing === -1 ? -1 : 1;
    this.pose(t, frame);
    const level = contextLevel(this.actor.contextPercent);
    // Nearly out of context: it trembles under the smoke.
    this.body.x = level === 3 ? Math.sin(t * 38) * 0.7 : 0;
    drawFumes(this.fumes.clear(), level, t, this.headTop);
    const { mood } = this.actor;
    const lift =
      mood === "idle" ? ((t * 0.8) % 1) * 5 : Math.sin(t * 2.4) * 1.5;
    this.bubble.position.set(8, this.headTop - 12 - lift);
    this.bubble.scale.set(
      mood === "attention" ? 1.08 + Math.sin(t * 8) * 0.07 : 1,
    );
    if (mood === "idle") this.bubble.alpha = 1 - ((t * 0.8) % 1) * 0.6;
    else this.bubble.alpha = 1;

    const ring = this.ring.clear();
    if (mood === "attention") {
      const pulse = (t * 1.1) % 1;
      ring
        .ellipse(0, 1, 14 + pulse * 12, 4.5 + pulse * 3.5)
        .stroke({ width: 2, color: ATTENTION, alpha: 1 - pulse });
      ring.ellipse(0, 1, 14, 4.5).stroke({ width: 2, color: ATTENTION });
    }
  }

  /** Redraw the body for this frame. `t` is time plus this agent's offset. */
  protected abstract pose(t: number, frame: ActorFrame): void;
}
