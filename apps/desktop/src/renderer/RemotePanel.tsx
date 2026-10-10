/**
 * Settings → Remote: whether a phone may operate this Mac through the relay,
 * the pairing QR code, and the phones that are paired.
 *
 * The connector's status lives in the host and changes on its own (a phone
 * pairs, the network drops), so the panel asks for it every two seconds
 * while it is open rather than riding on every snapshot.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { encode } from "uqr";
import type {
  RemotePairingDto,
  RemoteStateDto,
  RemoteStatusDto,
  RpcResult,
} from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { ConfirmButton } from "./ConfirmButton";
import { SettingRow } from "./SettingsModal";

const POLL_MS = 2_000;

const STATUS_TEXT: Record<RemoteStatusDto, string> = {
  off: "Off",
  connecting: "Connecting to the relay…",
  waiting_for_phone: "Connected. Waiting for a phone to pair.",
  online: "Connected. Paired phones can reach this Mac.",
  offline: "Can't reach the relay. Retrying.",
  locked:
    "The relay refused this Mac: the account has no active access or used its data for the month.",
};

/**
 * A QR code as SVG, dark on light whatever the theme, so cameras read it.
 * Low error correction: it is read off a screen, never printed, and the
 * pairing link is long enough that a denser code reads worse.
 */
export function QrCode({ text, label }: { text: string; label: string }) {
  const path = useMemo(() => {
    const { data } = encode(text, { ecc: "L", border: 2 });
    let d = "";
    data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { d, size: data.length };
  }, [text]);
  return (
    <svg
      aria-label={label}
      className="remote-qr"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${path.size} ${path.size}`}
    >
      <rect fill="#fff" height={path.size} width={path.size} />
      <path d={path.d} fill="#000" />
    </svg>
  );
}

/** What phone access promises about privacy, shown before it is turned on. */
function EncryptionNotice() {
  return (
    <aside className="remote-e2e" aria-label="End-to-end encryption">
      <svg
        aria-hidden="true"
        className="remote-e2e-icon"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
        viewBox="0 0 24 24"
      >
        <rect height="10" rx="2.5" width="15" x="4.5" y="10.5" />
        <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
        <path d="M12 14.5v2.5" />
      </svg>
      <div>
        <strong>End-to-end encrypted</strong>
        <p>
          Everything between your phone and this Mac is end-to-end encrypted. No
          one else, not even Daedalus, can read it.
        </p>
      </div>
    </aside>
  );
}

function useCountdown(until: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [until]);
  return until === undefined ? 0 : Math.max(0, until - now);
}

const minutes = (ms: number) => {
  const seconds = Math.floor(ms / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export function RemotePanel({
  busy,
  client,
  perform,
}: {
  busy: boolean;
  client: DesktopClient;
  perform: <T>(operation: Promise<RpcResult<T>>) => Promise<T | undefined>;
}) {
  const [state, setState] = useState<RemoteStateDto>();
  const [pairing, setPairing] = useState<RemotePairingDto>();
  const [error, setError] = useState<string>();
  const left = useCountdown(pairing?.expiresAt);

  const refresh = useCallback(async () => {
    const result = await client.request.remoteGet({});
    if (result.ok) setState(result.data);
  }, [client]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // A phone that pairs shows up in the list; the code it used is spent.
  const phoneCount = state?.phones.length ?? 0;
  const [countWhenShown, setCountWhenShown] = useState(0);
  useEffect(() => {
    if (pairing && phoneCount > countWhenShown) setPairing(undefined);
  }, [pairing, phoneCount, countWhenShown]);
  useEffect(() => {
    if (pairing && left === 0) setPairing(undefined);
  }, [pairing, left]);

  const showCode = async () => {
    setError(undefined);
    const result = await client.request.remotePairingCode({});
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setCountWhenShown(phoneCount);
    setPairing(result.data);
  };

  const connected =
    state?.status === "waiting_for_phone" || state?.status === "online";
  const relayHost = state?.relay ? new URL(state.relay).host : "";

  return (
    <div className="remote-panel">
      <h3>Phone access</h3>
      <SettingRow
        checked={state?.enabled ?? false}
        disabled={busy || !state}
        description="Operate this Mac's sessions from your phone, from anywhere, while Daedalus is open."
        onChange={async (enabled) => {
          setPairing(undefined);
          const next = await perform(
            client.request.remoteSetEnabled({ enabled }),
          );
          if (next) setState(next);
        }}
        title="Allow phone access"
      />
      <EncryptionNotice />
      {state?.enabled ? (
        <p className="remote-status" data-status={state.status}>
          <span aria-hidden="true" className="remote-status-dot" />
          {STATUS_TEXT[state.status]}
          {relayHost ? <code>{relayHost}</code> : undefined}
        </p>
      ) : undefined}

      {state?.enabled ? (
        <>
          <h3>Pair a phone</h3>
          {pairing ? (
            <div className="remote-pairing">
              <QrCode label="Pairing code" text={pairing.url} />
              <div>
                <p>
                  Scan this with your phone's camera and sign in. The code works
                  once and expires in {minutes(left)}.
                </p>
                <div className="remote-pairing-actions">
                  <button className="quiet" onClick={showCode} type="button">
                    New code
                  </button>
                  <button
                    className="quiet"
                    onClick={() => setPairing(undefined)}
                    type="button"
                  >
                    Hide
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="remote-pairing-start">
              <button disabled={!connected} onClick={showCode} type="button">
                Show pairing code
              </button>
              {connected ? undefined : (
                <small>Pairing needs this Mac connected to the relay.</small>
              )}
            </div>
          )}
          {error ? (
            <p className="accounts-error" role="alert">
              {error}
            </p>
          ) : undefined}

          <h3>Paired phones</h3>
          {phoneCount === 0 ? (
            <p className="remote-empty">No phones yet.</p>
          ) : (
            <ul className="accounts-list remote-phones">
              {state.phones.map((phone) => (
                <li key={phone.id}>
                  <span aria-hidden="true" className="remote-phone-icon" />
                  <span className="accounts-who">
                    <strong>{phone.name || "Phone"}</strong>
                    <small>
                      Paired{" "}
                      {new Date(phone.pairedAt).toLocaleDateString(undefined, {
                        dateStyle: "medium",
                      })}
                    </small>
                  </span>
                  <span className="accounts-actions">
                    <ConfirmButton
                      armedLabel="Remove"
                      armedTitle={`Forget ${phone.name || "this phone"} on this Mac`}
                      className="quiet"
                      disabled={busy}
                      onConfirm={async () => {
                        const next = await perform(
                          client.request.remotePhoneRemove({ id: phone.id }),
                        );
                        if (next) setState(next);
                      }}
                      type="button"
                    >
                      Remove
                    </ConfirmButton>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : undefined}
    </div>
  );
}
