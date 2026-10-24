# Deploying Daedalus cloud workspaces

`deploy/helm/daedalus` is the Helm chart. It needs Kubernetes 1.30 or later
because it ships a ValidatingAdmissionPolicy (GA in 1.30). `deploy/kind` runs it
on a local kind cluster.

## Local cluster

```
deploy/kind/up.sh     # cluster, images, chart; prints the gateway URL
deploy/kind/down.sh
```

`up.sh` builds `apps/gateway/Dockerfile` and `apps/runner/Dockerfile` when they
exist and loads them into the node. The gateway is reachable at
`http://localhost:8080` through a NodePort mapped by `kind-config.yaml`. The
node image is `kindest/node:v1.33.1`, and its default CNI, kindnet, enforces
NetworkPolicy (checked: a pod in a tenant namespace could not reach pods in
other namespaces, and others could not reach it).

## Access model

The gateway ServiceAccount has no cluster-wide access to pods or secrets.
`ClusterRole daedalus-gateway` lets it manage namespaces and rolebindings and
bind only `daedalus-tenant-admin`. After creating `u-<userId>` it creates a
RoleBinding `daedalus-gateway` there, which gives it pods, secrets, PVCs,
network policies, resource quotas and service accounts in that namespace only.
A ValidatingAdmissionPolicy rejects, for the gateway's identity, namespace and
rolebinding writes outside namespaces named `u-*` that carry the
`daedalus.dev/user` label, and rolebindings to any role but
`daedalus-tenant-admin`.

Two more admission policies back this up. `daedalus-gateway-scope` requires the
labels `pod-security.kubernetes.io/enforce=restricted` and
`enforce-version=v1.30` on every namespace the gateway creates, and exactly one
subject, the gateway ServiceAccount, on every RoleBinding. `daedalus-gateway-pods`
allows the gateway to create only the two-container workspace pod: containers
`runner` and `session`, both with the chart's runner image (repository and tag),
no host namespaces or host ports, no privileged containers, service account
`runner` without a token, and volumes limited to the pod's own `ws-<id>` and
`ws-<id>-state` PVCs, its `ws-<id>-runner` Secret and emptyDirs. The volumes
`state` and `token` may be mounted only in `runner`, and `workspace` and `cache`
only in `session`. `deploy/kind/policy-test/run.sh` runs these cases as server
dry runs against the kind cluster. By digest instead of tag is a 1b change.

The tenant RBAC verbs are get, list, watch, create and delete. The gateway
cannot update or patch objects, so it must create and delete rather than apply.

## NetworkPolicy

The per-user policy denies all ingress and allows egress to the gateway on its
port, cluster DNS and the internet, except `tenant.blockedEgressCIDRs`. The
default blocks all RFC 1918 ranges and link-local, which covers pod and service
CIDRs and the cloud metadata address. Adjust it if your cluster uses public
ranges for pods.

## Admin page (optional)

The gateway can serve an admin page on a port of its own: users, their
workspaces with status, sleep times, days until collection, disk and pod
resources, sleep, wake and delete, a per-user workspace limit, a cluster
summary and an audit log. It is off by default. To turn it on, make a Secret
with an `admin-token` key (and optionally `viewer-token`, for read-only
access), each at least 32 characters:

```
kubectl -n daedalus create secret generic daedalus-admin \
  --from-literal=admin-token="$(openssl rand -base64 32)"
helm upgrade daedalus deploy/helm/daedalus --reset-then-reuse-values \
  --set admin.enabled=true --set admin.bootstrap.existingSecret=daedalus-admin
kubectl -n daedalus port-forward deploy/daedalus-gateway 8082
open http://localhost:8082/admin/
```

By default the port is bound to 127.0.0.1 inside the pod, so only
`kubectl port-forward` reaches it. `admin.expose: true` adds a ClusterIP
Service and lets in only the `admin.allowFrom` peers. Sign-in off loopback
needs https: put a TLS proxy in front and list its addresses in
`admin.trustedProxies`, since the gateway believes `X-Forwarded-Proto` only
from those. Loopback is decided from the socket address, not the Host header. Every admin action is logged to the
gateway's stdout as a JSON line (`"audit":"admin"`) and kept in its database.
To rotate the token, change the Secret and restart the gateway. The design
and threat model are in `artifacts/cloud-sessions/admin-design.md` in the
Daedalus workspace.

