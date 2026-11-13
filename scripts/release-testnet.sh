#!/usr/bin/env bash
# One testnet release of the integrated head (T-030): verifier, relayer (GAS_KEY + starter NEAR on), web (+ watcher
# refresh), faucet, then main fast-forwarded to this commit. The owner runs it; agents never do.
#   bash scripts/release-testnet.sh           # from a clean checkout of origin/main
#   DRY=1 bash scripts/release-testnet.sh     # print every command, run none (no token read, no network)
# Stops at the first failure and names the step. Before each Worker deploy it records the live version id, and
# writes the rollback lines to $ROLLBACK (printed at the end and on failure). Never prints a secret; never
# runs `wrangler login`.
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
ACCOUNT=f0b938c1641f5223c48199ec45751913 # Cloudflare account id (operator@example.invalid)
TOKEN_FILE=${CLOUDFLARE_TOKEN_FILE:-$HOME/.config/cloudflare/api-token}
GAS_CREDS=${GAS_CREDS:-$HOME/.near-credentials/testnet/zarf-near-gas-1112.testnet.json} # the starter-NEAR gas account
FAUCET_REF=${FAUCET_REF:-origin/main}
ROLLBACK=${ROLLBACK:-${XDG_STATE_HOME:-$HOME/.local/state}/zarf-near/release-testnet-$(date -u +%Y%m%dT%H%M%SZ).txt} # outside the checkout
DRY=${DRY:-}

step=''
trap '[[ -n $step ]] && { echo; echo "STOPPED at step: $step. Nothing after it ran."; [[ -s $ROLLBACK ]] && { echo "Rollback for what already went out:"; cat "$ROLLBACK"; }; }' ERR
begin() { step=$1; echo; echo "=== $1 ==="; }
# Prints the command; runs it unless DRY. Takes a single string so DRY shows it exactly as run.
run() { echo "+ $1"; [[ -n $DRY ]] || bash -c "set -euo pipefail; cd '$root'; $1"; }
wr() { echo "CLOUDFLARE_API_TOKEN=\$(cat $TOKEN_FILE) npx wrangler"; }

# The live version of a Worker before we replace it: one rollback line per Worker (read at run time).
remember() { # <dir> <worker name> [--env testnet]
  local dir=$1 name=$2; shift 2
  if [[ -n $DRY ]]; then echo "+ (cd $dir && $(wr) deployments status $* --json)  # → rollback line for $name"; return; fi
  local id
  id=$(cd "$dir" && CLOUDFLARE_API_TOKEN=$(cat "$TOKEN_FILE") npx wrangler deployments status "$@" --json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).versions||[];if(v.length!==1)process.exit(1);console.log(v[0].version_id)})')
  echo "(cd $dir && CLOUDFLARE_API_TOKEN=\$(cat $TOKEN_FILE) npx wrangler rollback $id $* -m 'release-testnet rollback' -y)  # $name" >> "$ROLLBACK"
  echo "  live $name version before this release: $id"
}

begin "0 preflight: clean checkout of origin/main, Cloudflare account $ACCOUNT"
run "git fetch -q origin"
run "test -z \"\$(git status --porcelain)\" || { echo 'the checkout has local changes' >&2; exit 1; }"
run "test \"\$(git rev-parse HEAD)\" = \"\$(git rev-parse origin/main)\" || { echo 'HEAD is not origin/main' >&2; exit 1; }"
run "git merge-base --is-ancestor origin/main HEAD || { echo 'origin/main moved: this checkout is no longer a fast-forward' >&2; exit 1; }"
run "git rev-parse -q --verify $FAUCET_REF >/dev/null"
run "test -r $GAS_CREDS"
run "(cd verifier && pnpm install --frozen-lockfile >/dev/null && $(wr) whoami 2>/dev/null | grep -q $ACCOUNT) || { echo 'the token does not see account $ACCOUNT' >&2; exit 1; }"
[[ -n $DRY ]] || { mkdir -p "$(dirname "$ROLLBACK")" && : > "$ROLLBACK"; }
[[ -z $DRY ]] || echo "+ : > $ROLLBACK"

begin "1 verifier (testnet)"
remember verifier zarf-near-verifier --env testnet
run "cd verifier && $(wr) deploy --env testnet"

begin "2 relayer: GAS_KEY secret (piped, never printed), deploy with STARTER_NEAR on"
run "grep -q '\"STARTER_NEAR\": \"on\"' relayer/wrangler.jsonc"
run "cd relayer && pnpm install --frozen-lockfile >/dev/null"
remember relayer zarf-near-relayer --env testnet
run "cd relayer && node -e 'process.stdout.write(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).private_key)' $GAS_CREDS | $(wr) secret put GAS_KEY --env testnet >/dev/null"
run "cd relayer && $(wr) deploy --env testnet"

begin "3 web + watcher refresh (scripts/deploy-web.sh)"
run "cd web && pnpm install --frozen-lockfile >/dev/null"
remember web zarf-near-claim --env testnet
run "scripts/deploy-web.sh testnet"

begin "4 faucet ($FAUCET_REF)"
faucet_dir=${TMPDIR:-/tmp}/zarf-near-faucet-release
run "rm -rf $faucet_dir && git worktree prune && git worktree add -q --detach $faucet_dir $FAUCET_REF"
run "cd $faucet_dir/faucet && pnpm install --frozen-lockfile >/dev/null"
remember "$faucet_dir/faucet" zarf-near-faucet-testnet
run "cd $faucet_dir/faucet && $(wr) deploy"
run "git worktree remove --force $faucet_dir"

# T-029 (near.zarf.to) hook: once it closes, its deploy step goes here, before the push.

begin "5 push main to main (fast-forward only)"
run "git fetch -q origin && git merge-base --is-ancestor origin/main HEAD && git push origin HEAD:main"

step=''
echo; echo "DONE: testnet runs $(git rev-parse --short HEAD) (main) and $FAUCET_REF. Rollback lines: $ROLLBACK"
[[ -n $DRY || ! -s $ROLLBACK ]] || cat "$ROLLBACK"
