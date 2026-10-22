import { useState } from "react";
import type { DesktopClient } from "./client-types";

export type RunsOnPlace = "local" | "cloud";

const rememberedKey = (workspaceId: string) =>
  `daedalus.session.runsOn.${workspaceId}`;

/** Where the last new session in a workspace ran, for the next one. */
export function rememberedRunsOn(workspaceId: string | undefined): RunsOnPlace {
  if (!workspaceId) return "local";
  try {
    return window.localStorage.getItem(rememberedKey(workspaceId)) === "cloud"
      ? "cloud"
      : "local";
  } catch {
    return "local";
  }
}

export function rememberRunsOn(workspaceId: string, place: RunsOnPlace): void {
  try {
    window.localStorage.setItem(rememberedKey(workspaceId), place);
  } catch {
    // Only a convenience.
  }
}

/**
 * The top of the new session dialog: where the session runs. Signed in to a
 * cloud gateway, it is a two-way choice; signed out, a small link signs in
 * right here, without leaving the dialog.
 */
export function RunsOn({
  client,
  signedIn,
  value,
  cloudUnavailable,
  onChange,
  onSignedIn,
}: {
  client: DesktopClient;
  signedIn: boolean;
  value: RunsOnPlace;
  /** Why Cloud cannot take a session now, such as a failed pod. */
  cloudUnavailable?: string;
  onChange: (place: RunsOnPlace) => void;
  /** After the inline sign-in, with Cloud chosen. */
  onSignedIn: () => Promise<void> | void;
}) {
  const [setup, setSetup] = useState(false);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [email, setEmail] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();

  const signIn = async () => {
    if (!gatewayUrl.trim() || !email.trim()) return;
    setWorking(true);
    setError(undefined);
    try {
      const response = await client.request.cloudSignIn({ gatewayUrl, email });
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setSetup(false);
      await onSignedIn();
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="session-runs-on">
      <div className="session-runs-on-row">
        <span className="session-runs-on-label">Runs on</span>
        {signedIn ? (
          <span
            aria-label="Runs on"
            className="accounts-methods"
            data-testid="session-location"
            role="radiogroup"
          >
            {(
              [
                { id: "local", label: "This Mac" },
                { id: "cloud", label: "Cloud" },
              ] as const
            ).map((place) => (
              <button
                aria-checked={value === place.id}
                className={value === place.id ? "selected" : ""}
                data-testid={`session-location-${place.id}`}
                disabled={place.id === "cloud" && Boolean(cloudUnavailable)}
                key={place.id}
                onClick={() => onChange(place.id)}
                role="radio"
                title={place.id === "cloud" ? cloudUnavailable : undefined}
                type="button"
              >
                {place.label}
              </button>
            ))}
          </span>
        ) : (
          <>
            <span className="session-runs-on-value">This Mac</span>
            {!setup && (
              <button
                className="quiet link session-runs-on-setup"
                data-testid="cloud-setup"
                onClick={() => setSetup(true)}
                type="button"
              >
                Set up cloud
              </button>
            )}
          </>
        )}
      </div>
      {setup && !signedIn && (
        <div
          className="session-runs-on-signin"
          data-testid="cloud-setup-form"
          onKeyDown={(event) => {
            // The dialog's own form must not submit from these fields.
            if (event.key === "Enter") {
              event.preventDefault();
              void signIn();
            }
          }}
        >
          <input
            aria-label="Gateway URL"
            autoFocus
            data-testid="cloud-gateway-url"
            disabled={working}
            onChange={(event) => setGatewayUrl(event.target.value)}
            placeholder="https://gateway.example.com"
            type="url"
            value={gatewayUrl}
          />
          <input
            aria-label="Email"
            autoComplete="email"
            data-testid="cloud-email"
            disabled={working}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            type="email"
            value={email}
          />
          <button
            data-testid="cloud-sign-in"
            disabled={working || !gatewayUrl.trim() || !email.trim()}
            onClick={() => void signIn()}
            type="button"
          >
            {working ? "Signing in…" : "Sign in"}
          </button>
          <button
            className="quiet"
            disabled={working}
            onClick={() => {
              setSetup(false);
              setError(undefined);
            }}
            type="button"
          >
            Cancel
          </button>
          {error && (
            <p
              className="accounts-error"
              data-testid="cloud-error"
              role="alert"
            >
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
