# Zarf on NEAR

**Pay any email, on any chain.** A sender funds a campaign with USDC for a list of email
addresses. Each recipient opens their claim link, signs in with Google, and receives the tokens
at a NEAR account they choose, without holding NEAR or a wallet beforehand. The chain stores
salted commitments, amounts, each campaign's merkle root and sender, and each claim's destination;
never an email. Built for the NEAR Hackathon
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
- **The salt is in the claim link's fragment** (`#s=<salt>&a=<amount>&p=<proof>`), which the claim site's server never
  receives. At claim time it goes only to the verifier, which never logs it. The sender's recovery
  file and link list hold every salt. A leaked link lets its holder test one guessed email against
  one commitment; it does not let anyone claim without that Google account.
- **The relayer pays gas and nothing else.** It signs with a NEAR function-call key limited to the
  contract's `claim` method and attaches no deposit. It refuses claims that our verifier did not
  sign. The destination is inside the verifier's signature, so the relayer cannot redirect funds.
  Gas is spent only after a valid verifier signature; the per-IP rate limits on the verifier and
  relayer only shed noise and are not a security property (Cloudflare's limits are approximate).
- **Unclaimed funds go back to the sender** with `reclaim` after the campaign deadline.
- **Storage is pre-paid by the sender** in NEAR (`prepay_deposit`): the campaign entry plus storage
  for each claim. The unused reservation returns to the sender's free pre-pay on `reclaim`, and
  `prepay_withdraw` sends free pre-pay back to the sender.

Known limit: an account created in the browser ("Create one for me") receives the USDC but needs a
little NEAR for gas before it can move it. **TODO:** the owner decides whether claims include a
small NEAR drip.

## How it works

```
 sender                         recipient
   │ CSV of emails + amounts       │ opens /claim/<campaign>/<commitment>#s=…&a=…&p=…
   ▼                               ▼
 web /create ──ft_transfer_call──▶ contract ◀──claim(signed args)── relayer
   │  salts, commitments,           (escrow)                          ▲
   │  merkle root, claim links         ▲                              │ signed claim args
   │                                   │ views                        │
   └──── claim link (proof inside) ─▶ web /claim ──id_token + salt──▶ verifier
                                    choose destination → Google sign-in
                                    (nonce = sha256(destination))
```

| Part | Path | What it does |
| --- | --- | --- |
| Spec | `spec/` | Byte-exact claim format (`claim.md`) and the shared test vectors (`vectors.json`) every layer must reproduce |
| Contract | `contract/` | NEP-141 escrow (Rust, near-sdk 5.26.1): campaigns keyed by (sender, merkle_root), merkle-checked claims signed by a registered verifier key, pending/in-flight accounting with a `#[private]` callback, reclaim after the deadline, the owner's `resolve_pending` exit. Unit 54/54 (Rust 1.86) and near-workspaces integration 6/6 (Rust 1.95) pass. See `contract/README.md` |
| Verifier | `verifier/` | Cloudflare Worker: Google ID token (RS256, JWKS, aud/iss/exp/email_verified, nonce = destination), HMAC commitment, merkle proof, chain checks, ed25519 signature |
| Relayer | `relayer/` | Cloudflare Worker: submits verifier-signed `claim` calls with a claim-only function-call key; payout status from the contract's events |
| Create app | `web/src/routes/create` | CSV → salts, commitments, tree; storage pre-pay + one `ft_transfer_call`; claim links carrying each recipient's salt, amount and Merkle proof (nothing else is published) |
| Claim app | `web/src/routes/claim` | Destination (existing account or an in-browser implicit account), Google sign-in, verifier → relayer; the receipt trusts the relayer's event-based 200 (`claim_paid`) and polls `claim_state` only on a 202 |

## Run it

No secrets and no Google login are needed.

Prerequisites: `git`, `make`, Node 24, and pnpm 10.30.3, which each `package.json` pins as
`packageManager` (with Node 24, `corepack enable` once provides it). `pnpm install` needs network
access.

```sh
make install   # optional: test and demo install what they need themselves
make test      # verifier, relayer, web and the demo harness: tests, type checks, build; then the contract's tests
make demo      # the claim flow end to end
```

`make test` keeps going after a failure and ends with one summary line; it exits 1 only if
something that ran failed. Expected on a machine without the Rust toolchain:

```text
SUMMARY: verifier ✓ relayer ✓ web ✓ scripts ✓ contract NOT RUN (cargo missing)
```

`make test` runs the contract's tests (`contract/Makefile`: unit, then near-workspaces
integration) when `cargo` is installed, and prints `SKIP contract: …` with the reason otherwise.
For those you also need `rustup`, `cargo-near`, a C compiler and `perl` (the integration crate
builds OpenSSL from source). rustup installs the pinned toolchains (1.86.0 for the contract, 1.95.0
for the integration tests) and the wasm target from each `rust-toolchain.toml`. The contract's unit
suite (54 tests) and its near-workspaces integration suite (6 tests) pass; the integration step
takes about 2-3 min including the wasm builds (the tests create the contract with a 30 s
`resolve_delay_ns`, so the stranded-claim test does not wait the 1 h used on testnet and mainnet).

`make demo` starts the verifier and the relayer locally and plays one recipient's claim: a sign-in
token, the verifier's checks and signature, the relayer's `claim` transaction, then it asserts
`claim_state == "claimed"`. The demo verifier is a separate build (`verifier/src/demo.ts`) whose
token issuer is generated in memory at startup in place of Google; the release verifier never
includes it and rejects its tokens (`verifier/test/demo.test.ts`).

