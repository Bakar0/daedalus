/**
 * Arrow keys between board cards. The lanes are stacked, each a column of
 * cards: ↑ / ↓ move within a lane and run on into the next or previous one,
 * ← / → jump to the previous or next lane at the same position (or its last
 * card when it is shorter), Home / End go to the first and last card of the
 * lane. Empty and folded lanes are left out of `lanes`.
 */
export function gridMove(
  lanes: readonly (readonly string[])[],
  current: string,
  key: string,
): string | undefined {
  const filled = lanes.filter((lane) => lane.length > 0);
  const laneIndex = filled.findIndex((lane) => lane.includes(current));
  const lane = filled[laneIndex];
  if (!lane) return filled[0]?.[0];
  const row = lane.indexOf(current);
  const differs = (id: string | undefined) =>
    id !== undefined && id !== current ? id : undefined;
  switch (key) {
    case "ArrowDown":
      return differs(lane[row + 1] ?? filled[laneIndex + 1]?.[0]);
    case "ArrowUp":
      return differs(lane[row - 1] ?? filled[laneIndex - 1]?.at(-1));
    case "ArrowRight":
    case "ArrowLeft": {
      const next = filled[laneIndex + (key === "ArrowRight" ? 1 : -1)];
      return next ? differs(next[Math.min(row, next.length - 1)]) : undefined;
    }
    case "Home":
      return differs(lane[0]);
    case "End":
      return differs(lane.at(-1));
    default:
      return undefined;
  }
}

/** The card that is the grid's one Tab stop. */
export function gridTabStop(
  lanes: readonly (readonly string[])[],
  lastFocused: string | undefined,
  selected: string | undefined,
): string | undefined {
  const all = lanes.flat();
  if (lastFocused && all.includes(lastFocused)) return lastFocused;
  if (selected && all.includes(selected)) return selected;
  return all[0];
}
