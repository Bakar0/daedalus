/**
 * Settings → Agents: each provider, whether it is installed, and the accounts
 * it can run sessions on.
 *
 * Sign-in state is asked of the providers when the panel opens and on Check
 * again, not carried in every snapshot: each answer is a provider subprocess.
 * Signing in opens the provider's own command in an integrated terminal,
 * because it opens a browser and may ask something; Daedalus never sees a
 * credential.
 */
import React, { useCallback, useEffect, useState } from "react";
import type {
  AccountDto,
  AccountStatusDto,
  DesktopSettingsDto,
  IntegratedTerminalDto,
  RpcResult,
} from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { ConfirmButton } from "./ConfirmButton";

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
    return status.kind === "api-key" ? "No key set" : "Signed out";
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
  const [adding, setAdding] = useState<Provider>();
  const [renaming, setRenaming] = useState<string>();
  const [name, setName] = useState("");
  const [copied, setCopied] = useState<string>();
  /** The kind of account the add form makes. */
  const [addKind, setAddKind] = useState<"login" | "api-key">("login");
  /** The account whose key form is open, as `provider:account`. */
  const [keying, setKeying] = useState<string>();
  const [apiKey, setApiKey] = useState("");
  /** Which Claude login each account's Sign in runs. */
  const [variants, setVariants] = useState<
    Record<string, "subscription" | "sso" | "console">
  >({});

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
    .map((item) => `${item.provider}:${item.account}`)
    .join(",");
  useEffect(() => {
    void check();
  }, [check, accountKeys]);

  const statusOf = (account: AccountDto) =>
    statuses?.find(
      (item) =>
        item.provider === account.provider && item.account === account.account,
    );

  async function signIn(account: AccountDto) {
    const terminal = await perform(
      client.request.accountSignIn({
        provider: account.provider,
        account: account.account,
        ...(account.provider === "claude"
          ? {
              variant:
                variants[`${account.provider}:${account.account}`] ??
                "subscription",
            }
          : {}),
      }),
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

  async function add(event: React.FormEvent, provider: Provider) {
    event.preventDefault();
    const kind = provider === "claude" ? addKind : "login";
    const added = await perform(
      client.request.accountAdd({ provider, name, kind }),
    );
    if (added) {
      setAdding(undefined);
      setName("");
      // An API-key account is no use until it has its key, so ask now.
      if (added.kind === "api-key") {
        setKeying(`${added.provider}:${added.account}`);
        setApiKey("");
      }
    }
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

  async function rename(event: React.FormEvent, account: AccountDto) {
    event.preventDefault();
    if (
      await perform(
        client.request.accountRename({
          provider: account.provider,
          account: account.account,
          name,
        }),
      )
    ) {
      setRenaming(undefined);
      setName("");
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
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.stopPropagation();
                              setKeying(undefined);
                              setApiKey("");
                            }
                          }}
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
                          onClick={() => {
                            setKeying(undefined);
                            setApiKey("");
                          }}
                          type="button"
                        >
                          Cancel
                        </button>
                      </form>
                    ) : renaming === key ? (
                      <form
                        className="accounts-name-form"
                        onSubmit={(event) => void rename(event, account)}
                      >
                        <input
                          aria-label="Account name"
                          autoFocus
                          maxLength={60}
                          onChange={(event) => setName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.stopPropagation();
                              setRenaming(undefined);
                            }
                          }}
                          value={name}
                        />
                        <button disabled={busy || !name.trim()} type="submit">
                          Save
                        </button>
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
                    <span className="accounts-actions">
                      {keying === key ? undefined : account.kind ===
                        "api-key" ? (
                        <>
                          <button
                            className={
                              status?.state === "signed-in" ? "quiet" : ""
                            }
                            disabled={busy}
                            onClick={() => {
                              setKeying(key);
                              setRenaming(undefined);
                              setApiKey("");
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
                            className="quiet"
                            armedTitle={`Sign ${account.name} out of ${provider.label}`}
                            disabled={busy}
                            onConfirm={() => void signOut(account)}
                            type="button"
                          >
                            Sign out
                          </ConfirmButton>
                        ) : (
                          <>
                            {account.provider === "claude" ? (
                              <select
                                aria-label={`How ${account.name} signs in`}
                                onChange={(event) =>
                                  setVariants((current) => ({
                                    ...current,
                                    [key]: event.target.value as
                                      "subscription" | "sso" | "console",
                                  }))
                                }
                                value={variants[key] ?? "subscription"}
                              >
                                <option value="subscription">
                                  Subscription
                                </option>
                                <option value="sso">SSO</option>
                                <option value="console">Console</option>
                              </select>
                            ) : undefined}
                            <button
                              disabled={busy}
                              onClick={() => void signIn(account)}
                              type="button"
                            >
                              Sign in
                            </button>
                          </>
                        )
                      ) : undefined}
                      {!isDefault && renaming !== key ? (
                        <>
                          <button
                            className="quiet"
                            disabled={busy}
                            onClick={() => {
                              setRenaming(key);
                              setName(account.name);
                            }}
                            type="button"
                          >
                            Rename
                          </button>
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
                        </>
                      ) : undefined}
                    </span>
                  </li>
                );
              })}
            </ul>
            {adding === provider.id ? (
              <form
                className="accounts-name-form"
                onSubmit={(event) => void add(event, provider.id)}
              >
                <input
                  aria-label={`New ${provider.label} account name`}
                  autoFocus
                  maxLength={60}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      setAdding(undefined);
                    }
                  }}
                  placeholder="Personal"
                  value={name}
                />
                {provider.id === "claude" ? (
                  <select
                    aria-label="How the new account authenticates"
                    onChange={(event) =>
                      setAddKind(event.target.value as "login" | "api-key")
                    }
                    value={addKind}
                  >
                    <option value="login">Sign in</option>
                    <option value="api-key">API key</option>
                  </select>
                ) : undefined}
                <button disabled={busy || !name.trim()} type="submit">
                  Add
                </button>
                <button onClick={() => setAdding(undefined)} type="button">
                  Cancel
                </button>
              </form>
            ) : (
              <button
                className="accounts-add quiet"
                disabled={busy}
                onClick={() => {
                  setAdding(provider.id);
                  setRenaming(undefined);
                  setName("");
                  setAddKind("login");
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
