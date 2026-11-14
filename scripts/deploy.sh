#!/usr/bin/env bash
# Deploys the Zarf escrow to NEAR testnet (default) or mainnet and makes it ready for campaigns.
#
#   1. deploy + `new` in ONE batched transaction (spec: nobody can initialise it first)
#   2. owner: refresh_token_storage for USDC (read on chain, not hard-coded)
#   3. the Mode W verifier signer is an initial signer of `new` (active at once; a later
#      add_owner_key would wait the upgrade delay)
#   4. print the views the apps read
#
# Mainnet (and OWNER_ON_MAC=1 on testnet) signs nothing on this host: no owner, escrow or relayer
# full-access key is ever read here. It builds the wasm and writes an owner kit (the wasm plus
# owner-steps.sh) that the owner runs on their own machine, off the deploy host, with near-cli-rs
# (keys in the local key store or on a hardware wallet); then VERIFY_ONLY=1 checks the result from here with read-only RPC views.
#
# Required env:
#   CONTRACT_ID      account to deploy to (testnet: its full-access key in ~/.near-credentials)
#   OWNER_ID         contract owner (testnet: key in ~/.near-credentials; mainnet: on the owner's machine only)
# Optional env:
#   NETWORK          testnet (default) or mainnet. Mainnet requires LOCK_CONTRACT=1, Circle's
#                    mainnet USDC exactly, .near accounts, no faucet, GUARDIAN_ID, SIGNER_PUBKEY,
#                    BACKUP_SIGNER_PUBKEY and RELAYER_ID, and always runs as OWNER_ON_MAC=1.
#   OWNER_ON_MAC=1   write the owner kit instead of signing here (forced on mainnet)
#   KIT_DIR          default <repo>/owner-kit-$NETWORK
#   OWNER_SIGN       how the kit signs as OWNER_ID: sign-with-keychain (default) or 'sign-with-ledger usb'
#   ESCROW_NEAR, RELAYER_NEAR   what the kit funds the two new accounts with, with the unit as near-cli
#                    takes it (default '3.5 NEAR' and '1 NEAR')
#   VERIFY_ONLY=1    read-only: check the deployed escrow and relayer against this env, sign nothing
#   EXPECT_CODE_HASH base58 code hash the build (and VERIFY_ONLY) must match
#   GUARDIAN_ID      account that can only delay (cancel, freeze, drop a not-yet-active key)
#   BACKUP_SIGNER_PUBKEY  a second verifier key (64 lowercase hex) whose seed is kept offline: an
#                    initial signer too, so if SIGNER_PUBKEY leaks the owner removes it and live
#                    campaigns go on with the backup key (they snapshot both at creation)
#   SIGNER_PUBKEY    verifier ed25519 public key (64 lowercase hex). Default: derived from
#                    VERIFIER_SEED_FILE, which is created (32 random bytes, mode 600) if missing
#   VERIFIER_SEED_FILE   default ~/.config/zarf-near/$NETWORK-verifier.seed
#   RELAYER_ID       relayer account; gets a claim-only function-call key whose secret goes to
#                    RELAYER_KEY_FILE (default ~/.config/zarf-near/$NETWORK-relayer.key, mode 600)
#   USDC_ID              default: Circle's USDC for NETWORK (testnet one verified in docs/deploy/testnet.md)
#   SIGNER_VALID_DAYS    default 60; must outlive every campaign deadline (spec snapshot rule)
#   RPC                  JSON-RPC for the script's views. Default: FastNEAR (test.rpc.fastnear.com /
#                        free.rpc.fastnear.com); rpc.*.near.org is deprecated. `near` uses its own config.
#   CREATE_ACCOUNTS=1    create CONTRACT_ID / OWNER_ID with the testnet faucet if missing
#   DRY_RUN=1            print every command instead of running it. It still creates the real
#                        verifier seed and relayer key files if missing, and the real run reuses them.
#   UPGRADE_DELAY_NS     default 10 min on testnet, 1 h on mainnet (the contract allows 10 min .. 1 h there)
#   LOCK_CONTRACT=1      finally delete every full-access key on CONTRACT_ID. After that the code
#                        changes only through propose_upgrade/apply_upgrade (the timelock).
#                        Mandatory on mainnet, opt-in on testnet.
#   SKIP_DEPLOY=1        resume after deploy + new: skip build and deploy, run only the lock (again;
#                        a no-op if no full-access key is left), the USDC registration, refresh and
#                        the relayer key. Every step is safe to repeat. A failure after deploy prints
#                        the exact rerun command.
set -euo pipefail

