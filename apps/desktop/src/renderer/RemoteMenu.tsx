/**
 * Phone access from the Workspaces heading: whether it is on and connected,
 * the switch (turning it off disconnects every phone at once, the thing to
 * do on coming back to the Mac), and the way to pair a phone. The full
 * section, with the QR code and the paired phones, is Settings › Remote.
 */
import { useCallback, useEffect, useState } from "react";
import type { RemoteStateDto, RpcResult } from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { Menu, MenuCheck } from "./Menu";
import { STATUS_TEXT } from "./RemotePanel";

const POLL_MS = 3_000;

function PhoneIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      <rect height="18" rx="2.5" width="11" x="6.5" y="3" />
      <path d="M11 17.5h2" />
    </svg>
  );
}

export function RemoteMenu({
  client,
  perform,
  onPair,
}: {
  client: DesktopClient;
  perform: <T>(operation: Promise<RpcResult<T>>) => Promise<T | undefined>;
  onPair: () => void;
}) {
  const [state, setState] = useState<RemoteStateDto>();
  const refresh = useCallback(async () => {
    // A host without phone access (a test page) has no answer to give.
    const result = await client.request.remoteGet({}).catch(() => undefined);
    if (result?.ok) setState(result.data);
  }, [client]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const status = state?.enabled ? state.status : "off";
  const phones = state?.phones.length ?? 0;
  return (
    <Menu
      align="end"
      className="remote-menu"
      label={`Phone access: ${STATUS_TEXT[status]}`}
      menuLabel="Phone access"
      summary={
        <>
          <PhoneIcon />
          <span
            aria-hidden="true"
            className="remote-menu-dot"
            data-status={status}
          />
        </>
      }
      summaryClassName="quiet workspace-heading-action"
      title="Phone access"
    >
      <span className="menu-heading">Phone access</span>
      <p className="remote-menu-status" data-status={status}>
        {STATUS_TEXT[status]}
        {state?.enabled && phones > 0
          ? ` ${phones} paired phone${phones === 1 ? "" : "s"}.`
          : ""}
      </p>
      <button
        aria-checked={state?.enabled ?? false}
        className="quiet menu-item"
        disabled={!state}
        onClick={async () => {
          const next = await perform(
            client.request.remoteSetEnabled({ enabled: !state?.enabled }),
          );
          if (next) setState(next);
        }}
        role="menuitemcheckbox"
        type="button"
      >
        <span className="menu-item-label">Allow phone access</span>
        {state?.enabled ? <MenuCheck /> : undefined}
      </button>
      <button
        className="quiet menu-item"
        onClick={onPair}
        role="menuitem"
        type="button"
      >
        <span className="menu-item-label">Pair a phone…</span>
      </button>
    </Menu>
  );
}
