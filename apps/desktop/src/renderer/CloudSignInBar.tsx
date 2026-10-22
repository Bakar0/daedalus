import type { CloudSignInDto, SessionColorDto } from "@daedalus/protocol";
import { sessionColorStyle } from "./session-color-style";

const KIND_LABEL: Record<CloudSignInDto["kind"], string> = {
  claude: "Claude",
  aws: "AWS",
};

/**
 * A cloud session's sign-in, over its terminal while there is nothing for
 * the user to do in the terminal itself: Daedalus starting Claude's
 * sign-in, the page waiting for the click, and the browser step. The page
 * opens only on the click (the pod runs code this Mac does not trust), and
 * its URL never reaches the window.
 */
export function CloudSignInPanel({
  signIn,
  busy,
  onOpen,
  onDismiss,
}: {
  signIn: CloudSignInDto;
  busy: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const what = KIND_LABEL[signIn.kind];
  return (
    <div
      aria-live="polite"
      className="cloud-signin-panel"
      data-kind={signIn.kind}
      data-phase={signIn.phase}
      data-testid={
        signIn.phase === "waiting"
          ? "cloud-signin-bar"
          : "cloud-signin-progress"
      }
    >
      {signIn.phase === "starting" ? (
        <>
          <span aria-hidden="true" className="session-launch-spinner" />
          <strong>Signing in to {what}…</strong>
          <span>
            This session runs in the cloud and is not signed in yet. Daedalus
            started the sign-in; the page to open comes next.
          </span>
        </>
      ) : signIn.phase === "waiting" ? (
        <>
          <strong>Sign in to {what} to use this session</strong>
          <span>
            The session wants to open a sign-in page on{" "}
            <strong data-testid="cloud-signin-host">{signIn.host}</strong>.
            {signIn.kind === "aws"
              ? " Sign in there and approve the code it shows."
              : " Sign in there; the session carries on by itself."}
          </span>
          <span className="cloud-signin-actions">
            <button
              data-testid="cloud-signin-open"
              disabled={busy}
              onClick={onOpen}
              type="button"
            >
              Open sign-in page
            </button>
            <button
              className="quiet"
              data-testid="cloud-signin-dismiss"
              disabled={busy}
              onClick={onDismiss}
              type="button"
            >
              Not now
            </button>
          </span>
        </>
      ) : signIn.phase === "browser" ? (
        <>
          <span aria-hidden="true" className="session-launch-spinner" />
          <strong>Finish signing in in your browser</strong>
          <span>
            The page on {signIn.host} is open. This session goes on as soon as
            you are signed in.
          </span>
          <span className="cloud-signin-actions">
            <button className="quiet" onClick={onDismiss} type="button">
              Show the terminal
            </button>
          </span>
        </>
      ) : (
        <>
          <strong>The sign-in stopped</strong>
          <span>{signIn.message}</span>
          <span className="cloud-signin-actions">
            <button className="quiet" onClick={onDismiss} type="button">
              Show the terminal
            </button>
          </span>
        </>
      )}
    </div>
  );
}

/** After the page opened in its paste-code form: the terminal stays usable. */
export function CloudPasteCodeBar({
  host,
  color,
  onDone,
}: {
  host: string;
  color: SessionColorDto | null;
  onDone: () => void;
}) {
  return (
    <section
      aria-label="Paste the sign-in code"
      className="routine-bar cloud-sign-in-bar"
      data-color={color ?? undefined}
      data-testid="cloud-signin-paste"
      style={sessionColorStyle(color)}
    >
      <div className="routine-bar-row">
        <span className="routine-bar-text">
          The page on <strong>{host}</strong> shows a code once you sign in.
          Copy it and paste it into this session's terminal.
        </span>
        <span className="routine-bar-actions">
          <button className="quiet" onClick={onDone} type="button">
            Done
          </button>
        </span>
      </div>
    </section>
  );
}
