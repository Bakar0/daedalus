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
  type AdminLogEntryDto,
  formatInviteCode,
  inviteCodeComplete,
  type RemoteStateDto,
  type RpcResult,
} from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { ConfirmButton } from "./ConfirmButton";
import { Menu, MenuDots } from "./Menu";
import { repositoryFuzzyScore } from "./repository-search";

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
      {state?.admin ? (
        <>
          <h3 className="admin-title">
            Admin <span className="admin-only">only you see this</span>
          </h3>
          <AdminSection busy={busy} client={client} />
        </>
      ) : undefined}
    </div>
  );
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

/** A whole number from a field, or undefined when it is empty or not one. */
const wholeNumber = (text: string): number | undefined => {
  const value = Number(text);
  return text.trim() && Number.isInteger(value) && value > 0
    ? value
    : undefined;
};

/**
 * "1/3 used · 7-day Pro · until Oct 17". The relay lists only keys that
 * still work, and removes a key once it is used up or expired.
 */
function keyLine(key: AdminKeyDto): string {
  return [
    `${key.used}/${key.maxUses} used`,
    key.grantDays ? `${key.grantDays}-day Pro` : "Pro",
    ...(key.expiresAt ? [`until ${shortDate(key.expiresAt)}`] : []),
  ].join(" · ");
}

/** "Created Dana's trial (3 uses, 14-day Pro)", "Ended friend@…'s plan". */
function logLine(entry: AdminLogEntryDto): string {
  const key = entry.detail.name || entry.target;
  switch (entry.action) {
    case "invites.create":
      return `Created ${key} (${entry.detail.maxUses ?? 1} ${entry.detail.maxUses === 1 ? "use" : "uses"}, ${entry.detail.grantDays ? `${entry.detail.grantDays}-day Pro` : "Pro"})`;
    case "invites.delete":
      return `Deleted ${key}`;
    case "invites.rename":
      return `Renamed ${entry.target} to ${entry.detail.name || "no name"}`;
    case "plan.set":
      return entry.detail.status === "revoked"
        ? `Revoked ${entry.target}`
        : entry.detail.status === "expired"
          ? `Ended ${entry.target}'s plan`
          : `Gave ${entry.target} ${entry.detail.days ? `${entry.detail.days} days of Pro` : "Pro"}`;
  }
}

/** "Pro until Oct 19", "Admin", "Pro · ended" or "No plan". */
function accountLine(account: AdminAccountDto): string {
  if (!account.plan) return "No plan";
  const name = `${account.plan.slice(0, 1).toUpperCase()}${account.plan.slice(1)}`;
  if (account.status === "revoked") return `${name} · revoked`;
  if (
    account.status !== "active" ||
    (account.expiresAt && Date.parse(account.expiresAt) <= Date.now())
  )
    return `${name} · ended`;
  return account.expiresAt
    ? `${name} until ${shortDate(account.expiresAt)}`
    : name;
}

