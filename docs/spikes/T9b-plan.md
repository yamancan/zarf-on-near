# T9b plan: the mainnet Intents claim, end to end

The recipient claims NEAR USDC and receives USDC on Base (or another memo-free EVM chain)
through 1Click. Mainnet only: Intents has no testnet. Facts come from spike S3
(`docs/spikes/S3.md` on `s2-s3-spikes`), re-checked 2026-11-11. The verifier check is
`verifier/src/intents.ts` (T9a, reviewed PASS). This plan contains no code for `web/`;
the change list in §6 is for whoever implements it.

## 1. Flow

```
claim page                                           1Click                      verifier / relayer / contract
──────────                                           ──────                      ────────────────────────────
1. link opened: salt from #s=, campaign view, leaf amount (leaves list, moved before sign-in)
2. destination: "NEAR account" (today) | "USDC on another chain" (new)
3. picker: chain + EVM address  ──GET /v0/tokens──▶  asset id for (chain, USDC)
4. dry quote (preview)          ──POST /v0/quote dry:true──▶ amountOut, minAmountOut, fees
5. user confirms                ──POST /v0/quote dry:false─▶ depositAddress (64-hex implicit), deadlines
6. nonce = sha256(depositAddress); attempt saved with {quote, intents fields}; Google redirect
7. callback → POST /claim {…, destination: depositAddress, intents: {destination_asset, recipient}}
                                                      ◀─GET /v0/status── verifier: checkIntentsStatus, then sign
8. relayer submits claim; contract storage_deposits the deposit address on USDC, then ft_transfer
9. app (optional) POST /v0/deposit/submit {depositAddress, txHash}
10. app polls GET /v0/status every 5 s → SUCCESS: "Paid on Base", destinationChainTxHashes[0]
```

