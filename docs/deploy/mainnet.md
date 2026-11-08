# Mainnet deployment (planned, not run)

Public data only. Nothing here has been executed. The owner provides the mainnet accounts.

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
CONTRACT_ID=<escrow>.near OWNER_ID=<owner>.near RELAYER_ID=<relayer>.near \
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
- The script refuses: no `LOCK_CONTRACT=1`; a `USDC_ID` other than Circle's mainnet contract;
  accounts not ending in `.near`; the public test keys from `spec/vectors.json`.
- The script prints `view get_config` at the end. Expect `network` = `mainnet`,
  `upgrade_delay_ns` = `3600000000000`, `guardian_id` = the guardian, and the line "contract has
  no full-access key" (it exits 70 if one remains).

## Before running

- [ ] Owner: the four mainnet accounts, funded. The escrow needs ≈ 3.2 NEAR (code + state + gas).
- [ ] Owner: decide the guardian account (a different key holder than the owner; the script
      refuses `GUARDIAN_ID` = `OWNER_ID`).
- [ ] The README trust statement matches this posture (owner single key or multisig; guardian set
      or not; builds not reproducible yet).
- [ ] Dry run first: the same command with `DRY_RUN=1`.
