/**
 * Daedalus Pro on the Mac: the account and plan page (Settings › Account),
 * the badge by the logo, and the tag on Pro features. The relay is what
 * enforces the plan; these only show it and lead to where it is changed.
 *
 * Pro is invite-only: everything about it, phone access included, shows only
 * to an account that has a plan or is an admin (`showsPro`). Anyone else
 * sees the sign-in and nothing more.
 *
 * The plan comes with the remote state (`remoteGet`): the account the Mac
 * signed in to and its plan, as the relay last reported them.
 */
import { useEffect, useState } from "react";
import {
  type AdminAccountDto,
  type AdminKeyDto,
  type AdminLogEntryDto,
  formatInviteCode,
  inviteCodeComplete,
  inviteLink,
  type RemoteStateDto,
  type RpcResult,
} from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { ConfirmButton } from "./ConfirmButton";
import { Menu, MenuDots } from "./Menu";
import { repositoryFuzzyScore } from "./repository-search";
import { useMutation, useRpcQuery, type RpcQueryResult } from "./use-rpc";

/** Whether the Mac's account has a plan that lets phones in right now. */
export const hasPlan = (state: RemoteStateDto | undefined): boolean =>
  Boolean(state?.signedIn && state.plan && state.lockedBy !== "no_plan");

/**
 * Whether this Mac shows anything about Pro: its account has a plan or is
 * an admin. An admin gives plans from the admin section.
 */
export const showsPro = (state: RemoteStateDto | undefined): boolean =>
  Boolean(state?.signedIn && (state.admin || hasPlan(state)));

/** "Pro plan" or "Pro plan until Nov 1, 2026". */
export function planText(plan: { name: string; expiresAt: string | null }) {
  const name = `${plan.name.slice(0, 1).toUpperCase()}${plan.name.slice(1)} plan`;
  return plan.expiresAt
    ? `${name} until ${new Date(plan.expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`
    : name;
}

/**
 * The remote state, asked again every `pollMs` while mounted. A host without
 * phone access (a test page) has no answer to give, so `data` stays empty.
 */
export function useRemoteState(
  client: DesktopClient,
  pollMs: number,
): RpcQueryResult<RemoteStateDto> {
  return useRpcQuery(() => client.request.remoteGet({}), {
    pollMs,
    deps: [client],
  });
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
  const { data: state } = useRemoteState(client, 5_000);
  if (!state || !showsPro(state)) return null;
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
  const { data: state, refresh } = useRemoteState(client, 2_000);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [signingIn, setSigningIn] = useState(false);

  // The plan may have changed elsewhere (an invite on the phone, a plan
  // that ended): ask the relay when the page opens.
  useEffect(() => {
    void client.request
      .remoteRefreshAccount({})
      .then((result) => {
        if (result.ok) void refresh();
      })
      .catch(() => undefined);
  }, [client, refresh]);
  useEffect(() => {
    if (state?.signedIn) setSigningIn(false);
  }, [state?.signedIn]);

  const pro = hasPlan(state);
  const visible = showsPro(state);

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
                : visible
                  ? "Free. This account has no Pro plan."
                  : "Signed in on this Mac."}
            </small>
          </span>
          <ConfirmButton
            armedLabel="Sign out"
            armedTitle="Sign this Mac out; paired phones are forgotten"
            className="quiet"
            disabled={busy}
            onConfirm={async () => {
              if (await perform(client.request.remoteLeaveAccount({})))
                await refresh();
            }}
            type="button"
          >
            Sign out
          </ConfirmButton>
        </div>
      ) : (
        <div className="account-signin">
          <p>
            Sign in with Google to connect this Mac to your Daedalus account.
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

      {visible ? (
        <>
          <h3>Plan</h3>
          <div className="plan-cards">
            <section className={`plan-card ${pro ? "" : "is-current"}`}>
              <header>
                <strong>Free</strong>
                {pro ? undefined : (
                  <span className="plan-current">Current</span>
                )}
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
                {pro ? (
                  <span className="plan-current">Current</span>
                ) : undefined}
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
                    const next = await client.request.remoteRedeemInvite({
                      code,
                    });
                    if (!next.ok) {
                      setError(next.error.message);
                      return;
                    }
                    await refresh();
                    setCode("");
                  }}
                >
                  <p className="plan-note">
                    Paid plans are coming. For now, Pro comes with an invite
                    code.
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
        </>
      ) : undefined}
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
          <AdminGate busy={busy} client={client} relay={state.relay} />
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
/** A new invite's fields: one person, 30 days of Pro, no name yet. */
const NEW_INVITE = { note: "", days: 30 as number | null, uses: "1" };

