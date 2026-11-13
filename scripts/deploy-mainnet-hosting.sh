#!/usr/bin/env bash
# Deploys the three mainnet Workers (zarf-near-verifier, zarf-near-relayer, zarf-near-claim) from the
# committed head, after the checks in docs/deploy/mainnet-hosting.md. Run it only once the owner has
# approved the mainnet escrow and env.mainnet in the three wrangler.jsonc files is filled in.
# Never prints a secret. Never runs `wrangler login`.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
ACCOUNT=f0b938c1641f5223c48199ec45751913 # Cloudflare account id
dir=${ZARF_NEAR_SECRETS:-$HOME/.config/zarf-near}
token_file=${CLOUDFLARE_TOKEN_FILE:-$HOME/.config/cloudflare/api-token}
die() { echo "deploy-mainnet-hosting: $*" >&2; exit 1; }

[[ -z $(git status --porcelain) ]] || die "the tree is not clean: deploy from a committed head"
[[ -f $dir/mainnet-verifier.seed && -f $dir/mainnet-relayer.key ]] || die "no mainnet keys in $dir: run scripts/mainnet-keys.mjs first"
[[ -f $token_file ]] || die "no Cloudflare token at $token_file"

wr() { (cd "$1" && shift && CLOUDFLARE_API_TOKEN=$(cat "$token_file") npx wrangler "$@"); }
(cd watcher && pnpm install --frozen-lockfile >/dev/null)
wr watcher whoami 2>/dev/null | grep -q "$ACCOUNT" || die "the Cloudflare token does not see account $ACCOUNT"
# Blue-team B1: nothing goes live while the watcher's alerts would reach nobody (src/index.ts throws without it).
wr watcher secret list --env mainnet 2>/dev/null | grep -qw ALERT_WEBHOOK_URL ||
  die "the mainnet watcher has no ALERT_WEBHOOK_URL secret, so its alerts would reach nobody. Set it first: (cd watcher && npx wrangler secret put ALERT_WEBHOOK_URL --env mainnet)"

# env.mainnet must be filled in and agree across the three workers (jsonc: strip // comments first).
vals=$(node -e '
  const fs = require("fs");
  const env = (p) => JSON.parse(fs.readFileSync(p, "utf8").replace(/^\s*\/\/.*$/gm, "")).env.mainnet.vars;
  const v = env("verifier/wrangler.jsonc"), r = env("relayer/wrangler.jsonc"), w = env("web/wrangler.jsonc");
  if (!(v.CONTRACT_ID && v.CONTRACT_ID === r.CONTRACT_ID && r.CONTRACT_ID === w.PUBLIC_CONTRACT_ID)) throw new Error("CONTRACT_ID empty or different across the three env.mainnet blocks");
  console.log(v.CONTRACT_ID, r.RELAYER_ACCOUNT_ID || "-", r.VERIFIER_SIGNERS || "-", v.GOOGLE_CLIENT_ID || "-", w.PUBLIC_GOOGLE_CLIENT_ID || "-");') ||
  die "env.mainnet is not filled in (see the error above)"
read -r contract relayer_account signers vclient wclient <<<"$vals"
[[ $relayer_account != - && $signers != - ]] || die "RELAYER_ACCOUNT_ID and VERIFIER_SIGNERS must be set in relayer env.mainnet"
[[ $vclient != - && $vclient == "$wclient" ]] || die "GOOGLE_CLIENT_ID (verifier) and PUBLIC_GOOGLE_CLIENT_ID (web) must be set and equal"
# The upgrade watcher (watcher/README.md) must watch this escrow and these signers before anything goes live.
CONTRACT=$contract SIGNERS=$signers node -e '
  const v = JSON.parse(require("fs").readFileSync("watcher/wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, "")).env.mainnet.vars;
  const want = (s) => s.split(",").map((x) => x.trim()).filter(Boolean).sort().join(",");
  if (v.CONTRACT_ID !== process.env.CONTRACT || !v.EXPECTED_OWNER || !v.CLAIM_PAGE_URL || !v.EXPECTED_CODE_HASH || want(v.EXPECTED_SIGNERS) !== want(process.env.SIGNERS))
    throw new Error("watcher env.mainnet: CONTRACT_ID, EXPECTED_SIGNERS must match, EXPECTED_OWNER, EXPECTED_CODE_HASH and CLAIM_PAGE_URL must be set");' ||
  die "watcher/wrangler.jsonc env.mainnet is not filled in (see the error above)"

# The signer in the config must be the one derived from the seed file we are about to upload.
signer=$(SEED_FILE="$dir/mainnet-verifier.seed" node -e '
  const c = require("node:crypto"), fs = require("fs");
  const seed = Buffer.from(fs.readFileSync(process.env.SEED_FILE, "utf8").trim(), "hex");
  const k = c.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  console.log(c.createPublicKey(k).export({ format: "der", type: "spki" }).subarray(-32).toString("hex"));')
[[ ",$signers," == *",$signer,"* ]] || die "VERIFIER_SIGNERS does not contain the signer of mainnet-verifier.seed ($signer)"

echo "deploying $(git rev-parse --short HEAD) against $contract (signer $signer, relayer $relayer_account)"
tr -d '\n' <"$dir/mainnet-verifier.seed" | wr verifier secret put SIGNER_SEED --env mainnet
tr -d '\n' <"$dir/mainnet-relayer.key" | wr relayer secret put RELAYER_KEY --env mainnet
wr verifier deploy --env mainnet
wr relayer deploy --env mainnet
(cd web && pnpm build)
wr web deploy --env mainnet
scripts/watcher-refresh.sh mainnet # records the live claim page and deploys the watcher

echo "health:"
curl -s https://zarf-near-verifier.sparkling-queen-5e77.workers.dev/health; echo
curl -s https://zarf-near-relayer.sparkling-queen-5e77.workers.dev/health; echo
