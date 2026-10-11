/**
 * Daedalus Pro on the Mac: the account and plan page (Settings › Account),
 * the badge by the logo, and the tag on Pro features. The relay is what
 * enforces the plan; these only show it and lead to where it is changed.
 *
 * The plan comes with the remote state (`remoteGet`): the account the Mac
 * signed in to and its plan, as the relay last reported them.
 */
import { useCallback, useEffect, useState } from "react";
import {
  type AdminAccountDto,
  type AdminKeyDto,
  formatInviteCode,
  inviteCodeComplete,
  type RemoteStateDto,
  type RpcResult,
} from "@daedalus/protocol";
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
                  maxLength={11}
                  onChange={(event) =>
                    setCode(formatInviteCode(event.target.value))
                  }
                  placeholder="XXXXX-XXXXX"
                  spellCheck={false}
                  value={code}
                />
                <button
                  disabled={busy || !inviteCodeComplete(code)}
                  type="submit"
                >
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
      {state?.admin ? <AdminSection busy={busy} client={client} /> : undefined}
    </div>
  );
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

/** A whole number from a field, or undefined when it is empty or not one. */
const wholeNumber = (text: string): number | undefined => {
  const value = Number(text);
  return text.trim() && Number.isInteger(value) && value > 0
    ? value
    : undefined;
};

/**
 * For accounts on the relay's admin list: make and remove Pro keys (invite
 * codes), and grant, end or revoke an account's plan.
 */
