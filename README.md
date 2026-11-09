# Zarf on NEAR

**Pay any email, on any chain.** A sender funds a campaign with USDC for a list of email
addresses. Each recipient opens their claim link, signs in with Google, and receives the tokens
at a NEAR account they choose, without holding NEAR or a wallet beforehand. The chain stores
only salted commitments and amounts, never an email. Built for the NEAR Hackathon
(build window ends 2026-11-14 23:59 UTC).

> Status: work in progress. Sections marked **TODO** are filled in before submission.

## Trust model

Read this before using it with real money.

- **The verifier sees the email.** At claim time it checks the Google ID token and the
  recipient's salt, and signs the claim. This is not zero-knowledge.
- **The chain never sees an email.** Per recipient it stores
  `commitment = HMAC-SHA256(salt, canonical email)` and the amount (`spec/claim.md`). Amounts are
  public per commitment.
- **Mode W (this deployment): owner-registered key.** The verifier runs as a Cloudflare Worker,
  and the contract owner registers its signing key. The verifier operator is trusted. A leaked
  key can claim every allocation of the campaigns that accept it, up to each campaign's tree.
  **TODO (T11):** Mode T (a Shade Agent in a TEE, key registered through on-chain attestation) is
  described as "attested" only if it ships.
- **Each campaign snapshots its accepted keys at creation.** Removing a snapshotted key
  (`remove_agent`) freezes that campaign's claims until `reclaim`. Revocation costs liveness,
  never funds.
- **The owner's emergency exit can affect one claim.** `resolve_pending` settles a claim stuck in
  `pending` after an hour. A wrong answer can double-pay or block that **one** claim; it cannot
  touch any other allocation.
- **The salt travels only in the claim link**, in the URL fragment (`#s=`), which never reaches a
  server. A leaked link lets its holder test one guessed email against one commitment; it does
  not let anyone claim without that Google account.
- **The relayer pays gas and nothing else.** It signs with a NEAR function-call key limited to the
  contract's `claim` method and attaches no deposit. It refuses claims that our verifier did not
  sign. The destination is inside the verifier's signature, so the relayer cannot redirect funds.
- **Unclaimed funds go back to the sender** with `reclaim` after the campaign deadline.

Known limit: an account created in the browser ("Create one for me") receives the USDC but needs a
little NEAR for gas before it can move it. **TODO:** the owner decides whether claims include a
small NEAR drip.

## How it works

```
 sender                         recipient
   │ CSV of emails + amounts       │ opens /claim/<campaign>/<commitment>#s=<salt>
   ▼                               ▼
 web /create ──ft_transfer_call──▶ contract ◀──claim(signed args)── relayer
   │  salts, commitments,           (escrow)                          ▲
   │  merkle root, claim links         ▲                              │ signed claim args
   │                                   │ views                        │
   └──────── leaf list file ──────▶ web /claim ──id_token + salt──▶ verifier
                                    choose destination → Google sign-in
                                    (nonce = sha256(destination))
```

| Part | Path | What it does |
| --- | --- | --- |
| Spec | `spec/` | Byte-exact claim format (`claim.md`) and the shared test vectors (`vectors.json`) every layer must reproduce |
| Contract | `contract/` | **TODO (T2/T3):** NEP-141 escrow: campaigns, merkle-checked signed claims, pending/in-flight accounting, reclaim |
| Verifier | `verifier/` | Cloudflare Worker: Google ID token (RS256, JWKS, aud/iss/exp/email_verified, nonce = destination), HMAC commitment, merkle proof, chain checks, ed25519 signature |
| Relayer | `relayer/` | Cloudflare Worker: submits verifier-signed `claim` calls with a claim-only function-call key; payout status from the contract's events |
| Create app | `web/src/routes/create` | CSV → salts, commitments, tree; storage pre-pay + one `ft_transfer_call`; claim links and the public leaf list |
| Claim app | `web/src/routes/claim` | Destination (existing account or an in-browser implicit account), Google sign-in, verifier → relayer, receipt from on-chain state |

## Run the tests

No secrets and no Google login are needed. Node 24 and pnpm:

```sh
(cd verifier && pnpm install && pnpm test && pnpm typecheck)
(cd relayer  && pnpm install && pnpm test && pnpm typecheck)
(cd web      && pnpm install && pnpm test && pnpm check && pnpm build)
```

