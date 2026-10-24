#!/usr/bin/env bash
# Checks the tenant NetworkPolicy from a workspace pod on the kind cluster:
# the instance metadata address and 10.0.0.0/8 are blocked, the gateway's
# runner port and the internet are not. A control pod outside the tenant
# namespace must reach the same targets, so a block is the policy's doing.
# For the metadata address it starts a container on the kind network that
# holds 169.254.169.254 and listens on port 80, and routes the address to it
# from the node, so the traffic leaves the node as it would on a cloud (an
# address on the node itself is never seen by kindnet's policy, which runs
# on postrouting). Both go after the run.
# Usage: deploy/kind/egress-check.sh <namespace>   (its first workspace pod)
set -euo pipefail

ns="${1:?usage: $0 <tenant namespace>}"
cluster="${KIND_CLUSTER:-daedalus}"
node="$cluster-control-plane"
k() { kubectl --context "kind-$cluster" "$@"; }
check_ns=daedalus-egress-check

pod="$(k -n "$ns" get pods -l daedalus.dev/workspace -o name | head -1)"
[ -n "$pod" ] || { echo "no workspace pod in $ns" >&2; exit 1; }
echo "workspace $pod, runtime $(k -n "$ns" get "$pod" -o jsonpath='{.spec.runtimeClassName}')"
echo "owner: $(k -n "$ns" get "$pod" -o jsonpath='{.metadata.ownerReferences[*].kind}/{.metadata.ownerReferences[*].name}')"
gateway_ip="$(k -n daedalus get pods -l app.kubernetes.io/component=gateway -o jsonpath='{.items[0].status.podIP}')"

imds=daedalus-fake-imds
cleanup() {
  k delete ns "$check_ns" --wait=false >/dev/null 2>&1 || true
  docker exec "$node" ip route del 169.254.169.254/32 >/dev/null 2>&1 || true
  docker rm -f "$imds" >/dev/null 2>&1 || true
}
trap cleanup EXIT
node_image="$(docker inspect -f '{{.Config.Image}}' "$node")"
docker rm -f "$imds" >/dev/null 2>&1 || true
docker run -d --name "$imds" --network kind --cap-add NET_ADMIN --entrypoint sh \
  "$node_image" -c 'ip addr add 169.254.169.254/32 dev lo &&
    exec python3 -m http.server 80 --bind 169.254.169.254' >/dev/null
imds_ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$imds")"
node_ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$node")"
docker exec "$imds" ip route add 10.244.0.0/16 via "$node_ip"
docker exec "$node" ip route replace 169.254.169.254/32 via "$imds_ip"
for _ in $(seq 30); do
  docker exec "$node" curl -s -m1 -o /dev/null http://169.254.169.254/ && break
  sleep 1
done
k wait --for=delete "ns/$check_ns" --timeout=120s >/dev/null 2>&1 || true
k create ns "$check_ns" >/dev/null
image="$(k -n "$ns" get "$pod" -o jsonpath='{.spec.containers[0].image}')"
k -n "$check_ns" apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata: { name: control }
spec:
  containers:
    - name: probe
      image: $image
      imagePullPolicy: IfNotPresent
      command: [sleep, "600"]
EOF
k -n "$check_ns" wait --for=condition=Ready pod/control --timeout=60s >/dev/null

# Prints "open" or "blocked" for host:port, from the given pod and container.
probe() {
  k exec "$@" -- bun -e '
    const [host, port] = [process.argv[1], Number(process.argv[2])];
    const done = (r) => { console.log(r); process.exit(0); };
    setTimeout(() => done("blocked"), 3000);
    Bun.connect({ hostname: host, port, socket: { open() { done("open") }, data() {} } })
      .catch(() => done("blocked"));' "$target" "$port"
}

fail=0
expect() { # target port expected-from-workspace
  target="$1" port="$2"
  workspace="$(probe -n "$ns" "${pod#pod/}" -c session)"
  ok=yes
  [ "$workspace" = "$3" ] || ok=no
  # A block proves the policy only if the target answers others.
  if [ "$3" = blocked ]; then
    control="$(probe -n "$check_ns" control -c probe)"
    [ "$control" = open ] || ok="no (the control pod is $control too, so this proves nothing)"
  fi
  [ "$ok" = yes ] || fail=1
  printf '%-34s workspace %-8s want %-8s %s\n' "$target:$port" "$workspace" "$3" "$ok"
}
expect 169.254.169.254 80 blocked
expect "$gateway_ip" 8080 blocked
expect daedalus-gateway-runners.daedalus.svc 8081 open
expect 1.1.1.1 443 open
exit "$fail"
