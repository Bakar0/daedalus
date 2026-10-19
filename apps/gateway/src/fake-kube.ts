import type { KubeApi, KubeObject, KubeResponse } from "./kube";

/**
 * An in-memory Kubernetes API for tests. Objects live under their path. It
 * acts out the parts of the real API the controller depends on:
 *
 * - Namespaced objects need their namespace, and a namespace being deleted
 *   refuses new ones.
 * - The gateway's own access: outside the cluster-wide namespace and
 *   RoleBinding rights, every namespaced call needs the `daedalus-gateway`
 *   RoleBinding in that namespace first, as the chart's RBAC does.
 * - A pod quota per namespace, refused with the API's "exceeded quota".
 */
export class FakeKube implements KubeApi {
  readonly objects = new Map<string, KubeObject>();
  readonly calls: string[] = [];
  /** Pods a namespace may hold before the quota refuses more. */
  podQuota = Infinity;
  /** When set, a deleted pod stays, terminating, until `finishDeletes`. */
  slowPodDeletes = false;
  #terminating = new Set<string>();

  async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: KubeObject,
  ): Promise<KubeResponse> {
    this.calls.push(`${method} ${path}`);
    const namespaced = /\/namespaces\/([^/]+)\/([^/]+)/.exec(path);
    if (namespaced) {
      const [, namespace, plural] = namespaced;
      if (!this.objects.has(`/api/v1/namespaces/${namespace}`))
        return fail(404, `namespaces "${namespace}" not found`);
      const bound = this.objects.has(
        `/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings/daedalus-gateway`,
      );
      if (plural !== "rolebindings" && !bound)
        return fail(403, `${plural} is forbidden: no access in ${namespace}`);
      if (method === "POST" && this.#terminating.has(namespace!))
        return fail(
          403,
          `unable to create new content in namespace ${namespace} because it is being terminated`,
        );
    }

    if (method === "POST") {
      const metadata = body?.metadata as { name?: string } | undefined;
      const key = `${path}/${metadata?.name}`;
      if (this.objects.has(key)) return fail(409, "already exists");
      if (path.endsWith("/pods")) {
        const count = [...this.objects.keys()].filter((other) =>
          other.startsWith(`${path}/`),
        ).length;
        if (count >= this.podQuota)
          return fail(
            403,
            `pods "${metadata?.name}" is forbidden: exceeded quota: tenant, requested: pods=1, used: pods=${count}, limited: pods=${this.podQuota}`,
          );
      }
      const stored = structuredClone(body!);
      if (path.endsWith("/pods")) stored.status = { phase: "Running" };
      this.objects.set(key, stored);
      return { status: 201, body: stored };
    }

    const object = this.objects.get(path);
    if (!object) return fail(404, "not found");
    if (method === "GET") return { status: 200, body: object };

    if (path.includes("/pods/") && this.slowPodDeletes) {
      const metadata = object.metadata as Record<string, unknown>;
      metadata.deletionTimestamp = new Date().toISOString();
      return { status: 200, body: object };
    }
    this.objects.delete(path);
    const namespace = /^\/api\/v1\/namespaces\/([^/]+)$/.exec(path)?.[1];
    if (namespace) {
      // Namespace deletion takes its contents with it.
      for (const key of [...this.objects.keys()])
        if (key.includes(`/namespaces/${namespace}/`)) this.objects.delete(key);
    }
    return { status: 200, body: object };
  }

  /** Finishes pod deletions held by `slowPodDeletes`. */
  finishDeletes(): void {
    for (const [key, object] of this.objects) {
      const metadata = object.metadata as Record<string, unknown>;
      if (metadata.deletionTimestamp) this.objects.delete(key);
    }
  }

  /** Marks a namespace as being deleted. */
  terminate(namespace: string): void {
    this.#terminating.add(namespace);
  }

  pod(namespace: string, name: string): KubeObject | undefined {
    return this.objects.get(`/api/v1/namespaces/${namespace}/pods/${name}`);
  }

  /** Paths of everything stored, sorted, for assertions. */
  paths(): string[] {
    return [...this.objects.keys()].sort();
  }
}

const fail = (status: number, message: string): KubeResponse => ({
  status,
  body: { kind: "Status", status: "Failure", message, code: status },
});
