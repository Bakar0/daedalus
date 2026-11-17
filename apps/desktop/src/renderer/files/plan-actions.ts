import type { DesktopClient } from "../client-types";
import { askText } from "../dialogs";

/** Sent after a plan is made from the app, so the side panel reads again. */
export const PLANS_CHANGED = "daedalus:plans-changed";

/**
 * Asks for a title and writes `plans/<slug>.plan.md` with a skeleton.
 * Resolves to the new file's workspace-relative path, or undefined when
 * cancelled or refused (the refusal goes to `onError`).
 */
export async function createPlan(
  client: DesktopClient,
  workspaceId: string,
  onError: (message: string) => void,
): Promise<string | undefined> {
  const title = await askText({
    title: "New plan",
    message:
      "What is the plan called? It is saved as plans/<title>.plan.md, with a Tasks section to fill in.",
    confirmLabel: "Create",
  });
  if (!title?.trim()) return undefined;
  const response = await client.request.planCreate({
    workspace: workspaceId,
    title: title.trim(),
  });
  if (!response.ok) {
    onError(response.error.message);
    return undefined;
  }
  window.dispatchEvent(new Event(PLANS_CHANGED));
  return response.data.path;
}
