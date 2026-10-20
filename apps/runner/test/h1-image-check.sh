#!/bin/sh
# H-1 check for the built image, for integration where Docker runs. It
# mounts the runner's files the way the pod does, then tries to read them as
# the session uid (1001) and expects every read to fail.
#   usage: apps/runner/test/h1-image-check.sh daedalus-runner:dev
set -eu
image="${1:-daedalus-runner:dev}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/state" "$work/token"
echo secret-token >"$work/token/token"
echo '{"secretKey":"x"}' >"$work/state/identity.json"
echo '{}' >"$work/state/queue.jsonl"
chmod 0700 "$work/state"
chmod 0600 "$work/state/identity.json" "$work/state/queue.jsonl"
chmod 0440 "$work/token/token"
# Files owned by the runner uid, group 2000, as fsGroup makes them.
docker run --rm --user 0:0 -v "$work:/m" "$image" sh -c \
  'chown -R 1000:2000 /m/state && chown 0:2000 /m/token/token'
failed=0
# The state files are private to uid 1000 by mode (0600 in a 0700 folder), so
# they stay unreadable even if a volume were mounted into the session container.
for path in /var/lib/daedalus-runner/identity.json /var/lib/daedalus-runner/queue.jsonl; do
  if docker run --rm --user 1001:1001 --group-add 2000 \
      -v "$work/state:/var/lib/daedalus-runner" \
      "$image" cat "$path" >/dev/null 2>&1; then
    echo "FAIL: uid 1001 can read $path"
    failed=1
  fi
done
# The token is 0440 root:2000, which group 2000 can read, so the pod spec's
# mounts are what keep it away: the session container has no such volume.
if docker run --rm --user 1001:1001 --group-add 2000 \
    "$image" cat /run/daedalus-token/token >/dev/null 2>&1; then
  echo "FAIL: the session container has a token file"
  failed=1
fi
exit "$failed"
