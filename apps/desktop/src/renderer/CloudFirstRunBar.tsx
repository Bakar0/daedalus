import { useState } from "react";
import type { SessionColorDto } from "@daedalus/protocol";
import { sessionColorStyle } from "./session-color-style";

const seenKey = (hostId: string) => `daedalus.cloud.firstRunSeen.${hostId}`;

/** Whether the note was dismissed for this cloud workspace in this window. */
export function cloudFirstRunSeen(hostId: string): boolean {
  try {
    return window.localStorage.getItem(seenKey(hostId)) === "1";
  } catch {
    return false;
  }
}

/**
 * A bar above a cloud Claude session's terminal: Claude in a new pod is not
 * signed in, and the sign-in happens once, in that terminal. Claude's home in
 * the pod is on the workspace's volume, so the sign-in outlives the session
 * and a sleep; the bar is dismissed once per cloud workspace.
 */
export function CloudFirstRunBar({
  hostId,
  color,
}: {
  hostId: string;
  color: SessionColorDto | null;
}) {
  const [seen, setSeen] = useState(() => cloudFirstRunSeen(hostId));
  if (seen) return null;
  return (
    <section
      aria-label="Signing in to Claude in the cloud"
      className="routine-bar cloud-first-run-bar"
      data-color={color ?? undefined}
      data-testid="cloud-first-run-note"
      style={sessionColorStyle(color)}
    >
      <div className="routine-bar-row">
        <span className="routine-bar-text">
          This Claude runs in the workspace's cloud pod. Sign in to Claude once
          in this terminal (follow its prompt, or type <code>/login</code>); the
          sign-in stays on the workspace's volume for later sessions. Not needed
          when the workspace has an <code>ANTHROPIC_API_KEY</code> secret.
        </span>
        <span className="routine-bar-actions">
          <button
            className="quiet"
            data-testid="cloud-first-run-dismiss"
            onClick={() => {
              try {
                window.localStorage.setItem(seenKey(hostId), "1");
              } catch {
                // Shown again next time; nothing else depends on it.
              }
              setSeen(true);
            }}
            type="button"
          >
            Got it
          </button>
        </span>
      </div>
    </section>
  );
}
