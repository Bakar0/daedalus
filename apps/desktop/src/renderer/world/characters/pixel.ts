import { Graphics, GraphicsContext } from "pixi.js";
import type { WorldActor } from "../world-model";
import type { ActorFrame, WorldCharacter, WorldLook } from "../world-theme";
import { FigureBase, INK, SKIN } from "./parts";

/**
 * Retro sprites, 12 by 16 pixels drawn at three world pixels each. Claude is
 * a bearded wizard, Codex an engineer in a hard hat. Each frame is built once
 * per class and skin and shared, so a crowd costs no more than one agent.
 */

const P = 3;
const COLS = 12;
const ROWS = 16;

type Rows = readonly string[];

interface SpriteClass {
  head: Rows;
  torso: Rows;
  palette: Record<string, number>;
}

const LEGS: Record<"stand" | "stepA" | "stepB", Rows> = {
  stand: ["...ob..bo...", "...bb..bb..."],
  stepA: ["..ob....bo..", "..bb....bb.."],
  stepB: ["....obbo....", "....bbbb...."],
};

const WIZARD: SpriteClass = {
  head: [
    ".....oo.....",
    "....ohho....",
    "....ohgo....",
    "...ohhhho...",
    "..ohhhhhho..",
    ".oHHHHHHHHo.",
    "..osssssso..",
    "..osssssso..",
    "..osssssso..",
    "...owwwwo...",
  ],
  torso: [".orrwwwwrro.", ".srrrgrrrrs.", ".orrrrrrrro.", "..oRRRRRRo.."],
  palette: {
    h: 0xc2553c,
    H: 0x8a3a28,
    g: 0xffd166,
    r: 0xe88a6e,
    R: 0xb35a41,
  },
};

const ENGINEER: SpriteClass = {
  head: [
    "............",
    "....oooo....",
    "...ohhhho...",
    "..ohhhhhho..",
    "..ohhghhho..",
    ".oHHHHHHHHo.",
    "..osssssso..",
    "..osssssso..",
    "..osssssso..",
    "...osssso...",
  ],
  torso: [".orrgrrgrro.", ".srrrrrrrrs.", ".orrrRRrrro.", "..oRRRRRRo.."],
  palette: {
    h: 0xffc53d,
    H: 0xd18f00,
    g: 0xfff3b0,
    r: 0x2fbf8f,
    R: 0x1d7f5f,
  },
};

const BLUE_WIZARD: SpriteClass = {
  ...WIZARD,
  palette: {
    ...WIZARD.palette,
    h: 0x4058b8,
    H: 0x2c3d85,
    r: 0x6c8cff,
    R: 0x4a64c8,
  },
};

const CLASSES: Record<string, SpriteClass> = {
  claude: WIZARD,
  codex: ENGINEER,
};

const SHARED: Record<string, number> = {
  o: INK,
  w: 0xf4f4f4,
  b: 0x4a3424,
};

type Pose = "stand" | "stepA" | "stepB" | "wave" | "cheer";

/** Arms raised by overwriting pixels: [x, y, colour key]. */
const RAISED_RIGHT: ReadonlyArray<[number, number, string]> = [
  [11, 6, "s"],
  [11, 7, "r"],
  [11, 8, "r"],
  [10, 9, "r"],
  [10, 11, "o"],
];
const RAISED_LEFT: ReadonlyArray<[number, number, string]> = [
  [0, 6, "s"],
  [0, 7, "r"],
  [0, 8, "r"],
  [1, 9, "r"],
  [1, 11, "o"],
];

export function spriteRows(kind: SpriteClass, pose: Pose): string[] {
  const legs = LEGS[pose === "stepA" || pose === "stepB" ? pose : "stand"];
  const rows = [...kind.head, ...kind.torso, ...legs].map((row) =>
    row.split(""),
  );
  const raise =
    pose === "wave"
      ? RAISED_RIGHT
      : pose === "cheer"
        ? [...RAISED_RIGHT, ...RAISED_LEFT]
        : [];
  for (const [x, y, key] of raise) rows[y]![x] = key;
  return rows.map((row) => row.join(""));
}

const contexts = new Map<string, GraphicsContext>();

function contextFor(
  kind: SpriteClass,
  pose: Pose,
  skin: number,
): GraphicsContext {
  const key = `${kind.palette.h}-${pose}-${skin}`;
  const cached = contexts.get(key);
  if (cached) return cached;
  const context = new GraphicsContext();
  const colors: Record<string, number> = {
    ...SHARED,
    ...kind.palette,
    s: skin,
  };
  spriteRows(kind, pose).forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      const color = colors[row[x]!];
      if (color === undefined) continue;
      context.rect((x - COLS / 2) * P, (y - ROWS) * P, P, P).fill(color);
    }
  });
  contexts.set(key, context);
  return context;
}

