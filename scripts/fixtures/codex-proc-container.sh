#!/bin/sh
set -eu
# This script runs only inside its disposable privileged container. Mount changes
# live in a further private mount namespace, never the host or another container.
runuser -u node -- node scripts/check-codex-proc.ts normal
unshare --mount --propagation private sh -eu -c '
  fixture=$(mktemp)
  trap '\''rm -f "$fixture"'\'' EXIT
  echo masked-fixture > "$fixture"
  mount --bind "$fixture" /proc/sys/kernel/random/boot_id
  runuser -u node -- node scripts/check-codex-proc.ts masked
'
