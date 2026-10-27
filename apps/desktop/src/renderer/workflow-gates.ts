import type { WorkflowRunStepDto } from "@daedalus/protocol";

type Gate = NonNullable<WorkflowRunStepDto["gate"]>;

/**
 * How a gate reads in the app. A `start` gate waits for the user's go-ahead
 * before the step; a `result` gate waits for the user to approve what the
 * step produced. The tag is short enough for a step row.
 */
export const GATE_LABELS: Record<
  Gate,
  { tag: string; title: string; waiting: string; field: string }
> = {
  start: {
    tag: "start",
    title: "You give the go-ahead before this step starts",
    waiting: "waiting for your go-ahead to start · answer in the session",
    field: "The agent asks you before it starts this step.",
  },
  result: {
    tag: "review",
    title: "You approve what comes out of this step",
    waiting: "waiting for you to approve the result · answer in the session",
    field:
      "The agent asks you to approve what comes out of this step before it moves on.",
  },
};
