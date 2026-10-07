/**
 * Settings → Agents: each provider, whether it is installed, and the accounts
 * it can run sessions on.
 *
 * Sign-in state is asked of the providers when the panel opens and on Check
 * again, not carried in every snapshot: each answer is a provider subprocess.
 * Signing in opens the provider's own command in an integrated terminal,
 * because it opens a browser and may ask something; Daedalus never sees a
 * credential. An API key goes to the macOS Keychain.
 *
 * Each Claude account remembers how it signs in, chosen when it is added, so
 * Sign in is one click. There is no menu here: this panel lives in a modal
 * dialog, and WebKit does not let a popover opened inside one be clicked.
 */
import React, { useCallback, useEffect, useState } from "react";
import type {
  AccountDto,
  AccountStatusDto,
  ClaudeLoginDto,
  DesktopSettingsDto,
  IntegratedTerminalDto,
  RpcResult,
} from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { ConfirmButton } from "./ConfirmButton";

/** How a Claude account signs in. */
type ClaudeMethod = ClaudeLoginDto | "api-key";

const CLAUDE_METHODS: ReadonlyArray<{
  id: ClaudeMethod;
  label: string;
  hint: string;
}> = [
  {
    id: "subscription",
    label: "Subscription",
    hint: "Claude Pro, Max, Team or Enterprise",
  },
  { id: "sso", label: "SSO", hint: "Your organization's single sign-on" },
  {
    id: "console",
    label: "Console",
    hint: "Anthropic Console, billed per use",
  },
  { id: "api-key", label: "API key", hint: "Kept in your macOS Keychain" },
];

const LOGIN_LABEL: Record<ClaudeLoginDto, string> = {
  subscription: "Claude subscription",
  sso: "SSO",
  console: "Anthropic Console",
};

const PROVIDERS = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
] as const;

type Provider = (typeof PROVIDERS)[number]["id"];

/** One line under an account's name: who it is, or what is wrong. */
export function accountStateLine(status: AccountStatusDto | undefined): string {
  if (!status) return "Checking…";
  if (status.state === "missing") return "Not installed";
  if (status.state === "signed-out")
    return status.kind === "api-key"
      ? "No key set"
      : status.login && status.login !== "subscription"
        ? `Signed out · signs in with ${LOGIN_LABEL[status.login]}`
        : "Signed out";
  if (status.state === "unknown")
    return status.detail
      ? `Status unknown: ${status.detail}`
      : "Status unknown";
  return (
    ["Signed in", status.email, status.method, status.plan]
      .filter(Boolean)
      .join(" · ") || "Signed in"
  );
}

const stateTone = (status: AccountStatusDto | undefined): string =>
  !status
    ? "ended"
    : status.state === "signed-in"
      ? "done"
      : status.state === "unknown"
        ? "ended"
        : "lost";

/** A row of mutually exclusive choices, the look of a segmented control. */
function MethodChoice({
  label,
  methods,
  value,
  onChange,
}: {
  label: string;
  methods: ReadonlyArray<{ id: ClaudeMethod; label: string; hint: string }>;
  value: ClaudeMethod;
  onChange: (method: ClaudeMethod) => void;
}) {
  return (
    <span aria-label={label} className="accounts-methods" role="radiogroup">
      {methods.map((method) => (
        <button
          aria-checked={value === method.id}
          className={value === method.id ? "selected" : ""}
          key={method.id}
          onClick={() => onChange(method.id)}
          role="radio"
          title={method.hint}
          type="button"
        >
          {method.label}
        </button>
      ))}
    </span>
  );
}