/** How long the Pro an invite gives lasts; null for no end. */
const INVITE_DAYS: Array<{ label: string; days: number | null }> = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "No end", days: null },
];

/** The invite just made, shown with its link until Done. */
interface MadeInvite {
  code: string;
  note: string;
  grantDays: number | null;
  maxUses: number;
}

/** "dana@example.com has Pro for 30 days.", after a plan change. */
function planNotice(
  email: string,
  status: "active" | "expired" | "revoked",
  days: number,
): string {
  if (status === "revoked")
    return `${email} is revoked: no Pro, signed out everywhere.`;
  if (status === "expired") return `${email} no longer has Pro.`;
  return days
    ? `${email} has Pro for ${days} days. Their Mac shows it the next time Settings › Account opens.`
    : `${email} has Pro with no end. Their Mac shows it the next time Settings › Account opens.`;
}

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
 * Sudo mode: the admin section opens only after a Google sign-in in the
 * browser, and locks again 15 minutes after the last change (an hour at
 * most), or on Lock. Until then the Mac's own sign-in is not enough.
 */
function AdminGate({
  busy,
  client,
  relay,
}: {
  busy: boolean;
  client: DesktopClient;
  relay: string;
}) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string>();
  const { data: status, refresh: check } = useRpcQuery(
    () => client.request.remoteAdminStatus({}),
    { pollMs: 3_000, deps: [client] },
  );
  const until = status?.unlockedUntil;
  useEffect(() => {
    if (until) setWaiting(false);
  }, [until]);

  if (until === undefined) return null;
  if (!until)
    return (
      <div className="admin-locked">
        <p>
          Admin is locked. Unlock it by signing in with Google as this Mac's
          account.
        </p>
        <div className="account-actions">
          <button
            disabled={busy || waiting}
            onClick={async () => {
              setError(undefined);
              const started = await client.request.remoteAdminUnlock({});
              if (!started.ok) {
                setError(started.error.message);
                return;
              }
              setWaiting(true);
              await client.request.openExternal({ url: started.data.url });
            }}
            type="button"
          >
            Unlock with Google
          </button>
          <small>
            {waiting
              ? "Finish in your browser, then come back here."
              : "Stays unlocked for 15 minutes after your last change, an hour at most."}
          </small>
        </div>
        {error ? (
          <p className="accounts-error" role="alert">
            {error}
          </p>
        ) : undefined}
      </div>
    );
  return (
    <>
      <p className="admin-unlocked">
        Unlocked until{" "}
        {new Date(until).toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        })}
        <button
          className="quiet"
          onClick={async () => {
            await client.request.remoteAdminLock({});
            await check();
          }}
          type="button"
        >
          Lock
        </button>
      </p>
      <AdminSection
        busy={busy}
        client={client}
        onChange={check}
        relay={relay}
      />
    </>
  );
}

/**
 * For accounts on the relay's admin list: make and remove Pro keys (invite
 * codes), and grant, end or revoke an account's plan. Each row is one line
 * with its actions in a menu, so long lines never push them around.
 *
 * A key goes out as a code or as an invite link (`inviteLink`): the link
 * opens the relay's page, which signs the person in with Google and gives
 * the account Pro on the way, with nothing to type.
 */
