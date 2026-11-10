#!/usr/bin/env bash
# Turns on Google sign-in for the live testnet: sets GOOGLE_CLIENT_ID (verifier, env.testnet) and
# PUBLIC_GOOGLE_CLIENT_ID (web, env.testnet), commits, deploys both from the committed head, then checks
# /health and the claim card's Google button (no sign-in is completed). The client id is public.
#   scripts/enable-google-testnet.sh <client id>.apps.googleusercontent.com
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd); cd "$root"
id=${1:-}
die() { echo "enable-google-testnet: $*" >&2; exit 1; }
[[ $id =~ ^[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com$ ]] || die "not a Google OAuth web client id: '$id'"
[[ $(git branch --show-current) == main ]] || die "run on main (the live line)"
[[ -z $(git status --porcelain) ]] || die "the tree is not clean"
# Only the env.testnet block of each file changes (top-level and mainnet keep theirs).
ID="$id" node -e '
  const fs = require("fs");
  for (const [f, k] of [["verifier/wrangler.jsonc", "GOOGLE_CLIENT_ID"], ["web/wrangler.jsonc", "PUBLIC_GOOGLE_CLIENT_ID"]]) {
    const s = fs.readFileSync(f, "utf8"), a = s.indexOf("\"testnet\": {"), b = s.indexOf("\"mainnet\": {");
    if (a < 0 || b < a) throw new Error(f + ": env blocks not where expected");
    const block = s.slice(a, b), next = block.replace(`"${k}": ""`, `"${k}": "${process.env.ID}"`);
    if (next === block) throw new Error(f + ": " + k + " is not empty in env.testnet");
    fs.writeFileSync(f, s.slice(0, a) + next + s.slice(b));
  }'
git add verifier/wrangler.jsonc web/wrangler.jsonc
git commit -q -m "testnet: Google sign-in on (OAuth web client $id)"
export CLOUDFLARE_API_TOKEN=$(cat ~/.config/cloudflare/api-token)
(cd verifier && npx wrangler whoami 2>/dev/null | grep -q f0b938c1641f5223c48199ec45751913) || die "the Cloudflare token does not see account f0b938c1…"
(cd verifier && npx wrangler deploy --env testnet | grep -E "Version ID")
(cd web && pnpm install --frozen-lockfile >/dev/null && pnpm build >/dev/null && npx wrangler deploy --env testnet | grep -E "Version ID")
sleep 5
health=$(curl -s https://zarf-near-verifier-testnet.sparkling-queen-5e77.workers.dev/health); echo "verifier /health: $health"
grep -q '"google_client_id_set":true' <<<"$health" || die "verifier does not report google_client_id_set true"
PLAYWRIGHT_CORE=${PLAYWRIGHT_CORE:-playwright-core} \
  node web/scripts/google-button-check.cjs https://zarf-near-claim-testnet.sparkling-queen-5e77.workers.dev "$id"
echo "done: $(git rev-parse --short HEAD); push with: git push origin main"