NETWORK=${NETWORK:-testnet}
MAINNET_USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
case $NETWORK in
  testnet)
    RPC=${RPC:-https://test.rpc.fastnear.com} SUFFIX=.testnet EXPLORER=https://testnet.nearblocks.io
    USDC_ID=${USDC_ID:-3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af}
    MIN_LIFETIME_NS=600000000000 ;;          # 10 min (spec)
  mainnet)
    RPC=${RPC:-https://free.rpc.fastnear.com} SUFFIX=.near EXPLORER=https://nearblocks.io
    USDC_ID=${USDC_ID:-$MAINNET_USDC}
    MIN_LIFETIME_NS=2592000000000000 ;;      # 30 days (spec)
  *) echo "NETWORK must be testnet or mainnet" >&2; exit 64 ;;
esac
AGENT_TTL_NS=604800000000000      # 7 days: how long an attested agent's registration lasts (spec, Mode T roadmap)
RESOLVE_DELAY_NS=3600000000000    # 1 h before resolve_pending may act (spec)
# Public delay before a proposed upgrade or owner change takes effect.
# testnet default 10 min; mainnet default 1 h (the contract allows 10 min .. 1 h there)
if [[ $NETWORK == mainnet ]]; then UPGRADE_DELAY_NS=${UPGRADE_DELAY_NS:-3600000000000}; fi
UPGRADE_DELAY_NS=${UPGRADE_DELAY_NS:-600000000000}
VERIFIER_SEED_FILE=${VERIFIER_SEED_FILE:-$HOME/.config/zarf-near/$NETWORK-verifier.seed}
RELAYER_KEY_FILE=${RELAYER_KEY_FILE:-$HOME/.config/zarf-near/$NETWORK-relayer.key}
SIGNER_VALID_DAYS=${SIGNER_VALID_DAYS:-60}

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
wasm="$repo_root/contract/target/near/release/zarf_near.wasm"

: "${CONTRACT_ID:?set CONTRACT_ID}" "${OWNER_ID:?set OWNER_ID}"
# Checked before any transaction. A full-access key can sign as the escrow and call the token
# directly, so on mainnet it must be deleted.
if [[ $NETWORK == mainnet ]]; then
  [[ ${LOCK_CONTRACT:-} == 1 ]] || { echo "LOCK_CONTRACT=1 is mandatory on mainnet" >&2; exit 64; }
  [[ $USDC_ID == "$MAINNET_USDC" ]] || { echo "mainnet USDC_ID must be Circle's $MAINNET_USDC" >&2; exit 64; }
  [[ ${CREATE_ACCOUNTS:-} != 1 ]] || { echo "CREATE_ACCOUNTS uses the testnet faucet only" >&2; exit 64; }
  [[ -n ${GUARDIAN_ID:-} ]] || { echo "GUARDIAN_ID is mandatory on mainnet: without it a stolen owner key cannot be stopped" >&2; exit 64; }
  [[ -n ${SIGNER_PUBKEY:-} ]] || { echo "SIGNER_PUBKEY is mandatory on mainnet (scripts/mainnet-keys.mjs prints it)" >&2; exit 64; }
  [[ -n ${BACKUP_SIGNER_PUBKEY:-} ]] || { echo "BACKUP_SIGNER_PUBKEY is mandatory on mainnet (the offline verifier key)" >&2; exit 64; }
  [[ -n ${RELAYER_ID:-} ]] || { echo "RELAYER_ID is mandatory on mainnet" >&2; exit 64; }
  [[ ${OWNER_ON_MAC:-1} == 1 ]] || { echo "mainnet signs off the deploy host only (OWNER_ON_MAC=1)" >&2; exit 64; }
  OWNER_ON_MAC=1
  [[ ${GUARDIAN_ID:-} != "$OWNER_ID" ]] || { echo "GUARDIAN_ID must not be OWNER_ID: one stolen key would hold both" >&2; exit 64; }
