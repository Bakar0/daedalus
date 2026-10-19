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

The tenant RBAC verbs are get, list, watch, create and delete. The gateway
cannot update or patch objects, so it must create and delete rather than apply.

## NetworkPolicy

The per-user policy denies all ingress and allows egress to the gateway on its
port, cluster DNS and the internet, except `tenant.blockedEgressCIDRs`. The
default blocks all RFC 1918 ranges and link-local, which covers pod and service
CIDRs and the cloud metadata address. Adjust it if your cluster uses public
ranges for pods.

## gVisor (optional)

Install runsc in the kind node, add a `runsc` containerd runtime, create a
`RuntimeClass` named `gvisor` with handler `runsc`, then install with
`--set workspace.runtimeClassName=gvisor`. Not scripted yet.