function AdminSection({
  busy,
  client,
}: {
  busy: boolean;
  client: DesktopClient;
}) {
  const [keys, setKeys] = useState<AdminKeyDto[]>();
  const [accounts, setAccounts] = useState<AdminAccountDto[]>();
  const [error, setError] = useState<string>();
  const [made, setMade] = useState<string>();
  const [copied, setCopied] = useState<string>();
  const [form, setForm] = useState({
    uses: "1",
    trial: "",
    valid: "30",
    note: "",
  });
  const [grantDays, setGrantDays] = useState("");

  const load = useCallback(async () => {
    const [keyList, accountList] = await Promise.all([
      client.request.remoteAdminKeys({}),
      client.request.remoteAdminAccounts({}),
    ]);
    if (keyList.ok) setKeys(keyList.data);
    else setError(keyList.error.message);
    if (accountList.ok) setAccounts(accountList.data);
    else setError(accountList.error.message);
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async <T,>(operation: Promise<RpcResult<T>>) => {
    setError(undefined);
    const result = await operation;
    if (!result.ok) {
      setError(result.error.message);
      return undefined;
    }
    await load();
    return result.data;
  };
  const copy = async (code: string) => {
    const result = await client.request.clipboardWrite({ text: code });
    if (result.ok) setCopied(code);
  };

  return (
    <div className="admin-section">
      <h3>Admin: Pro keys</h3>
      <form
        className="admin-key-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const trial = wholeNumber(form.trial);
          const valid = wholeNumber(form.valid);
          const created = await run(
            client.request.remoteAdminCreateKey({
              maxUses: wholeNumber(form.uses) ?? 1,
              ...(trial ? { grantDays: trial } : {}),
              ...(valid ? { days: valid } : {}),
              note: form.note.trim(),
            }),
          );
          if (created) {
            setMade(created.code);
            setCopied(undefined);
            setForm((current) => ({ ...current, note: "" }));
          }
        }}
      >
        <label>
          <span>Uses</span>
          <input
            inputMode="numeric"
            onChange={(event) => setForm({ ...form, uses: event.target.value })}
            value={form.uses}
          />
        </label>
        <label>
          <span>Pro for (days)</span>
          <input
            inputMode="numeric"
            onChange={(event) =>
              setForm({ ...form, trial: event.target.value })
            }
            placeholder="No end"
            value={form.trial}
          />
        </label>
        <label>
          <span>Key works for (days)</span>
          <input
            inputMode="numeric"
            onChange={(event) =>
              setForm({ ...form, valid: event.target.value })
            }
            placeholder="No limit"
            value={form.valid}
          />
        </label>
        <label className="admin-key-note">
          <span>Note</span>
          <input
            onChange={(event) => setForm({ ...form, note: event.target.value })}
            placeholder="Who it is for"
            value={form.note}
          />
        </label>
        <button disabled={busy} type="submit">
          Create key
        </button>
      </form>
      {made ? (
        <p className="admin-made">
          New key <code>{made}</code>
          <button
            className="quiet"
            onClick={() => void copy(made)}
            type="button"
          >
            {copied === made ? "Copied" : "Copy"}
          </button>
        </p>
      ) : undefined}
      {keys === undefined ? undefined : keys.length === 0 ? (
        <p className="remote-empty">No keys yet.</p>
      ) : (
        <ul className="accounts-list admin-keys">
          {keys.map((key) => (
            <li key={key.code}>
              <span className="accounts-who">
                <strong>
                  <code>{key.code}</code>
                </strong>
                <small>
                  {key.used} of {key.maxUses} used ·{" "}
                  {key.grantDays
                    ? `Pro for ${key.grantDays} days`
                    : "Pro, no end"}
                  {" · "}
                  {key.expiresAt
                    ? `${Date.parse(key.expiresAt) < Date.now() ? "expired" : "works until"} ${shortDate(key.expiresAt)}`
                    : "works until used up"}
                  {key.note ? ` · ${key.note}` : ""}
                </small>
              </span>
              <span className="accounts-actions">
                <button
                  className="quiet"
                  onClick={() => void copy(key.code)}
                  type="button"
                >
                  {copied === key.code ? "Copied" : "Copy"}
                </button>
                <ConfirmButton
                  armedLabel="Delete"
                  armedTitle={`Delete ${key.code}; plans it already gave stay`}
                  className="quiet"
                  disabled={busy}
                  onConfirm={() =>
                    void run(
                      client.request.remoteAdminDeleteKey({ code: key.code }),
                    )
                  }
                  type="button"
                >
                  Delete
                </ConfirmButton>
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3>Admin: accounts</h3>
      <label className="admin-grant-days">
        <span>Grant Pro for (days)</span>
        <input
          inputMode="numeric"
          onChange={(event) => setGrantDays(event.target.value)}
          placeholder="No end"
          value={grantDays}
        />
      </label>
      {accounts === undefined ? undefined : (
        <ul className="accounts-list admin-accounts">
          {accounts.map((account) => {
            const active =
              account.status === "active" &&
              (!account.expiresAt ||
                Date.parse(account.expiresAt) > Date.now());
            const setPlan = (status: "active" | "expired" | "revoked") =>
              void run(
                client.request.remoteAdminSetPlan({
                  email: account.email,
                  status,
                  ...(status === "active"
                    ? { days: wholeNumber(grantDays) ?? 0 }
                    : {}),
                }),
              );
            return (
              <li key={account.id}>
                <span className="accounts-who">
                  <strong>{account.email}</strong>
                  <small>
                    {account.plan
                      ? `${account.plan.slice(0, 1).toUpperCase()}${account.plan.slice(1)}`
                      : "No plan"}
                    {account.plan && !active
                      ? account.status === "revoked"
                        ? " · revoked"
                        : " · ended"
                      : account.expiresAt
                        ? ` until ${shortDate(account.expiresAt)}`
                        : ""}
                    {account.source ? ` · by ${account.source}` : ""}
                    {` · joined ${shortDate(account.createdAt)}`}
                  </small>
                </span>
                <span className="accounts-actions">
                  <button
                    className="quiet"
                    disabled={busy}
                    onClick={() => setPlan("active")}
                    type="button"
                  >
                    {active ? "Set Pro" : "Grant Pro"}
                  </button>
                  {active ? (
                    <ConfirmButton
                      armedLabel="End plan"
                      armedTitle={`End ${account.email}'s plan now; an invite code renews it`}
                      className="quiet"
                      disabled={busy}
                      onConfirm={() => setPlan("expired")}
                      type="button"
                    >
                      End plan
                    </ConfirmButton>
                  ) : undefined}
                  {account.status === "revoked" ? undefined : (
                    <ConfirmButton
                      armedLabel="Revoke"
                      armedTitle={`Revoke ${account.email}: ends its plan and sign-ins, and invite codes stop working for it`}
                      className="quiet danger-link"
                      disabled={busy}
                      onConfirm={() => setPlan("revoked")}
                      type="button"
                    >
                      Revoke
                    </ConfirmButton>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {error ? (
        <p className="accounts-error" role="alert">
          {error}
        </p>
      ) : undefined}
    </div>
  );
}
