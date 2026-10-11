import { useEffect, useState } from "react";
import {
  type PushState,
  pushState,
  turnOffPush,
  turnOnPush,
} from "./notifications";

const EXPLAIN: Record<PushState, string> = {
  unsupported: "This browser cannot show notifications.",
  install_first:
    "On iPhone, add Daedalus to your Home Screen (Share › Add to Home Screen) and open it from there to turn on notifications.",
  off: "Get a notification when a session on your Mac needs you while you are away from it.",
  on: "You get a notification when a session needs you while you are away from your Mac.",
  blocked:
    "Notifications are blocked for this site. Allow them in your browser's site settings.",
};

/**
 * Turning push on or off. `compact` is the home screen's prompt, shown only
 * while it is off; the full one is the Account row.
 */
export function PushControl({
  token,
  compact,
}: {
  token: string;
  compact?: boolean;
}) {
  const [state, setState] = useState<PushState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    void pushState().then(setState);
  }, []);
  if (!state || (compact && state !== "off")) return null;

  const change = async (on: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      setState(on ? await turnOnPush(token) : await turnOffPush(token));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  if (compact)
    return (
      <div className="push-prompt">
        <p>{EXPLAIN.off}</p>
        <button
          className="button primary"
          disabled={busy}
          onClick={() => void change(true)}
        >
          Turn on notifications
        </button>
        {error ? <p className="error">{error}</p> : undefined}
      </div>
    );

  return (
    <div className="card push-card">
      <label className="push-row">
        <span>
          <strong>Notifications</strong>
          <small>{EXPLAIN[state]}</small>
        </span>
        {state === "on" || state === "off" ? (
          <input
            aria-label="Notifications"
            checked={state === "on"}
            className="switch"
            disabled={busy}
            onChange={(event) => void change(event.target.checked)}
            type="checkbox"
          />
        ) : undefined}
      </label>
      {error ? <p className="error">{error}</p> : undefined}
    </div>
  );
}
