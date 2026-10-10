import type { ReactNode } from "react";

/** The top bar and the page under it. */
export function Shell({
  title,
  subtitle,
  onAccount,
  onBack,
  children,
}: {
  title: string;
  /** A short line under the title: the connection, for a Mac. */
  subtitle?: ReactNode;
  onAccount?: () => void;
  onBack?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <header className="bar">
        {onBack ? (
          <button aria-label="Back" className="bar-icon" onClick={onBack}>
            ‹
          </button>
        ) : (
          <img alt="" className="bar-logo" src="/icon-192.png" />
        )}
        <div className="bar-title">
          <h1>{title}</h1>
          {subtitle ? <small>{subtitle}</small> : undefined}
        </div>
        {onAccount ? (
          <button aria-label="Account" className="bar-icon" onClick={onAccount}>
            <span aria-hidden="true" className="avatar" />
          </button>
        ) : (
          <span className="bar-spacer" />
        )}
      </header>
      <main>{children}</main>
    </div>
  );
}