Nothing changes in the contract or the relayer. The deposit address is an ordinary NEAR
`destination`, and the contract already registers an unregistered destination on USDC
(spec `claim`, paid from the campaign's storage reservation).

## 2. Exact 1Click calls

Base URL `https://1click.chaindefuser.com`. No key and no auth header. CORS is `*`
(preflight checked 2026-11-11), so the browser calls it directly with no proxy.
1Click sees the recipient's IP, address and amount; the privacy note in the README says so.

**Assets.** `GET /v0/tokens` returns entries `{assetId, blockchain, symbol, decimals,
contractAddress}`. The app keeps a short allow-list of `(blockchain, symbol)` pairs:
`base/USDC`, `arb/USDC` and `eth/USDC`, all EVM and memo-free. It resolves each `assetId`
at runtime and hides a chain whose entry is missing. The origin is fixed:
`nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (6 decimals).

**Preview (before the user commits):**

```http
POST /v0/quote
{ "dry": true, "swapType": "EXACT_INPUT", "slippageTolerance": 100,
  "originAsset": "nep141:17208628…33a1", "depositType": "ORIGIN_CHAIN",
  "destinationAsset": "<assetId>", "amount": "<leaf amount, base units>",
  "recipient": "<0x… as typed>", "recipientType": "DESTINATION_CHAIN",
  "refundTo": "<get_campaign(id).sender>", "refundType": "ORIGIN_CHAIN",
  "deadline": "<now + 60 min, ISO>" }
→ 201 { "quote": { "amountOut", "amountOutFormatted", "minAmountOut", "withdrawFee",
                   "timeEstimate" }, "quoteRequest": {…}, "signature": "ed25519:…" }
→ 400 { "message": "Amount is too low for bridge, try at least 2429" } | { "message": "refundTo is not valid" } | …
```

**Real quote:** the same body with `"dry": false`. The response adds
`quote.depositAddress` (64 lowercase hex), `quote.deadline` and
`quote.timeWhenInactive`; S3 observed both at request `deadline` + 72 h. The values must be
exactly what intents.ts accepts: slippage ≤ 100, no `appFees` beyond 1Click's own keyless
entry, no `referral`, `confidentiality` public. Never send `appFees`, `referral`,
`customRecipientMsg` or `virtualChain*`.

**Status:** `GET /v0/status?depositAddress=<addr>` returns `status` ∈ `PENDING_DEPOSIT |
KNOWN_DEPOSIT_TX | PROCESSING | SUCCESS | INCOMPLETE_DEPOSIT | REFUNDED | FAILED`, plus
`quoteResponse` (the full original request) and `swapDetails`, which holds
`destinationChainTxHashes: [{hash, explorerUrl}]`, `amountOutFormatted`,
`refundedAmountFormatted` and `refundReason`. An unknown address gives `404`.

**Speed-up (optional):** `POST /v0/deposit/submit {"depositAddress", "txHash"}`, where
`txHash` is the relayer's NEAR claim tx. Ignore any failure here.

## 3. Picker rules

- The address must match `^0x[0-9a-fA-F]{40}$`. If it is mixed-case, check the EIP-55
  checksum and refuse it on a mismatch (a typo guard). Send `recipient` as typed.
- **Exchange deposit addresses:** allowed only because every listed chain is EVM and
  memo-free. The copy reads: "If this is an exchange address, make sure the exchange
  credits USDC on <chain> to it without a memo or tag." No memo/tag field exists anywhere,
  so no memo network can ever be listed. Adding Solana, Stellar, XRP, TON or similar
  needs its own review, since a memo or tag can be required.
- **Refund destination (reviewer M1, decided): back to the campaign sender on NEAR.**
  `refundType: ORIGIN_CHAIN`, `refundTo = get_campaign(campaign_id).sender`. The page reads
  it from the contract view for the quote; the verifier reads it from chain itself and
  never from the request. A failed swap returns the USDC to the payer, who can pay again.
  Nothing depends on a key the recipient may not hold: an exchange deposit address has no
  withdrawable Intents account, so the earlier `INTENTS` refund could strand funds for good.
  Checked 2026-11-11 with keyless dry quotes: an existing named account (`intents.near`) as
  an `ORIGIN_CHAIN` refundTo → 201 with `refundFee 0`; a nonexistent named account → 400.
  A sender always holds USDC, so it is registered on USDC and pays no `refundFee` (S3 saw
  4465 base units only for an unregistered implicit account).
- Show the preview as "≈ {amountOutFormatted} USDC on {chain} (at least
  {minAmountOut/1e6}); network fee {withdrawFee/1e6} USDC; about {timeEstimate} s".

## 4. Verifier wiring (`verifier/`, web-agent's tree; the smallest change)

- The request gains an optional `intents: { destination_asset, recipient }`. There is no
  refund field: the verifier passes `campaignSender = campaign.sender` from its own
  `get_campaign` read.
  When it is present:
  1. require `destination` to be 64-hex (the deposit address);
  2. after `E102` (so the amount is the merkle-proven leaf amount) and before signing,
     `checkIntentsStatus(await fetchIntentsStatus(destination), { depositAddress:
     destination, amount, destinationAsset, recipient, campaignSender, expiresAtNs })`, using
     the same `expiresNs` that gets signed;
  3. `IntentsError` → `409 { error: e.code }`. A fetch failure or the per-request 10 s
     timeout (`fetchIntentsStatus` sets `AbortSignal.timeout`) → `UpstreamError('1click')` →
     `503 UPSTREAM_UNAVAILABLE`.
  - 1Click's keyless rate limits are not documented. Judge traffic could hit them, at which
    point both the page's quote and the verifier's status call fail. Unknown; an API key
    from the partner dashboard is the fallback.
- When `intents` is absent nothing changes, and implicit accounts from "create one for me"
  still work.
- When the contract's `get_network()` is not `mainnet`, `intents` is refused
  (`400 E108_INVALID_INPUT`), because the origin asset is mainnet USDC.
- Tests: one stubbed `fetchFn` path per outcome (pass, mismatch code, 404, 503). The
  existing `intents.test.ts` already pins every field rule.

## 5. UI states and failure paths

| State / event | Where caught | What the user sees | Recovery |
| --- | --- | --- | --- |
| Quote 400 (too low, bad address, route gone) | step 4 | 1Click's `message`, plain words | fix the address or pick NEAR |
| Quote 5xx / timeout (10 s) | step 4/5 | "Cross-chain quotes are unavailable right now" | retry, or claim to NEAR |
| Request `deadline` (60 min) passes before sign-in returns | step 7 (app checks before POST) | "Your quote expired" | re-quote → **new deposit address → new nonce → sign in again** |
| Verifier `INTENTS_QUOTE_EXPIRES_FIRST` | step 7 | same as above | same |
| Verifier `INTENTS_NOT_PENDING` | step 7 | "This quote was already used" | re-quote + sign in. Never reuse an address: one quote per claim |
| Verifier any other `INTENTS_*` | step 7 | "The quote doesn't match what you chose" | re-quote + sign in |
| `UPSTREAM_UNAVAILABLE` (1Click) | step 7 | "Couldn't confirm the quote; nothing was sent" | retry (the token is gone, so sign in again) |
| Deposit address not on USDC | contract | nothing: the contract `storage_deposit`s it first | – |
| `E115` transfer failed (`claim_reverted`) | relay result | "The transfer didn't go through; your claim is open again" | retry with the same quote if `status` is still `PENDING_DEPOSIT` and the deadlines allow; else re-quote |
| Claim stuck `pending` (callback failed) | `claim_state` | "Payment is being settled" | the owner's `resolve_pending` after `resolve_delay_ns` (1 h) |
| 1Click `KNOWN_DEPOSIT_TX` / `PROCESSING` | step 10 | "Paid on NEAR, swapping to {chain}…" with the NEAR tx link | keep polling. After 10 min: "Still processing", keep the page link |
| `SUCCESS` | step 10 | "Paid on {chain}": `amountOutFormatted` USDC, `destinationChainTxHashes[0].explorerUrl` | done; clear the attempt |
| `REFUNDED` | step 10 | "The swap failed and the funds went back to the sender. Ask them to send again." + `refundReason` | the sender re-funds; this commitment is already claimed on chain |
| `INCOMPLETE_DEPOSIT` / `FAILED` | step 10 | "The swap failed": the deposit address and NEAR tx hash, for support | 1Click support. Not expected, because the deposit is exactly `amount` |

The attempt in `sessionStorage` additionally holds `{depositAddress, destinationAsset,
recipient, campaignSender, requestDeadline}`. A reload after sign-in keeps the quote but needs
a fresh Google token, the same as today.

## 6. Smallest web/ change list (for the implementer)

1. `lib/intents.ts` (new): `INTENTS_ASSETS` allow-list, `resolveAssets()` (GET /v0/tokens),
   `quote(dry, args)`, `status(addr)`, `submitDeposit(addr, txHash)`, an EIP-55 check. Each
   function takes `fetchFn` for tests; recorded fixtures go in `lib/fixtures/`.
2. `lib/claim.ts`: extend `Attempt` with an optional `intents` block. `destinationNonce`
   stays as is (the deposit address is an AccountId).
3. Claim page: a third destination mode, "USDC on another chain", shown only when the
   contract's `get_network()` (already read on the page) returns `mainnet`. Add the picker, preview and confirm steps (§3); the leaf
   amount loaded before sign-in (move `fetchLeaves` + `checkedProof` up from the receipt
   page); and `destination` = `depositAddress` for the nonce.
4. Receipt page: pass `intents` in `requestSignature`; after the relayer, fire and forget
   `submitDeposit`, then poll `status` and show the states in §5.
5. `services.ts` `describeError`: map each `INTENTS_*` code to the copy in §5.
6. Env: none new (the 1Click URL is a constant). The mode stays off unless the network is
   mainnet.

Tests: lib unit tests on the recorded fixtures; one Playwright path with a stubbed 1Click
that walks picker → quote → (mock sign-in) → receipt `SUCCESS`, and one for `REFUNDED`.

## 7. Mainnet run (T9 acceptance; needs the owner)

One mainnet escrow deployment, one campaign of 2-3 USDC funded by the owner, one claim
to the owner's Base address. Record:
- the 1Click deposit address;
- the NEAR claim tx;
- the Base tx (`explorerUrl`);
- the fee actually charged.

No mainnet funds or accounts until the owner provides them. `scripts/intents-mainnet-smoke.sh`
exercises the riskiest step (a real deposit to a 1Click address reaching Base) before the
escrow is involved.

## 8. Residual trust (README wording later)

- **The claim page decides which address gets paid.** Its integrity (static hosting,
  strict CSP, no third-party scripts) is the trust root for the destination. A compromised
  page can quote an attacker's address and bind the nonce to that quote, or leave `intents`
  out and name any NEAR account.
- **The verifier's intents check confirms consistency, not intent.** It proves the quote
  1Click holds matches what the page sent: amount, asset, recipient, refund to the sender,
  deadlines. It cannot know what the recipient meant to type.
- The 1Click quote signature is not verified; the check trusts TLS to
  `1click.chaindefuser.com`.

## Not verified

- A real `REFUNDED` swap returning to a named sender account (needs mainnet funds; the
  dry quote accepts the shape).
- 1Click's keyless rate limits.
- That `arb/USDC` and `eth/USDC` exist in `/v0/tokens` (they are resolved at runtime and
  hidden if missing); only `base/USDC` was seen in S3.
- 1Click behaviour when the deposit lands after the request `deadline` but before
  `quote.deadline`. Avoided by design: the app refuses to start a claim past the request
  deadline, and the verifier requires both deadlines after `expires_at_ns`.