## gVisor

Workspace pods run in gVisor by default (`workspace.runtimeClassName: gvisor`).
The chart creates `RuntimeClass gvisor` with handler `runsc`
(`workspace.runtimeClassHandler`), or uses an existing one of that name, such
as GKE Sandbox's, when its handler matches. The install fails with a message
when the nodes report their runtime handlers (`status.runtimeHandlers`, 1.30
or later with a recent containerd) and none offers the handler. Nodes that
report none cannot be checked, and NOTES says so. On a cluster with nodes both
with and without gVisor, add a `nodeSelector` that keeps workspaces on gVisor
nodes (not in the chart yet).

`--set workspace.runtimeClassName=""` runs workspaces on the node's default
runtime. Then workspace code shares the host kernel with every other pod on the
node, so one kernel bug is a way out of the workspace. Do not do this on a
shared cluster. The `daedalus-gateway-pods` admission policy requires the
configured RuntimeClass on every workspace pod, so a compromised gateway cannot
drop it.

On kind, `deploy/kind/gvisor.sh` (run by `up.sh`, and safe to run again)
installs gVisor 20261012.0 into the node: it downloads
`https://storage.googleapis.com/gvisor/releases/release/<version>/<arch>/gvisor.tar.bz2`
(`<arch>` is `aarch64` or `x86_64`), checks it against a pinned sha512, copies
`runsc`, `containerd-shim-runsc-v1` and `gvisor-bin` into `/usr/local/bin`
through `/opt` (the node's `/tmp` is a tmpfs), adds the `runsc` runtime to
`/etc/containerd/config.toml` and restarts containerd. On other clusters do
the same on each node, or use the provider's gVisor option.

The runtime must pass the pod annotations `dev.gvisor.*` to runsc
(`pod_annotations = ["dev.gvisor.*"]` under the `runsc` runtime in
containerd). The gateway sets gVisor mount hints on the `shared` volume so it
is one tmpfs in the pod's sandbox; without them each container sees its own
copy of the directory, the runner cannot connect to the session's socket, and
moving a workspace to the cloud fails with "The runner refused: Failed to
connect". The pod admission policy allows no other `dev.gvisor.*` annotation.

gVisor is slower for file-system-heavy work: in the stage 0 benchmark on kind,
a git clone was 4 to 6 times slower and a warm `bun install` about 10 times.

## EKS checklist (before 1b)

The chart's defaults were checked on kind only. On EKS, confirm each item:

- The VPC CNI's network policy agent is on (`enableNetworkPolicy: "true"` in the
  `vpc-cni` add-on configuration). Without it every NetworkPolicy is silently
  ignored. Check that a tenant pod cannot reach a pod in another namespace
  before installing anything else.
- Prefer private node subnets. Nodes with public IPs are reachable through
  `0.0.0.0/0` minus the private ranges, so a workspace could reach node
  NodePorts and host-network listeners. If you must use public subnets, add
  the node public addresses to `tenant.blockedEgressCIDRs`.
- Set `tenant.blockedEgressCIDRs` to cover the VPC CIDR, which may be public
  space if you use a secondary CIDR. The default covers RFC 1918 and
  link-local, so it includes the metadata address 169.254.169.254.
- Require IMDSv2 with hop limit 1 on the node group so pods cannot use the
  metadata service even if the policy is off.
- The policy has no IPv6 egress rule, so an enforcing CNI blocks IPv6 egress,
  including `fd00:ec2::254`. Verify on a dual-stack cluster.
- The EKS public API endpoint is reachable from tenant pods, which hold no
  token. Restrict it with `publicAccessCidrs` or use a private endpoint.
- DNS to kube-dns is open, so a workspace can resolve cluster service names and
  send data out through DNS queries. Accept it for stage 0 or add a DNS policy.
- Label the release namespace `pod-security.kubernetes.io/enforce=restricted`.
