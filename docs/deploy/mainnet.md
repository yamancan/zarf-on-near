# Mainnet deployment (planned, not run)

Public data only. Nothing here has been executed. The owner provides the mainnet accounts.

## Joint runbook: escrow, hosting, cross-chain demo (owner approved 2026-11-12; not run yet)

Roles: the **contract operator** runs the escrow side (`scripts/deploy.sh`), the **web operator** the keys and
hosting (`scripts/mainnet-keys.mjs`, `scripts/deploy-mainnet-hosting.sh`, `docs/deploy/mainnet-hosting.md`).
Nothing starts until step 0 is complete.

**What is deployed.** Contract 0.1.2: the reviewed `contract/` tree (later commits change only scripts and docs). Release wasm 316,408 B, sha256 `3f703dd7808b25b990dd8623f3603b47a5325ec139e5186344da00f308493bd5`,
**code hash `5GdxDSB4sGW9Ewod4Q4Na613C2sLQjVfFjLbbZbKt6N8`**: the same as testnet `zarf-near-1112.testnet`,
rebuilt on the deploy host with the same result. If `deploy.sh` builds a different hash,
stop. Hosting is the reviewed web build (or the reviewed head at the time).

**No owner, escrow or relayer full-access key ever exists on the deploy host.** Every signed step runs on
the owner's own machine, off the deploy host, from an *owner kit* that `deploy.sh` writes (the release wasm plus `owner-steps.sh`, no
secret in it). The deploy host keeps only the verifier seed S and the relayer's claim-only key R, which the
Workers need, and checks the result with read-only views (`VERIFY_ONLY=1`).

| # | Who | Step | Done when |
| --- | --- | --- | --- |
| 0a | owner | Fund `<owner>.near` with ≈ 5.2 NEAR (the table below plus ≈ 0.05 NEAR demo prepay) and ≥ 3 mainnet USDC (`17208628…`) for the demo | balance visible on nearblocks |
| 0b | second person | Create `<guardian>.near` with 0.1 NEAR in their own wallet; send only the name. **Mandatory:** `deploy.sh` refuses mainnet without `GUARDIAN_ID`, and the guardian is fixed at `new` | name received |
| 0c | owner, off the deploy host | Install near-cli-rs (the kit was checked against 0.30.1). Keep the owner key in the local key store (`near account import-account using-seed-phrase … save-to-keychain`, network mainnet), or use a hardware wallet. **Never import it on the deploy host** | `near account view-account-summary <owner>.near network-config mainnet now` works on the owner's machine |
| 0d | owner, off the deploy host | Backup verifier key S2: run the one-liner under the table with the seed written to offline storage, keep it off every server, send only the printed 64-hex public key | S2 received |
| 0e | owner | Google OAuth client: add JavaScript origin `https://zarf-near-claim.sparkling-queen-5e77.workers.dev` and redirect URI `…/auth/google`; give the client id to web operator | client id received |
| 1 | web operator | `node scripts/mainnet-keys.mjs`: writes the verifier seed and relayer key off the repository (mode 600, never overwritten), prints the signer hex **S** and the relayer public key **R**. Must run before any `deploy.sh` run on mainnet (`deploy.sh` refuses mainnet without `SIGNER_PUBKEY` and without the relayer key file) | S and R sent to contract operator |
| 2 | contract operator | `deploy.sh` (command below): checks the env, builds the wasm, refuses unless its code hash is `5GdxDSB4…`, and writes the owner kit. It signs nothing. Check the printed `new()` args at the top of the kit: `network: mainnet`, the guardian, `initial_signers` = **S** and **S2**, and `R` | kit written; code hash as above |
| 3 | owner, off the deploy host | Copy the owner kit from the deploy host to the owner's machine, then run `bash owner-steps.sh`. The kit checks the wasm sha256, then: (1) creates `escrow.<owner>.near` (3.5 NEAR), its key in the local key store; (2) creates `relayer.<owner>.near` (1 NEAR), its full-access key in the local key store; (3) deploy + `new` in one transaction; (4) deletes the escrow's only key; (5) registers the escrow on USDC; (6) `refresh_token_storage`; (7) gives the relayer the claim-only key R. After a failure: `FROM=<step> bash owner-steps.sh` | the kit prints "done" |
| 3b | contract operator | `VERIFY_ONLY=1` with the same env (read-only): code hash, escrow has **no access key**, owner, network, guardian, 1 h delay, USDC, verifier keys = {S, S2}, nothing pending, escrow registered on USDC, relayer keys = one full-access key (the owner's machine) + R claim-only on the escrow. `relayer-handover.sh` is testnet-only now: there is nothing on this host to hand over | `verify: 0 failed` |
| 4 | contract operator → web operator | Hand over the contract id and relayer account (the 3b output) | message sent |
| 5 | web operator | Fill `env.mainnet` (`CONTRACT_ID`/`PUBLIC_CONTRACT_ID`, `RELAYER_ACCOUNT_ID`, `VERIFIER_SIGNERS` = S, both Google client ids), commit, `scripts/deploy-mainnet-hosting.sh` with the Cloudflare token scoped to the mainnet Workers (`mainnet-hosting.md`), smoke as in `mainnet-hosting.md` | `/health` of verifier and relayer show the contract, signer S, `claim_only: true` |
| 6 | owner (+ both agents watching) | Demo: on `https://zarf-near-claim.sparkling-queen-5e77.workers.dev/create`, from `<owner>.near`: a 2-3 USDC campaign, deadline ≈ 45 days (the contract requires ≥ 30 days on mainnet; the verifier keys are valid 60 days), prepay as the page computes (≈ 0.05 NEAR). Then one claim of ≥ 1 USDC with payout to **Base**, to the owner's own Base wallet (not an exchange). Live 1Click quotes: 1 USDC loses ≈ 1.25%, 3 USDC ≈ 1.09%; the page refuses a worst case over 5% | claim and payout tx hashes recorded below |
| 7 | owner | Explorer checks (below) | ticked |

Step 0d, the backup verifier key, on the owner's machine, off the deploy host (Node 18+; the seed file is created mode 600 and never
overwritten; the line prints only the public key S2):

