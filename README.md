# Zarf on NEAR

**Send USDC to any email, from any chain.** A sender funds a campaign with USDC for a list of email addresses. Each
recipient opens their claim link, signs in with Google (Gmail or Google Workspace), and receives the USDC at a NEAR account they
choose; they need no NEAR for gas, because a relayer pays it. The chain stores salted commitments,
amounts, each campaign's merkle root and sender, and each claim's destination; never an email.

**Linkdrop pays whoever holds the link; Zarf pays the owner of the email.** A forwarded or leaked
Zarf link is useless without that person's Google account.

**Live on NEAR testnet** (test funds, no value):

- Judges' page, a claim link for 0.5 test USDC to your Google email: https://near.zarf.to/try
- Claim and send app: https://near.zarf.to
- Escrow contract: [`zarf-near-1112.testnet`](https://testnet.nearblocks.io/address/zarf-near-1112.testnet)
- The contract's on-chain metadata (NEP-330 `link`, upgrade `source`) records the deployment source in
  [the testnet deployment notes](docs/deploy/testnet.md).
  (accounts, keys and versions: `docs/deploy/testnet.md`)
- The hackathon judges have access to this repository.

> Live on NEAR testnet. A real Google claim has run end to end on the hosted app; the evidence table
> below lists what has run, with transactions and tests.

**What it uses from NEAR** (each one is in the code and on testnet unless it says otherwise):

1. A **function-call access key limited to `claim`** for the relayer: the recipient pays no gas, and a
   stolen relayer key cannot move funds (`relayer/`, `scripts/deploy.sh`).
2. A **keyless escrow account**: every access key is deleted after deploy; the code changes only
   through a public, delayed upgrade (10 min on testnet, at most 1 h on mainnet).
3. **NEP-141 USDC with storage registration by the escrow**: the recipient does not need to be
   registered on the token first; `claim` registers them (`storage_deposit`) and pays (`ft_transfer`).
4. **Storage staking paid by the sender**: a pre-pay covers each claim's storage, and what is not used
   comes back to the sender.
5. **Promise callbacks**: a payout that fails on the token rolls the claim back to unclaimed, so a
   claim cannot pay twice (`on_claim`).
6. **NEAR Connect** wallet selector for senders (Meteor, Intear, Nightly; HOT on mainnet; Ethereum Wallets for
   MetaMask senders with a NEP-518 `0x` account).
7. **NEAR Intents (1Click)** both ways, built for mainnet (1Click has no testnet): a recipient can take the
   payout as USDC on ten chains (Base, Arbitrum, Ethereum, Optimism, Polygon, Avalanche, Monad, Solana, Sui,
   Aptos), and a sender can fund a campaign from USDC on those chains (1Click delivers it as NEAR USDC to the
   sender's own account). On testnet the send page shows a live quote.
8. **Any NEAR account as the destination**: named, implicit, or NEP-518 `0x` (Ethereum) accounts. A
   `0x` account received a payout and spent it with its Ethereum key on testnet
   ([payout](https://testnet.nearblocks.io/txns/2Zi796Z4k87JPLkgt8Dtsu1iZxhThtVcj4dPUCCNgRtJ),
   [spend](https://testnet.nearblocks.io/txns/FkRvT7Wt77DwWpgosZJ7EG31rfFSJbKW6voxCW4MAafe)); the claim
   form accepts `0x` when `PUBLIC_ETH_ACCOUNTS=on`.

**No wallet yet?** On testnet a recipient can create a NEAR account with Face ID or Touch ID: the account's
key is derived from a passkey (WebAuthn PRF) each time it is opened and never stored, and a key file is the
fallback where the device gives no PRF. It is an in-browser wallet, switched on for testnet (`web/src/lib/passkey.ts`).

Google sign-in is not a NEAR feature: our verifier checks the Google token, and the contract checks
the verifier's signature. Trion Labs runs the verifier (How trust works, below).

**Same team, separate entry** (rule Q-015): **ad402-near**, a sponsor rail that pays a user per sponsor
card into a NEAR account, https://github.com/yamancan/ad402-near <!-- TODO(Q-015): set the final public URL before submission -->.
The two projects share no code.

Built for the NEAR Hackathon (build window ends 2026-11-14 23:59 UTC). Pre-window work it builds
on is listed under "Prior work, baseline and libraries".

## How trust works

- **The verifier checks the Google sign-in and signs each claim.** Trion Labs runs it. At claim time it
  checks the Google ID token and the recipient's salt against the commitment, then signs the claim; it sees
  the email at that moment and never stores it.
- **The chain never sees an email.** Per recipient it stores
  `commitment = HMAC-SHA256(salt, canonical email)` and the amount (`spec/claim.md`). Amounts are
  public per commitment.
- **Mode W (this deployment): owner-registered key.** The verifier runs as a Cloudflare Worker,
  and the contract owner registers its signing key. Each campaign accepts the keys registered when it
  was created, and a claim pays only with one of their signatures.
- **The contract is upgradable, only behind a public delay.** The owner proposes a code hash, which
  is visible on chain, and can apply it only after `upgrade_delay_ns`: 10 min on testnet, at most
  1 h on mainnet (there `new` refuses a value outside 10 min to 1 h). `watcher/` watches that window: a
  cron Worker that alerts within 2 min on a proposed upgrade, an owner change,
  a verifier-key change, a claim page that differs from what was deployed, and, read from the protocol rather
  than the contract's own views, an escrow code hash other than the expected one or any access key on the
  escrow. A guardian can cancel any proposal, so `scripts/deploy.sh` requires a guardian and an offline backup
  verifier key for mainnet. On mainnet the owner will hold the guardian himself, in a separate account.
- **The escrow account has no full-access key.** Every full-access key is deleted after deploy and
  `new` (`spec/claim.md`, "Upgrades and ownership"), so nobody can sign as the escrow and move its
  tokens; the only way to change the code is the delayed upgrade. On testnet `zarf-near-1112.testnet` holds no access key
  at all.
- **Each campaign snapshots its accepted keys at creation.** Removing a snapshotted key
  (`remove_agent`) freezes that campaign's claims until `reclaim`. Revocation costs liveness,
  never funds.
- **The owner settles a stuck claim.** `resolve_pending` settles a claim that has stayed `pending` for an
  hour, as paid or as unpaid. USDC is pooled per token in the escrow, so the answer moves that pool: a claim
  settled as unpaid can be claimed again from it (`settle` in `contract/src/lib.rs`).
- **The salt is in the claim link's fragment** (`#s=<salt>&a=<amount>&p=<proof>`), which the claim site's server never
  receives. At claim time it goes only to the verifier, which never logs it. If the sender uses Email All
  Recipients, the mailer (`mailer/`) and Resend, our email provider, also see each address and its link; the mailer
  stores only the commitment. The sender's recovery
  file and link list hold every salt. Claiming with a link needs the Google account it was sent to.
- **The relayer pays gas and nothing else.** It signs with a NEAR function-call key limited to the
  contract's `claim` method and attaches no deposit. It refuses claims that our verifier did not
  sign. The destination is inside the verifier's signature, so the relayer cannot redirect funds.
  Gas is spent only after a valid verifier signature; per-IP rate limits on the verifier and relayer
  shed noise.
  `claim` is permissionless: anyone holding the verifier's signed arguments can submit them, so
  the relayer is a convenience, not a trust point. We do not use NEP-366 meta-transactions because
  they need the recipient to sign a delegate action with their own NEAR key, and a recipient here
  proves who they are with Google: they may have no NEAR account or key at all.
- **A cross-chain payout goes through a third party.** If the recipient picks USDC on another chain,
  the destination address and the amount go to NEAR Intents 1Click, which pays out from a one-time
  deposit address. 1Click's status for that address is public, so the claim can be linked to the
  destination address. Payout assets are pinned to Circle USDC on ten chains, each as a NEAR-side token from
  one of three bridge issuers: `omft.near` (Base, Arbitrum, Ethereum, Solana, Sui, Aptos),
  `omdep.near` (Polygon, Avalanche) and HOT Omni `v2_1.omni.hot.tg` (Optimism, Monad) (`web/src/lib/chains.ts`).
  The list is the same for funding a send.
  For a payout requested through the claim page's cross-chain step the verifier refuses a quote that could
  lose more than 2%, a payout above 1,000 USDC, or a refund anywhere but the sender, so the recipient gets a
  fair quote. Very small payouts often cost the bridge more than 2%; a claim to a NEAR account has no such
  check.
  If the bridge does not complete the payout by its deadline, it refunds the campaign sender on
  NEAR. If a payout ends in the bridge's FAILED state, the page tells the recipient to contact the sender,
  who can reach NEAR Intents support with the deposit address.
- **The sender's wallet code comes from the wallets.** The send pages connect through NEAR Connect with a
  pinned list of wallets (Meteor, Intear, Nightly; HOT on mainnet). Each wallet's code runs in a sandboxed
  iframe that cannot read the page. The code from GitHub is pinned to a commit; Intear serves its own, which
  is pinned by SHA-256 (`integrity` in wallets.json, checked by web/patches/@hot-labs__near-connect@0.12.0.patch):
  when Intear ships a new file, Intear stops opening until someone reads it and updates the hash. A changed wallet script could ask the wallet to sign a different transaction, so the
  wallet's own approval screen, which shows the receiver and amount, is the last check before signing. The
  claim page uses the same list only to read the recipient's account name ("Use my wallet"), never to sign,
  and the recipient confirms that name before Google sign-in. The send pages, and the claim form with `0x`
  accounts on, also offer Ethereum Wallets (MetaMask). Its executor script from evm-on-near.dev is pinned by
  SHA-256 like Intear's; a MetaMask sender signs in evm-on-near.dev's own popup and confirms on MetaMask's
  screen.
- **The Face ID account is a wallet inside the claim page** (testnet only). Its key is re-derived from the
  passkey on each opening and held in the page's memory while it is open. The passkey is bound to the claim
  site's domain, and the key file is its backup.
- **USDC is Circle's.** Circle can pause USDC or block an account, and claims and take-backs (`reclaim`)
  follow that.
- **One send is at most 100 USDC on mainnet**, set in the create app; the contract itself has no cap.
- **Unclaimed funds go back to the sender** with `reclaim` after the campaign deadline.
- **Storage is pre-paid by the sender** in NEAR (`prepay_deposit`): the campaign entry plus storage
  for each claim. The unused reservation returns to the sender's free pre-pay on `reclaim`, and
  `prepay_withdraw` sends free pre-pay back to the sender.

On mainnet the recipient claims to an existing NEAR account; the in-browser account (a key file, or the
Face ID account above) is switched on for testnet.
On testnet only, after a paid claim, a destination that holds under 0.005 NEAR (or a new implicit or `0x`
account) gets 0.02 test NEAR once, from a separate gas account with its own key, never the relayer's;
at most 50 a day, and never on mainnet (`relayer/src/starter.ts`). Gas for the claim itself
is the relayer's: the contract requires 55 Tgas attached (`required_claim_gas`), and a claim
measured about 11.6 Tgas burnt.

**Next fixes**

- The relayer will check the merkle proof before sending, so a resent approval with a wrong proof costs no
  gas; until then it is rate-limited to about 3 a minute per commitment (`relayer/src/relay.ts`).
- The claim page will keep the receipt and the cross-chain recovery steps across a reload while a claim
  settles; the claim and its on-chain state already carry through a reload.
- A claim the relayer answers with 202 (paid later) will also get starter NEAR, and a failed starter transfer
  will leave that destination its one starter (`relayer/src/index.ts`, `relayer/src/starter.ts`).
- The judges' page will update its daily caps in one atomic step and retry a failed counter write, so a burst
  of requests stays within the daily test-USDC budget (`faucet/src/limits.ts`).

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
| Contract | `contract/` | NEP-141 escrow (Rust, near-sdk 5.26.1): campaigns keyed by (sender, merkle_root), merkle-checked claims signed by a registered verifier key, pending/in-flight accounting with a `#[private]` callback, reclaim after the deadline, the owner's `resolve_pending` exit. Unit 71/71 (Rust 1.86) and near-workspaces integration 11/11 (Rust 1.95) pass. See `contract/README.md` |
| Verifier | `verifier/` | Cloudflare Worker: Google ID token (RS256, JWKS, aud/iss/exp/email_verified, nonce = destination), HMAC commitment, merkle proof, chain checks, ed25519 signature |
| Relayer | `relayer/` | Cloudflare Worker: submits verifier-signed `claim` calls with a claim-only function-call key; payout status from the contract's events |
| Create app | `web/src/routes/create` | CSV → salts, commitments, tree; storage pre-pay + one `ft_transfer_call`; claim links carrying each recipient's salt, amount and Merkle proof (nothing else is published) |
| Claim app | `web/src/routes/claim` | Destination: an existing NEAR account, checked on chain before sign-in; on testnet also a new account with Face ID or a key file (off on mainnet). Cross-chain payout through NEAR Intents to USDC on ten chains: on testnet shown as a mainnet option; on mainnet through 1Click. Then Google sign-in, verifier → relayer; the receipt trusts the relayer's event-based 200 (`claim_paid`) and polls `claim_state` only on a 202 |
| Judges' page | `faucet/` | Cloudflare Worker behind `/try`: Turnstile, per-IP/per-email/daily limits, then a one-recipient test-USDC campaign and its claim link |
| Watcher | `watcher/` | Cron Worker: alerts on a proposed upgrade, owner or verifier-key change, the escrow's code hash or any access key on it, and a changed live claim page (`watcher/README.md`) |
| Proxy | `proxy/` | `near.zarf.to`: passes `/try` (with its script, font and API) and `/health` to the judges' page, everything else to the claim app |
| Mailer | `mailer/` | Email All Recipients: emails each recipient their claim link through Resend, only for a leaf whose Merkle proof reaches a live, funded, unclaimed campaign on chain; one mail per commitment, capped per campaign, per day and per sender; stores commitments only |

## Run it

No secrets and no Google login are needed.

Prerequisites: `git`, `make`, Node 24, and pnpm 10.30.3, which each `package.json` pins as
`packageManager` (with Node 24, `corepack enable` once provides it). `pnpm install` needs network
access.

```sh
make install   # optional: test and demo install what they need themselves
make test      # verifier, relayer, web, the upgrade watcher and the demo harness: tests, type checks, build; then the contract's tests
make demo      # the claim flow end to end
```

`make test` keeps going after a failure and ends with one summary line; it exits 1 only if
something that ran failed. Expected on a machine without the Rust toolchain:

```text
SUMMARY: verifier ✓ relayer ✓ web ✓ watcher ✓ scripts ✓ proxy ✓ mailer ✓ faucet ✓ contract NOT RUN (cargo missing)
```

`make test` runs the contract's tests (`contract/Makefile`: unit, then near-workspaces
integration) when `cargo` is installed, and prints `SKIP contract: …` with the reason otherwise.
For those you also need `rustup`, `cargo-near`, a C compiler and `perl` (the integration crate
builds OpenSSL from source). rustup installs the pinned toolchains (1.86.0 for the contract, 1.95.0
for the integration tests) and the wasm target from each `rust-toolchain.toml`. The contract's unit
suite (71 tests) and its near-workspaces integration suite (11 tests) pass; the integration step
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
  those keys on mainnet, and `scripts/deploy.sh` refuses them too.

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
| The contract pays a claim on testnet and refuses a repeat (contract-level evidence on 0.1.2, not a Google claim) | claim `Cmi5X9XyiQjSfhJDahWz6TvZKSjkVX5MKjFqAYS7m7Zt`; repeat `FLmmkbCQckFQWK9CEKxmxrtMrf2XLB28qR2guPnk6RFL` → `E105` |
| A real claim end to end on testnet: a link from the judges' page, Google sign-in on the hosted app, the verifier's signature, the relayer's transaction | tx `AY7GFZSLZa5R26YTAUyUWA6uTBMJ9MAcmBaZkjnFMa2F` (`zarf-near-relayer-1111.testnet` → `zarf-near-1112.testnet` `claim`, campaign 2, 0.5 test USDC to `zarf-near-dest3-1112.testnet`, events `claim_started` and `claim_paid`). Check: `curl -s https://test.rpc.fastnear.com -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":"AY7GFZSLZa5R26YTAUyUWA6uTBMJ9MAcmBaZkjnFMa2F","sender_account_id":"zarf-near-relayer-1111.testnet"}}'` |

## Prior work, baseline and libraries

**Prior work.** This builds on Zarf on Stellar by the same team (Trion Labs), live at
[zarf.to](https://zarf.to). The ideas carried over are a token sent to an email and claimed with
Google, a nonce bound to the destination, a claim expiry, the canonical-email rule, and the
error-code numbering. None of its protocol code is reused: Zarf on Stellar proves Google sign-in with
a Noir circuit verified by Soroban contracts, neither runs on NEAR, and this repository replaces the
proof with the verifier service described above.

**Baseline: pre-window Trion work copied into this repository.** The web apps reuse Zarf's
interface, copied from Zarf on Stellar (2026-10-14) and
adapted; these files are not hackathon work:

| Path here | From Zarf on Stellar |
| --- | --- |
| `web/src/lib/zen/**` | The Zen UI kit: components (ZenButton, ZenCard, ZenInput, ZenSelect, ZenCheckbox, ZenAlert, ZenBadge, PageHeader, ThemeToggle, ZarfLogo), theme store, colour, spacing, motion, radius and shadow tokens, light and dark themes |
| `web/src/app.css` | The ripple background, the dark ground and the landing grain |
| `web/src/lib/{Amount,Hero,Medallion,Note,ZarfMark}.svelte`, `web/src/routes/+layout.svelte` | The claim card's amount block, the landing hero, the status medallion and line, the logo mark, the navbar: markup and classes adapted |
| `web/src/lib/zarf-kit/**` | Zarf's UI kit (`web/packages/ui/lib`) and the create app's recipient grid, import controls and row checks (`apps/create/src/lib/components/recipients`), copied as they are; each change is listed in `web/src/lib/zarf-kit/README.md` (NEAR's own row checks are in `web/src/lib/create/grid.ts`) |
| `web/static/favicon.svg`, `web/static/og.png`, `faucet/src/assets.ts` (favicon) | Brand assets |

Third-party assets: the Saira font (`web/static/fonts`, SIL OFL, licence beside it) and Google's sign-in
button and Gmail mark (`web/static/google`, used as Google's branding guidelines allow).

**Hackathon diff.** Everything else in this repository was built in the build window, starting
from the first commit on 2026-11-07.
History: [hackathon-submission](https://github.com/yamancan/zarf-on-near/tree/hackathon-submission).

**Libraries.**

| Where | Library | Use |
| --- | --- | --- |
| verifier | none at runtime (Web Crypto) | RS256, HMAC, SHA-256, ed25519 |
| relayer | none at runtime (Web Crypto) | NEAR transaction encoding and signing are written here |
| relayer (tests only) | `@near-js/transactions` 2.5.1, `@near-js/crypto` 2.5.1 | reference implementation the transaction bytes are checked against |
| web | `@sveltejs/kit`, `svelte`, `vite`, `@sveltejs/adapter-cloudflare` | apps |
| web (claim, cross-chain step) | `@noble/hashes` 1.8.0 | keccak-256 for the EIP-55 address checksum |
| web (send, fund from another chain) | `uqr` 0.1.3 (MIT) | the deposit address as a QR code |
| web (send pages; claim form reads the account only) | `@hot-labs/near-connect` 0.12.0, with a pinned wallet list (Meteor, Intear, Nightly; HOT on mainnet; Ethereum Wallets on the claim form with 0x on) | sender wallet: NEAR Connect, NEAR's replacement for the deprecated wallet selector (MyNearWallet stopped accepting app connections in Nov 2026) |
| all | `typescript`, `vitest`, `wrangler`, `svelte-check` | build and tests |
| contract | `near-sdk` 5.26.1 (Rust 1.86.0) | the escrow; built with `cargo-near` |
| contract (tests only) | `near-workspaces` 0.24.0 (Rust 1.95.0), `near-contract-standards` 5.26.1 (the test-only `mock-ft`), `tokio`, `ed25519-dalek` 2, `sha2` 0.10 | sandbox integration tests and a test-only `mock-ft` token |
| verifier (tests only) | `@types/node` 24 | builds the release and demo bundles in a test, to check what each contains |

AI assistance: this code was written with Claude Code agents (implementation and review), with
humans deciding design and scope.

## Roadmap

- TEE-attested verifier: the signing key registered through on-chain attestation.
- NEAR Auth (FastAuth): give a recipient without a NEAR account one at claim time.

## Tracks

Real-World Money (primary), Open Innovation.

## License

MIT, see `LICENSE`.
