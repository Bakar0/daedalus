/**
 * A thin Kubernetes API client: one `request` over plain fetch, with the
 * pod's service account token and CA. The controller builds the paths and
 * bodies itself, so tests swap this for a fake that stores objects by path.
 */

export type KubeObject = Record<string, unknown>;

export interface KubeResponse {
  status: number;
  body: KubeObject;
}

export interface KubeApi {
  request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: KubeObject,
  ): Promise<KubeResponse>;
}

const SERVICE_ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount";

/** The API server as seen from inside a pod. */
export function inClusterKube(
  env: Record<string, string | undefined>,
): KubeApi {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT ?? "443";
  if (!host) throw new Error("Not running in a Kubernetes pod");
  const base = `https://${host.includes(":") ? `[${host}]` : host}:${port}`;
  let ca: Promise<string> | undefined;
  return {
    async request(method, path, body) {
      ca ??= Bun.file(`${SERVICE_ACCOUNT}/ca.crt`).text();
      // Bound service account tokens rotate, so read it on every request.
      const token = (await Bun.file(`${SERVICE_ACCOUNT}/token`).text()).trim();
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        tls: { ca: await ca },
      });
      const text = await response.text();
      let parsed: KubeObject = {};
      try {
        parsed = text ? (JSON.parse(text) as KubeObject) : {};
      } catch {
        parsed = { message: text };
      }
      return { status: response.status, body: parsed };
    },
  };
}

/** A Kubernetes call that did not succeed, with the API's own message. */
export class KubeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }

  static from(response: KubeResponse, what: string): KubeError {
    const message =
      typeof response.body.message === "string"
        ? response.body.message
        : `status ${response.status}`;
    return new KubeError(response.status, `${what}: ${message}`);
  }

  /** A ResourceQuota refused the object. */
  get isQuota(): boolean {
    return this.status === 403 && /exceeded quota/i.test(this.message);
  }

  /** The namespace is being deleted, so nothing new can go in it. */
  get isTerminating(): boolean {
    return /being terminated/i.test(this.message);
  }
}
