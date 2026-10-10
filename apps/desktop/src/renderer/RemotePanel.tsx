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
  RemoteActivityDto,
  RemotePairingDto,
  RemoteStateDto,
  RpcResult,
} from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { ConfirmButton } from "./ConfirmButton";
import { SettingRow } from "./SettingsModal";

const POLL_MS = 2_000;

/**
 * How phone access stands, in four looks shared by the heading's icon and
 * this panel: off (no dot), ready (a ring: on, no phone connected right now),
 * live (a solid dot: a phone is connected now) and trouble (red).
 */
export type RemoteLook = "off" | "connecting" | "ready" | "live" | "trouble";

export function remoteLook(state: RemoteStateDto | undefined): RemoteLook {
  if (!state?.enabled) return "off";
  if (
    state.status === "offline" ||
    state.status === "locked" ||
    state.status === "removed"
  )
    return "trouble";
  if (state.status === "connecting" || state.status === "off")
    return "connecting";
  return state.connectedPhones > 0 ? "live" : "ready";
}

export function remoteStatusText(state: RemoteStateDto | undefined): string {
  if (!state?.enabled) return "Off. No phone can reach this Mac.";
  switch (state.status) {
    case "connecting":
    case "off":
      return "Connecting to the relay…";
    case "offline":
      return "Can't reach the relay. Retrying.";
    case "locked":
      return "The relay refused this Mac: the account has no active access or used its allowance for the month, or the relay is paused until the 1st.";
    case "removed":
      return "The relay no longer accepts this Mac: it was removed from its account. Start over to pair it again.";
    case "waiting_for_phone":
      return "On. Waiting for a phone to pair.";
    case "online":
      return state.connectedPhones === 0
        ? "On. No phone is connected right now."
        : `On. ${state.connectedPhones === 1 ? "A phone is" : `${state.connectedPhones} phones are`} connected now.`;
  }
}

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

/**
 * What phone access means, shown before it is turned on: what the relay can
 * and cannot see, and that a phone can do what this Mac's keyboard can.
 */
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
          The relay forwards encrypted data it cannot read. The phone app itself
          is a web page that comes from the relay.
        </p>
        <p>
          A paired phone can do anything on this Mac that you can at its
          keyboard: it can open a terminal and run any command. Pair only your
          own phone, and remove a lost one here.
        </p>
      </div>
    </aside>
  );
}

/** The name the phone shows in its title bar for this Mac. */
function MacNameField({
  name,
  busy,
  onSave,
}: {
  name: string;
  busy: boolean;
  onSave: (name: string) => void;
}) {
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const changed = draft.trim() !== name;
  return (
    <form
      className="settings-choice remote-name"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed) onSave(draft);
      }}
    >
      <span>
        <strong>Name on your phone</strong>
        <small>
          What your phone calls this Mac. Leave it empty for the computer's own
          name.
        </small>
      </span>
      <span className="remote-name-edit">
        <input
          aria-label="Name on your phone"
          disabled={busy}
          maxLength={60}
          onChange={(event) => setDraft(event.target.value)}
          value={draft}
        />
        {changed ? (
          <button disabled={busy} type="submit">
            Save
          </button>
        ) : undefined}
      </span>
    </form>
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

/** A phone that scanned the code; the user compares six digits and decides. */
function PairingRequest({
  request,
  account,
  busy,
  onAnswer,
}: {
  request: NonNullable<RemoteStateDto["pairingRequest"]>;
  account: string | undefined;
  busy: boolean;
  onAnswer: (allow: boolean) => void;
}) {
  const left = useCountdown(request.expiresAt);
  return (
    <div
      className="remote-request"
      role="alertdialog"
      aria-label="Pair a phone"
    >
      <p>
        <strong>{request.phoneName || "A phone"}</strong> wants to pair with
        this Mac{account ? ` on ${account}` : ""}.
      </p>
      <p>Allow it only if your phone shows this code:</p>
      <p className="remote-request-code">
        {request.code.slice(0, 3)} {request.code.slice(3)}
      </p>
      <small>
        If the code differs, or you did not just scan the code, decline.
        Declining the first phone also takes this Mac off that account.{" "}
        {minutes(left)} left.
      </small>
      <div className="remote-pairing-actions">
        <button disabled={busy} onClick={() => onAnswer(true)} type="button">
          Allow
        </button>
        <button
          className="quiet"
          disabled={busy}
          onClick={() => onAnswer(false)}
          type="button"
        >
          Decline
        </button>
      </div>
    </div>
  );
}

const ACTIONS: Record<string, string> = {
  "terminal.open": "Opened a terminal",
  "terminal.close": "Closed a terminal",
  agentSpawn: "Started a session",
  agentSend: "Sent a message",
  agentStop: "Stopped a session",
  taskCreate: "Created a task",
  taskUpdate: "Edited a task",
  taskSetStatus: "Moved a task",
};

