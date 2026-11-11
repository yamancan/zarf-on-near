#!/usr/bin/env bash
# Mainnet smoke test for the riskiest T9 assumption: a plain NEP-141 deposit of NEAR USDC to a
# 1Click deposit address arrives as USDC on Base. No escrow involved. MOVES REAL FUNDS.
#
#   SIGNER=<owner>.near BASE_RECIPIENT=0x… scripts/intents-mainnet-smoke.sh            # dry run: dry quote + printed commands
#   SIGNER=<owner>.near BASE_RECIPIENT=0x… CONFIRM_MAINNET=yes scripts/intents-mainnet-smoke.sh
#
# Optional: AMOUNT (base units, default 1000000 = 1 USDC), REFUND_TO (default SIGNER),
# SIGN_WITH (near-cli-rs signer, default sign-with-keychain). Needs curl, jq, near-cli-rs.
# The SIGNER's key must already be in near-cli-rs; this script never reads or prints it.
set -euo pipefail

: "${SIGNER:?SIGNER=<mainnet account that holds USDC and pays>}"
: "${BASE_RECIPIENT:?BASE_RECIPIENT=0x… (a Base address of the owner)}"
AMOUNT="${AMOUNT:-1000000}"
REFUND_TO="${REFUND_TO:-$SIGNER}"
SIGN_WITH="${SIGN_WITH:-sign-with-keychain}"
LIVE=$([[ ${CONFIRM_MAINNET:-} == yes ]] && echo 1 || echo 0)

API=https://1click.chaindefuser.com
RPC=https://rpc.mainnet.near.org
USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
ORIGIN="nep141:$USDC"
DEST="nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"

[[ $SIGNER == *.near || $SIGNER =~ ^[0-9a-f]{64}$ ]] || { echo "SIGNER must be a mainnet account" >&2; exit 64; }
[[ $BASE_RECIPIENT =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "BASE_RECIPIENT must be a 0x address" >&2; exit 64; }
[[ $AMOUNT =~ ^[1-9][0-9]*$ ]] || { echo "AMOUNT must be base units" >&2; exit 64; }

run() { # prints instead of running unless CONFIRM_MAINNET=yes
  if [[ $LIVE == 1 ]]; then "$@"; else printf '+'; printf ' %q' "$@"; echo; fi
}

view() { # view <account> <method> <json-args>
  curl -sSf "$RPC" -H 'content-type: application/json' -d "$(jq -nc --arg a "$1" --arg m "$2" --arg b "$(printf '%s' "$3" | base64 -w0)" \
    '{jsonrpc:"2.0",id:1,method:"query",params:{request_type:"call_function",finality:"final",account_id:$a,method_name:$m,args_base64:$b}}')" |
    jq -er '.result.result | implode'
}

# 1. Quote. dry:true in a dry run (no deposit address is created), dry:false when live.
body="$(jq -n --argjson dry "$([[ $LIVE == 1 ]] && echo false || echo true)" --arg a "$AMOUNT" --arg r "$BASE_RECIPIENT" \
  --arg f "$REFUND_TO" --arg o "$ORIGIN" --arg d "$DEST" --arg dl "$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)" '{
  dry: $dry, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: $o, depositType: "ORIGIN_CHAIN",
  destinationAsset: $d, amount: $a, recipient: $r, recipientType: "DESTINATION_CHAIN",
  refundTo: $f, refundType: "ORIGIN_CHAIN", deadline: $dl }')"
quote="$(curl -sS -m 40 -X POST "$API/v0/quote" -H 'content-type: application/json' -d "$body")"
jq -e '.quote' >/dev/null <<<"$quote" || { echo "quote failed: $quote" >&2; exit 1; }
jq '{amountIn: .quote.amountIn, amountOut: .quote.amountOut, minAmountOut: .quote.minAmountOut, withdrawFee: .quote.withdrawFee,
     refundFee: .quote.refundFee, depositAddress: .quote.depositAddress, deadline: .quote.deadline, appFees: .quoteRequest.appFees}' <<<"$quote"

# The echoed request must be exactly what we asked for before anything is paid to its address.
jq -e --arg a "$AMOUNT" --arg r "$BASE_RECIPIENT" --arg f "$REFUND_TO" '.quoteRequest | .amount == $a and .recipient == $r
  and .refundTo == $f and .refundType == "ORIGIN_CHAIN" and .swapType == "EXACT_INPUT" and .slippageTolerance <= 100' \
  <<<"$quote" >/dev/null || { echo "quote does not echo our request; stopping" >&2; exit 1; }

DA="$(jq -r '.quote.depositAddress // "<deposit-address-from-real-quote>"' <<<"$quote")"
[[ $LIVE == 0 || $DA =~ ^[0-9a-f]{64}$ ]] || { echo "unexpected deposit address: $DA" >&2; exit 1; }

# 2. Register the deposit address on USDC (it does not exist yet; S3), then 3. pay it.
if [[ $LIVE == 1 && $(view "$USDC" storage_balance_of "{\"account_id\":\"$DA\"}") != null ]]; then
  echo "deposit address already registered on USDC"
else
  run near contract call-function as-transaction "$USDC" storage_deposit \
    json-args "{\"account_id\":\"$DA\",\"registration_only\":true}" prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' \
    sign-as "$SIGNER" network-config mainnet "$SIGN_WITH" send
fi
run near contract call-function as-transaction "$USDC" ft_transfer \
  json-args "{\"receiver_id\":\"$DA\",\"amount\":\"$AMOUNT\"}" prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as "$SIGNER" network-config mainnet "$SIGN_WITH" send

if [[ $LIVE == 0 ]]; then echo "dry run: nothing sent. Re-run with CONFIRM_MAINNET=yes to pay $AMOUNT base units."; exit 0; fi

# 4. Poll until 1Click settles (20 min max), then print the Base transaction.
for _ in $(seq 240); do
  st="$(curl -sS -m 20 "$API/v0/status?depositAddress=$DA" || true)"
  s="$(jq -r '.status // "?"' <<<"$st" 2>/dev/null || echo '?')"
  echo "$(date -u +%H:%M:%S) $s"
  case $s in
    SUCCESS)
      jq '{amountOut: .swapDetails.amountOutFormatted, base: .swapDetails.destinationChainTxHashes, near: .swapDetails.nearTxHashes}' <<<"$st"
      exit 0 ;;
    REFUNDED | FAILED | INCOMPLETE_DEPOSIT)
      jq '{status, refunded: .swapDetails.refundedAmountFormatted, reason: .swapDetails.refundReason, near: .swapDetails.nearTxHashes}' <<<"$st"
      exit 1 ;;
  esac
  sleep 5
done
echo "not settled after 20 min; deposit address $DA (check $API/v0/status?depositAddress=$DA)" >&2
exit 2
