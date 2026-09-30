import type { WorldActor, WorldCrate, WorldModel } from "./world-model";

/**
 * Progress an agent just made, noticed by comparing one snapshot with the
 * next, for a short pop over its head and the hover card's recent list.
 * Every kind of session makes some: a research agent finishes turns, a
 * coding agent also commits, pushes and opens pull requests. Nothing here
 * is counted or kept past the app's run; it is feedback at the moment of
 * progress, not a score.
 */
export interface WorldMilestone {
  sessionId: string;
  text: string;
}

const clip = (value: string, length: number) => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
};

const pull = (crate: WorldCrate) =>
  crate.label.startsWith("#") ? `PR ${crate.label}` : "a pull request";

function crateStep(before: WorldCrate | undefined, after: WorldCrate) {
  const steps: string[] = [];
  const was = before?.stage;
  if (after.commits > (before?.commits ?? 0) && after.stage !== "merged")
    steps.push(
      after.commits - (before?.commits ?? 0) === 1
        ? "Committed"
        : `Committed ${after.commits - (before?.commits ?? 0)} times`,
    );
  if (was === after.stage) return steps;
  if (after.stage === "pushed" && was === "packing") steps.push("Pushed");
  if (
    (after.stage === "draft" || after.stage === "open") &&
    (was === undefined || was === "packing" || was === "pushed")
  )
    steps.push(`Opened ${pull(after)}`);
  if (after.stage === "open" && was === "draft")
    steps.push(`${pull(after)} ready for review`);
  if (after.stage === "merged" && was !== undefined)
    steps.push(`${pull(after)} merged`);
  return steps;
}

/** What changed for the better between two snapshots, per live agent. */
export function milestonesBetween(
  before: WorldModel,
  after: WorldModel,
): WorldMilestone[] {
  const previous = new Map(
    before.actors.map((actor) => [actor.sessionId, actor]),
  );
  const live = new Map<string, WorldActor>(
    after.actors.map((actor) => [actor.sessionId, actor]),
  );
  const milestones: WorldMilestone[] = [];
  for (const actor of after.actors) {
    const was = previous.get(actor.sessionId);
    if (!was) continue;
    if (
      was.mood === "working" &&
      (actor.mood === "idle" || actor.mood === "done")
    )
      milestones.push({
        sessionId: actor.sessionId,
        text: actor.detail ? `✓ ${clip(actor.detail, 48)}` : "✓ Turn finished",
      });
    if (!was.taskDone && actor.taskDone && actor.taskLabel)
      milestones.push({
        sessionId: actor.sessionId,
        text: `✓ ${clip(actor.taskLabel, 40)} done`,
      });
  }
  const crates = new Map(
    before.zones
      .flatMap((zone) => zone.crates)
      .map((crate) => [crate.id, crate]),
  );
  for (const crate of after.zones.flatMap((zone) => zone.crates)) {
    // Only an agent still in the building has a head to pop over.
    if (!live.has(crate.sessionId) || !previous.has(crate.sessionId)) continue;
    for (const text of crateStep(crates.get(crate.id), crate))
      milestones.push({ sessionId: crate.sessionId, text });
  }
  return milestones;
}