fi
umask 077
# Secrets are written to files only, never printed (per network: ~/.config/zarf-near/$NETWORK-*).
if [[ -z ${SIGNER_PUBKEY:-} ]]; then
  mkdir -p "$(dirname "$VERIFIER_SEED_FILE")"
  [[ -s $VERIFIER_SEED_FILE ]] || node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' >"$VERIFIER_SEED_FILE"
  chmod 600 "$VERIFIER_SEED_FILE"
  SIGNER_PUBKEY=$(node -e '
    const c = require("crypto"), seed = Buffer.from(require("fs").readFileSync(process.argv[1], "utf8").trim(), "hex");
    if (seed.length !== 32) throw new Error("seed must be 32 bytes hex");
    const k = c.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
    process.stdout.write(c.createPublicKey(k).export({ format: "der", type: "spki" }).subarray(-32).toString("hex"));' "$VERIFIER_SEED_FILE")
fi
[[ $SIGNER_PUBKEY =~ ^[0-9a-f]{64}$ ]] || { echo "SIGNER_PUBKEY must be 64 lowercase hex" >&2; exit 64; }
if [[ -n ${BACKUP_SIGNER_PUBKEY:-} ]]; then
  [[ $BACKUP_SIGNER_PUBKEY =~ ^[0-9a-f]{64}$ ]] || { echo "BACKUP_SIGNER_PUBKEY must be 64 lowercase hex" >&2; exit 64; }
  [[ $BACKUP_SIGNER_PUBKEY != "$SIGNER_PUBKEY" ]] || { echo "BACKUP_SIGNER_PUBKEY must differ from SIGNER_PUBKEY" >&2; exit 64; }
fi
# The vector keys' seeds are public (spec/vectors.json): anyone could sign claims with them.
# Hard-coded like the contract's PUBLIC_TEST_KEYS (a contract test pins both to the vectors).
for test_key in 8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c \
                fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618; do
  [[ $SIGNER_PUBKEY != "$test_key" && ${BACKUP_SIGNER_PUBKEY:-} != "$test_key" ]] ||
    { echo "SIGNER_PUBKEY or BACKUP_SIGNER_PUBKEY is a public test key from spec/vectors.json; use real keys" >&2; exit 64; }
done
for account in "$CONTRACT_ID" "$OWNER_ID" ${RELAYER_ID:+"$RELAYER_ID"} ${GUARDIAN_ID:+"$GUARDIAN_ID"}; do
  [[ $account == *"$SUFFIX" ]] || { echo "$account is not a $NETWORK account (*$SUFFIX)" >&2; exit 64; }
done

run() {
  if [[ ${DRY_RUN:-} == 1 ]]; then printf '+'; printf ' %q' "$@"; echo; else "$@"; fi
}

# Read-only RPC view; prints the decoded JSON result.
view() {
  local account=$1 method=$2 args=${3:-'{}'}
  curl -sSf "$RPC" -H 'content-type: application/json' -d "$(jq -nc \
    --arg a "$account" --arg m "$method" --arg b "$(printf '%s' "$args" | base64 -w0)" \
    '{jsonrpc:"2.0",id:1,method:"query",params:{request_type:"call_function",finality:"final",account_id:$a,method_name:$m,args_base64:$b}}')" |
    jq -er '.result.result | implode'
}

call() { # call <method> <json-args> [gas] -- as OWNER_ID
  run near contract call-function as-transaction "$CONTRACT_ID" "$1" json-args "$2" \
    prepaid-gas "${3:-30 Tgas}" attached-deposit '0 NEAR' sign-as "$OWNER_ID" \
    network-config "$NETWORK" sign-with-legacy-keychain send
}

# The new() args. Both verifier keys are initial signers: active at once, snapshotted by every campaign.
make_init_args() {
  local valid_until=$(( ($(date +%s) + SIGNER_VALID_DAYS * 86400) * 1000000000 ))
  jq -nc --arg o "$OWNER_ID" --arg u "$USDC_ID" --arg m "$MIN_LIFETIME_NS" --arg t "$AGENT_TTL_NS" \
    --arg r "$RESOLVE_DELAY_NS" --arg g "$UPGRADE_DELAY_NS" --arg s "$SIGNER_PUBKEY" --arg b "${BACKUP_SIGNER_PUBKEY:-}" \
    --arg v "$valid_until" --arg n "$NETWORK" --arg gd "${GUARDIAN_ID:-}" \
    '{owner_id:$o, guardian_id:(if $gd == "" then null else $gd end), network:$n, token_ids:[$u], min_lifetime_ns:$m, agent_ttl_ns:$t, resolve_delay_ns:$r, upgrade_delay_ns:$g, initial_signers:([{signer:$s, valid_until_ns:$v}] + (if $b == "" then [] else [{signer:$b, valid_until_ns:$v}] end))}'
}

# The relayer's claim-only public key R, from RELAYER_KEY_FILE (created here if missing, except on mainnet).
relayer_pubkey() {
  if [[ $NETWORK == mainnet && ! -s $RELAYER_KEY_FILE ]]; then
    echo "no $RELAYER_KEY_FILE: run scripts/mainnet-keys.mjs first" >&2; return 64
  fi
  mkdir -p "$(dirname "$RELAYER_KEY_FILE")"
  if [[ ! -s $RELAYER_KEY_FILE ]]; then
    # near secret format: ed25519:<base58(seed || pub)>; written to the file only.
    node -e '
      const c = require("crypto"), { privateKey, publicKey } = c.generateKeyPairSync("ed25519");
      const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
      const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
      const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      const b58 = (b) => { let n = BigInt("0x" + b.toString("hex")), o = ""; for (; n > 0n; n /= 58n) o = A[Number(n % 58n)] + o; for (const x of b) { if (x) break; o = "1" + o; } return o; };
      process.stdout.write("ed25519:" + b58(Buffer.concat([seed, pub])));' >"$RELAYER_KEY_FILE"
  fi
  chmod 600 "$RELAYER_KEY_FILE"
  node -e '
    const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const s = require("fs").readFileSync(process.argv[1], "utf8").trim().replace(/^ed25519:/, "");
    let n = 0n; for (const ch of s) n = n * 58n + BigInt(A.indexOf(ch));
    const b = Buffer.from(n.toString(16).padStart(128, "0"), "hex");
    const pub = b.subarray(32), out = []; let m = BigInt("0x" + pub.toString("hex"));
    for (; m > 0n; m /= 58n) out.unshift(A[Number(m % 58n)]);
    for (const x of pub) { if (x) break; out.unshift("1"); } // base58 keeps leading zero bytes as "1"
    process.stdout.write("ed25519:" + out.join(""));' "$RELAYER_KEY_FILE"
}

if [[ ${DRY_RUN:-} != 1 ]]; then
  for tool in near cargo curl jq; do
    command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 69; }
  done
