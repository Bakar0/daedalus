import type { CloudSignInDto, SessionColorDto } from "@daedalus/protocol";
import { sessionColorStyle } from "./session-color-style";

const KIND_LABEL: Record<CloudSignInDto["kind"], string> = {
  claude: "Claude",
  aws: "AWS",
};

/**
 * A bar above a cloud session's terminal when its pod asked to open a
 * sign-in page (`daedal open-url`). It names the page's host and opens it
 * only on the click: the pod runs code this Mac does not trust. The URL
 * itself never reaches the window.
 */
export function CloudSignInBar({
  offer,
  color,
  busy,
  onOpen,
  onDismiss,
}: {
  offer: CloudSignInDto;
  color: SessionColorDto | null;
  busy: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <section
      aria-label="Sign-in page"
      className="routine-bar cloud-sign-in-bar"
      data-color={color ?? undefined}
      data-kind={offer.kind}
      data-testid="cloud-signin-bar"
      style={sessionColorStyle(color)}
    >
      <div className="routine-bar-row">
        <span className="routine-bar-text">
          This session wants to open a {KIND_LABEL[offer.kind]} sign-in page on{" "}
          <strong data-testid="cloud-signin-host">{offer.host}</strong>.
        </span>
        <span className="routine-bar-actions">
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
            Dismiss
          </button>
        </span>
      </div>
    </section>
  );
}

/** After the page opened in its paste-code form. */
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
