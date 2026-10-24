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
helm upgrade daedalus deploy/helm/daedalus --reuse-values \
  --set admin.enabled=true --set admin.bootstrap.existingSecret=daedalus-admin
kubectl -n daedalus port-forward deploy/daedalus-gateway 8082
open http://localhost:8082/admin/
```

By default the port is bound to 127.0.0.1 inside the pod, so only
`kubectl port-forward` reaches it. `admin.expose: true` adds a ClusterIP
Service and lets in only the `admin.allowFrom` peers. Put TLS in front, since
sign-in off localhost needs https. Every admin action is logged to the
gateway's stdout as a JSON line (`"audit":"admin"`) and kept in its database.
To rotate the token, change the Secret and restart the gateway. The design
and threat model are in `artifacts/cloud-sessions/admin-design.md` in the
Daedalus workspace.

## gVisor (optional)

Tested on kind with gVisor release-20261012.0, arm64. Newer releases ship one
tarball per architecture, `https://storage.googleapis.com/gvisor/releases/release/<version>/<arch>/gvisor.tar.bz2`
with a `.sha512` beside it (there is no `latest` path and no bare `runsc`).
Extract it and copy `runsc`, `containerd-shim-runsc-v1` and the `gvisor-bin`
directory into `/usr/local/bin` in the kind node. Use `docker cp` into `/opt`,
not `/tmp`, which is a tmpfs in the node. Then append to
`/etc/containerd/config.toml`:

```
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"
```

Run `systemctl restart containerd` in the node, create a `RuntimeClass` named
`gvisor` with handler `runsc`, and install with
`--set workspace.runtimeClassName=gvisor`. Not scripted yet.

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
