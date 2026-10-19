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

/** The gateway's HTTP API (packages/remote-protocol/src/gateway.ts). */
export class GatewayClient {
  readonly url: string;

  constructor(
    url: string,
    private readonly token?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      throw new DaedalusError(
        "VALIDATION",
        "A gateway address starts with https:// or http://",
      );
    this.url = parsed.origin;
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
          ? "The gateway did not accept the sign-in; run 'daedal cloud login' again"
          : (error?.message ?? `The gateway answered ${response.status}`),
        error?.code ? { gatewayCode: error.code } : undefined,
      );
    }
    return parsed as T;
  }
}
