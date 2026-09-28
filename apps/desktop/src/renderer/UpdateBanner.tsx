import type { AppUpdateDto } from "@daedalus/protocol";

/**
 * The strip under the top bar that offers a newer Daedalus. The host decides
 * when there is something to say (see UpdateController); this only draws it
 * and sends the two answers back.
 */
export function UpdateBanner({
  update,
  onInstall,
  onDismiss,
}: {
  update: AppUpdateDto;
  onInstall: () => void;
  /** `version` is set only for "Later" on an offer, which hides that version. */
  onDismiss: (version?: string) => void;
}) {
  const role = update.state === "error" ? "alert" : "status";
  return (
    <div
      className={`update-banner update-${update.state}`}
      data-update-state={update.state}
      role={role}
    >
      <span>{updateMessage(update)}</span>
      <span className="update-banner-actions">
        {update.state === "available" ? (
          <>
            <button className="update-banner-primary" onClick={onInstall}>
              Update and restart
            </button>
            <button onClick={() => onDismiss(update.version)}>Later</button>
          </>
        ) : undefined}
        {update.state === "current" || update.state === "error" ? (
          <button onClick={() => onDismiss()}>Close</button>
        ) : undefined}
      </span>
    </div>
  );
}

export function updateMessage(update: AppUpdateDto): string {
  switch (update.state) {
    case "available":
      return `Daedalus ${update.version} is available. You have ${update.currentVersion}. Sessions keep running while it restarts.`;
    case "downloading":
      return `Downloading Daedalus ${update.version}…`;
    case "restarting":
      return `Installing Daedalus ${update.version}. It will reopen in a moment.`;
    case "current":
      return `Daedalus ${update.currentVersion} is the latest version.`;
    case "error":
      return update.message ?? "Could not update Daedalus.";
  }
}
