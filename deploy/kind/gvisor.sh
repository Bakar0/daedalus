#!/usr/bin/env bash
# Install gVisor (runsc) into the kind node so workspace pods can use the
# chart's default RuntimeClass. Safe to run again: it does only what is missing.
# Usage: deploy/kind/gvisor.sh   (KIND_CLUSTER, default daedalus)
set -euo pipefail

cluster="${KIND_CLUSTER:-daedalus}"
node="$cluster-control-plane"
version=20261012.0
# sha512 of gvisor.tar.bz2 for $version, per architecture.
sha_aarch64=2fe7425abd16ad6ca649ab9bc3d7e8e76756834d86ffcc08dbe97c82c3b7262a7d6401f23632f2b296649cc1408b560416b2ab65a4043aa123fc7b90f3a1b2e2
sha_x86_64=9606445eed5aedfcf05310e7ccef61d994089914c6622fc82624c24d2b18db1b2210f40e40a7be27b8b7772859de7d95c501b4eba66423053c960bf671377c5e

if docker exec "$node" test -x /usr/local/bin/runsc; then
  echo "gVisor binaries already in $node"
else
  arch="$(docker exec "$node" uname -m)"
  case "$arch" in
    aarch64) sha="$sha_aarch64" ;;
    x86_64) sha="$sha_x86_64" ;;
    *) echo "no gVisor build for $arch" >&2; exit 1 ;;
  esac
  dir="$(mktemp -d)"
  trap 'rm -rf "$dir"' EXIT
  echo "Downloading gVisor $version ($arch)..."
  curl -fsSL -o "$dir/gvisor.tar.bz2" \
    "https://storage.googleapis.com/gvisor/releases/release/$version/$arch/gvisor.tar.bz2"
  echo "$sha  $dir/gvisor.tar.bz2" | shasum -a 512 -c - >/dev/null
  tar -xjf "$dir/gvisor.tar.bz2" -C "$dir"
  # /tmp in the node is a tmpfs, so copy through /opt.
  docker exec "$node" rm -rf /opt/gvisor
  docker exec "$node" mkdir -p /opt/gvisor
  for f in runsc containerd-shim-runsc-v1 gvisor-bin; do
    docker cp "$dir/$f" "$node:/opt/gvisor/"
  done
  docker exec "$node" sh -c 'rm -rf /usr/local/bin/gvisor-bin &&
    cp -r /opt/gvisor/* /usr/local/bin/ && rm -rf /opt/gvisor'
  echo "gVisor $version installed in $node"
fi

# The runsc runtime for containerd. pod_annotations passes the gateway's
# dev.gvisor.* mount hints on to runsc; without them the runner cannot reach
# the session's socket.
config=/etc/containerd/config.toml
if docker exec "$node" grep -q 'pod_annotations = \["dev.gvisor' "$config"; then
  echo "containerd runsc runtime already configured in $node"
  exit 0
fi
if ! docker exec "$node" grep -q 'runtimes.runsc]' "$config"; then
  docker exec "$node" sh -c "printf '%s\n' '' \
    '[plugins.\"io.containerd.grpc.v1.cri\".containerd.runtimes.runsc]' \
    '  runtime_type = \"io.containerd.runsc.v1\"' >>$config"
fi
docker exec "$node" sed -i \
  's/^  runtime_type = "io.containerd.runsc.v1"$/&\n  pod_annotations = ["dev.gvisor.*"]/' "$config"
docker exec "$node" systemctl restart containerd
kubectl --context "kind-$cluster" wait --for=condition=Ready "node/$node" --timeout=120s >/dev/null
echo "containerd runsc runtime configured in $node"