export function AccountsPanel({
  busy,
  client,
  settings,
  perform,
  onOpenTerminal,
}: {
  busy: boolean;
  client: DesktopClient;
  settings: DesktopSettingsDto;
  perform: <T>(operation: Promise<RpcResult<T>>) => Promise<T | undefined>;
  /** Shows a terminal the panel opened, which closes Settings. */
  onOpenTerminal: (terminal: IntegratedTerminalDto) => void;
}) {
  const [statuses, setStatuses] = useState<AccountStatusDto[]>();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string>();
  const [copied, setCopied] = useState<string>();
  /** The provider whose add form is open. */
  const [adding, setAdding] = useState<Provider>();
  /** The account whose edit form is open, as `provider:account`. */
  const [editing, setEditing] = useState<string>();
  /** The account whose key form is open, as `provider:account`. */
  const [keying, setKeying] = useState<string>();
  const [name, setName] = useState("");
  const [method, setMethod] = useState<ClaudeMethod>("subscription");
  const [apiKey, setApiKey] = useState("");

  const check = useCallback(async () => {
    setChecking(true);
    setCheckError(undefined);
    try {
      const response = await client.request.accountStatus({});
      if (response.ok) setStatuses(response.data);
      else setCheckError(response.error.message);
    } catch (cause) {
      setCheckError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChecking(false);
    }
  }, [client]);

  // Asked again whenever the list of accounts changes, so an added account
  // shows its state without a click.
  const accountKeys = settings.accounts
    .map((item) => `${item.provider}:${item.account}:${item.login ?? ""}`)
    .join(",");
  useEffect(() => {
    void check();
  }, [check, accountKeys]);

  const statusOf = (account: AccountDto) =>
    statuses?.find(
      (item) =>
        item.provider === account.provider && item.account === account.account,
    );

  const closeForms = () => {
    setAdding(undefined);
    setEditing(undefined);
    setKeying(undefined);
    setName("");
    setApiKey("");
  };

  async function signIn(provider: Provider, account: string) {
    const terminal = await perform(
      client.request.accountSignIn({ provider, account }),
    );
    if (terminal) onOpenTerminal(terminal);
  }

  async function signOut(account: AccountDto) {
    if (
      await perform(
        client.request.accountSignOut({
          provider: account.provider,
          account: account.account,
        }),
      )
    )
      await check();
  }

  /**
   * Adds the account and goes straight on to what makes it usable: the
   * sign-in for a login, the key for an API-key account. One click.
   */
  async function add(event: React.FormEvent, provider: Provider) {
    event.preventDefault();
    const choice: ClaudeMethod =
      provider === "claude" ? method : "subscription";
    const added = await perform(
      client.request.accountAdd({
        provider,
        name,
        kind: choice === "api-key" ? "api-key" : "login",
        ...(provider === "claude" && choice !== "api-key"
          ? { login: choice }
          : {}),
      }),
    );
    if (!added) return;
    const key = apiKey;
    closeForms();
    if (choice === "api-key") {
      const saved = await perform(
        client.request.accountSetApiKey({
          provider: "claude",
          account: added.account,
          key,
        }),
      );
      // A key that did not take leaves the account in place, asking for it.
      if (!saved) setKeying(`${added.provider}:${added.account}`);
      await check();
    } else await signIn(provider, added.account);
  }

  async function saveEdit(event: React.FormEvent, account: AccountDto) {
    event.preventDefault();
    const isDefault = account.account === "default";
    if (!isDefault && name.trim() && name.trim() !== account.name) {
      const renamed = await perform(
        client.request.accountRename({
          provider: account.provider,
          account: account.account,
          name,
        }),
      );
      if (!renamed) return;
    }
    if (
      account.provider === "claude" &&
      account.kind === "login" &&
      method !== "api-key" &&
      method !== (account.login ?? "subscription")
    ) {
      const changed = await perform(
        client.request.accountSetLogin({
          provider: "claude",
          account: account.account,
          login: method,
        }),
      );
      if (!changed) return;
    }
    closeForms();
  }

  async function saveKey(event: React.FormEvent, account: AccountDto) {
    event.preventDefault();
    const saved = await perform(
      client.request.accountSetApiKey({
        provider: "claude",
        account: account.account,
        key: apiKey,
      }),
    );
    // The key leaves the form either way: it is not kept in this page.
    setApiKey("");
    if (saved) {
      setKeying(undefined);
      await check();
    }
  }

  async function copy(command: string) {
    const response = await client.request.clipboardWrite({ text: command });
    if (response.ok && response.data.written) {
      setCopied(command);
      window.setTimeout(
        () =>
          setCopied((current) => (current === command ? undefined : current)),
        1500,
      );
    }
  }

  const escapeCloses = (event: React.KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    closeForms();
  };

  return (
    <div className="accounts-panel">
      <div className="accounts-toolbar">
        <p className="skills-note">
          Each account is a provider folder of its own. An added account shares
          no settings, plugins or memory with the default one. Signing in runs
          the provider's own command; an API key is kept in your macOS Keychain,
          never in a file.
        </p>
        <button
          className="quiet"
          disabled={checking}
          onClick={() => void check()}
          type="button"
        >
          {checking ? "Checking…" : "Check again"}
        </button>
      </div>
      {checkError ? (
        <p className="accounts-error" role="alert">
          {checkError}
        </p>
      ) : undefined}
      {PROVIDERS.map((provider) => {
        const availability = settings.providers.find(
          (item) => item.name === provider.id,
        );
        const accounts = settings.accounts.filter(
          (item) => item.provider === provider.id,
        );
        const install = statuses?.find(
          (item) => item.provider === provider.id && item.install,
        )?.install;
        return (
          <section
            className="accounts-provider"
            data-provider={provider.id}
            key={provider.id}
          >
            <h3>
              {provider.label}
              <code title={availability?.executable}>
                {availability?.available
                  ? availability.executable
                  : "not installed"}
              </code>
            </h3>
            {install ? (
              <div className="accounts-install">
                <p>
                  {provider.label} is not installed. Run one of these in a
                  terminal, then Check again.
                </p>
                {install.map((item) => (
                  <div className="accounts-install-row" key={item.command}>
                    <span>{item.label}</span>
                    <code>{item.command}</code>
                    <button
                      className="quiet"
                      onClick={() => void copy(item.command)}
                      type="button"
                    >
                      {copied === item.command ? "Copied" : "Copy"}
                    </button>
                  </div>
                ))}
              </div>
            ) : undefined}
            <ul className="accounts-list">
              {accounts.map((account) => {
                const status = statusOf(account);
                const key = `${account.provider}:${account.account}`;
                const isDefault = account.account === "default";
                // Something to edit: a profile's name, or a Claude login's
                // method. Default Codex has neither.
                const editable =
                  !isDefault ||
                  (account.provider === "claude" && account.kind === "login");
                const formOpen = editing === key || keying === key;
                return (
                  <li data-account={account.account} key={key}>
                    <span className={`agent-dot tone-${stateTone(status)}`} />
                    {keying === key ? (
                      <form
                        className="accounts-name-form"
                        onSubmit={(event) => void saveKey(event, account)}
                      >
                        <input
                          aria-label={`API key for ${account.name}`}
                          autoComplete="off"
                          autoFocus
                          onChange={(event) => setApiKey(event.target.value)}
                          onKeyDown={escapeCloses}
                          placeholder="sk-ant-…"
                          spellCheck={false}
                          type="password"
                          value={apiKey}
                        />
                        <button disabled={busy || !apiKey.trim()} type="submit">
                          Save key
                        </button>
                        <button
                          className="quiet"
                          onClick={closeForms}
                          type="button"
                        >
                          Cancel
                        </button>
                      </form>
                    ) : editing === key ? (
                      <form
                        className="accounts-edit-form"
                        onSubmit={(event) => void saveEdit(event, account)}
                      >
                        {!isDefault ? (
                          <input
                            aria-label="Account name"
                            autoFocus
                            maxLength={60}
                            onChange={(event) => setName(event.target.value)}
                            onKeyDown={escapeCloses}
                            value={name}
                          />
                        ) : (
                          <strong>{account.name}</strong>
                        )}
                        {account.provider === "claude" &&
                        account.kind === "login" ? (
                          <MethodChoice
                            label={`How ${account.name} signs in`}
                            methods={CLAUDE_METHODS.filter(
                              (item) => item.id !== "api-key",
                            )}
                            onChange={setMethod}
                            value={method}
                          />
                        ) : undefined}
                        <span className="accounts-form-actions">
                          <button
                            className="quiet"
                            onClick={closeForms}
                            type="button"
                          >
                            Cancel
                          </button>
                          <button
                            disabled={busy || (!isDefault && !name.trim())}
                            type="submit"
                          >
                            Save
                          </button>
                        </span>
                      </form>
                    ) : (
                      <span className="accounts-who">
                        <strong>{account.name}</strong>
                        <small>{accountStateLine(status)}</small>
                        <code title={account.directory}>
                          {account.directory}
                        </code>
                      </span>
                    )}
                    {formOpen ? undefined : (
                      <span className="accounts-actions">
                        {account.kind === "api-key" ? (
                          <>
                            <button
                              className={
                                status?.state === "signed-in" ? "quiet" : ""
                              }
                              disabled={busy}
                              onClick={() => {
                                closeForms();
                                setKeying(key);
                              }}
                              type="button"
                            >
                              {status?.state === "signed-in"
                                ? "Replace key"
                                : "Set key"}
                            </button>
                            {status?.state === "signed-in" ? (
                              <ConfirmButton
                                armedLabel="Remove key"
                                armedTitle={`Delete ${account.name}'s key from the Keychain`}
                                className="quiet"
                                disabled={busy}
                                onConfirm={() => void signOut(account)}
                                type="button"
                              >
                                Remove key
                              </ConfirmButton>
                            ) : undefined}
                          </>
                        ) : status && status.state !== "missing" ? (
                          status.state === "signed-in" ? (
                            <ConfirmButton
                              armedLabel="Sign out"
                              armedTitle={`Sign ${account.name} out of ${provider.label}`}
                              className="quiet"
                              disabled={busy}
                              onConfirm={() => void signOut(account)}
                              type="button"
                            >
                              Sign out
                            </ConfirmButton>
                          ) : (
                            <button
                              disabled={busy}
                              onClick={() =>
                                void signIn(provider.id, account.account)
                              }
                              title={
                                account.login
                                  ? `Sign in with ${LOGIN_LABEL[account.login]}`
                                  : undefined
                              }
                              type="button"
                            >
                              Sign in
                            </button>
                          )
                        ) : undefined}
                        {editable ? (
                          <button
                            className="quiet"
                            disabled={busy}
                            onClick={() => {
                              closeForms();
                              setEditing(key);
                              setName(account.name);
                              setMethod(account.login ?? "subscription");
                            }}
                            type="button"
                          >
                            Edit
                          </button>
                        ) : undefined}
                        {!isDefault ? (
                          <ConfirmButton
                            armedLabel="Remove"
                            armedTitle={`Sign ${account.name} out and delete its folder`}
                            className="danger-link"
                            disabled={busy}
                            onConfirm={() =>
                              void perform(
                                client.request.accountRemove({
                                  provider: account.provider,
                                  account: account.account,
                                }),
                              )
                            }
                            type="button"
                          >
                            Remove
                          </ConfirmButton>
                        ) : undefined}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {adding === provider.id ? (
              <form
                className="accounts-add-form"
                onSubmit={(event) => void add(event, provider.id)}
              >
                <label>
                  <span>Name</span>
                  <input
                    aria-label={`New ${provider.label} account name`}
                    autoFocus
                    maxLength={60}
                    onChange={(event) => setName(event.target.value)}
                    onKeyDown={escapeCloses}
                    placeholder="Personal"
                    value={name}
                  />
                </label>
                {provider.id === "claude" ? (
                  <div className="accounts-add-method">
                    <span>Signs in with</span>
                    <MethodChoice
                      label="How the new account signs in"
                      methods={CLAUDE_METHODS}
                      onChange={setMethod}
                      value={method}
                    />
                    <small>
                      {CLAUDE_METHODS.find((item) => item.id === method)?.hint}
                    </small>
                  </div>
                ) : undefined}
                {provider.id === "claude" && method === "api-key" ? (
                  <label>
                    <span>API key</span>
                    <input
                      aria-label="API key"
                      autoComplete="off"
                      onChange={(event) => setApiKey(event.target.value)}
                      onKeyDown={escapeCloses}
                      placeholder="sk-ant-…"
                      spellCheck={false}
                      type="password"
                      value={apiKey}
                    />
                  </label>
                ) : undefined}
                <span className="accounts-form-actions">
                  <button className="quiet" onClick={closeForms} type="button">
                    Cancel
                  </button>
                  <button
                    disabled={
                      busy ||
                      !name.trim() ||
                      (provider.id === "claude" &&
                        method === "api-key" &&
                        !apiKey.trim())
                    }
                    type="submit"
                  >
                    {provider.id === "claude" && method === "api-key"
                      ? "Add account"
                      : "Add and sign in"}
                  </button>
                </span>
              </form>
            ) : (
              <button
                className="accounts-add quiet"
                disabled={busy}
                onClick={() => {
                  closeForms();
                  setAdding(provider.id);
                  setMethod("subscription");
                }}
                type="button"
              >
                Add {provider.label} account
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}
