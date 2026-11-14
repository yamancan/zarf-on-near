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
| Claim verifier as a Shade Agent in a TEE | A Cloudflare Worker run by Trion Labs whose signing key the contract owner registers (Mode W) |
| Relayer that pays the recipient's gas | Shipped: a function-call key limited to `claim`, no deposit |
| Create and claim web apps | Shipped, live on testnet |
| Judges' page (`/try`): a claim link to your own Google email | Shipped, live on testnet |
| NEAR Intents (1Click) payout to USDC on ten chains (Base, Arbitrum, Ethereum, Optimism, Polygon, Avalanche, Monad, Solana, Sui, Aptos) | Built in the verifier and the claim page, for mainnet through 1Click (Intents has no testnet) |
| Payout to any NEAR account | Shipped for named and implicit accounts; NEP-518 `0x` accounts proven on testnet (receive and spend) and accepted by the claim form behind `PUBLIC_ETH_ACCOUNTS` |
| Sender funds from USDC on another chain (added 2026-11-13) | Built for mainnet: 1Click quote, deposit address with QR, status, signature check; testnet shows a live quote |
| Recipient with no wallet (added 2026-11-13) | Built, testnet only: a NEAR account created with Face ID/Touch ID (passkey PRF-derived key, never stored; key-file fallback) |

## Tracks

**Real-World Money** (primary) and **Open Innovation**.

## How a claim is authorised

The recipient's gas
is paid by our relayer with an ordinary NEAR transaction; the claim is authorised by our
verifier's signature over a Google sign-in, and the contract enforces that signature, the merkle
proof, the destination and the amount. The README's "How trust works" has the details.

## Rules we followed (nearhackathon.com and its HACKATHON.md)

- Only work built in the window (2026-11-07 to 2026-11-14 23:59 UTC) is judged. The first commit
  here is from 2026-11-07. Pre-window work by the same team, Zarf on Stellar, is named in the
  README with the exact files whose interface code was copied from it (the baseline table).
- Testnet is accepted; NEAR Intents has no testnet, so the cross-chain steps are built for mainnet.
- One person may enter two independent projects if each README names the other (Q-015). Our second
  entry is **ad402-near**: https://github.com/yamancan/ad402-near.
  The two share no code.
- License: PolyForm Noncommercial 1.0.0 (`LICENSE`).

## How trust works

- The verifier (Mode W, run by Trion Labs) checks each Google sign-in and signs the claim; it never stores
  the email.
- The contract changes only through a public, delayed upgrade (10 min on testnet, at most 1 h on mainnet),
  and `watcher/` alerts within 2 min on a proposal.
- A cross-chain payout goes through NEAR Intents 1Click.

The README's "How trust works" has the details.
