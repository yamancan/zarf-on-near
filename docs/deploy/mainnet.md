# Mainnet deployment (planned, not run)

Public data only. Nothing here has been executed. The owner provides the mainnet accounts.

## Joint runbook: escrow, hosting, cross-chain demo (owner approved 2026-11-12; not run yet)

Agreed between coding-agent (escrow, `scripts/deploy.sh`) and web-agent (keys and hosting,
`scripts/mainnet-keys.mjs`, `scripts/deploy-mainnet-hosting.sh`, `docs/deploy/mainnet-hosting.md`).
Nothing starts until step 0 is complete.

**What is deployed.** Contract 0.1.2: the reviewed `contract/` tree (later commits change only scripts and docs). Release wasm 316,408 B, sha256 `3f703dd7808b25b990dd8623f3603b47a5325ec139e5186344da00f308493bd5`,
**code hash `5GdxDSB4sGW9Ewod4Q4Na613C2sLQjVfFjLbbZbKt6N8`**: the same as testnet `zarf-near-1112.testnet`,
rebuilt on the deploy host with the same result. If `deploy.sh` builds a different hash,
stop. Hosting is the reviewed web build (or the reviewed head at the time).

| # | Who | Step | Done when |
| --- | --- | --- | --- |
| 0a | owner | Fund `<owner>.near` with ≈ 5.2 NEAR (the table below plus ≈ 0.05 NEAR demo prepay) and ≥ 3 mainnet USDC (`17208628…`) for the demo | balance visible on nearblocks |
| 0b | second person | Create `<guardian>.near` with 0.1 NEAR in their own wallet; send only the name | name received |
| 0c | owner | In **their own SSH terminal**: `near account import-account` → using-seed-phrase → `<owner>.near` → mainnet → legacy keychain | `~/.near-credentials/mainnet/<owner>.near.json` exists |
| 0d | owner | Google OAuth client: add JavaScript origin `https://zarf-near-claim.sparkling-queen-5e77.workers.dev` and redirect URI `…/auth/google`; give the client id to web-agent | client id received |
| 1 | web-agent | `node scripts/mainnet-keys.mjs`: writes the verifier seed and relayer key off the repository (mode 600, never overwritten), prints the signer hex **S** and the relayer public key **R**. **Must run before any `deploy.sh` run on mainnet, even a dry run**: `deploy.sh` creates those files if they are missing, and then `mainnet-keys.mjs` refuses | S and R sent to coding-agent |
| 2 | coding-agent | Create `escrow.<owner>.near` (3.5 NEAR) and `relayer.<owner>.near` (1 NEAR) with `create-account fund-myself … sign-as <owner>.near` (commands below) | both keys in `~/.near-credentials/mainnet/` |
| 3 | coding-agent | `deploy.sh` with `DRY_RUN=1`, then for real (command below). Check in the dry run: the `new` args carry `network: mainnet`, the guardian, and `initial_signers[0].signer` = **S**. The `add-key` line carries **R**. `deploy.sh` does deploy + `new` (S is active at once, so no `add_owner_key`), the lock, the USDC registration, the refresh and the relayer's claim-only key. On a failure after deploy it prints a `SKIP_DEPLOY=1` rerun command | "contract has no full-access key"; code hash as above |
| 4 | coding-agent → web-agent | Hand over the contract id and relayer account, with checks: `get_network` = `"mainnet"`; `get_config.token_ids` ∋ `17208628…`; `get_agent(S)` = owner kind; relayer `view_access_key(R)` = FunctionCall, receiver = contract, methods `["claim"]` | message sent |
| 5 | web-agent | Fill `env.mainnet` (`CONTRACT_ID`/`PUBLIC_CONTRACT_ID`, `RELAYER_ACCOUNT_ID`, `VERIFIER_SIGNERS` = S, both Google client ids), commit, `scripts/deploy-mainnet-hosting.sh`, smoke as in `mainnet-hosting.md` | `/health` of verifier and relayer show the contract, signer S, `claim_only: true` |
| 6 | owner (+ both agents watching) | Demo: on `https://zarf-near-claim.sparkling-queen-5e77.workers.dev/create`, from `<owner>.near`: a 2-3 USDC campaign, deadline ≈ 45 days (the contract requires ≥ 30 days on mainnet; the verifier key S is valid 60 days), prepay as the page computes (≈ 0.05 NEAR). Then one claim of ≥ 1 USDC with payout to **Base**, to the owner's own Base wallet (not an exchange). Live 1Click quotes: 1 USDC loses ≈ 1.25%, 3 USDC ≈ 1.09%; the page refuses a worst case over 5% | claim and payout tx hashes recorded below |
| 7 | owner | Explorer checks (below) | ticked |

