#!/bin/sh
# H-1 check for the built image, for integration where Docker runs. It
# builds the runner's files the way the pod does, then tries to read them as
# the session uid (1001) and expects every read to fail. The files live in
# named volumes, not bind mounts, because Docker Desktop on macOS refuses to
# chown a bind-mounted file to root.
#   usage: apps/runner/test/h1-image-check.sh daedalus-runner:dev
set -eu
image="${1:-daedalus-runner:dev}"
tag="h1check-$$"
cleanup() { docker volume rm -f "$tag-state" "$tag-token" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker volume create "$tag-state" >/dev/null
docker volume create "$tag-token" >/dev/null
# Files owned by the runner uid, group 2000, as fsGroup makes them.
docker run --rm --user 0:0 -v "$tag-state:/var/lib/daedalus-runner" \
  -v "$tag-token:/run/daedalus-token" "$image" sh -c '
    echo secret-token >/run/daedalus-token/token
    echo "{\"secretKey\":\"x\"}" >/var/lib/daedalus-runner/identity.json
    echo "{}" >/var/lib/daedalus-runner/queue.jsonl
    chmod 0700 /var/lib/daedalus-runner
    chmod 0600 /var/lib/daedalus-runner/identity.json /var/lib/daedalus-runner/queue.jsonl
    chown -R 1000:2000 /var/lib/daedalus-runner
    chmod 0440 /run/daedalus-token/token
    chown 0:2000 /run/daedalus-token/token'
failed=0
# The state files are private to uid 1000 by mode (0600 in a 0700 folder), so
# they stay unreadable even if a volume were mounted into the session container.
for path in /var/lib/daedalus-runner/identity.json /var/lib/daedalus-runner/queue.jsonl; do
  if docker run --rm --user 1001:1001 --group-add 2000 \
      -v "$tag-state:/var/lib/daedalus-runner" \
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
# Control: the runner uid does read both, so the test is not passing by accident.
docker run --rm --user 1000:1000 --group-add 2000 \
  -v "$tag-state:/var/lib/daedalus-runner" -v "$tag-token:/run/daedalus-token" \
  "$image" sh -c 'cat /var/lib/daedalus-runner/identity.json /run/daedalus-token/token >/dev/null' \
  || { echo "FAIL: control, the runner uid cannot read its own files"; failed=1; }
exit "$failed"
