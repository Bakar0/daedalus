/**
 * Daedalus Pro on the Mac: the account and plan page (Settings › Account),
 * the badge by the logo, and the tag on Pro features. The relay is what
 * enforces the plan; these only show it and lead to where it is changed.
 *
 * The plan comes with the remote state (`remoteGet`): the account the Mac
 * signed in to and its plan, as the relay last reported them.
 */
import { useCallback, useEffect, useState } from "react";
import type { RemoteStateDto, RpcResult } from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { ConfirmButton } from "./ConfirmButton";

/** Whether the Mac's account has a plan that lets phones in right now. */
export const hasPlan = (state: RemoteStateDto | undefined): boolean =>
  Boolean(state?.signedIn && state.plan && state.lockedBy !== "no_plan");

/** "Pro plan" or "Pro plan until Nov 1, 2026". */
export function planText(plan: { name: string; expiresAt: string | null }) {
  const name = `${plan.name.slice(0, 1).toUpperCase()}${plan.name.slice(1)} plan`;
  return plan.expiresAt
    ? `${name} until ${new Date(plan.expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`
    : name;
}

/** The remote state, asked again every `pollMs` while mounted. */
export function useRemoteState(
  client: DesktopClient,
  pollMs: number,
): [RemoteStateDto | undefined, (state: RemoteStateDto) => void] {
  const [state, setState] = useState<RemoteStateDto>();
  const refresh = useCallback(async () => {
    // A host without phone access (a test page) has no answer to give.
    const result = await client.request.remoteGet({}).catch(() => undefined);
    if (result?.ok) setState(result.data);
  }, [client]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollMs);
    return () => window.clearInterval(timer);
  }, [refresh, pollMs]);
  return [state, setState];
}

/** Marks a Pro feature, in a menu, a tab or a heading. */
export function ProTag() {
  return <span className="pro-tag">Pro</span>;
}

/**
 * Next to the logo: "Pro" when the account has it, else a Get Pro button.
 * Both open Settings › Account.
 */
export function ProBadge({
  client,
  onOpen,
}: {
  client: DesktopClient;
  onOpen: () => void;
}) {
  const [state] = useRemoteState(client, 5_000);
  if (!state) return null;
  return hasPlan(state) ? (
    <button
      className="quiet pro-badge"
      onClick={onOpen}
      title={state.plan ? planText(state.plan) : "Daedalus Pro"}
      type="button"
    >
      Pro
    </button>
  ) : (
    <button className="quiet pro-badge get-pro" onClick={onOpen} type="button">
      Get Pro
    </button>
  );
}

const PRO_FEATURES = [
  "Phone access: watch and steer this Mac's sessions from anywhere",
  "A live terminal and the board on your phone, end-to-end encrypted",
  "Notifications on your phone when a session needs you",
];

const FREE_FEATURES = [
  "The board, sessions and terminals on this Mac",
  "Every agent, the CLI, skills and worktrees",
];

/** Settings › Account: who this Mac is signed in as, and the plan. */
export function AccountPanel({
  busy,
  client,
  perform,
}: {
  busy: boolean;
  client: DesktopClient;
  perform: <T>(operation: Promise<RpcResult<T>>) => Promise<T | undefined>;
}) {
  const [state, setState] = useRemoteState(client, 2_000);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [signingIn, setSigningIn] = useState(false);

  // The plan may have changed elsewhere (an invite on the phone, a plan
  // that ended): ask the relay when the page opens.
  useEffect(() => {
    void client.request
      .remoteRefreshAccount({})
      .then((result) => {
        if (result.ok) setState(result.data);
      })
      .catch(() => undefined);
  }, [client, setState]);
  useEffect(() => {
    if (state?.signedIn) setSigningIn(false);
  }, [state?.signedIn]);

  const pro = hasPlan(state);

  return (
    <div className="account-panel">
      <h3>Account</h3>
      {!state ? undefined : state.signedIn ? (
        <div className="settings-choice account-who">
          <span>
            <strong>{state.account ?? "Signed in"}</strong>
            <small>
              {pro && state.plan
                ? planText(state.plan)
                : "Free. This account has no Pro plan."}
            </small>
          </span>
          <ConfirmButton
            armedLabel="Sign out"
            armedTitle="Sign this Mac out; paired phones are forgotten"
            className="quiet"
            disabled={busy}
            onConfirm={async () => {
              const next = await perform(client.request.remoteLeaveAccount({}));
              if (next) setState(next);
            }}
            type="button"
          >
            Sign out
          </ConfirmButton>
        </div>
      ) : (
        <div className="account-signin">
          <p>
            Sign in with Google to use Daedalus Pro on this Mac. Use the same
            account on your phone.
          </p>
          <div className="account-actions">
            <button
              disabled={busy || signingIn}
              onClick={async () => {
                setError(undefined);
                setSigningIn(true);
                const started = await client.request.remoteSignIn({});
                if (!started.ok) {
                  setSigningIn(false);
                  setError(started.error.message);
                  return;
                }
                await client.request.openExternal({ url: started.data.url });
              }}
              type="button"
            >
              Sign in with Google
            </button>
            <small>
              {signingIn
                ? "Finish in your browser, then come back here."
                : "Opens your browser. Signing in connects this Mac to the Daedalus relay."}
            </small>
          </div>
        </div>
      )}

      <h3>Plan</h3>
      <div className="plan-cards">
        <section className={`plan-card ${pro ? "" : "is-current"}`}>
          <header>
            <strong>Free</strong>
            {pro ? undefined : <span className="plan-current">Current</span>}
          </header>
          <ul>
            {FREE_FEATURES.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
        </section>
        <section className={`plan-card pro ${pro ? "is-current" : ""}`}>
          <header>
            <strong>Pro</strong>
            {pro ? <span className="plan-current">Current</span> : undefined}
          </header>
          <ul>
            <li>Everything in Free</li>
            {PRO_FEATURES.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
          {pro ? (
            <p className="plan-note">
              {state?.plan ? planText(state.plan) : "Pro"}. Thank you.
            </p>
          ) : state?.signedIn ? (
            <form
              className="plan-get"
              onSubmit={async (event) => {
                event.preventDefault();
                setError(undefined);
                const next = await client.request.remoteRedeemInvite({ code });
                if (!next.ok) {
                  setError(next.error.message);
                  return;
                }
                setState(next.data);
                setCode("");
              }}
            >
              <p className="plan-note">
                Paid plans are coming. For now, Pro comes with an invite code.
              </p>
              <div className="plan-get-row">
                <input
                  aria-label="Invite code"
                  disabled={busy}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="Invite code"
                  value={code}
                />
                <button disabled={busy || !code.trim()} type="submit">
                  Get Pro
                </button>
              </div>
            </form>
          ) : (
            <p className="plan-note">Sign in above to get Pro.</p>
          )}
        </section>
      </div>
      {error ? (
        <p className="accounts-error" role="alert">
          {error}
        </p>
      ) : undefined}
    </div>
  );
}