fi

echo "== USDC on chain: $USDC_ID"
meta=$(view "$USDC_ID" ft_metadata)
jq -e '.symbol == "USDC" and .decimals == 6' <<<"$meta" >/dev/null ||
  { echo "unexpected token metadata: $meta" >&2; exit 65; }

b58() { node -e '
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz", b = Buffer.from(process.argv[1], "hex");
  let n = BigInt("0x" + b.toString("hex")), o = ""; for (; n > 0n; n /= 58n) o = A[Number(n % 58n)] + o;
  for (const x of b) { if (x) break; o = "1" + o; } process.stdout.write(o);' "$1"; }

# Read-only check of a deployment made from the owner kit (or by hand). Signs nothing, reads no key.
if [[ ${VERIFY_ONLY:-} == 1 ]]; then
  fails=0
  check() { if eval "$2"; then echo "ok    $1"; else echo "FAIL  $1" >&2; fails=$((fails + 1)); fi; }
  rpcq() { curl -sSf "$RPC" -H 'content-type: application/json' -d "$(jq -nc --argjson p "$1" '{jsonrpc:"2.0",id:1,method:"query",params:$p}')"; }
  account=$(rpcq "$(jq -nc --arg a "$CONTRACT_ID" '{request_type:"view_account",finality:"final",account_id:$a}')")
  escrow_keys=$(rpcq "$(jq -nc --arg a "$CONTRACT_ID" '{request_type:"view_access_key_list",finality:"final",account_id:$a}')" | jq -c '.result.keys')
  config=$(view "$CONTRACT_ID" get_config) watch=$(view "$CONTRACT_ID" watch) owner=$(view "$CONTRACT_ID" get_owner)
  storage=$(view "$USDC_ID" storage_balance_of "$(jq -nc --arg a "$CONTRACT_ID" '{account_id:$a}')")
  signers=$(jq -c '[.owner_keys[].signer] | sort' <<<"$watch")
  want=$(jq -nc --arg s "$SIGNER_PUBKEY" --arg b "${BACKUP_SIGNER_PUBKEY:-}" '[$s, $b] | map(select(. != "")) | sort')
  [[ -n ${EXPECT_CODE_HASH:-} ]] && check "code hash = $EXPECT_CODE_HASH" '[[ $(jq -r .result.code_hash <<<"$account") == "$EXPECT_CODE_HASH" ]]'
  check "escrow has no access key at all" '[[ $escrow_keys == "[]" ]]'
  check "owner = $OWNER_ID" '[[ $owner == "\"$OWNER_ID\"" ]]'
  check "network = $NETWORK" '[[ $(jq -r .network <<<"$config") == "$NETWORK" ]]'
  check "guardian = ${GUARDIAN_ID:-null}" '[[ $(jq -r .guardian_id <<<"$config") == "${GUARDIAN_ID:-null}" ]]'
  check "upgrade delay = $UPGRADE_DELAY_NS ns" '[[ $(jq -r .upgrade_delay_ns <<<"$config") == "$UPGRADE_DELAY_NS" ]]'
  check "token_ids = [$USDC_ID]" '[[ $(jq -c .token_ids <<<"$config") == "[\"$USDC_ID\"]" ]]'
  check "verifier keys = $want" '[[ $signers == "$want" ]]'
  check "no pending upgrade or owner change" '[[ $(jq -c "[.pending_upgrade, .pending_owner]" <<<"$watch") == "[null,null]" ]]'
  check "escrow registered on USDC" '[[ $storage != null ]]'
  if [[ -n ${RELAYER_ID:-} ]]; then
    R=$(relayer_pubkey)
    relayer_keys=$(rpcq "$(jq -nc --arg a "$RELAYER_ID" '{request_type:"view_access_key_list",finality:"final",account_id:$a}')" | jq -c '.result.keys')
    check "relayer $RELAYER_ID keys = one full-access (owner's machine) + R claim-only on $CONTRACT_ID" \
      'jq -e --arg r "$R" --arg c "$CONTRACT_ID" "length == 2 and ([.[] | select(.access_key.permission == \"FullAccess\")] | length) == 1
        and any(.[]; .public_key == \$r and .access_key.permission.FunctionCall.receiver_id == \$c and .access_key.permission.FunctionCall.method_names == [\"claim\"])" <<<"$relayer_keys" >/dev/null'
  fi
  echo "verify: $fails failed"
  exit $(( fails > 0 ))
fi

# The owner kit: everything that needs a full-access key, as commands for the owner's machine.
if [[ ${OWNER_ON_MAC:-} == 1 ]]; then
  kit=${KIT_DIR:-$repo_root/owner-kit-$NETWORK}
  owner_sign=${OWNER_SIGN:-sign-with-keychain}
  [[ $owner_sign == sign-with-keychain || $owner_sign == "sign-with-ledger usb" ]] || { echo "OWNER_SIGN: sign-with-keychain or 'sign-with-ledger usb'" >&2; exit 64; }
  [[ -n ${RELAYER_ID:-} ]] || { echo "OWNER_ON_MAC needs RELAYER_ID" >&2; exit 64; }
  echo "== build"
  run make -C "$repo_root/contract" wasm
  if [[ -s $wasm ]]; then
    wasm_sha=$(sha256sum "$wasm" | cut -d' ' -f1) code_hash=$(b58 "$(sha256sum "$wasm" | cut -d' ' -f1)")
    echo "wasm sha256 $wasm_sha, code hash $code_hash"
    [[ -z ${EXPECT_CODE_HASH:-} || $code_hash == "$EXPECT_CODE_HASH" ]] || { echo "STOP: code hash $code_hash, expected $EXPECT_CODE_HASH" >&2; exit 65; }
  else
    [[ ${DRY_RUN:-} == 1 ]] || { echo "missing $wasm" >&2; exit 66; }
    wasm_sha="<sha256 of the release wasm>"
  fi
  for v in "${ESCROW_NEAR:-3.5 NEAR}" "${RELAYER_NEAR:-1 NEAR}"; do
    [[ $v =~ ^[0-9]+(\.[0-9]+)?\ NEAR$ ]] || { echo "ESCROW_NEAR/RELAYER_NEAR must look like '3.5 NEAR', got '$v'" >&2; exit 64; }
  done
  R=$(relayer_pubkey)
  mkdir -p "$kit"
  [[ -s $wasm ]] && cp "$wasm" "$kit/zarf_near.wasm"
  {
    echo '#!/usr/bin/env bash'
    echo "# Owner kit for $CONTRACT_ID ($NETWORK), written by scripts/deploy.sh on $(date -u +%FT%TZ)."
    echo '# Run on YOUR own machine, not on the deploy host: every step signs with a key that only your machine holds'
    echo '# (local key store or a hardware wallet). Resume after a failure with FROM=<step> bash owner-steps.sh.'
    for v in NETWORK CONTRACT_ID OWNER_ID RELAYER_ID USDC_ID; do printf '%s=%q\n' "$v" "${!v}"; done
    printf '%s=%q\n' R "$R" WASM_SHA256 "$wasm_sha" OWNER_SIGN "$owner_sign" INIT_ARGS "$(make_init_args)" \
      ESCROW_NEAR "${ESCROW_NEAR:-3.5 NEAR}" RELAYER_NEAR "${RELAYER_NEAR:-1 NEAR}"
    cat <<'KIT'
set -euo pipefail
cd "$(dirname "$0")"
FROM=${FROM:-1}
step() { if (( $1 < FROM )); then echo "-- skip $1: $2"; return 1; fi; echo; echo "== $1: $2"; }
command -v near >/dev/null || { echo "install near-cli-rs first (https://github.com/near/near-cli-rs)"; exit 69; }
# Written against near-cli-rs 0.30.1's command grammar; on another version check `near --version` first.
near --version
got=$(shasum -a 256 zarf_near.wasm | cut -d' ' -f1)
[[ $got == "$WASM_SHA256" ]] || { echo "STOP: zarf_near.wasm sha256 is $got, expected $WASM_SHA256"; exit 1; }
echo "new() args: $INIT_ARGS"

if step 1 "create $CONTRACT_ID ($ESCROW_NEAR from $OWNER_ID); its key goes to your local key store and is deleted in step 4"; then
  near account create-account fund-myself "$CONTRACT_ID" "$ESCROW_NEAR" autogenerate-new-keypair save-to-keychain \
    sign-as "$OWNER_ID" network-config "$NETWORK" $OWNER_SIGN send
fi
if step 2 "create $RELAYER_ID ($RELAYER_NEAR from $OWNER_ID); its full-access key stays in your local key store"; then
  near account create-account fund-myself "$RELAYER_ID" "$RELAYER_NEAR" autogenerate-new-keypair save-to-keychain \
    sign-as "$OWNER_ID" network-config "$NETWORK" $OWNER_SIGN send
fi
if step 3 "deploy + new on $CONTRACT_ID (one transaction)"; then
  near contract deploy "$CONTRACT_ID" use-file zarf_near.wasm with-init-call new json-args "$INIT_ARGS" \
    prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config "$NETWORK" sign-with-keychain send
fi
if step 4 "lock: delete the escrow's only key (after this nobody can sign as $CONTRACT_ID)"; then
  keys=$(near account list-keys "$CONTRACT_ID" network-config "$NETWORK" now 2>&1 | grep -oE 'ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}' | sort -u || true)
  [[ $(wc -w <<<"$keys") == 1 ]] || { echo "STOP: expected exactly one key on $CONTRACT_ID, found: $keys"; exit 1; }
  near account delete-keys "$CONTRACT_ID" public-keys "$keys" network-config "$NETWORK" sign-with-keychain send
fi
if step 5 "register $CONTRACT_ID on USDC (0.00125 NEAR from $OWNER_ID)"; then
  near contract call-function as-transaction "$USDC_ID" storage_deposit json-args "{\"account_id\":\"$CONTRACT_ID\",\"registration_only\":true}" \
    prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as "$OWNER_ID" network-config "$NETWORK" $OWNER_SIGN send
fi
if step 6 "refresh_token_storage (owner)"; then
  near contract call-function as-transaction "$CONTRACT_ID" refresh_token_storage json-args "{\"token_id\":\"$USDC_ID\"}" \
    prepaid-gas '50 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER_ID" network-config "$NETWORK" $OWNER_SIGN send
fi
if step 7 "give $RELAYER_ID the claim-only key R = $R"; then
  near account add-key "$RELAYER_ID" grant-function-call-access --allowance unlimited --contract-account-id "$CONTRACT_ID" \
    --function-names claim use-manually-provided-public-key "$R" network-config "$NETWORK" sign-with-keychain send
fi
echo
echo "done. Tell the contract operator; it checks from the deploy host with VERIFY_ONLY=1 (read-only)."
KIT
  } >"$kit/owner-steps.sh"
  chmod 700 "$kit/owner-steps.sh"
  echo "owner kit: $kit (zarf_near.wasm + owner-steps.sh; no secret in it)"
  echo "the owner copies the kit from the deploy host to their machine, then runs:  bash owner-steps.sh"
  echo "then, here:  VERIFY_ONLY=1 with the same env${EXPECT_CODE_HASH:+ (EXPECT_CODE_HASH=$EXPECT_CODE_HASH)}"
  exit 0
fi

if [[ ${CREATE_ACCOUNTS:-} == 1 ]]; then
  for account in "$CONTRACT_ID" "$OWNER_ID" ${RELAYER_ID:+"$RELAYER_ID"}; do
    if [[ ${DRY_RUN:-} == 1 ]] || ! near account view-account-summary "$account" \
        network-config "$NETWORK" now >/dev/null 2>&1; then
      run near account create-account sponsor-by-faucet-service "$account" \
        autogenerate-new-keypair save-to-legacy-keychain network-config "$NETWORK" create
    fi
  done
fi

if [[ ${SKIP_DEPLOY:-} != 1 ]]; then
echo "== build"
run make -C "$repo_root/contract" wasm
[[ ${DRY_RUN:-} == 1 || -s $wasm ]] || { echo "missing $wasm" >&2; exit 66; }

echo "== deploy + new (one transaction)"
init_args=$(make_init_args)
run near contract deploy "$CONTRACT_ID" use-file "$wasm" \
  with-init-call new json-args "$init_args" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  network-config "$NETWORK" sign-with-legacy-keychain send
fi

# From here on the escrow exists: on failure, print how to resume without redeploying.
rerun_cmd() {
  local v out="SKIP_DEPLOY=1"
  for v in DRY_RUN NETWORK LOCK_CONTRACT CONTRACT_ID OWNER_ID RELAYER_ID GUARDIAN_ID USDC_ID SIGNER_PUBKEY RELAYER_KEY_FILE; do
    [[ -n ${!v:-} ]] && out+=" $v=$(printf '%q' "${!v}")"
  done
  echo "$out $(printf '%q' "$0")"
}
on_fail() { echo "FAILED after deploy. Keep any custom RPC configured in your environment; its value is omitted here. Resume with:" >&2; echo "  $(rerun_cmd)" >&2; }
set -E
trap on_fail ERR

# Locked right after deploy + new: nothing below needs the escrow's full-access key
# (storage_deposit and refresh are signed by OWNER_ID, the add-key by RELAYER_ID).
full_access_keys() {
  curl -sSf "$RPC" -H 'content-type: application/json' -d "$(jq -nc --arg a "$CONTRACT_ID" \
    '{jsonrpc:"2.0",id:1,method:"query",params:{request_type:"view_access_key_list",finality:"final",account_id:$a}}')" |
    jq -er '[.result.keys[] | select(.access_key.permission == "FullAccess") | .public_key] | join(",")'
}

if [[ ${LOCK_CONTRACT:-} == 1 ]]; then
  echo "== lock: delete every full-access key on $CONTRACT_ID"
  keys=$( [[ ${DRY_RUN:-} == 1 ]] && echo "<full-access keys>" || full_access_keys )
  [[ -n $keys ]] && run near account delete-keys "$CONTRACT_ID" public-keys "$keys" \
    network-config "$NETWORK" sign-with-legacy-keychain send
  if [[ ${DRY_RUN:-} != 1 ]]; then
    # RPC nodes can lag the delete by a block: 3 reads, 2 s apart, before calling it a failure.
    for attempt in 1 2 3; do
      remaining=$(full_access_keys) || remaining="<RPC error>"
      [[ -z $remaining ]] && break
      [[ $attempt == 3 ]] || sleep 2
    done
    if [[ -n $remaining ]]; then
      echo "LOCK FAILED: full-access keys remain on $CONTRACT_ID: $remaining" >&2
      on_fail
      exit 70
    fi
  fi
fi

echo "== register the escrow on USDC (it must hold tokens; ft_transfer_call fails otherwise)"
run near contract call-function as-transaction "$USDC_ID" storage_deposit \
  json-args "$(jq -nc --arg a "$CONTRACT_ID" '{account_id:$a, registration_only:true}')" \
  prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as "$OWNER_ID" \
  network-config "$NETWORK" sign-with-legacy-keychain send

echo "== refresh_token_storage (owner)"
call refresh_token_storage "$(jq -nc --arg u "$USDC_ID" '{token_id:$u}')" '50 Tgas'

if [[ -n ${RELAYER_ID:-} ]]; then
  echo "== relayer claim-only key ($RELAYER_ID)"
  relayer_pub=$(relayer_pubkey)
  # Resumed run: skip only an exact claim-only key. An empty method_names means every method.
  existing=""
  if [[ ${DRY_RUN:-} != 1 ]]; then
    existing=$(curl -sSf "$RPC" -H 'content-type: application/json' -d "$(jq -nc \
      --arg a "$RELAYER_ID" --arg k "$relayer_pub" \
      '{jsonrpc:"2.0",id:1,method:"query",params:{request_type:"view_access_key",finality:"final",account_id:$a,public_key:$k}}')" |
      jq -c '.result.permission // empty') || existing=""
  fi
  if [[ -z $existing ]]; then
    run near account add-key "$RELAYER_ID" grant-function-call-access --allowance unlimited \
      --contract-account-id "$CONTRACT_ID" --function-names claim \
      use-manually-provided-public-key "$relayer_pub" network-config "$NETWORK" sign-with-legacy-keychain send
  elif jq -e --arg c "$CONTRACT_ID" '.FunctionCall.receiver_id == $c and .FunctionCall.method_names == ["claim"]' \
      <<<"$existing" >/dev/null 2>&1; then
    echo "relayer key already present (resumed run)"
  else
    echo "relayer key $relayer_pub is already on $RELAYER_ID with another permission: $existing" >&2
    echo "delete it (near account delete-keys $RELAYER_ID public-keys $relayer_pub ...) and rerun" >&2
    on_fail
    exit 65
  fi
  echo "relayer public key: $relayer_pub"
fi

trap - ERR
[[ ${DRY_RUN:-} == 1 ]] && exit 0
echo "== views"
echo "get_config:         $(view "$CONTRACT_ID" get_config)"
echo "storage_costs:      $(view "$CONTRACT_ID" storage_costs "$(jq -nc --arg u "$USDC_ID" '{token_id:$u}')")"
echo "agent:              $(view "$CONTRACT_ID" get_agent "$(jq -nc --arg s "$SIGNER_PUBKEY" '{account_id:$s}')")"
echo "required_claim_gas: $(view "$CONTRACT_ID" required_claim_gas)"
echo "deployed: $EXPLORER/address/$CONTRACT_ID"
remaining=$(full_access_keys)
if [[ -n $remaining ]]; then
  echo "WARNING: contract is upgradeable by: $remaining" >&2
else
  echo "contract has no full-access key: its code changes only through the upgrade timelock"
fi
