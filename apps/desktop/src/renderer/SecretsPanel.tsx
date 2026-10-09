import React, { useCallback, useEffect, useState } from "react";
import type { RpcResult, SecretDto, WorkspaceDto } from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { ConfirmButton } from "./ConfirmButton";

const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Secrets to add, replace, show and remove. With a workspace it edits that
 * workspace's own and lists the global ones it can also use; without one it
 * edits the global ones.
 *
 * It keeps its own busy state and loads its list directly, rather than
 * through the app's `perform`, which refreshes the whole app on every call.
 */
export function SecretsPanel({
  client,
  onError,
  onOpenGlobal,
  workspace,
}: {
  client: DesktopClient;
  /** Opens Settings → Secrets, from a workspace's dialog. */
  onOpenGlobal?: () => void;
  onError: (message: string | undefined) => void;
  workspace?: WorkspaceDto;
}) {
  const workspaceId = workspace?.id ?? null;
  const [secrets, setSecrets] = useState<SecretDto[]>();
  const [working, setWorking] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  /** The secret whose value is being replaced, if any. */
  const [replacing, setReplacing] = useState<string>();
  const [newValue, setNewValue] = useState("");
  /** Values the user asked to see, by secret name. */
  const [shown, setShown] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const response = await client.request.secretList({ workspaceId });
    if (response.ok) setSecrets(response.data);
    else onError(response.error.message);
  }, [client, onError, workspaceId]);
  useEffect(() => {
    void load();
  }, [load]);

  /** Runs one change, reports a failure, and reloads the list. */
  async function act<T>(
    request: Promise<RpcResult<T>>,
  ): Promise<T | undefined> {
    setWorking(true);
    onError(undefined);
    try {
      const response = await request;
      if (!response.ok) {
        onError(response.error.message);
        return undefined;
      }
      await load();
      return response.data;
    } finally {
      setWorking(false);
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (await act(client.request.secretSet({ workspaceId, name, value }))) {
      setName("");
      setValue("");
    }
  }

  async function replace(event: React.FormEvent, secretName: string) {
    event.preventDefault();
    if (
      await act(
        client.request.secretSet({
          workspaceId,
          name: secretName,
          value: newValue,
        }),
      )
    ) {
      setReplacing(undefined);
      setNewValue("");
      setShown(({ [secretName]: _dropped, ...rest }) => rest);
    }
  }

  async function toggleShown(secret: SecretDto) {
    if (shown[secret.name] !== undefined) {
      setShown(({ [secret.name]: _dropped, ...rest }) => rest);
      return;
    }
    const response = await client.request.secretReveal({
      workspaceId: secret.workspaceId,
      name: secret.name,
    });
    if (response.ok)
      setShown((current) => ({
        ...current,
        [secret.name]: response.data.value,
      }));
    else onError(response.error.message);
  }

  const own = (secret: SecretDto) => secret.workspaceId === workspaceId;
  const canAdd = SECRET_NAME.test(name) && value.length > 0 && !working;
  return (
    <section className="settings-section secrets-panel">
      <p className="secrets-intro">
        Agents use these with{" "}
        <code>daedal exec --secret NAME -- &lt;command&gt;</code>.
        {workspace ? (
          <>
            {" "}
            Global secrets apply here too.{" "}
            {onOpenGlobal ? (
              <button className="link" onClick={onOpenGlobal} type="button">
                Edit global secrets
              </button>
            ) : undefined}
          </>
        ) : (
          " They apply in every workspace."
        )}
      </p>
      {secrets === undefined ? undefined : secrets.length === 0 ? (
        <p className="secrets-empty">No secrets yet.</p>
      ) : (
        <ul className="accounts-list secrets-list">
          {secrets.map((secret) => {
            const key = `${secret.workspaceId ?? "global"}:${secret.name}`;
            const value = shown[secret.name];
            const showing = own(secret) && value !== undefined;
            return (
              <li
                data-overridden={secret.overridden || undefined}
                data-secret={secret.name}
                key={key}
              >
                {replacing === secret.name && own(secret) ? (
                  <form
                    className="accounts-name-form"
                    onSubmit={(event) => void replace(event, secret.name)}
                  >
                    <code>{secret.name}</code>
                    <input
                      aria-label={`New value for ${secret.name}`}
                      autoComplete="off"
                      autoFocus
                      onChange={(event) => setNewValue(event.target.value)}
                      spellCheck={false}
                      type="password"
                      value={newValue}
                    />
                    <button disabled={working || !newValue} type="submit">
                      Save
                    </button>
                    <button
                      className="quiet"
                      onClick={() => {
                        setReplacing(undefined);
                        setNewValue("");
                      }}
                      type="button"
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="accounts-who">
                      <code>{secret.name}</code>
                      <small>
                        {workspace && !own(secret)
                          ? secret.overridden
                            ? "Global · overridden by this workspace's"
                            : "Global"
                          : `Set ${new Date(secret.updatedAt).toLocaleString()}`}
                      </small>
                      {showing ? (
                        <code className="secret-value">{value}</code>
                      ) : undefined}
                    </span>
                    {own(secret) ? (
                      <span className="accounts-actions">
                        <button
                          className="quiet"
                          onClick={() => void toggleShown(secret)}
                          type="button"
                        >
                          {showing ? "Hide" : "Show"}
                        </button>
                        <button
                          className="quiet"
                          disabled={working}
                          onClick={() => {
                            setNewValue("");
                            setReplacing(secret.name);
                          }}
                          type="button"
                        >
                          Replace
                        </button>
                        <ConfirmButton
                          aria-label={`Remove ${secret.name}`}
                          armedTitle="Deletes the value from the Keychain. Commands that ask for it stop until it is set again."
                          className="quiet"
                          disabled={working}
                          onConfirm={() =>
                            void act(
                              client.request.secretRemove({
                                workspaceId,
                                name: secret.name,
                              }),
                            )
                          }
                          title="Remove"
                        >
                          Remove
                        </ConfirmButton>
                      </span>
                    ) : (
                      <span />
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <form className="accounts-name-form secrets-add" onSubmit={add}>
        <input
          aria-label="Secret name"
          autoComplete="off"
          onChange={(event) =>
            setName(
              event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
            )
          }
          placeholder="GH_TOKEN"
          spellCheck={false}
          value={name}
        />
        <input
          aria-label="Secret value"
          autoComplete="off"
          onChange={(event) => setValue(event.target.value)}
          placeholder="Value"
          spellCheck={false}
          type="password"
          value={value}
        />
        <button disabled={!canAdd} type="submit">
          Add
        </button>
      </form>
    </section>
  );
}
