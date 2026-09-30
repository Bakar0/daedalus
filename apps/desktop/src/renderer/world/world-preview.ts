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
}

export const NO_PREVIEW: WorldPreview = { context: "off", crateStep: null };

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
  if (preview.context === "off" && preview.crateStep === null) return model;
  const { context, crateStep } = preview;
  const actors =
    context === "off"
      ? model.actors
      : model.actors.map((actor, index) => ({
          ...actor,
          contextPercent:
            context === "spread" ? SPREAD[index % SPREAD.length]! : context,
        }));
  const owner = model.actors[0];
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