```bash
node -e 'const c=require("crypto"),fs=require("fs"),{privateKey:k,publicKey:p}=c.generateKeyPairSync("ed25519");fs.writeFileSync(process.argv[1],k.export({format:"der",type:"pkcs8"}).subarray(-32).toString("hex"),{mode:0o600,flag:"wx"});console.log(p.export({format:"der",type:"spki"}).subarray(-32).toString("hex"))' <offline-storage>/zarf-mainnet-verifier-backup.seed
```

Step 2 (`<…>` filled in at run time; `DRY_RUN=1` first prints the build instead of running it):

```bash
NETWORK=mainnet LOCK_CONTRACT=1 \
CONTRACT_ID=escrow.<owner>.near OWNER_ID=<owner>.near RELAYER_ID=relayer.<owner>.near \
GUARDIAN_ID=<guardian>.near SIGNER_PUBKEY=<S> BACKUP_SIGNER_PUBKEY=<S2> \
RELAYER_KEY_FILE=<relayer-key-file> \
EXPECT_CODE_HASH=5GdxDSB4sGW9Ewod4Q4Na613C2sLQjVfFjLbbZbKt6N8 \
scripts/deploy.sh                    # hardware-wallet owner: add OWNER_SIGN='sign-with-ledger usb'
# step 3b: the same line with VERIFY_ONLY=1
```

The relayer key file is read only to derive R; the verifier seed is never read (`SIGNER_PUBKEY` is given).

**If S leaks.** The owner calls `remove_agent(S)` from the owner's machine and the web operator redeploys the verifier
with the S2 seed (`SIGNER_SEED`) and `VERIFIER_SIGNERS` = S2. Every campaign created after `new` snapshots
both keys, so live campaigns keep paying out. Without S2, removing S would freeze them until their deadline.