/** The audit log's latest entries; reading the board is left out. */
function RecentActivity({ entries }: { entries: RemoteActivityDto[] }) {
  const shown = entries.filter(
    (entry) =>
      ![
        "snapshot",
        "workspaceGet",
        "taskGet",
        "taskTimeline",
        "agentGet",
        "agentModels",
      ].includes(entry.action),
  );
  if (shown.length === 0) return <p className="remote-empty">Nothing yet.</p>;
  return (
    <ul className="remote-activity">
      {shown.slice(0, 20).map((entry) => (
        <li key={`${entry.at}-${entry.action}-${entry.target ?? ""}`}>
          <time dateTime={entry.at}>
            {new Date(entry.at).toLocaleString(undefined, {
              dateStyle: "short",
              timeStyle: "short",
            })}
          </time>
          <span>
            {entry.phone || "Phone"}: {ACTIONS[entry.action] ?? entry.action}
            {entry.ok ? "" : ` (failed${entry.code ? `, ${entry.code}` : ""})`}
            {entry.bytesIn !== undefined
              ? `, ${entry.bytesIn} characters typed`
              : ""}
          </span>
        </li>
      ))}
    </ul>
  );
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
  const [activity, setActivity] = useState<RemoteActivityDto[]>([]);
  const [error, setError] = useState<string>();
  const left = useCountdown(pairing?.expiresAt);

  const refresh = useCallback(async () => {
    const [result, recent] = await Promise.all([
      client.request.remoteGet({}),
      client.request.remoteActivity({}),
    ]);
    if (result.ok) setState(result.data);
    if (recent.ok) setActivity(recent.data);
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
  // The code is spent once a phone uses it; the request takes its place.
  const request = state?.pairingRequest;
  useEffect(() => {
    if (request) setPairing(undefined);
  }, [request]);

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
        <p className="remote-status" data-look={remoteLook(state)}>
          <span aria-hidden="true" className="remote-status-dot" />
          {remoteStatusText(state)}
          {relayHost ? <code>{relayHost}</code> : undefined}
        </p>
      ) : undefined}
      {state?.status === "removed" ? (
        <div className="remote-pairing-start">
          <button
            disabled={busy}
            onClick={async () => {
              const next = await perform(client.request.remoteStartOver({}));
              if (next) setState(next);
            }}
            type="button"
          >
            Start over
          </button>
          <small>
            Makes this Mac a new device with no paired phones. The old details
            are kept in remote/device.json.removed.
          </small>
        </div>
      ) : undefined}
      {state?.enabled && state.account ? (
        <div className="settings-choice remote-account">
          <span>
            <strong>Account</strong>
            <small>
              This Mac is on {state.account}'s account on the relay. Only phones
              signed in to it can reach this Mac.
            </small>
          </span>
          <ConfirmButton
            armedLabel="Leave"
            armedTitle="Take this Mac off the account and forget every paired phone"
            className="quiet"
            disabled={busy}
            onConfirm={async () => {
              const next = await perform(client.request.remoteLeaveAccount({}));
              if (next) setState(next);
            }}
            type="button"
          >
            Leave this account
          </ConfirmButton>
        </div>
      ) : undefined}
      {state?.enabled ? (
        <MacNameField
          busy={busy}
          name={state.macName}
          onSave={async (name) => {
            const next = await perform(
              client.request.remoteSetMacName({ name }),
            );
            if (next) setState(next);
          }}
        />
      ) : undefined}
      {state?.enabled ? (
        <SettingRow
          checked={state.keepAwake}
          disabled={busy}
          description="Stops this Mac from going to sleep on its own while phone access is on, so your sessions keep running and can reach your phone. The display still turns off, and closing a laptop's lid still puts it to sleep."
          onChange={async (enabled) => {
            const next = await perform(
              client.request.remoteSetKeepAwake({ enabled }),
            );
            if (next) setState(next);
          }}
          title="Keep the Mac awake while away"
        />
      ) : undefined}

      {state?.enabled ? (
        <>
          <h3>Pair a phone</h3>
          {request ? (
            <PairingRequest
              account={state.account}
              busy={busy}
              onAnswer={async (allow) => {
                const next = await perform(
                  client.request.remoteConfirmPairing({ allow }),
                );
                if (next) setState(next);
              }}
              request={request}
            />
          ) : pairing ? (
            <div className="remote-pairing">
              <QrCode label="Pairing code" text={pairing.url} />
              <div>
                <p>
                  Scan this with your phone's camera and sign in. Anyone who
                  sees this code can ask to pair, so you will be asked to allow
                  the phone here. The code works once and expires in{" "}
                  {minutes(left)}.
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

          <h3>Recent phone activity</h3>
          <RecentActivity entries={activity} />
        </>
      ) : undefined}
    </div>
  );
}
