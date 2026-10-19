#!/usr/bin/env bash
# Create a kind cluster, load the gateway and runner images, install the chart.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cluster="${KIND_CLUSTER:-daedalus}"
ns="${DAEDALUS_NAMESPACE:-daedalus}"

if ! kind get clusters | grep -qx "$cluster"; then
  kind create cluster --name "$cluster" --config "$here/kind-config.yaml"
fi
kubectl config use-context "kind-$cluster" >/dev/null

build() { # name, dockerfile path
  if [ -f "$repo/$2" ]; then
    docker build -t "daedalus-$1:dev" -f "$repo/$2" "$repo"
    kind load docker-image "daedalus-$1:dev" --name "$cluster"
  else
    echo "skipping $1 image: $2 does not exist on this branch"
  fi
}
build gateway apps/gateway/Dockerfile
build runner apps/runner/Dockerfile

kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace "$ns" pod-security.kubernetes.io/enforce=restricted --overwrite

helm upgrade --install daedalus "$here/../helm/daedalus" \
  --namespace "$ns" -f "$here/values.yaml" "$@"

echo "Waiting for the gateway..."
kubectl -n "$ns" rollout status deploy/daedalus-gateway --timeout=180s || {
  echo "gateway not ready (is the daedalus-gateway:dev image built?)" >&2
  exit 1
}
echo
echo "Gateway URL: http://localhost:8080"
echo "Dev login:   POST http://localhost:8080/v1/dev/login"