/**
 * For accounts on the relay's admin list: make and remove Pro keys (invite
 * codes), and grant, end or revoke an account's plan. Each row is one line
 * with its actions in a menu, so long lines never push them around.
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
  const [activity, setActivity] = useState<AdminLogEntryDto[]>();
  const [error, setError] = useState<string>();
  const [made, setMade] = useState<string>();
  const [copied, setCopied] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ uses: "1", trial: "", note: "" });
  const [renaming, setRenaming] = useState<{ code: string; name: string }>();
  const [filter, setFilter] = useState("");

  // The repository picker's fuzzy matcher, as in Settings › Skills: the
  // name (a key's name or code, an account's email) ranks ahead of the
  // rest of the line.
  const ranked = <T,>(
    items: T[],
    name: (item: T) => string,
    details: (item: T) => string,
  ) =>
    filter.trim()
      ? items
          .map((item) => ({
            item,
            score: repositoryFuzzyScore(filter, name(item), details(item)),
          }))
          .filter(
            (entry): entry is { item: T; score: number } =>
              entry.score !== undefined,
          )
          .sort((left, right) => right.score - left.score)
          .map((entry) => entry.item)
      : items;
  const shownKeys = ranked(
    keys ?? [],
    (key) => key.note || key.code,
    (key) => `${key.code} ${keyLine(key)}`,
  );
  const shownAccounts = ranked(
    accounts ?? [],
    (account) => account.email,
    accountLine,
  );

  const load = useCallback(async () => {
    const [keyList, accountList, log] = await Promise.all([
      client.request.remoteAdminKeys({}),
      client.request.remoteAdminAccounts({}),
      client.request.remoteAdminLog({}),
    ]);
    if (log.ok) setActivity(log.data);
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
  const setPlan = (
    email: string,
    status: "active" | "expired" | "revoked",
    days = 0,
  ) =>
    void run(
      client.request.remoteAdminSetPlan({
        email,
        status,
        ...(status === "active" ? { days } : {}),
      }),
    );

  return (
    <div className="admin-section">
      <input
        aria-label="Filter keys and accounts"
        className="admin-filter"
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filter keys and accounts"
        type="search"
        value={filter}
      />
      <div className="admin-heading">
        <h3>Pro keys</h3>
        {creating ? undefined : (
          <button
            className="quiet"
            disabled={busy}
            onClick={() => setCreating(true)}
            type="button"
          >
            New key
          </button>
        )}
      </div>
      {creating ? (
        <form
          className="admin-key-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const trial = wholeNumber(form.trial);
            const created = await run(
              client.request.remoteAdminCreateKey({
                maxUses: wholeNumber(form.uses) ?? 1,
                ...(trial ? { grantDays: trial } : {}),
                days: 30,
                note: form.note.trim(),
              }),
            );
            if (created) {
              setMade(created.code);
              setCopied(undefined);
              setCreating(false);
              setForm({ uses: "1", trial: "", note: "" });
            }
          }}
        >
          <input
            aria-label="Uses"
            className="admin-uses"
            inputMode="numeric"
            onChange={(event) => setForm({ ...form, uses: event.target.value })}
            title="How many accounts can use it"
            value={form.uses}
          />
          <input
            aria-label="Pro for how many days"
            className="admin-trial"
            inputMode="numeric"
            onChange={(event) =>
              setForm({ ...form, trial: event.target.value })
            }
            placeholder="Days of Pro"
            title="How long the Pro it gives lasts; empty for no end"
            value={form.trial}
          />
          <input
            aria-label="Name"
            onChange={(event) => setForm({ ...form, note: event.target.value })}
            placeholder="Name, e.g. Dana's trial"
            value={form.note}
          />
          <button disabled={busy} type="submit">
            Create
          </button>
          <button
            className="quiet"
            onClick={() => setCreating(false)}
            type="button"
          >
            Cancel
          </button>
          <small>
            Uses, days of Pro (empty for no end), a name. A key works for 30
            days.
          </small>
        </form>
      ) : undefined}
      {made ? (
        <p className="admin-made">
          Created <code>{made}</code>
          <button
            className="quiet"
            onClick={() => void copy(made)}
            type="button"
          >
            {copied === made ? "Copied" : "Copy"}
          </button>
        </p>
      ) : undefined}
      {keys === undefined ? undefined : shownKeys.length === 0 ? (
        <p className="remote-empty">
          {keys.length === 0 ? "No keys yet." : "No keys match."}
        </p>
      ) : (
        <ul className="admin-list admin-keys">
          {shownKeys.map((key) => {
            const line = keyLine(key);
            if (renaming?.code === key.code)
              return (
                <li className="is-renaming" key={key.code}>
                  <form
                    className="admin-rename"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      await run(
                        client.request.remoteAdminRenameKey({
                          code: key.code,
                          name: renaming.name.trim(),
                        }),
                      );
                      setRenaming(undefined);
                    }}
                  >
                    <input
                      aria-label={`Name for ${key.code}`}
                      autoFocus
                      onChange={(event) =>
                        setRenaming({
                          code: key.code,
                          name: event.target.value,
                        })
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setRenaming(undefined);
                        }
                      }}
                      placeholder={key.code}
                      value={renaming.name}
                    />
                    <button disabled={busy} type="submit">
                      Save
                    </button>
                    <button
                      className="quiet"
                      onClick={() => setRenaming(undefined)}
                      type="button"
                    >
                      Cancel
                    </button>
                  </form>
                </li>
              );
            return (
              <li key={key.code}>
                <span className="admin-key-name">
                  {key.note ? (
                    <strong title={key.note}>{key.note}</strong>
                  ) : undefined}
                  <code>{key.code}</code>
                </span>
                <small title={line}>{line}</small>
                <Menu
                  align="end"
                  label={`Actions for ${key.code}`}
                  menuLabel={`Actions for ${key.code}`}
                  summary={<MenuDots />}
                  summaryClassName="quiet admin-row-menu"
                >
                  <button
                    className="quiet menu-item"
                    onClick={() => void copy(key.code)}
                    role="menuitem"
                    type="button"
                  >
                    <span className="menu-item-label">Copy</span>
                  </button>
                  <button
                    className="quiet menu-item"
                    onClick={() =>
                      setRenaming({ code: key.code, name: key.note })
                    }
                    role="menuitem"
                    type="button"
                  >
                    <span className="menu-item-label">Rename…</span>
                  </button>
                  <button
                    className="quiet menu-item menu-item-danger"
                    onClick={() =>
                      void run(
                        client.request.remoteAdminDeleteKey({ code: key.code }),
                      )
                    }
                    role="menuitem"
                    type="button"
                  >
                    <span className="menu-item-label">Delete</span>
                  </button>
                </Menu>
              </li>
            );
          })}
        </ul>
      )}

      <div className="admin-heading">
        <h3>Accounts</h3>
      </div>
      {accounts === undefined ? undefined : shownAccounts.length === 0 ? (
        <p className="remote-empty">No accounts match.</p>
      ) : (
        <ul className="admin-list admin-accounts">
          {shownAccounts.map((account) => (
            <li key={account.id}>
              <strong title={account.email}>{account.email}</strong>
              <small>{accountLine(account)}</small>
              <Menu
                align="end"
                label={`Plan for ${account.email}`}
                menuLabel={`Plan for ${account.email}`}
                summary={<MenuDots />}
                summaryClassName="quiet admin-row-menu"
              >
                <button
                  className="quiet menu-item"
                  onClick={() => setPlan(account.email, "active")}
                  role="menuitem"
                  type="button"
                >
                  <span className="menu-item-label">Pro, no end</span>
                </button>
                <button
                  className="quiet menu-item"
                  onClick={() => setPlan(account.email, "active", 30)}
                  role="menuitem"
                  type="button"
                >
                  <span className="menu-item-label">Pro for 30 days</span>
                </button>
                <button
                  className="quiet menu-item"
                  onClick={() => setPlan(account.email, "active", 7)}
                  role="menuitem"
                  type="button"
                >
                  <span className="menu-item-label">Pro for 7 days</span>
                </button>
                <hr className="menu-separator" />
                <button
                  className="quiet menu-item"
                  onClick={() => setPlan(account.email, "expired")}
                  role="menuitem"
                  type="button"
                >
                  <span className="menu-item-label">End plan</span>
                </button>
                <button
                  className="quiet menu-item menu-item-danger"
                  onClick={() => setPlan(account.email, "revoked")}
                  role="menuitem"
                  title="Ends the plan and every sign-in; invite codes stop working for it"
                  type="button"
                >
                  <span className="menu-item-label">Revoke</span>
                </button>
              </Menu>
            </li>
          ))}
        </ul>
      )}
      {activity?.length ? (
        <details className="admin-activity">
          <summary>Activity</summary>
          <ul>
            {activity.slice(0, 30).map((entry) => (
              <li key={`${entry.at}-${entry.action}-${entry.target}`}>
                <time dateTime={entry.at}>
                  {new Date(entry.at).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </time>
                <span title={entry.actor}>{logLine(entry)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : undefined}
      {error ? (
        <p className="accounts-error" role="alert">
          {error}
        </p>
      ) : undefined}
    </div>
  );
}
