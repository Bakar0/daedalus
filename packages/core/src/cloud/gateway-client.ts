import type {
  CloudWorkspace,
  CreateWorkspaceRequest,
  DevLoginResponse,
  GatewayError,
  GatewayErrorCode,
  GatewayUser,
} from "@daedalus/remote-protocol";
import { DaedalusError, type ErrorCode } from "../errors";

/** How a gateway refusal reads as a Daedalus error. */
const CODES: Record<GatewayErrorCode, ErrorCode> = {
  VALIDATION: "VALIDATION",
  UNAUTHORIZED: "DEPENDENCY",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  QUOTA: "CONFLICT",
  INTERNAL: "INTERNAL",
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The origin of a gateway address. It must be https: the token travels in
 * every request, and the runner keys this Mac pins come back in answers.
 * Plain http is allowed only to this machine, as for a kind cluster.
 */
export function gatewayOrigin(address: string): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new DaedalusError("VALIDATION", "The gateway address is not a URL");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK.has(url.hostname))
  )
    throw new DaedalusError(
      "VALIDATION",
      "A gateway address starts with https:// (http:// only for localhost)",
    );
  return url.origin;
}

/** What a Kubernetes quota counts, in words. */
const QUOTA_RESOURCES: Record<string, string> = {
  persistentvolumeclaims: "storage volumes",
  pods: "running workspaces",
  "requests.cpu": "CPU",
  "requests.memory": "memory",
  "requests.storage": "storage",
  "requests.ephemeral-storage": "scratch space",
};

/**
 * A gateway's QUOTA refusal in plain words. Its own limit already reads
 * well; a Kubernetes quota comes as the API server's text ("... is
 * forbidden: exceeded quota: workspaces, requested: pods=1, used: pods=6,
 * limited: pods=6"), which names what ran out and the numbers.
 */
export function plainQuotaMessage(message: string): string {
  if (!/exceeded quota/i.test(message)) return message;
  const limited = /limited:\s*([^,=\s]+)=([^,\s]+)/i.exec(message);
  const resource = limited?.[1];
  const what = (resource && QUOTA_RESOURCES[resource]) ?? "resources";
  return `Your cloud workspaces use all the ${what} the gateway allows you${
    limited ? ` (${limited[2]})` : ""
  }. Delete a cloud workspace, or ask the gateway's administrator to raise the limit.`;
}

/** The gateway's HTTP API (packages/remote-protocol/src/gateway.ts). */
export class GatewayClient {
  readonly url: string;

  constructor(
    url: string,
    private readonly token?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.url = gatewayOrigin(url);
  }

  devLogin(email: string): Promise<DevLoginResponse> {
    return this.#request("POST", "/v1/dev/login", { email });
  }

  me(): Promise<GatewayUser> {
    return this.#request("GET", "/v1/me");
  }

  createWorkspace(request: CreateWorkspaceRequest): Promise<CloudWorkspace> {
    return this.#request("POST", "/v1/workspaces", request);
  }

  async listWorkspaces(): Promise<CloudWorkspace[]> {
    return (
      await this.#request<{ workspaces: CloudWorkspace[] }>(
        "GET",
        "/v1/workspaces",
      )
    ).workspaces;
  }

  getWorkspace(id: string): Promise<CloudWorkspace> {
    return this.#request("GET", `/v1/workspaces/${encodeURIComponent(id)}`);
  }

  wakeWorkspace(id: string): Promise<CloudWorkspace> {
    return this.#request(
      "POST",
      `/v1/workspaces/${encodeURIComponent(id)}/wake`,
    );
  }

  sleepWorkspace(id: string): Promise<CloudWorkspace> {
    return this.#request(
      "POST",
      `/v1/workspaces/${encodeURIComponent(id)}/sleep`,
    );
  }

  setDisposable(id: string, disposable: boolean): Promise<CloudWorkspace> {
    return this.#request(
      "POST",
      `/v1/workspaces/${encodeURIComponent(id)}/disposable`,
      { disposable },
    );
  }

  async deleteWorkspace(id: string): Promise<void> {
    await this.#request("DELETE", `/v1/workspaces/${encodeURIComponent(id)}`);
  }

  /** The relay's WebSocket address for this Mac. */
  connectUrl(macId: string): string {
    const url = new URL("/v1/connect", this.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("macId", macId);
    return url.toString();
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.url), {
        method,
        headers: {
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
        // A redirect would carry the token to another origin.
        redirect: "error",
      });
    } catch (error) {
      throw new DaedalusError(
        "DEPENDENCY",
        `The gateway at ${this.url} did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const error = (parsed as GatewayError | undefined)?.error;
      const code = error?.code && CODES[error.code];
      throw new DaedalusError(
        code ?? (response.status === 404 ? "NOT_FOUND" : "INTERNAL"),
        response.status === 401
          ? "The gateway did not accept the sign-in; sign in again in Settings › Cloud or with 'daedal cloud login'"
          : error?.code === "QUOTA" && error.message
            ? plainQuotaMessage(error.message)
            : (error?.message ?? `The gateway answered ${response.status}`),
        error?.code ? { gatewayCode: error.code } : undefined,
      );
    }
    return parsed as T;
  }
}
