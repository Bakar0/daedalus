import type { PlanOwnerDto } from "@daedalus/protocol";

/**
 * What an owner's dot means, in the plan view's chips and the side panel's
 * Plans rows. Its own module so the side panel need not load the plan view.
 */
export const OWNER_STATE_TEXT: Record<PlanOwnerDto["state"], string> = {
  working: "working",
  waiting: "waiting on you",
  idle: "idle",
  error: "stopped on an error",
  stopped: "not running",
  none: "no session",
};
