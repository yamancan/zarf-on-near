#!/usr/bin/env bash
# One testnet release of the integrated head: verifier, relayer (GAS_KEY + starter NEAR on), web (+ watcher
# refresh), faucet, a smoke curl of near.zarf.to, then main fast-forwarded to this commit. The owner runs it;
# agents never do.
#   bash scripts/release-testnet.sh           # from a clean checkout of origin/main
#   DRY=1 bash scripts/release-testnet.sh     # print every command, run none (no token read, no network)
#   RESUME=1 ROLLBACK=<first run's file> bash scripts/release-testnet.sh
#       finish a run that stopped after its web deploy: no verifier, relayer or web deploy; refresh the watcher from
#       the web build already in this tree (it must be the deployed one), then faucet, smoke and push. Appends to
#       that rollback file, never truncates it.
# Stops at the first failure and names the step. Before each Worker deploy it records the live version id, and
# writes the rollback lines to $ROLLBACK (printed at the end and on failure). Step 3's watcher refresh commits
# watcher/expected/testnet.json locally: it reaches main (step 6). Never prints a secret; never
# runs `wrangler login`.
set -Eeuo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
ACCOUNT=f0b938c1641f5223c48199ec45751913 # Cloudflare account id (operator@example.invalid)
TOKEN_FILE=${CLOUDFLARE_TOKEN_FILE:-$HOME/.config/cloudflare/api-token}
GAS_CREDS=${GAS_CREDS:-$HOME/.near-credentials/testnet/zarf-near-gas-1112.testnet.json} # the starter-NEAR gas account
FAUCET_REF=${FAUCET_REF:-origin/main}
RESUME=${RESUME:-}
rollback_given=${ROLLBACK:-}
ROLLBACK=${ROLLBACK:-${XDG_STATE_HOME:-$HOME/.local/state}/zarf-near/release-testnet-$(date -u +%Y%m%dT%H%M%SZ).txt} # outside the checkout
DRY=${DRY:-}

step=''
rerun_hint='' # set once step 3 begins: only from then on can the checkout hold the watcher-refresh commit
stopped() {
  [[ -n $step ]] || return 0
  echo; echo "STOPPED at step: $step. Nothing after it ran."
  [[ -z $rerun_hint ]] || echo "To run again: git reset --hard origin/main (drops the local watcher-refresh commit; step 3 makes it again)."
  if [[ -s $ROLLBACK ]]; then
    echo "Rollback for what already went out (newest last; run them newest first):"; cat "$ROLLBACK"
    echo "Keep $ROLLBACK: it holds the pre-release version ids. A rerun writes a new file whose ids are this run's deploys."
  fi
}
trap stopped ERR
begin() { step=$1; echo; echo "=== $1 ==="; }
# Prints the command; runs it unless DRY. Takes a single string so DRY shows it exactly as run.
run() { echo "+ $1"; [[ -n $DRY ]] || bash -c "set -euo pipefail; cd '$root'; $1"; }
wr() { echo "CLOUDFLARE_API_TOKEN=\$(cat $TOKEN_FILE) npx wrangler"; }