**TODO (T8):** `make test` runs all of the above plus the contract's tests; `make demo` runs the
full flow in a local sandbox with a test-only OIDC issuer.

## Claim → evidence

| Claim | Evidence |
| --- | --- |
| Every layer agrees on the bytes of commitments, leaves, nonces and signed payloads | `spec/vectors.json`; `verifier/test/claim.test.ts`, `verifier/test/claimFlow.test.ts`, `web/src/lib/create/create.test.ts`, `web/src/lib/merkle.test.ts`; **TODO** contract tests |
| The verifier also produces the same signatures inside Cloudflare's runtime | `verifier/test/workerd.test.ts` |
| A Google sign-in only pays the destination chosen before it | `verifier/test/googleIdToken.test.ts` (`BAD_NONCE`), `web/src/lib/claim.test.ts` (nonce vectors) |
| Another person's Google account or claim link cannot claim | `verifier/test/claimFlow.test.ts` (`COMMITMENT_MISMATCH`) |
| The verifier signs nothing the contract would refuse (deadline, claimed, pending, snapshot, balance, its own registry entry) | `verifier/test/claimFlow.test.ts` |
| No email or salt goes on chain or into the public leaf list | `web/src/lib/create/create.test.ts` (leaf list test); `spec/claim.md` |
| The relayer can only call `claim`, never with a deposit, and refuses claims our verifier did not sign | `relayer/test/relay.test.ts`, `relayer/test/near.test.ts` (transaction bytes checked against `@near-js/transactions`) |
| A reverted transfer is never shown as paid | `relayer/test/relay.test.ts` (`claim_reverted`), `web/src/lib/services.test.ts` (`settleClaim`) |
| The create app never funds a campaign twice when an outcome is lost | `web/src/lib/create/create.test.ts` (`fundCampaign`) |
| Funds never stay stuck in `pending`; reclaim excludes in-flight funds | **TODO (T3)** contract tests |
| A real claim on testnet | **TODO:** tx hash |
| A cross-chain claim through NEAR Intents lands on Base | **TODO (T9):** tx hashes |

## Prior work, baseline and libraries

**Prior work.** This builds on Zarf on Stellar by the same team (Trion Labs), live at
[zarf.to](https://zarf.to). The ideas carried over are a token sent to an email and claimed with
Google, a nonce bound to the destination, a claim expiry, the canonical-email rule, and the
error-code numbering. **No code is reused.** Zarf on Stellar proves Google sign-in with a Noir
circuit verified by Soroban contracts. Neither runs on NEAR, so this repository replaces the proof
with the verifier service described above.

**Hackathon diff (Q-003).** Everything in this repository was built in the build window, starting
from the first commit on 2026-11-07.
[hackathon-submission](https://github.com/yamancan/zarf-on-near/tree/hackathon-submission) is the submission tag.

**Libraries (Q-005).**

| Where | Library | Use |
| --- | --- | --- |
| verifier | none at runtime (Web Crypto) | RS256, HMAC, SHA-256, ed25519 |
| relayer | none at runtime (Web Crypto) | NEAR transaction encoding and signing are written here |
| relayer (tests only) | `@near-js/transactions` 2.5.1, `@near-js/crypto` 2.5.1 | reference implementation the transaction bytes are checked against |
| web | `@sveltejs/kit`, `svelte`, `vite`, `@sveltejs/adapter-cloudflare` | apps |
| web (create only) | `@near-wallet-selector/core` + `@near-wallet-selector/my-near-wallet` 10.1.4, `@near-js/transactions` 2.5.1, `buffer` 6.0.3 | sender wallet (MyNearWallet popup) |
| all | `typescript`, `vitest`, `wrangler`, `svelte-check` | build and tests |
| contract | **TODO (T2)** | `near-sdk`, `cargo-near`, `near-workspaces` versions |

AI assistance: this code was written with Claude Code agents (implementation and review), with
humans deciding design and scope.

**Other entry (Q-015).** **TODO:** link `ad402-near`, which names this project in its README too.

## Tracks

Real-World Money (primary), Privacy & Private AI, Open Innovation.

## License

MIT, see `LICENSE`.