function AdminSection({
  busy,
  client,
  onChange,
  relay,
}: {
  busy: boolean;
  client: DesktopClient;
  /** A change moves the unlock's end on; the gate reads it again. */
  onChange: () => void;
  /** The relay's address, which invite links point at. */
  relay: string;
}) {
  const keyQuery = useRpcQuery(() => client.request.remoteAdminKeys({}), {
    deps: [client],
  });
  const accountQuery = useRpcQuery(
    () => client.request.remoteAdminAccounts({}),
    { deps: [client] },
  );
  const logQuery = useRpcQuery(() => client.request.remoteAdminLog({}), {
    deps: [client],
  });
  const keys = keyQuery.data;
  const accounts = accountQuery.data;
  const activity = logQuery.data;
  const [mutationError, setError] = useState<string>();
  const error = mutationError ?? keyQuery.error ?? accountQuery.error;
  const [made, setMade] = useState<MadeInvite>();
  const [copied, setCopied] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(NEW_INVITE);
  /** What the last plan change did, so a click on the menu shows a result. */
  const [notice, setNotice] = useState<string>();
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

  const { run } = useMutation({
    onStart: () => setError(undefined),
    onError: setError,
    onSettled: async ({ ok }) => {
      if (ok)
        await Promise.all([
          keyQuery.refresh(),
          accountQuery.refresh(),
          logQuery.refresh(),
        ]);
      onChange();
    },
  });
  /** Copies a key's code, or with `link` its invite link. */
  const copy = async (code: string, link = false) => {
    const result = await client.request.clipboardWrite({
      text: link ? inviteLink(relay, code) : code,
    });
    if (result.ok) setCopied(link ? `link:${code}` : code);
  };
  const setPlan = async (
    email: string,
    status: "active" | "expired" | "revoked",
    days = 0,
  ) => {
    setNotice(undefined);
    const done = await run(
      client.request.remoteAdminSetPlan({
        email,
        status,
        ...(status === "active" ? { days } : {}),
      }),
    );
    if (done !== undefined) setNotice(planNotice(email, status, days));
  };

  return (
    <div className="admin-section">
      <input
        aria-label="Filter invites and accounts"
        className="admin-filter"
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filter invites and accounts"
        type="search"
        value={filter}
      />
      <div className="admin-heading">
        <h3>Invites</h3>
        {creating ? undefined : (
          <button
            className="quiet"
            disabled={busy}
            onClick={() => {
              setMade(undefined);
              setCreating(true);
            }}
            type="button"
          >
            Invite someone
          </button>
        )}
      </div>
      {creating ? (
        <form
          className="admin-invite-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const input = {
              maxUses: wholeNumber(form.uses) ?? 1,
              ...(form.days ? { grantDays: form.days } : {}),
              days: 30,
              note: form.note.trim(),
            };
            const created = await run(
              client.request.remoteAdminCreateKey(input),
            );
            if (created) {
              setMade({
                code: created.code,
                note: input.note,
                grantDays: form.days,
                maxUses: input.maxUses,
              });
              setCopied(undefined);
              setCreating(false);
              setForm(NEW_INVITE);
            }
          }}
        >
          <label className="admin-field">
            <span>Who is it for</span>
            <input
              autoFocus
              onChange={(event) =>
                setForm({ ...form, note: event.target.value })
              }
              placeholder="Dana, or Design team"
              value={form.note}
            />
          </label>
          <div className="admin-field">
            <span id="admin-invite-days">Pro lasts</span>
            <div
              aria-labelledby="admin-invite-days"
              className="admin-choices"
              role="radiogroup"
            >
              {INVITE_DAYS.map((choice) => (
                <button
                  aria-checked={form.days === choice.days}
                  className={form.days === choice.days ? "is-current" : ""}
                  key={choice.label}
                  onClick={() => setForm({ ...form, days: choice.days })}
                  role="radio"
                  type="button"
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
          <label className="admin-field">
            <span>People who can use it</span>
            <input
              className="admin-uses"
              inputMode="numeric"
              onChange={(event) =>
                setForm({ ...form, uses: event.target.value })
              }
              value={form.uses}
            />
          </label>
          <p className="admin-hint">
            You get a link to send. The link stops working after 30 days, or
            once{" "}
            {wholeNumber(form.uses) === 1
              ? "it is used"
              : "all its uses are taken"}
            .
          </p>
          <div className="admin-form-actions">
            <button
              disabled={busy || wholeNumber(form.uses) === undefined}
              type="submit"
            >
              Create invite
            </button>
            <button
              className="quiet"
              onClick={() => setCreating(false)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : undefined}
      {made ? (
        <div className="admin-made">
          <strong>
            {made.note ? `Invite for ${made.note} is ready` : "Invite is ready"}
          </strong>
          <div className="admin-made-link">
            <code title={inviteLink(relay, made.code)}>
              {inviteLink(relay, made.code)}
            </code>
            <button onClick={() => void copy(made.code, true)} type="button">
              {copied === `link:${made.code}` ? "Copied" : "Copy link"}
            </button>
          </div>
          <ol>
            <li>Send them the link.</li>
            <li>
              They open it and sign in with Google. That account gets{" "}
              {made.grantDays
                ? `Pro for ${made.grantDays} days`
                : "Pro with no end"}
              {made.maxUses > 1 ? ` (up to ${made.maxUses} people)` : ""}.
            </li>
            <li>
              In Daedalus on their Mac, they sign in with the same Google
              account in Settings › Account.
            </li>
          </ol>
          <div className="admin-made-actions">
            <button
              className="quiet"
              onClick={() => void copy(made.code)}
              type="button"
            >
              {copied === made.code ? "Code copied" : `Copy code ${made.code}`}
            </button>
            <button
              className="quiet"
              onClick={() => setMade(undefined)}
              type="button"
            >
              Done
            </button>
          </div>
        </div>
      ) : undefined}
      {keys === undefined ? undefined : shownKeys.length === 0 ? (
        <p className="remote-empty">
          {keys.length === 0
            ? "No open invites. Invite someone to give them Pro."
            : "No invites match."}
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
                    onClick={() => void copy(key.code, true)}
                    role="menuitem"
                    type="button"
                  >
                    <span className="menu-item-label">Copy invite link</span>
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
      <p className="admin-hint">
        Everyone who has signed in. Use … on a row to give or end Pro directly,
        without an invite.
      </p>
      {notice ? (
        <p className="admin-notice" role="status">
          {notice}
        </p>
      ) : undefined}
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
                  onClick={() => void setPlan(account.email, "active")}
                  role="menuitem"
                  type="button"
                >
                  <span className="menu-item-label">Give Pro, no end</span>
                </button>
                <button
                  className="quiet menu-item"
                  onClick={() => void setPlan(account.email, "active", 30)}
                  role="menuitem"
                  type="button"
                >
                  <span className="menu-item-label">Give Pro for 30 days</span>
                </button>
                <button
                  className="quiet menu-item"
                  onClick={() => void setPlan(account.email, "active", 7)}
                  role="menuitem"
                  type="button"
                >
                  <span className="menu-item-label">Give Pro for 7 days</span>
                </button>
                <hr className="menu-separator" />
                <button
                  className="quiet menu-item"
                  onClick={() => void setPlan(account.email, "expired")}
                  role="menuitem"
                  type="button"
                >
                  <span className="menu-item-label">End Pro now</span>
                </button>
                <button
                  className="quiet menu-item menu-item-danger"
                  onClick={() => void setPlan(account.email, "revoked")}
                  role="menuitem"
                  title="Ends Pro and every sign-in; invites stop working for this account"
                  type="button"
                >
                  <span className="menu-item-label">Revoke and sign out</span>
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