# The live version of a Worker before we replace it: one rollback line per Worker (read at run time).
remember() { # <dir> <worker name> [--env testnet]
  local dir=$1 name=$2; shift 2
  if [[ -n $DRY ]]; then echo "+ (cd $dir && $(wr) deployments status $* --json)  # → rollback line for $name"; return; fi
  # A temporary checkout (the faucet) is addressed by Worker name from web/, which stays; the rest from their own dir.
  local at="cd $root/$dir && CLOUDFLARE_API_TOKEN=\$(cat $TOKEN_FILE) npx wrangler" by="$*"
  [[ $dir != /* ]] || { at="cd $root/web && CLOUDFLARE_ACCOUNT_ID=$ACCOUNT CLOUDFLARE_API_TOKEN=\$(cat $TOKEN_FILE) npx wrangler"; by="--name $name"; }
  local out err id
  err=$(mktemp)
  if ! out=$(cd "$dir" && CLOUDFLARE_API_TOKEN=$(cat "$TOKEN_FILE") npx wrangler deployments status "$@" --json 2>"$err"); then
    # 10007: the Worker does not exist yet, so this release creates it. Removing it is the owner's call: a comment.
    if grep -q 'code: 10007' "$err" - <<<"$out"; then
      rm -f "$err"
      echo "# $name was new before this release; to remove it: ($at delete $by --force)" >> "$ROLLBACK"
      echo "  $name does not exist yet: this release creates it"
      return 0
    fi
    cat "$err" >&2; rm -f "$err"; return 1
  fi
  rm -f "$err"
  id=$(node -e 'const v=JSON.parse(process.argv[1]).versions||[];if(v.length!==1)process.exit(1);console.log(v[0].version_id)' "$out")
  echo "($at rollback $id $by -m 'release-testnet rollback' -y)  # $name" >> "$ROLLBACK"
  echo "  live $name version before this release: $id"
}

# Sourced (scripts/release-testnet.test.mjs): the functions above only, nothing runs.
[[ ${BASH_SOURCE[0]} == "$0" ]] || return 0

# A resume keeps the first run's file: it holds the pre-release ids, and the faucet's line is added to it.
if [[ -n $RESUME ]] && ! [[ -n $rollback_given && -s $rollback_given ]]; then
  echo "RESUME=1 needs ROLLBACK=<the first run's rollback file>, which must exist and not be empty" >&2; exit 64
fi

begin "0 preflight: clean checkout of origin/main, Cloudflare account $ACCOUNT"
run "git fetch -q origin"
run "test -z \"\$(git status --porcelain)\" || { echo 'the checkout has local changes' >&2; exit 1; }"
run "test \"\$(git rev-parse HEAD)\" = \"\$(git rev-parse origin/main)\" || { echo 'HEAD is not origin/main' >&2; exit 1; }"
run "git merge-base --is-ancestor origin/main HEAD || { echo 'origin/main moved: this checkout is no longer a fast-forward' >&2; exit 1; }"
run "git rev-parse -q --verify $FAUCET_REF >/dev/null"
run "test -r $GAS_CREDS"
# The watcher refresh (step 3) fingerprints https://near.zarf.to, which is served through proxy/.
run "curl -sf -o /dev/null --max-time 20 https://near.zarf.to/ || { echo 'near.zarf.to does not answer: deploy the proxy first' >&2; exit 1; }"
run "(cd verifier && pnpm install --frozen-lockfile >/dev/null && $(wr) whoami 2>/dev/null | grep -q $ACCOUNT) || { echo 'the token does not see account $ACCOUNT' >&2; exit 1; }"
if [[ -n $RESUME ]]; then
  run "test -d web/.svelte-kit/output/client || { echo 'no web build in this tree: a resume needs the build that was deployed' >&2; exit 1; }"
  echo "  resuming: rollback lines are appended to $ROLLBACK"
else
  [[ -n $DRY ]] || { mkdir -p "$(dirname "$ROLLBACK")" && : > "$ROLLBACK"; }
  [[ -z $DRY ]] || echo "+ : > $ROLLBACK"
fi

if [[ -z $RESUME ]]; then
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
rerun_hint=1
run "cd web && pnpm install --frozen-lockfile >/dev/null"
run "cd watcher && pnpm install --frozen-lockfile >/dev/null"
remember web zarf-near-claim --env testnet
remember watcher zarf-near-watcher-testnet --env testnet # watcher-refresh.sh redeploys it with the new fingerprint
run "scripts/deploy-web.sh testnet"
else
begin "3 (resume) watcher refresh from the deployed web build; verifier, relayer and web are not deployed again"
rerun_hint=1
run "cd watcher && pnpm install --frozen-lockfile >/dev/null"
# The first run recorded the watcher before its deploy-web.sh; record it only if that line is missing.
if ! grep -q '# zarf-near-watcher-testnet$' "$ROLLBACK" 2>/dev/null; then remember watcher zarf-near-watcher-testnet --env testnet; fi
# watcher-refresh.sh fails unless every live script is byte-identical to this tree's build: a wrong tree stops here.
run "scripts/watcher-refresh.sh testnet"
fi

begin "4 faucet ($FAUCET_REF)"
faucet_dir=${TMPDIR:-/tmp}/zarf-near-faucet-release
run "rm -rf $faucet_dir && git worktree prune && git worktree add -q --detach $faucet_dir $FAUCET_REF"
run "cd $faucet_dir/faucet && pnpm install --frozen-lockfile >/dev/null"
remember "$faucet_dir/faucet" zarf-near-faucet-testnet
run "cd $faucet_dir/faucet && $(wr) deploy"
run "git worktree remove --force $faucet_dir"

# near.zarf.to: the proxy owns the faucet's PROXY_KEY. This script never creates, deletes or rewrites
# PROXY_KEY: `wrangler deploy` keeps a Worker's existing secrets.

begin "5 smoke: near.zarf.to (proxy → web, faucet) and the faucet on workers.dev"
for u in https://near.zarf.to/ https://near.zarf.to/create https://near.zarf.to/campaigns https://near.zarf.to/try https://near.zarf.to/try.js \
  https://zarf-near-faucet-testnet.sparkling-queen-5e77.workers.dev/try; do
  run "code=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 $u); echo \"  \$code $u\"; [[ \$code == 2* || \$code == 3* ]]"
done

begin "6 push the release commit to main (fast-forward only)"
run "git fetch -q origin && git merge-base --is-ancestor origin/main HEAD && git push origin HEAD:main"

step=''
echo; echo "DONE: testnet runs $(git rev-parse --short HEAD) (main) and $FAUCET_REF. Rollback lines: $ROLLBACK"
[[ -n $DRY || ! -s $ROLLBACK ]] || cat "$ROLLBACK"
