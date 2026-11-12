#!/usr/bin/env bash
# Deploys the testnet claim web app, then refreshes the upgrade watcher's expected fingerprint of it
# (scripts/watcher-refresh.sh). Mainnet goes through scripts/deploy-mainnet-hosting.sh, which does the same.
# Never prints a secret. Never runs `wrangler login`.
#   scripts/deploy-web.sh testnet
set -euo pipefail
net=${1:?usage: scripts/deploy-web.sh testnet}
[[ $net == testnet ]] || { echo "deploy-web: testnet only; mainnet is scripts/deploy-mainnet-hosting.sh" >&2; exit 1; }
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
ACCOUNT=f0b938c1641f5223c48199ec45751913 # Cloudflare account id
token_file=${CLOUDFLARE_TOKEN_FILE:-$HOME/.config/cloudflare/api-token}

wr() { (cd web && CLOUDFLARE_API_TOKEN=$(cat "$token_file") npx wrangler "$@"); }
(cd web && pnpm install --frozen-lockfile && pnpm build)
wr whoami 2>/dev/null | grep -q "$ACCOUNT" || { echo "deploy-web: the Cloudflare token does not see account $ACCOUNT" >&2; exit 1; }
echo "deploying web $(git rev-parse --short HEAD) to $net"
wr deploy --env "$net"
scripts/watcher-refresh.sh "$net"
