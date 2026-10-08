import React, { useCallback, useEffect, useState } from "react";
import type {
  RpcResult,
  WorkspaceDto,
  WorkspaceSecretDto,
} from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { ConfirmButton } from "./ConfirmButton";

const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * A workspace's secrets: names to add, replace and remove. A value goes in
 * through a password field and is never read back, so nothing here shows one.
 */
export function SecretsPanel({
  busy,
  client,
  perform,
  workspace,
}: {
  busy: boolean;
  client: DesktopClient;
  perform: <T>(operation: Promise<RpcResult<T>>) => Promise<T | undefined>;
  workspace: WorkspaceDto;
}) {
  const [secrets, setSecrets] = useState<WorkspaceSecretDto[]>();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  /** The secret whose value is being replaced, if any. */
  const [replacing, setReplacing] = useState<string>();

  const load = useCallback(async () => {
    const listed = await perform(
      client.request.secretList({ workspaceId: workspace.id }),
    );
    if (listed) setSecrets(listed);
  }, [client, perform, workspace.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const closeForms = () => {
    setReplacing(undefined);
    setName("");
    setValue("");
  };

  async function save(event: React.FormEvent, secretName: string) {
    event.preventDefault();
    const saved = await perform(
      client.request.secretSet({
        workspaceId: workspace.id,
        name: secretName,
        value,
      }),
    );
    if (!saved) return;
    closeForms();
    await load();
  }

  async function remove(secretName: string) {
    if (
      await perform(
        client.request.secretRemove({
          workspaceId: workspace.id,
          name: secretName,
        }),
      )
    )
      await load();
  }

  const nameValid = SECRET_NAME.test(name);
  return (
    <section className="settings-section secrets-panel">
      <p className="secrets-intro">
        Values an agent&apos;s tools need, like API keys, so nobody pastes them
        into a prompt. An agent runs <code>daedal secret list</code> to see the
        names and <code>daedal exec --secret NAME -- &lt;command&gt;</code> to
        give a command one. Values are kept in the macOS Keychain and never
        shown again. This keeps them out of prompts; it does not hide them from
        an agent that looks.
      </p>
      {secrets === undefined ? undefined : secrets.length === 0 ? (
        <p className="secrets-empty">No secrets yet.</p>
      ) : (
        <ul className="accounts-list secrets-list">
          {secrets.map((secret) => (
            <li data-secret={secret.name} key={secret.name}>
              {replacing === secret.name ? (
                <form
                  className="accounts-name-form"
                  onSubmit={(event) => void save(event, secret.name)}
                >
                  <code>{secret.name}</code>
                  <input
                    aria-label={`New value for ${secret.name}`}
                    autoComplete="off"
                    autoFocus
                    onChange={(event) => setValue(event.target.value)}
                    spellCheck={false}
                    type="password"
                    value={value}
                  />
                  <button disabled={busy || !value} type="submit">
                    Save
                  </button>
                  <button className="quiet" onClick={closeForms} type="button">
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <span className="accounts-who">
                    <code>{secret.name}</code>
                    <small>
                      Set {new Date(secret.updatedAt).toLocaleString()}
                    </small>
                  </span>
                  <span className="accounts-actions">
                    <button
                      className="quiet"
                      disabled={busy}
                      onClick={() => {
                        setValue("");
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
                      disabled={busy}
                      onConfirm={() => void remove(secret.name)}
                      title="Remove"
                    >
                      Remove
                    </ConfirmButton>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="accounts-name-form secrets-add"
        onSubmit={(event) => void save(event, name)}
      >
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
          value={replacing ? "" : value}
          disabled={replacing !== undefined}
        />
        <button
          disabled={busy || !nameValid || !value || replacing !== undefined}
          type="submit"
        >
          Add
        </button>
      </form>
    </section>
  );
}