Later: the verifier keys expire after 60 days. Before that, the owner adds new keys with `add_owner_key`
(from the owner's machine), which take effect after the 1 h delay; campaigns snapshot the keys valid through their deadline.

### Mainnet record

(filled in at run time: account creation, deploy + `new`, lock, USDC registration, refresh,
relayer key, hosting versions, demo campaign, claim and payout tx hashes)

## Owner checklist (about 15 minutes)

**Budget: about 5.1 NEAR in total** (minimum that works: about 3.4 NEAR). Gas price on mainnet
is 0.0001 NEAR per Tgas, the same as testnet, so the testnet figures in `testnet.md` carry over.

| Account | Who holds the key | NEAR | What it pays |
| --- | --- | --- | --- |
| `<owner>.near` (owner) | the owner only: a wallet and the owner machine's key store, or a hardware wallet; **never on the deploy host** | 0.5 | creating the two sub-accounts, escrow USDC registration (0.00125), `refresh_token_storage`, later upgrade proposals and their code-growth deposits |
| `escrow.<owner>.near` (escrow) | nobody once deployed: its only key is deleted right after `new` | 3.5 | its own storage, locked for as long as it lives: code + state = 318,486 B = 3.19 NEAR on testnet 1112; deploy gas ≈ 0.003 |
| `relayer.<owner>.near` (relayer) | the relayer Worker (claim-only key R); its full-access key only in the owner's local key store | 1.0 | gas for every claim: ≈ 11.6 Tgas = 0.0012 NEAR, so about 800 claims |
| `<guardian>.near` (guardian) | a **different person**, in a different wallet; never on the deploy host | 0.1 | gas for a cancel or a freeze, if ever needed |

The escrow and the relayer are funded from the owner's account when we create them, so the owner
funds `<owner>.near` with about 5.0 NEAR and the guardian with 0.1 NEAR.

**What the owner does**

1. In a wallet (e.g. Meteor or MyNearWallet), have `<owner>.near` with about 5.0 NEAR (5.2 with
   the demo prepay) and, for the demo, ≥ 3 mainnet USDC.
2. A second person creates `<guardian>.near` in their own wallet, funds it with 0.1 NEAR, and
   sends us only the account name.
3. On **your own machine** (never on the deploy host): install near-cli-rs and keep the owner key in the local
   key store (`near account import-account` → `using-seed-phrase` → mainnet → `save-to-keychain`), or use a
   hardware wallet. Make the backup verifier key S2 (the one-liner under the runbook table) and send its public key.
4. Tell us the account names and S2. We send you an owner kit; run it on your machine (step 3 above) and tell
   us when it prints "done". We check the result from the deploy host without any key (step 3b).

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
- The owner key was never on the deploy host. Upgrades, settings, owner and key changes are signed on
  the owner's machine, off the deploy host. The deploy host holds only S (the verifier's signing seed) and R (can only call `claim`).
- **Residual, accepted with Mode W:** S on the deploy host (and in the verifier Worker) can still move funds
  through forged claims. `claim` pays any destination that carries a valid S signature, so whoever holds S
  can claim every unclaimed allocation of every live campaign to their own account, given the claim links
  or the leaf data. The guardian and the upgrade watcher cannot stop that; only `remove_agent(S)` from the
  owner's machine does, after which live campaigns continue on S2.

## Posture

- **No full-access key on the escrow** (`LOCK_CONTRACT=1` is mandatory on mainnet; the script
  refuses to start without it). Code then changes only through `propose_upgrade` →
  `upgrade_delay_ns` → `apply_upgrade`, and ownership only through `propose_owner` → delay →
  `accept_owner`.
- `upgrade_delay_ns` = 1 h (the contract allows 10 min .. 1 h on mainnet). One hour protects
  only if someone watches `watch()` and cancels a bad proposal in time.
- A **guardian** (`GUARDIAN_ID`) can cancel, freeze proposals for 7 days, and drop an owner key
  that is not active yet; it can never propose, apply, add keys or move funds. **Mandatory:**
  `deploy.sh` refuses mainnet without `GUARDIAN_ID`. The upgrade watcher (`watcher/`) alerts within
  2 min, and the guardian is the one who can act on a stolen owner key.
- Two verifier keys at `new`: S (hot, on the Worker) and S2 (seed kept offline by the owner), so a
  leaked S can be removed without freezing live campaigns.
- Owner keys added after `new` wait the same delay; the verifier key is an `initial_signers`
  entry, active at once.
- `resolve_delay_ns` = 1 h; `min_lifetime_ns` = 30 days.

## Command block

The joint runbook above, steps 2, 3 and 3b. The deploy host never signs on mainnet: `deploy.sh` always
writes the owner kit there (`OWNER_ON_MAC` is forced) and refuses to start without `LOCK_CONTRACT=1`,
`GUARDIAN_ID`, `SIGNER_PUBKEY`, `BACKUP_SIGNER_PUBKEY`, `RELAYER_ID` and the relayer key file; with a
`USDC_ID` other than Circle's mainnet contract; with accounts not ending in `.near`; or with the public
test keys from `spec/vectors.json`. `VERIFY_ONLY=1` exits 1 unless every check passes.

The rehearsal on testnet is the same command with `NETWORK=testnet OWNER_ON_MAC=1` and `.testnet` accounts.

## Before running

- [ ] Owner: the checklist above: `<owner>.near` with ≈ 5.0 NEAR, `<guardian>.near` with 0.1 NEAR.
- [ ] Owner: decide the guardian account (a different key holder than the owner; the script
      refuses `GUARDIAN_ID` = `OWNER_ID` and refuses mainnet without one).
- [ ] Owner: the backup verifier key S2 made offline; only its public key sent.
- [ ] No `~/.near-credentials/mainnet/` on the deploy host (`ls` shows nothing).
- [ ] The README trust statement matches this posture (owner single key or multisig; guardian set
      or not; builds not reproducible yet).
- [ ] Dry run first: the same command with `DRY_RUN=1`; read the `new()` args in the kit.
