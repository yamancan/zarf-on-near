#!/usr/bin/env bash
# `make demo` against a local NEAR sandbox: starts `make -C contract demo-sandbox` in its own
# process group, waits for its env block, runs `make demo` with it (DEMO_REQUIRE_RPC=1, so it
# can never fall back to mocks), and stops the whole group on exit. Test-only keys; nothing
# touches a real network.
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
log=$(mktemp)
timeout_s=${SANDBOX_TIMEOUT_S:-900} # the first run compiles the contracts and fetches the sandbox

pidfile=$(mktemp)
pgid=
cleanup() {
  if [[ -n $pgid ]] && kill -0 -- "-$pgid" 2>/dev/null; then
    kill -TERM -- "-$pgid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do kill -0 -- "-$pgid" 2>/dev/null || break; sleep 1; done
    kill -KILL -- "-$pgid" 2>/dev/null || true
  fi
  rm -f "$log" "$pidfile"
}
# Installed before the session starts, so a Ctrl-C during the pidfile wait is still tracked.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Own session and process group: make -> sh -> demo_sandbox -> neard all share one pgid.
# setsid may fork, so the group id is read from inside the new session, not from $!.
setsid bash -c 'echo $$ >"$1"; exec make -C "$2/contract" demo-sandbox' _ "$pidfile" "$repo_root" >"$log" 2>&1 &
for _ in $(seq 50); do [[ -s $pidfile ]] && break; sleep 0.1; done
pgid=$(<"$pidfile")
[[ $pgid =~ ^[0-9]+$ ]] || { pgid=; echo "could not start the demo sandbox" >&2; exit 1; }

state=timeout
for ((i = 0; i < timeout_s; i++)); do
  if grep -q '^# sandbox running' "$log"; then state=ready; break; fi
  if ! kill -0 -- "-$pgid" 2>/dev/null; then state=exited; break; fi
  sleep 1
done
case $state in
  exited) tail -n 30 "$log" >&2; echo "demo sandbox exited before it was ready (last 30 lines above)" >&2; exit 1 ;;
  timeout) tail -n 30 "$log" >&2; echo "demo sandbox not ready after ${timeout_s}s (last 30 lines above)" >&2; exit 1 ;;
esac

# Only the eight known names, with a strict value charset; nothing is sourced.
while IFS='=' read -r k v; do
  case $k in
    NEAR_RPC_URL | CONTRACT_ID | NETWORK | RELAYER_ACCOUNT_ID | RELAYER_KEY | DEMO_CAMPAIGN_ID | DEMO_VECTOR_CAMPAIGN | DEMO_DESTINATION)
      [[ $v =~ ^[A-Za-z0-9:._/+-]+$ ]] && export "$k=$v" ;;
  esac
done < <(sed -n 's/^export //p' "$log")
: "${NEAR_RPC_URL:?missing from the sandbox env block}" "${CONTRACT_ID:?missing}" "${NETWORK:?missing}"
: "${RELAYER_ACCOUNT_ID:?missing}" "${RELAYER_KEY:?missing}" "${DEMO_CAMPAIGN_ID:?missing}"
: "${DEMO_VECTOR_CAMPAIGN:?missing}" "${DEMO_DESTINATION:?missing}"

DEMO_REQUIRE_RPC=1 make -C "$repo_root" demo
