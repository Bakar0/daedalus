/**
 * Phone access from the Workspaces heading: whether it is on and connected,
 * the switch (turning it off disconnects every phone at once, the thing to
 * do on coming back to the Mac), and the way to pair a phone. The full
 * section, with the QR code and the paired phones, is Settings › Remote.
 */
import type { RpcResult } from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { Menu, MenuCheck } from "./Menu";
import { hasPlan, ProTag, showsPro, useRemoteState } from "./ProPlan";
import { remoteLook, remoteStatusText } from "./RemotePanel";

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
  onGetPro,
}: {
  client: DesktopClient;
  perform: <T>(operation: Promise<RpcResult<T>>) => Promise<T | undefined>;
  onPair: () => void;
  /** Settings › Account, for a Mac without Pro. */
  onGetPro: () => void;
}) {
  const { data: state, refresh } = useRemoteState(client, POLL_MS);

  // Phone access is Pro, and Pro shows only to those who have it.
  if (!showsPro(state)) return null;
  const look = remoteLook(state);
  return (
    <Menu
      align="end"
      className="remote-menu"
      label={`Phone access: ${remoteStatusText(state)}`}
      menuLabel="Phone access"
      summary={
        <>
          <PhoneIcon />
          <span
            aria-hidden="true"
            className="remote-menu-dot"
            data-look={look}
          />
        </>
      }
      summaryClassName="quiet workspace-heading-action"
      title={`Phone access: ${remoteStatusText(state)}`}
    >
      <span className="menu-heading">
        Phone access <ProTag />
      </span>
      <p className="remote-menu-status" data-look={look}>
        {hasPlan(state)
          ? remoteStatusText(state)
          : "Phone access is part of Daedalus Pro."}
      </p>
      {hasPlan(state) || state?.enabled ? (
        <button
          aria-checked={state?.enabled ?? false}
          className="quiet menu-item"
          disabled={!state}
          onClick={async () => {
            const next = await perform(
              client.request.remoteSetEnabled({ enabled: !state?.enabled }),
            );
            if (next) await refresh();
          }}
          role="menuitemcheckbox"
          type="button"
        >
          <span className="menu-item-label">Allow phone access</span>
          {state?.enabled ? <MenuCheck /> : undefined}
        </button>
      ) : undefined}
      <button
        className="quiet menu-item"
        onClick={hasPlan(state) ? onPair : onGetPro}
        role="menuitem"
        type="button"
      >
        <span className="menu-item-label">
          {hasPlan(state) ? "Pair a phone…" : "Get Pro…"}
        </span>
      </button>
    </Menu>
  );
}