Commands for steps 2-3 (`<…>` filled in at run time):

```bash
near account create-account fund-myself escrow.<owner>.near '3.5 NEAR' autogenerate-new-keypair \
  save-to-legacy-keychain sign-as <owner>.near network-config mainnet sign-with-legacy-keychain send
near account create-account fund-myself relayer.<owner>.near '1 NEAR' autogenerate-new-keypair \
  save-to-legacy-keychain sign-as <owner>.near network-config mainnet sign-with-legacy-keychain send

NETWORK=mainnet LOCK_CONTRACT=1 \
CONTRACT_ID=escrow.<owner>.near OWNER_ID=<owner>.near RELAYER_ID=relayer.<owner>.near \
GUARDIAN_ID=<guardian>.near SIGNER_PUBKEY=<S> \
RELAYER_KEY_FILE=<relayer-key-file> \
DRY_RUN=1 scripts/deploy.sh          # then the same without DRY_RUN=1
```

`SIGNER_PUBKEY` is passed explicitly so `deploy.sh` never reads or creates the verifier seed.
The relayer key file is read only to derive R (`deploy.sh` keeps base58 leading zeros since
`ead1417`; compare its printed R with web-agent's anyway).

Later: the verifier key S expires after 60 days. Before that, the owner adds a new key with
`add_owner_key`, which takes effect after the 1 h delay; campaigns snapshot the keys valid
through their deadline.

### Mainnet record

(filled in at run time: account creation, deploy + `new`, lock, USDC registration, refresh,
relayer key, hosting versions, demo campaign, claim and payout tx hashes)

## Owner checklist (about 15 minutes)

**Budget: about 5.1 NEAR in total** (minimum that works: about 3.4 NEAR). Gas price on mainnet
is 0.0001 NEAR per Tgas, the same as testnet, so the testnet figures in `testnet.md` carry over.

| Account | Who holds the key | NEAR | What it pays |
| --- | --- | --- | --- |
| `<owner>.near` (owner) | the owner, in a wallet **and** imported on the deploy host | 0.5 | creating the two sub-accounts, escrow USDC registration (0.00125), `refresh_token_storage`, later upgrade proposals and their code-growth deposits |
| `escrow.<owner>.near` (escrow) | nobody once deployed: its only key is deleted right after `new` | 3.5 | its own storage, locked for as long as it lives: code + state = 318,486 B = 3.19 NEAR on testnet 1112; deploy gas ≈ 0.003 |
| `relayer.<owner>.near` (relayer) | the relayer Worker (claim-only key) | 1.0 | gas for every claim: ≈ 11.6 Tgas = 0.0012 NEAR, so about 800 claims |
| `<guardian>.near` (guardian) | a **different person**, in a different wallet; never on the deploy host | 0.1 | gas for a cancel or a freeze, if ever needed |

The escrow and the relayer are funded from the owner's account when we create them, so the owner
funds `<owner>.near` with about 5.0 NEAR and the guardian with 0.1 NEAR.

**What the owner does**

1. In a wallet (e.g. Meteor or MyNearWallet), have `<owner>.near` with about 5.0 NEAR (5.2 with
   the demo prepay) and, for the demo, ≥ 3 mainnet USDC.
2. A second person creates `<guardian>.near` in their own wallet, funds it with 0.1 NEAR, and
   sends us only the account name.
3. In **your own SSH terminal on the deploy host** (not in an agent chat: the seed phrase must not
   enter a transcript or shell history), type `near account import-account`, and pick
   `using-seed-phrase` → enter the phrase and `<owner>.near` → `mainnet` → save to the
   **legacy keychain**. This puts the owner key in `~/.near-credentials/mainnet/`.
4. Tell us the two account names, then wait for step 5 below and check the result (step 6).

**What we run** (no owner action needed; each step prints what it sends)

```bash
near account create-account fund-myself escrow.<owner>.near '3.5 NEAR' autogenerate-new-keypair \
  save-to-legacy-keychain sign-as <owner>.near network-config mainnet sign-with-legacy-keychain send
near account create-account fund-myself relayer.<owner>.near '1 NEAR' autogenerate-new-keypair \
  save-to-legacy-keychain sign-as <owner>.near network-config mainnet sign-with-legacy-keychain send
# then the command block below: first with DRY_RUN=1, then for real
```

The script deploys and initialises the escrow in one transaction, **deletes the escrow's only
full-access key immediately after**, then registers it on USDC and gives the relayer its
claim-only key. Then the verifier and relayer Workers get their secrets.

**How the owner checks it** (on `https://nearblocks.io/address/escrow.<owner>.near`)

- **Access keys:** the escrow's key list is **empty**. Nobody can sign as the escrow; its code
  changes only through `propose_upgrade` → 1 h public delay → `apply_upgrade`.
- **Code hash:** equals the base58 sha256 of the release wasm, which the deploy prints and which
  anyone can rebuild from the published commit. For the current contract (0.1.2, the same code as
  testnet `zarf-near-1112.testnet`) the expected value is
  `5GdxDSB4sGW9Ewod4Q4Na613C2sLQjVfFjLbbZbKt6N8`, unless the contract changes before the deploy.
- The same from a terminal, without an explorer:
  `near account view-account-summary escrow.<owner>.near network-config mainnet now`
  (code hash and access keys), and
  `near contract call-function as-read-only escrow.<owner>.near get_config json-args '{}' network-config mainnet now`
  (expect `"network":"mainnet"`, `"upgrade_delay_ns":"3600000000000"`, the guardian's account).
- After the deploy, the owner may remove the owner key from the deploy host
  (`~/.near-credentials/mainnet/<owner>.near.json`); it is needed only to propose upgrades or
  change settings, and the wallet keeps it.

## Posture

- **No full-access key on the escrow** (`LOCK_CONTRACT=1` is mandatory on mainnet; the script
  refuses to start without it). Code then changes only through `propose_upgrade` →
  `upgrade_delay_ns` → `apply_upgrade`, and ownership only through `propose_owner` → delay →
  `accept_owner`.
- `upgrade_delay_ns` = 1 h (the contract allows 10 min .. 1 h on mainnet). One hour protects
  only if someone watches `watch()` and cancels a bad proposal in time.
- A **guardian** (`GUARDIAN_ID`) can cancel, freeze proposals for 7 days, and drop an owner key
  that is not active yet; it can never propose, apply, add keys or move funds. Without one the
  script warns.
- Owner keys added after `new` wait the same delay; the verifier key is an `initial_signers`
  entry, active at once.
- `resolve_delay_ns` = 1 h; `min_lifetime_ns` = 30 days.

## Command block

```bash
cd <repo>                                      # a clone at the reviewed commit
make -C contract wasm                          # release wasm in contract/target/near/release

NETWORK=mainnet LOCK_CONTRACT=1 \
UPGRADE_DELAY_NS=3600000000000 \
USDC_ID=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 \
CONTRACT_ID=escrow.<owner>.near OWNER_ID=<owner>.near RELAYER_ID=relayer.<owner>.near \
GUARDIAN_ID=<guardian>.near \
scripts/deploy.sh
```

- The keys for `CONTRACT_ID`, `OWNER_ID` and `RELAYER_ID` must be in `~/.near-credentials/mainnet/`
  (legacy keychain) before the run. `CREATE_ACCOUNTS` is refused on mainnet.
- The verifier seed is created at `~/.config/zarf-near/mainnet-verifier.seed` (mode 600) unless
  `SIGNER_PUBKEY` is given; the relayer's claim-only key at `~/.config/zarf-near/mainnet-relayer.key`.
  Both end up as secrets of their Cloudflare Workers (`wrangler secret put`); after that, the
  plaintext copies on the build host are deleted (`shred -u`), so the only live copy of the
  verifier seed is the Worker secret.
- If a step after deploy + `new` fails, the script prints the exact rerun command with
  `SKIP_DEPLOY=1`: it skips the build and deploy and repeats the lock (a no-op once no key is left),
  the USDC registration, the refresh and the relayer key. Every one of them is safe to repeat.
- The script refuses: no `LOCK_CONTRACT=1`; a `USDC_ID` other than Circle's mainnet contract;
  accounts not ending in `.near`; the public test keys from `spec/vectors.json`.
- The script prints `view get_config` at the end. Expect `network` = `mainnet`,
  `upgrade_delay_ns` = `3600000000000`, `guardian_id` = the guardian, and the line "contract has
  no full-access key" (it exits 70 if one remains).

## Before running

- [ ] Owner: the checklist above: `<owner>.near` with ≈ 5.0 NEAR, `<guardian>.near` with 0.1 NEAR.
- [ ] Owner: decide the guardian account (a different key holder than the owner; the script
      refuses `GUARDIAN_ID` = `OWNER_ID`).
- [ ] The README trust statement matches this posture (owner single key or multisig; guardian set
      or not; builds not reproducible yet).
- [ ] Dry run first: the same command with `DRY_RUN=1`.
