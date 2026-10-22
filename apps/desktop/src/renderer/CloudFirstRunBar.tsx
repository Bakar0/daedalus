import React, { useState } from "react";
import type { AccountKindDto, SessionColorDto } from "@daedalus/protocol";
import { sessionColorStyle } from "./session-color-style";

// A Claude sign-in (login or default) is one per workspace; Bedrock's SSO
// note is its own.
const seenKey = (hostId: string, kind: string) =>
  `daedalus.cloud.firstRunSeen.${hostId}${kind === "bedrock" ? ".bedrock" : ""}`;

/** Whether the note was dismissed for this cloud workspace in this window. */
export function cloudFirstRunSeen(hostId: string, kind: string): boolean {
  try {
    return window.localStorage.getItem(seenKey(hostId, kind)) === "1";
  } catch {
    return false;
  }
}

/**
 * How a cloud Claude session signs in, by its account; undefined for one
 * that needs nothing (an API key, which comes with the launch).
 */
export function cloudFirstRunText(
  kind: AccountKindDto | "default",
): React.ReactNode | undefined {
  switch (kind) {
    case "api-key":
      return undefined;
    case "bedrock":
      return (
        <>
          This Claude runs in the workspace's cloud pod and reaches Bedrock
          through AWS SSO. When it signs in, a bar here offers the AWS sign-in
          page: open it and approve the code. The sign-in renews itself the same
          way when it expires.
        </>
      );
    case "login":
      return (
        <>
          This Claude runs in the workspace's cloud pod. Sign in to Claude once:
          type <code>/login</code> in this terminal, then open the sign-in page
          from the bar that appears here. The sign-in stays on the workspace's
          volume for later sessions.
        </>
      );
    case "default":
      return (
        <>
          This Claude runs in the workspace's cloud pod. Sign in to Claude once:
          type <code>/login</code> in this terminal, then open the sign-in page
          from the bar that appears here; the sign-in stays on the workspace's
          volume. Not needed when the workspace has an{" "}
          <code>ANTHROPIC_API_KEY</code> secret.
        </>
      );
  }
}

/**
 * A bar above a cloud Claude session's terminal: Claude in a new pod is not
 * signed in, and the sign-in happens once, in the pod, with the browser step
 * on this Mac. Claude's home in the pod is on the workspace's volume, so the
 * sign-in outlives the session and a sleep; the bar is dismissed once per
 * cloud workspace and kind of account.
 */
export function CloudFirstRunBar({
  hostId,
  kind,
  color,
}: {
  hostId: string;
  kind: AccountKindDto | "default";
  color: SessionColorDto | null;
}) {
  const [seen, setSeen] = useState(() => cloudFirstRunSeen(hostId, kind));
  const text = cloudFirstRunText(kind);
  if (seen || !text) return null;
  return (
    <section
      aria-label="Signing in to Claude in the cloud"
      className="routine-bar cloud-first-run-bar"
      data-color={color ?? undefined}
      data-testid="cloud-first-run-note"
      style={sessionColorStyle(color)}
    >
      <div className="routine-bar-row">
        <span className="routine-bar-text">{text}</span>
        <span className="routine-bar-actions">
          <button
            className="quiet"
            data-testid="cloud-first-run-dismiss"
            onClick={() => {
              try {
                window.localStorage.setItem(seenKey(hostId, kind), "1");
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
