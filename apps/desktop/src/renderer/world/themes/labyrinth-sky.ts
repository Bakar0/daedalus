import { Graphics } from "pixi.js";
import type { WorldArrangement } from "../world-theme";
import { scatter } from "./labyrinth-rooms";

/**
 * The sky over Daedalus Works follows the local clock: dawn, day, dusk and
 * a starry night, with the sun or the moon crossing it. It is decoration
 * only. It never dims for inactivity and carries no state, so a glance at
 * the World also tells the time of day, the way a window does.
 */

export interface Sky {
  top: number;
  bottom: number;
  /** 0 in daylight, 1 in full night. */
  stars: number;
  /** Where the sun or moon is along its arc, 0 rising to 1 setting. */
  body: { kind: "sun" | "moon"; progress: number } | null;
}

/** [hour, top colour, bottom colour], wrapping at midnight. */
const KEYS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0x0b1330, 0x1c2c52],
  [5, 0x1a2350, 0x5a4a72],
  [6.5, 0x4a6aa8, 0xf2a66a],
  [9, 0x5aa0e0, 0xbfe3f5],
  [12, 0x6fb8ee, 0xd4ecf8],
  [17, 0x5a8fd0, 0xf5c890],
  [19, 0x3a3f7a, 0xe07a5a],
  [20.5, 0x141c40, 0x3a3a6a],
  [24, 0x0b1330, 0x1c2c52],
];

const SUNRISE = 6;
const SUNSET = 19.5;

function mix(from: number, to: number, amount: number) {
  const channel = (shift: number) =>
    Math.round(
      ((from >> shift) & 255) * (1 - amount) + ((to >> shift) & 255) * amount,
    );
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

/** The sky at `hours` past local midnight, 0 to 24. */
export function skyAt(hours: number): Sky {
  const hour = ((hours % 24) + 24) % 24;
  let index = 0;
  while (index < KEYS.length - 2 && KEYS[index + 1]![0] <= hour) index += 1;
  const [startHour, startTop, startBottom] = KEYS[index]!;
  const [endHour, endTop, endBottom] = KEYS[index + 1]!;
  const amount = (hour - startHour) / (endHour - startHour);
  const day = hour >= SUNRISE && hour < SUNSET;
  const nightLength = 24 - SUNSET + SUNRISE;
  const intoNight = hour >= SUNSET ? hour - SUNSET : hour + 24 - SUNSET;
  // Stars fade in over the hour after sunset and out over the hour before
  // sunrise.
  const stars = day ? 0 : Math.min(1, intoNight, nightLength - intoNight);
  return {
    top: mix(startTop, endTop, amount),
    bottom: mix(startBottom, endBottom, amount),
    stars,
    body: day
      ? { kind: "sun", progress: (hour - SUNRISE) / (SUNSET - SUNRISE) }
      : { kind: "moon", progress: intoNight / nightLength },
  };
}

/** Local time as hours past midnight. The dev pages replace it. */
let clock = () => {
  const now = new Date();
  return now.getHours() + now.getMinutes() / 60;
};

export function setSkyClock(next: () => number) {
  clock = next;
}

const BANDS = 8;
const BLEED = 3000;

/**
 * Draws the sky into `g` for the arrangement's bounds and returns a function
 * that redraws it when the clock has moved on by a minute.
 */
export function createSky(g: Graphics, arrangement: WorldArrangement) {
  const { x, y, width } = arrangement.bounds;
  const random = scatter(arrangement.origins.length + 3);
  const stars = Array.from({ length: 70 }, () => ({
    x: x + random() * width,
    y: y + random() * -y * 0.8,
    radius: 0.8 + random() * 1.2,
    alpha: 0.4 + random() * 0.5,
  }));
  let drawnAt = Number.NaN;
  const draw = (hours: number) => {
    const sky = skyAt(hours);
    g.clear();
    g.rect(x - BLEED, y - BLEED, width + BLEED * 2, BLEED).fill(sky.top);
    for (let band = 0; band < BANDS; band += 1)
      g.rect(
        x - BLEED,
        y + (band * -y) / BANDS,
        width + BLEED * 2,
        -y / BANDS + 1,
      ).fill(mix(sky.top, sky.bottom, band / (BANDS - 1)));
    if (sky.stars > 0)
      for (const star of stars)
        g.circle(star.x, star.y, star.radius).fill({
          color: 0xffffff,
          alpha: star.alpha * sky.stars,
        });
    if (sky.body) {
      // A low arc from the left edge to the right, highest at its middle.
      const { kind, progress } = sky.body;
      const bx = x + width * (0.08 + progress * 0.84);
      const by = y + 60 + Math.pow((progress - 0.5) * 2, 2) * (-y - 150);
      if (kind === "sun") {
        g.circle(bx, by, 52).fill({ color: 0xfff3b0, alpha: 0.18 });
        g.circle(bx, by, 34).fill(0xfff3b0);
      } else {
        g.circle(bx, by, 30).fill(0xf4e7b8);
        g.circle(bx + 12, by - 6, 26).fill(mix(sky.top, sky.bottom, 0.2));
      }
    }
  };
  return () => {
    const hours = clock();
    if (Math.abs(hours - drawnAt) < 1 / 60) return;
    drawnAt = hours;
    draw(hours);
  };
}
