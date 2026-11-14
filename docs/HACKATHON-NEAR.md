# Zarf on NEAR: what we shipped for the NEAR Hackathon

The plan of 2026-11-07, beside what shipped. Where the plan and
this file differ, this file is right; the README's evidence table says what has run.

## The one sentence

**Pay any email on NEAR.** A sender funds a campaign with USDC on NEAR and names recipients by
email. Each recipient signs in with Google and receives the USDC at a NEAR account they choose,
with no gas of their own. The email never appears on chain.

## Plan vs shipped

| Planned | Shipped |
| --- | --- |
| NEAR escrow contract for NEP-141 USDC: campaigns, one claim per recipient, reclaim after the deadline | Shipped, live on testnet (`zarf-near-1112.testnet`): keyless, upgradable only through a public delay, 0.1.2 |
| Claim verifier as a Shade Agent in a TEE | **Not shipped.** The verifier is a Cloudflare Worker whose signing key the contract owner registers (Mode W). You trust its operator, Trion Labs. A TEE-attested verifier is roadmap only |
| Relayer that pays the recipient's gas | Shipped: a function-call key limited to `claim`, no deposit |
| Create and claim web apps | Shipped, live on testnet |
| Judges' page (`/try`): a claim link to your own Google email | Shipped, live on testnet |
| NEAR Intents (1Click) payout to USDC on ten chains (Base, Arbitrum, Ethereum, Optimism, Polygon, Avalanche, Monad, Solana, Sui, Aptos) | Built in the verifier and the claim page; **not run through the bridge** (Intents has no testnet) |
| Payout to any NEAR account | Shipped for named and implicit accounts; NEP-518 `0x` accounts proven on testnet (receive and spend) and accepted by the claim form behind `PUBLIC_ETH_ACCOUNTS` |
| Sender funds from USDC on another chain (added 2026-11-13) | Built: 1Click quote, deposit address with QR, status, signature check; **mainnet only and not run with real money**; testnet shows a live dry quote |
| Recipient with no wallet (added 2026-11-13) | Built, testnet only: a NEAR account created with Face ID/Touch ID (passkey PRF-derived key, never stored; key-file fallback). Unaudited in-browser wallet |
| Chain Signatures (stretch) | Not built |

## Tracks

**Real-World Money** (primary) and **Open Innovation**. **Privacy & Private AI is not selected**:
the chain never sees an email, but our verifier does see it at claim time, so we do not claim a
privacy result.

## Words we use and do not use

We do not call this zero-knowledge, trustless or a meta-transaction design. The recipient's gas
is paid by our relayer with an ordinary NEAR transaction; the claim is authorised by our
verifier's signature over a Google sign-in, and the contract enforces that signature, the merkle
proof, the destination and the amount. The README's Trust model lists what you rely on us for.

## Rules we followed (nearhackathon.com and its HACKATHON.md)

- Only work built in the window (2026-11-07 to 2026-11-14 23:59 UTC) is judged. The first commit
  here is from 2026-11-07. Pre-window work by the same team, Zarf on Stellar, is named in the
  README with the exact files whose interface code was copied from it (the baseline table).
- Testnet is accepted; NEAR Intents has no testnet, so its payout is built but not shown live.
- One person may enter two independent projects if each README names the other (Q-015). Our second
  entry is **ad402-near**: https://github.com/yamancan/ad402-near.
  The two share no code.
- License: MIT.

## Risks we name

- The verifier sees each recipient's email at claim time and is a trust point (Mode W).
- The contract can be upgraded by its owner after a public delay (10 min on testnet, at most 1 h on
  mainnet); someone must watch for proposals.
- The owner's `resolve_pending` can settle one stuck claim wrongly; it cannot touch other claims.
- A cross-chain payout depends on NEAR Intents and its public status for the deposit address.