- `make demo` runs `--dry`: a mocked NEAR RPC stands in for the chain. It still checks what the
  chain would (the relayer's transaction signature, the verifier's signature, the merkle proof),
  so the TypeScript side runs end to end, but the contract does not. The output says so.
- `make demo-sandbox` runs the same claim against a local NEAR sandbox with the real contract
  deployed and a campaign seeded (`scripts/demo-sandbox.sh`). It needs the Rust toolchain above;
  the first run compiles the contracts and can take ~15 min. It passes: the demo verifier signs,
  the relayer submits, the real contract pays out, and `claim_state` reads `claimed`. It never falls back
  to the mocked chain.
- The sandbox demo signs with the public test keys in `spec/vectors.json`. The contract refuses
  those keys on mainnet, and `scripts/deploy-testnet.sh` refuses them too.

## Claim → evidence

| Claim | Evidence |
| --- | --- |
| Every layer agrees on the bytes of commitments, leaves, nonces and signed payloads | `spec/vectors.json`; `verifier/test/claim.test.ts`, `verifier/test/claimFlow.test.ts`, `web/src/lib/create/create.test.ts`, `web/src/lib/merkle.test.ts`; contract: `contract/src/tests.rs` (`leaves_match_vectors`, `payload_rebuilt_from_args_matches_vectors`, `every_invalid_vector_fails_with_its_code`) |
| The verifier also produces the same signatures inside Cloudflare's runtime | `verifier/test/workerd.test.ts` |
| A Google sign-in only pays the destination chosen before it | `verifier/test/googleIdToken.test.ts` (`BAD_NONCE`), `web/src/lib/claim.test.ts` (nonce vectors) |
| Another person's Google account or claim link cannot claim | `verifier/test/claimFlow.test.ts` (`COMMITMENT_MISMATCH`) |
| Before signing, the verifier checks: the Google token and the destination; that the campaign exists and its deadline has not passed; that the commitment is neither claimed nor pending; HMAC(salt, email) = commitment; the merkle proof against the on-chain root; that its key is in the campaign snapshot and its registry entry outlives the signature; that the balance covers the amount. It does not pre-check the contract's storage (E128) or gas (E130) checks | `verifier/test/claimFlow.test.ts` |
| No email or salt goes on chain; a claim link whose proof does not rebuild the on-chain root is refused before sign-in (`LINK_MISMATCH`) | `spec/claim.md`; `web/src/lib/merkle.test.ts` (`rootFromProof`), `web/src/lib/claim.test.ts` (link vectors) |
| The relayer can only call `claim`, never with a deposit, and refuses claims our verifier did not sign | `relayer/test/relay.test.ts`, `relayer/test/near.test.ts` (transaction bytes checked against `@near-js/transactions`) |
| A reverted transfer is never shown as paid | `relayer/test/relay.test.ts` (`claim_reverted`), `web/src/lib/services.test.ts` (`settleClaim`) |
| A draft can be funded at most once: (sender, merkle_root) is an idempotency key (E132), and after a lost wallet response the app checks `campaign_by_root` before any resend | `web/src/lib/create/create.test.ts` (`fundCampaign`, `resolveByRoot`, `mayCreate`); `contract/src/tests.rs` (`duplicate_root_is_e132_and_changes_nothing`) |
| A claim whose callback fails stays pending until the owner's `resolve_pending` (after 1 h); `reclaim` never touches in-flight funds | `contract/src/tests.rs` (`callback_failure_restores_claim_but_not_storage_debit`, `reclaim_excludes_in_flight_and_reverts_on_failed_transfer`, `resolve_pending_is_owner_only_and_waits_an_hour`); `contract/integration/tests/escrow.rs` (`failed_callback_strands_claim_until_owner_resolves_it`) |
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
History: [hackathon-submission](https://github.com/yamancan/zarf-on-near/tree/hackathon-submission)
(**TODO:** create the `hackathon-submission` tag at submission).

**Libraries (Q-005).**

| Where | Library | Use |
| --- | --- | --- |
| verifier | none at runtime (Web Crypto) | RS256, HMAC, SHA-256, ed25519 |
| relayer | none at runtime (Web Crypto) | NEAR transaction encoding and signing are written here |
| relayer (tests only) | `@near-js/transactions` 2.5.1, `@near-js/crypto` 2.5.1 | reference implementation the transaction bytes are checked against |
| web | `@sveltejs/kit`, `svelte`, `vite`, `@sveltejs/adapter-cloudflare` | apps |
| web (create only) | `@near-wallet-selector/core` + `@near-wallet-selector/my-near-wallet` 10.1.4, `@near-js/transactions` 2.5.1, `buffer` 6.0.3 | sender wallet (MyNearWallet popup) |
| all | `typescript`, `vitest`, `wrangler`, `svelte-check` | build and tests |
| contract | `near-sdk` 5.26.1 (Rust 1.86.0) | the escrow; built with `cargo-near` |
| contract (tests only) | `near-workspaces` 0.24.0 (Rust 1.95.0), `near-contract-standards` 5.26.1 (the test-only `mock-ft`), `tokio`, `ed25519-dalek` 2, `sha2` 0.10 | sandbox integration tests and a test-only `mock-ft` token |
| verifier (tests only) | `@types/node` 24 | builds the release and demo bundles in a test, to check what each contains |

AI assistance: this code was written with Claude Code agents (implementation and review), with
humans deciding design and scope.

**Other entry (Q-015).** **TODO:** link `ad402-near`, which names this project in its README too.

## Tracks

Real-World Money (primary), Privacy & Private AI, Open Innovation.

## License

MIT, see `LICENSE`.
