# Mainnet hosting (prepared, not deployed)

The three Workers for mainnet are configured but not deployed. Once the owner approves a mainnet
escrow and the steps below are done, one command deploys them:
`scripts/deploy-mainnet-hosting.sh`.

| Worker | URL |
| --- | --- |
| `zarf-near-claim` (claim and send app) | https://zarf-near-claim.sparkling-queen-5e77.workers.dev |
| `zarf-near-verifier` | https://zarf-near-verifier.sparkling-queen-5e77.workers.dev |
| `zarf-near-relayer` | https://zarf-near-relayer.sparkling-queen-5e77.workers.dev |

The Cloudflare account is the same as for testnet. `env.mainnet` in each `wrangler.jsonc` sets
`name` explicitly, so the workers carry no `-mainnet` suffix. NEAR RPC is
`https://free.rpc.fastnear.com`. The token is Circle USDC on NEAR,
`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`. Every empty value in
`env.mainnet` fails closed: the verifier and relayer return `*_MISCONFIGURED`, and the pages say the
site is not set up.

## What needs the contract id (and cannot be done before it)

- `CONTRACT_ID` in all three `env.mainnet` blocks (`PUBLIC_CONTRACT_ID` in web).
- The relayer's function-call key: its `receiver_id` is the contract.
- `add_owner_key(<verifier signer>)` on the contract (owner).
- Checking that the contract's `get_config().token_ids` includes mainnet USDC and that
  `get_network()` is `mainnet`. The claim page reads `get_network()` to switch on the
  cross-chain step.

Two more inputs are not tied to the contract, but the deploy needs them too:

- a funded mainnet relayer account (`RELAYER_ACCOUNT_ID`);
- the Google OAuth client id, with `https://zarf-near-claim.sparkling-queen-5e77.workers.dev` as
  a JavaScript origin and `…/auth/google` as a redirect URI.

Everything else is ready now.

## Steps

1. **Escrow (owner, `scripts/deploy.sh`).** Deploy with `network: mainnet`, an upgrade delay of
   1 h and no full-access key left on the escrow account. Note the contract id.
2. **Fresh keys, at deploy time, on the deploy host:**
   ```bash
   node scripts/mainnet-keys.mjs
   ```
   It writes `mainnet-verifier.seed` and `mainnet-relayer.key` (mode 600) in the deploy host's
   secrets directory and never overwrites them. It prints only the verifier signer (hex) and the relayer
   public key. They are never the testnet or spec keys, and the contract refuses test keys on
   mainnet anyway.
3. **On chain: done by `scripts/deploy.sh`** (the escrow runbook, `docs/deploy/mainnet.md`).
   Run it with `SIGNER_PUBKEY=<signer from step 2>`. Its `new` registers that signer as the initial
   signer, so it is active at once with no `add_owner_key` and no 1 h wait. It also adds the
   relayer's claim-only key from `mainnet-relayer.key`. Run `mainnet-keys.mjs` **before**
   `deploy.sh`, even before its dry run: `deploy.sh` creates the two files if they are missing, and
   `mainnet-keys.mjs` then refuses to overwrite them. Check that the relayer public key `deploy.sh`
   prints equals the one `mainnet-keys.mjs` printed.
4. **Fill `env.mainnet`** and commit:
   - verifier: `CONTRACT_ID`, `GOOGLE_CLIENT_ID`;
   - relayer: `CONTRACT_ID`, `RELAYER_ACCOUNT_ID`, `VERIFIER_SIGNERS` (the signer from step 2);
   - web: `PUBLIC_CONTRACT_ID`, `PUBLIC_GOOGLE_CLIENT_ID`.

   `CLAIM_ORIGINS` is already the mainnet origin only.
5. **Deploy:**
   ```bash
   scripts/deploy-mainnet-hosting.sh
   ```
   It stops on any of these:
   - a dirty tree;
   - missing key files;
   - an unfilled or inconsistent `env.mainnet` (the contract id must match across all three, and
     the two Google client ids must be equal);
   - a `VERIFIER_SIGNERS` that does not contain the seed file's signer;
   - a Cloudflare token that does not see the account.

   Otherwise it pipes the two secrets into `wrangler secret put … --env mainnet` (never printed),
   deploys the verifier, the relayer and the web, then curls both `/health` endpoints.
6. **Smoke.** Expected results:
   - verifier `/health`: `contract_id` = the contract, `signer` = step 2, `google_client_id_set: true`;
   - relayer `/health`: `contract_id` = the contract, `claim_only: true`, a balance for gas;
   - `/`, `/create`, `/privacy`: `200`;
   - an unknown campaign link shows "does not exist";
   - "USDC on another chain" lists Base, Arbitrum and Ethereum (not "mainnet only").

   Then open one real claim link in a browser at 390 px.

## Rollback

The Workers hold no funds. `npx wrangler rollback --env mainnet` (per worker) returns to the
previous version. Emptying a `CONTRACT_ID` and redeploying takes the site offline in a fail-closed
way. On-chain state is unaffected: unclaimed funds stay in the escrow and the sender reclaims them
after the deadline.
