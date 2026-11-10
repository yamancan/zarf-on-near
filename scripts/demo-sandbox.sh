#!/usr/bin/env bash
# `make demo` against a local NEAR sandbox: starts `make -C contract demo-sandbox` in the
# background, waits for its env block, runs `make demo` with it, and stops the sandbox on
# exit. Test-only keys; nothing touches a real network.
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
log=$(mktemp)
timeout_s=${SANDBOX_TIMEOUT_S:-900} # the first run compiles the contracts and fetches the sandbox

make -C "$repo_root/contract" demo-sandbox >"$log" 2>&1 &
sandbox=$!
cleanup() {
  kill "$sandbox" 2>/dev/null || true
  # make forwards nothing by itself: stop the demo_sandbox child too, so its sandbox exits.
  pkill -TERM -P "$sandbox" 2>/dev/null || true
  pkill -TERM -f 'target/debug/demo_sandbox' 2>/dev/null || true
  wait "$sandbox" 2>/dev/null || true
  rm -f "$log"
}
trap cleanup EXIT INT TERM

for ((i = 0; i < timeout_s; i++)); do
  grep -q '^# sandbox running' "$log" && break
  kill -0 "$sandbox" 2>/dev/null || { cat "$log" >&2; echo "demo sandbox exited early" >&2; exit 1; }
  sleep 1
done
grep -q '^# sandbox running' "$log" || { cat "$log" >&2; echo "demo sandbox not ready after ${timeout_s}s" >&2; exit 1; }

# Only the export lines; build output stays out of the environment.
# shellcheck disable=SC1090
source <(grep '^export ' "$log")
make -C "$repo_root" demo
