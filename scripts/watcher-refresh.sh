#!/usr/bin/env bash
# Run right after a web deploy (scripts/deploy-web.sh, scripts/deploy-mainnet-hosting.sh): records the live
# claim page as the watcher's expected fingerprint, so an honest deploy is not an alert. It first checks that
# every live script is byte-identical to the build just deployed (web/.svelte-kit/output/client), then
# redeploys the watcher with the new list and commits it. Never prints a secret. Never runs `wrangler login`.
#   scripts/watcher-refresh.sh testnet|mainnet
set -euo pipefail
net=${1:?usage: scripts/watcher-refresh.sh testnet|mainnet}
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
ACCOUNT=f0b938c1641f5223c48199ec45751913 # Cloudflare account id
token_file=${CLOUDFLARE_TOKEN_FILE:-$HOME/.config/cloudflare/api-token}
die() { echo "watcher-refresh: $*" >&2; exit 1; }

url=$(NET=$net node -e '
  const v = JSON.parse(require("fs").readFileSync("watcher/wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, "")).env[process.env.NET]?.vars;
  console.log(v?.CLAIM_PAGE_URL || "")')
[[ -n $url ]] || die "CLAIM_PAGE_URL is empty in watcher/wrangler.jsonc env.$net"
[[ -d web/.svelte-kit/output/client ]] || die "no web build: run this right after the web deploy, from the same tree"

out=watcher/expected/$net.json
for i in $(seq 12); do # the edge can serve the previous version for a few seconds
  if node watcher/scripts/fingerprint.ts "$url" 44 web/.svelte-kit/output/client >"$out.tmp"; then mv "$out.tmp" "$out"; break; fi
  rm -f "$out.tmp"
  [[ $i == 12 ]] && die "the live claim page never matched the local build: do not trust it; the watcher keeps the old list"
  sleep 5
done

wr() { (cd watcher && CLOUDFLARE_API_TOKEN=$(cat "$token_file") npx wrangler "$@"); }
(cd watcher && pnpm install --frozen-lockfile)
wr whoami 2>/dev/null | grep -q "$ACCOUNT" || die "the Cloudflare token does not see account $ACCOUNT"
wr deploy --env "$net"
git add "$out"
git diff --cached --quiet -- "$out" || git commit -m "watcher: expected $net claim page after web deploy" -- "$out"
echo "watcher-refresh: $net list has $(grep -c '"/_app/' "$out") scripts; ALERT_WEBHOOK_URL must be set once: (cd watcher && npx wrangler secret put ALERT_WEBHOOK_URL --env $net)"