class PixelHero extends FigureBase {
  private readonly shadow = new Graphics();
  private readonly sprite = new Graphics();
  private readonly face = new Graphics();
  private readonly effects = new Graphics();
  private readonly kind: SpriteClass;
  private readonly skin: number;

  constructor(actor: WorldActor, look: WorldLook) {
    super(actor, look, -ROWS * P - 2);
    this.kind = CLASSES[actor.provider] ?? BLUE_WIZARD;
    this.skin = SKIN[this.hashed % SKIN.length]!;
    this.shadow.ellipse(0, 0, 13, 3).fill({ color: 0x000000, alpha: 0.25 });
    this.body.addChild(this.shadow, this.sprite, this.face, this.effects);
  }

  protected pose(t: number, { walking }: ActorFrame) {
    const { mood } = this.actor;
    let pose: Pose = "stand";
    let hop = 0;
    if (walking) pose = Math.floor(t * 7) % 2 ? "stepA" : "stepB";
    else if (mood === "attention") {
      pose = Math.floor(t * 4) % 2 ? "wave" : "stand";
      hop = Math.floor(t * 8) % 2;
    } else if (mood === "done" && t % 2.4 < 0.6) {
      pose = "cheer";
      hop = 2;
    } else if (mood === "working") hop = Math.floor(t * 2.5) % 2;
    const context = contextFor(this.kind, pose, this.skin);
    if (this.sprite.context !== context) this.sprite.context = context;
    // Movement snaps to whole sprite pixels, as it would on real hardware.
    const shake =
      mood === "error" ? (Math.floor(t * 20) % 2 ? P / 3 : -P / 3) : 0;
    for (const layer of [this.sprite, this.face, this.effects])
      layer.position.set(shake, -hop * P);
    this.drawFace(t);
    this.drawEffects(t);
  }

  private pixel(g: Graphics, x: number, y: number, color: number) {
    g.rect((x - COLS / 2) * P, (y - ROWS) * P, P, P).fill(color);
  }

  private drawFace(t: number) {
    const { mood } = this.actor;
    const g = this.face.clear();
    const eyes = [4, 7];
    const closed =
      mood === "idle" || mood === "lost" || (t + this.seed * 5) % 3.4 < 0.14;
    for (const x of eyes) {
      if (mood === "done") {
        this.pixel(g, x - 1, 8, INK);
        this.pixel(g, x, 7, INK);
        this.pixel(g, x + 1, 8, INK);
      } else if (mood === "error") {
        this.pixel(g, x - 1, 6, INK);
        this.pixel(g, x + 1, 6, INK);
        this.pixel(g, x, 7, INK);
        this.pixel(g, x - 1, 8, INK);
        this.pixel(g, x + 1, 8, INK);
      } else if (closed) {
        this.pixel(g, x, 8, INK);
      } else {
        this.pixel(g, x, 7, INK);
        this.pixel(g, x, 8, INK);
        if (mood === "attention") this.pixel(g, x, 6, 0xffffff);
      }
    }
    if (mood === "attention" && this.kind !== WIZARD) {
      this.pixel(g, 5, 9, INK);
      this.pixel(g, 6, 9, INK);
    }
  }

  private drawEffects(t: number) {
    const { mood } = this.actor;
    const g = this.effects.clear();
    if (mood === "error") {
      // Pixel smoke, rising in whole steps.
      for (let puff = 0; puff < 3; puff += 1) {
        const step = Math.floor(((t * 1.5 + puff / 3) % 1) * 5);
        this.pixel(g, 3 + puff * 3, -1 - step, 0x8a8f99);
      }
    } else if (mood === "idle") {
      const step = Math.floor((t * 2) % 4);
      this.pixel(g, 10 + (step % 2), 2 - step, 0x8a97ad);
    } else if (mood === "working" && this.actor.place === "run") {
      // A glowing prompt block in front of the engineer's hands.
      if (t % 1 < 0.5) this.pixel(g, 11, 11, 0x3fdc8b);
    }
  }
}

export const pixelCharacter: WorldCharacter = {
  id: "pixel",
  label: "Pixel",
  description:
    "Retro sprites: a bearded wizard for Claude, an engineer in a hard hat for Codex.",
  create: (actor, look) => new PixelHero(actor, look),
};

export const SPRITE_CLASSES = { WIZARD, ENGINEER, BLUE_WIZARD };
export const SPRITE_SIZE = { columns: COLS, rows: ROWS };
