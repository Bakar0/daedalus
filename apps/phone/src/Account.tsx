import { useEffect, useState } from "react";
import { type PairedMac, RelayAccount } from "@daedalus/remote-protocol";
import { PushControl } from "./PushControl";
import { Shell } from "./Shell";
import { phoneIdentity, removeMac } from "./storage";

type Me = Awaited<ReturnType<RelayAccount["me"]>>;

/** Who is signed in, the plan and its use this month, and the devices. */
export function Account({
  token,
  macs,
  onBack,
  onSignOut,
}: {
  token: string;
  macs: PairedMac[];
  onBack: () => void;
  onSignOut: () => void;
}) {
  const account = new RelayAccount(location.origin, token);
  const [me, setMe] = useState<Me>();
  const [error, setError] = useState<string>();
  const reload = () =>
    account.me().then(setMe, (failure: Error) => setError(failure.message));
  useEffect(() => {
    void reload();
  }, [token]);

  const thisPhone = phoneIdentity().id;
  const usedMb = me ? me.usageBytes / (1024 * 1024) : 0;

  return (
    <Shell onBack={onBack} title="Account">
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : undefined}
      {me ? (
        <>
          <section className="group">
            <h2 className="group-title">Signed in</h2>
            <div className="card">
              <strong>{me.user.email}</strong>
              <small>
                {me.entitlement
                  ? `${me.entitlement.plan} plan · ${usedMb.toFixed(1)} of ${me.entitlement.monthlyMb} MB this month`
                  : "No active access"}
              </small>
            </div>
          </section>
          <PushControl token={token} />
          <section className="group">
            <h2 className="group-title">Devices</h2>
            <ul className="rows">
              {me.devices.map((device) => (
                <li className="row static" key={device.id}>
                  <span className="row-main">
                    <strong>
                      {device.kind === "mac"
                        ? (macs.find((mac) => mac.macId === device.id)
                            ?.macName ??
                          (device.name || "Mac"))
                        : device.name || "Phone"}
                      {device.id === thisPhone ? " (this phone)" : ""}
                    </strong>
                    <small>
                      {device.kind === "mac" ? "Mac" : "Phone"}
                      {device.lastSeenAt
                        ? ` · seen ${new Date(device.lastSeenAt).toLocaleDateString()}`
                        : ""}
                    </small>
                  </span>
                  <button
                    className="link danger"
                    onClick={async () => {
                      if (
                        !confirm(
                          device.kind === "mac"
                            ? "Remove this Mac from your account? It has to be paired again."
                            : "Remove this phone from your account? It can no longer connect.",
                        )
                      )
                        return;
                      await account.removeDevice(device.id);
                      if (device.kind === "mac") removeMac(device.id);
                      void reload();
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <button
            className="button"
            onClick={async () => {
              await account.signOut().catch(() => undefined);
              onSignOut();
            }}
          >
            Sign out
          </button>
        </>
      ) : error ? undefined : (
        <div className="spinner centered" />
      )}
    </Shell>
  );
}
