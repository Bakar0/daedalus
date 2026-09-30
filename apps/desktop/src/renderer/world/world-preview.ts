import type { WorldCrate, WorldCrateStage, WorldModel } from "./world-model";

/**
 * Pretend data for looking at the World's effects on a development build,
 * where real agents rarely pass 80% context or merge a pull request on cue.
 * It rewrites the model the view draws and nothing else: the snapshot, the
 * board and the database never see it, and stable builds never offer it.
 */

/** "spread" gives each agent a different level, in turn. */
export type ContextPreview = "off" | "spread" | 35 | 60 | 90;

export const CONTEXT_PREVIEWS: ReadonlyArray<{
  value: ContextPreview;
  label: string;
}> = [
  { value: "off", label: "Real context" },
  { value: "spread", label: "Context: one level each" },
  { value: 35, label: "Context: 35% (steam)" },
  { value: 60, label: "Context: 60% (sweat)" },
  { value: 90, label: "Context: 90% (smoke)" },
];

/** Below every threshold, then one past each, so all four show at once. */
const SPREAD = [20, 35, 60, 90];

/** The stages a pretend crate walks through, one per step, then it is gone. */
export const CRATE_STAGES: readonly WorldCrateStage[] = [
  "packing",
  "pushed",
  "draft",
  "open",
  "merged",
];

export interface WorldPreview {
  context: ContextPreview;
  /** How far the pretend crate has got, or null for none. */
  crateStep: number | null;
  /**
   * A pretend handoff by the first agent: 0 while it writes its note, 1
   * once its successor has started. Null for none.
   */
  handoffStep?: 0 | 1 | null;
}

export const NO_PREVIEW: WorldPreview = { context: "off", crateStep: null };

/** Seconds each pretend handoff step lasts, long enough to watch. */
export const HANDOFF_STEPS = [15, 10];

/**
 * The model with the preview applied. The pretend crate belongs to the
 * first agent, in its own workspace, and gains a commit at each step, so
 * the pops a real branch would make ("Committed", "Opened PR #999") come
 * from the same comparison as real ones.
 */
export function previewModel(
  model: WorldModel,
  preview: WorldPreview,
): WorldModel {
  const handoffStep = preview.handoffStep ?? null;
  if (
    preview.context === "off" &&
    preview.crateStep === null &&
    handoffStep === null
  )
    return model;
  const { context, crateStep } = preview;
  let actors =
    context === "off"
      ? model.actors
      : model.actors.map((actor, index) => ({
          ...actor,
          contextPercent:
            context === "spread" ? SPREAD[index % SPREAD.length]! : context,
        }));
  const owner = model.actors[0];
  // The first agent hands off: nearly out of context, it waits at the
  // machine writing, then a fresh successor takes its place.
  const leaving = actors[0];
  if (leaving && handoffStep === 0)
    actors = [
      { ...leaving, place: "handoff", contextPercent: 92 },
      ...actors.slice(1),
    ];
  if (leaving && handoffStep === 1)
    actors = [
      {
        ...leaving,
        sessionId: `${leaving.sessionId}:rebuilt`,
        name: `${leaving.name} (2)`,
        continuesFrom: leaving.sessionId,
        contextPercent: 4,
        mood: "working",
        label: "working",
      },
      ...actors.slice(1),
    ];
  const stage =
    crateStep === null ? undefined : (CRATE_STAGES[crateStep] ?? undefined);
  if (!owner || !stage) return { ...model, actors };
  const crate: WorldCrate = {
    id: "preview:crate",
    sessionId: owner.sessionId,
    // One commit to start, a second before the pull request opens.
    commits: crateStep! < 2 ? 1 : 2,
    stage,
    label: stage === "packing" || stage === "pushed" ? "preview" : "#999",
    url: null,
  };
  return {
    ...model,
    actors,
    zones: model.zones.map((zone) =>
      zone.id === owner.zoneId
        ? { ...zone, crates: [...zone.crates, crate] }
        : zone,
    ),
  };
}
