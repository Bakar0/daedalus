#!/usr/bin/env bash
# Server dry runs of the gateway admission policies on the kind cluster, as the
# gateway ServiceAccount. Run after deploy/kind/up.sh; it needs no images.
# Usage: deploy/kind/policy-test/run.sh   (prints each case and the denial)
here="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; cp "$here/pod.yaml" "$T/"; python3 "$here/mkcases.py" "$T"
k() { kubectl --context kind-daedalus "$@"; }
k get cm -n daedalus daedalus-tenant -o jsonpath='{.data.serviceaccount\.yaml}' > "$T/sa.yaml"
trap 'k delete ns u-t u-raw --wait=false >/dev/null 2>&1; rm -rf "$T"' EXIT
T="$T"; C="--context kind-daedalus"; G=system:serviceaccount:daedalus:daedalus-gateway
gw() { kubectl $C --as=$G "$@"; }
res() { tail -1 | cut -c1-230; }
echo "--- namespaces"
echo "no PSA labels:"; printf 'apiVersion: v1\nkind: Namespace\nmetadata: {name: u-nolabel, labels: {daedalus.dev/user: x}}\n' | gw create --dry-run=server -f - 2>&1 | res
printf 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: u-t\n  labels: {daedalus.dev/user: t, pod-security.kubernetes.io/enforce: restricted, pod-security.kubernetes.io/enforce-version: v1.30}\n' > $T/nst.yaml
echo "with PSA labels:"; gw create --dry-run=server -f $T/nst.yaml 2>&1 | res
kubectl $C apply -f $T/nst.yaml | res; kubectl $C apply -n u-t -f $T/sa.yaml | res
echo "--- rolebindings"
rb() { printf 'apiVersion: rbac.authorization.k8s.io/v1\nkind: RoleBinding\nmetadata: {name: daedalus-gateway, namespace: u-t}\nroleRef: {apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: daedalus-tenant-admin}\nsubjects: %s\n' "$1" | gw create -f - $2 2>&1 | res; }
echo "group system:authenticated:"; rb '[{kind: Group, name: "system:authenticated", apiGroup: rbac.authorization.k8s.io}]' --dry-run=server
echo "gateway SA plus another SA:"; rb '[{kind: ServiceAccount, name: daedalus-gateway, namespace: daedalus},{kind: ServiceAccount, name: x, namespace: daedalus}]' --dry-run=server
echo "gateway SA only:"; rb '[{kind: ServiceAccount, name: daedalus-gateway, namespace: daedalus}]'
echo "--- metrics (read-only, tenant namespaces only)"
# A SubjectAccessReview, not kubectl auth can-i: can-i says no for any group
# the cluster does not serve, and kind has no metrics-server.
sar() { printf 'apiVersion: authorization.k8s.io/v1\nkind: SubjectAccessReview\nspec:\n  user: %s\n  groups: [system:serviceaccounts, system:serviceaccounts:daedalus, system:authenticated]\n  resourceAttributes: {group: metrics.k8s.io, resource: %s, verb: %s, namespace: "%s"}\n' "$G" "$1" "$2" "$3" | kubectl $C create -f - -o jsonpath='{.status.allowed}'; }
for c in "pods list u-t yes" "pods get u-t yes" "pods create u-t no" "pods delete u-t no" \
         "pods list kube-system no" "pods list daedalus no" "pods list _ no" "nodes list _ no"; do
  set -- $c; ns="$3"; [ "$ns" = _ ] && ns=""
  got="$(sar "$1" "$2" "$ns")"; [ "$got" = true ] && got=yes || got=no
  [ "$got" = "$4" ] && r=ok || r="UNEXPECTED (want $4)"
  echo "$2 $1.metrics.k8s.io in ${ns:-all namespaces}: $got $r"
done
echo "--- pods"
echo "valid pod:"; gw create --dry-run=server -f $T/pod.yaml 2>&1 | res
for n in $T/neg-*.yaml; do echo "$(basename $n .yaml):"; gw create --dry-run=server -f $n 2>&1 | res; done
echo "--- cases the namespace Pod Security would stop first (u-raw has no PSA label)"
k get ns u-raw >/dev/null 2>&1 || { k create ns u-raw >/dev/null; k label ns u-raw daedalus.dev/user=raw >/dev/null; }
k get cm -n daedalus daedalus-tenant -o jsonpath='{.data.serviceaccount\.yaml}' | k apply -n u-raw -f - >/dev/null
k create rolebinding daedalus-gateway -n u-raw --clusterrole=daedalus-tenant-admin --serviceaccount=daedalus:daedalus-gateway >/dev/null 2>&1
for n in hostpath hostpid third-container privileged; do
  sed 's/namespace: u-t/namespace: u-raw/; s/allowPrivilegeEscalation: false, readOnlyRootFilesystem: true/allowPrivilegeEscalation: true, readOnlyRootFilesystem: true/' $T/neg-$n.yaml > $T/raw-$n.yaml
  echo "$n (no PSA):"; k --as=system:serviceaccount:daedalus:daedalus-gateway create --dry-run=server -f $T/raw-$n.yaml 2>&1 | tail -1 | sed 's/.*denied request: //' | cut -c1-170
done
