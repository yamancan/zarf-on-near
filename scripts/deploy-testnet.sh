#!/usr/bin/env bash
# Deploys the Zarf escrow to NEAR testnet and makes it ready for campaigns.
#
#   1. deploy + `new` in ONE batched transaction (spec: nobody can initialise it first)
#   2. owner: refresh_token_storage for testnet USDC (read on chain, not hard-coded)
#   3. owner: add_owner_key for the Mode W verifier signer
#   4. print the views the apps read
#
# Required env:
#   CONTRACT_ID      account to deploy to (its full-access key in ~/.near-credentials)
#   OWNER_ID         contract owner (key in ~/.near-credentials)
#   SIGNER_PUBKEY    verifier ed25519 public key, 64 lowercase hex chars
# Optional env:
#   USDC_ID              default: Circle's testnet USDC (verified on chain in docs/spikes/S1.md)
#   SIGNER_VALID_DAYS    default 60; must outlive every campaign deadline (spec snapshot rule)
#   CREATE_ACCOUNTS=1    create CONTRACT_ID / OWNER_ID with the testnet faucet if missing
#   DRY_RUN=1            print every command instead of running it
#
# Testnet only. Mainnet (T9) gets its own script with a 30-day min lifetime.
set -euo pipefail

NETWORK=testnet
RPC=https://rpc.testnet.near.org
USDC_ID=${USDC_ID:-3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af}
MIN_LIFETIME_NS=600000000000      # 10 min on testnet (spec)
AGENT_TTL_NS=604800000000000      # 7 days, the Shade CLI re-registration period (spec)
SIGNER_VALID_DAYS=${SIGNER_VALID_DAYS:-60}

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
wasm="$repo_root/contract/target/near/release/zarf_near.wasm"

: "${CONTRACT_ID:?set CONTRACT_ID}" "${OWNER_ID:?set OWNER_ID}" "${SIGNER_PUBKEY:?set SIGNER_PUBKEY}"
[[ $SIGNER_PUBKEY =~ ^[0-9a-f]{64}$ ]] || { echo "SIGNER_PUBKEY must be 64 lowercase hex" >&2; exit 64; }
# The vector keys' seeds are public (spec/vectors.json): anyone could sign claims with them.
for test_key in $(jq -r '.keys.signer, .keys.rogue_signer' "$repo_root/spec/vectors.json"); do
  [[ $SIGNER_PUBKEY != "$test_key" ]] ||
    { echo "SIGNER_PUBKEY is a public test key from spec/vectors.json; use the verifier's real key" >&2; exit 64; }
done
[[ $CONTRACT_ID == *.testnet && $OWNER_ID == *.testnet ]] || { echo "testnet accounts only" >&2; exit 64; }

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

if [[ ${DRY_RUN:-} != 1 ]]; then
  for tool in near cargo curl jq; do
    command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 69; }
  done
fi

echo "== USDC on chain: $USDC_ID"
meta=$(view "$USDC_ID" ft_metadata)
jq -e '.symbol == "USDC" and .decimals == 6' <<<"$meta" >/dev/null ||
  { echo "unexpected token metadata: $meta" >&2; exit 65; }

if [[ ${CREATE_ACCOUNTS:-} == 1 ]]; then
  for account in "$CONTRACT_ID" "$OWNER_ID"; do
    if [[ ${DRY_RUN:-} == 1 ]] || ! near account view-account-summary "$account" \
        network-config "$NETWORK" now >/dev/null 2>&1; then
      run near account create-account sponsor-by-faucet-service "$account" \
        autogenerate-new-keypair save-to-legacy-keychain network-config "$NETWORK" create
    fi
  done
fi

echo "== build"
run make -C "$repo_root/contract" wasm
[[ ${DRY_RUN:-} == 1 || -s $wasm ]] || { echo "missing $wasm" >&2; exit 66; }

echo "== deploy + new (one transaction)"
init_args=$(jq -nc --arg o "$OWNER_ID" --arg u "$USDC_ID" --arg m "$MIN_LIFETIME_NS" --arg t "$AGENT_TTL_NS" \
  '{owner_id:$o, network:"testnet", token_ids:[$u], min_lifetime_ns:$m, agent_ttl_ns:$t}')
run near contract deploy "$CONTRACT_ID" use-file "$wasm" \
  with-init-call new json-args "$init_args" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
  network-config "$NETWORK" sign-with-legacy-keychain send

echo "== refresh_token_storage (owner)"
call refresh_token_storage "$(jq -nc --arg u "$USDC_ID" '{token_id:$u}')" '50 Tgas'

echo "== add_owner_key (owner)"
valid_until=$(( ($(date +%s) + SIGNER_VALID_DAYS * 86400) * 1000000000 ))
call add_owner_key "$(jq -nc --arg s "$SIGNER_PUBKEY" --arg v "$valid_until" '{signer:$s, valid_until_ns:$v}')"

[[ ${DRY_RUN:-} == 1 ]] && exit 0
echo "== views"
echo "network:            $(view "$CONTRACT_ID" get_network)"
echo "storage_costs:      $(view "$CONTRACT_ID" storage_costs "$(jq -nc --arg u "$USDC_ID" '{token_id:$u}')")"
echo "agent:              $(view "$CONTRACT_ID" get_agent "$(jq -nc --arg s "$SIGNER_PUBKEY" '{account_id:$s}')")"
echo "required_claim_gas: $(view "$CONTRACT_ID" required_claim_gas)"
echo "deployed: https://testnet.nearblocks.io/address/$CONTRACT_ID"
