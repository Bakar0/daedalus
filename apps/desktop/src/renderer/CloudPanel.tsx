/**
 * Settings → Cloud: this Mac's sign-in to a Daedalus gateway, which runs
 * cloud workspaces in pods. The same dev login as `daedal cloud login`.
 *
 * The window sees the gateway address, the email and how the link stands;
 * the token stays in the host's Keychain entry and never comes over RPC.
 */
import React, { useState } from "react";
import type {
  CloudMcpServersDto,
  CloudStateDto,
  RpcResult,
} from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { useRpcQuery, type RpcQueryResult } from "./use-rpc";

/**
 * The cloud state, asked again every `pollMs`. Not on every snapshot push:
 * each answer is a gateway request. A host without cloud support (a test
 * page) has no answer, so `data` stays empty.
 */
export function useCloudState(
  client: DesktopClient,
  pollMs: number,
): RpcQueryResult<CloudStateDto> {
  return useRpcQuery(() => client.request.cloudState({}), {
    pollMs,
    deps: [client],
  });
}

export function cloudConnectionText(state: CloudStateDto): string {
  switch (state.connection) {
    case "signed-out":
      return "Not signed in.";
    case "connecting":
      return "Connecting to the gateway…";
    case "online":
      return "Connected.";
    case "error":
      return "Can't reach the gateway.";
  }
}

const REMEMBERED_GATEWAY = "daedalus.cloud.gatewayUrl";

function rememberedGateway(): string {
  try {
    return window.localStorage.getItem(REMEMBERED_GATEWAY) ?? "";
  } catch {
    return "";
  }
}

function rememberGateway(url: string): void {
  try {
    window.localStorage.setItem(REMEMBERED_GATEWAY, url);
  } catch {
    // Only a convenience.
  }
}

export function CloudPanel({
  busy,
  client,
  perform,
}: {
  busy: boolean;
  client: DesktopClient;
  perform: <T>(operation: Promise<RpcResult<T>>) => Promise<T | undefined>;
}) {
  const { data: state, error, refresh } = useCloudState(client, 5_000);
  const [gatewayUrl, setGatewayUrl] = useState(rememberedGateway);
  const [email, setEmail] = useState("");
  const [signInError, setSignInError] = useState<string>();
  const [working, setWorking] = useState(false);

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setSignInError(undefined);
    try {
      const response = await client.request.cloudSignIn({ gatewayUrl, email });
      if (response.ok) {
        rememberGateway(gatewayUrl.trim());
        setEmail("");
        await refresh();
      } else setSignInError(response.error.message);
    } finally {
      setWorking(false);
    }
  };

  const shownError = signInError ?? state?.error ?? error;
  return (
    <div className="cloud-panel" data-testid="cloud-panel">
      <h3>Cloud workspaces</h3>
      <p className="settings-note">
        A cloud workspace runs a local workspace's sessions in a pod on a
        Daedalus gateway. This Mac keeps the board, the database and every
        decision.
      </p>
      {state?.signedIn ? (
        <>
          <div className="cloud-account" data-testid="cloud-account">
            <span>
              Signed in as <strong>{state.email}</strong>
            </span>
            <code>{state.gatewayUrl}</code>
          </div>
          <p
            className="remote-status"
            data-connection={state.connection}
            data-look={
              state.connection === "online"
                ? "live"
                : state.connection === "error"
                  ? "trouble"
                  : "connecting"
            }
            data-testid="cloud-connection"
          >
            <span aria-hidden="true" className="remote-status-dot" />
            {cloudConnectionText(state)}
          </p>
          <div className="cloud-actions">
            <button
              className="quiet"
              data-testid="cloud-sign-out"
              disabled={busy || working}
              onClick={async () => {
                setSignInError(undefined);
                const next = await perform(client.request.cloudSignOut({}));
                if (next) await refresh();
              }}
              type="button"
            >
              Sign out
            </button>
            <small>
              Sessions already in the cloud keep running; this Mac stops
              reaching them until it signs in again.
            </small>
          </div>
          <CloudMcpServers busy={busy} client={client} />
        </>
      ) : (
        <form className="cloud-sign-in" onSubmit={signIn}>
          <label className="settings-choice">
            <span>
              <strong>Gateway</strong>
              <small>https://, or http:// for this machine only</small>
            </span>
            <input
              aria-label="Gateway URL"
              data-testid="cloud-gateway-url"
              disabled={working}
              onChange={(event) => setGatewayUrl(event.target.value)}
              placeholder="https://gateway.example.com"
              required
              type="url"
              value={gatewayUrl}
            />
          </label>
          <label className="settings-choice">
            <span>
              <strong>Email</strong>
              <small>The gateway's dev login signs in with an email only</small>
            </span>
            <input
              aria-label="Email"
              autoComplete="email"
              data-testid="cloud-email"
              disabled={working}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              required
              type="email"
              value={email}
            />
          </label>
          <div className="cloud-actions">
            <button
              data-testid="cloud-sign-in"
              disabled={busy || working || !gatewayUrl.trim() || !email.trim()}
              type="submit"
            >
              {working ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </form>
      )}
      {shownError ? (
        <p className="accounts-error" data-testid="cloud-error" role="alert">
          {shownError}
        </p>
      ) : undefined}
    </div>
  );
}

/**
 * The user's remote MCP servers, each off for cloud sessions until turned
 * on: a key can sit in a server's URL, and the pod runs code this Mac does
 * not trust. Name and host only; the URL stays in the host.
 */
export function CloudMcpServers({
  client,
  busy,
}: {
  client: DesktopClient;
  busy: boolean;
}) {
  const { data, error, refresh } = useRpcQuery(
    () => client.request.cloudMcpServers({}),
    { deps: [client] },
  );
  const [failure, setFailure] = useState<string>();
  const [pending, setPending] = useState<string>();
  const set = async (name: string, on: boolean) => {
    setPending(name);
    setFailure(undefined);
    try {
      const response = await client.request.cloudMcpServerSet({ name, on });
      if (!response.ok) setFailure(response.error.message);
      await refresh();
    } finally {
      setPending(undefined);
    }
  };
  const list: CloudMcpServersDto | undefined = data;
  return (
    <div className="cloud-mcp" data-testid="cloud-mcp-list">
      <h3>MCP servers in the cloud</h3>
      <p className="settings-note">
        Only the servers you turn on here go to cloud sessions. A server's
        address can hold a key, so none goes until you say so.
      </p>
      {list && !list.servers.length && !list.leftOut.length ? (
        <p className="settings-note" data-testid="cloud-mcp-empty">
          You have no remote MCP servers.
        </p>
      ) : undefined}
      {list?.servers.map((server) => (
        <label
          className="settings-row"
          data-name={server.name}
          data-testid="cloud-mcp-server"
          key={server.name}
        >
          <input
            checked={server.on}
            className="switch"
            data-testid="cloud-mcp-toggle"
            disabled={busy || pending === server.name}
            onChange={(event) => void set(server.name, event.target.checked)}
            type="checkbox"
          />
          <span>
            <strong>{server.name}</strong>
            <small>{server.host}</small>
          </span>
        </label>
      ))}
      {list?.leftOut.length ? (
        <div className="cloud-mcp-left-out" data-testid="cloud-mcp-left-out">
          <small>Not offered to cloud sessions:</small>
          {list.leftOut.map((one) => (
            <small key={one.name}>
              {one.name}: {one.reason}
            </small>
          ))}
        </div>
      ) : undefined}
      {failure || error ? (
        <p className="accounts-error" role="alert">
          {failure ?? error}
        </p>
      ) : undefined}
    </div>
  );
}
