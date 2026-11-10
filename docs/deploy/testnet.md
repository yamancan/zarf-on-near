# Testnet deployment

Public data only. Keys live on the deploy host, mode 600, never in this repo.

## Live system: `zarf-near-1112.testnet`

| Part | Where |
| --- | --- |
| Escrow contract | [`zarf-near-1112.testnet`](https://testnet.nearblocks.io/address/zarf-near-1112.testnet): no access keys at all (`view_access_key_list` is empty), code hash `5GdxDSB4sGW9Ewod4Q4Na613C2sLQjVfFjLbbZbKt6N8` |
| Config (`get_config`) | `upgrade_delay_ns` 600 s, `resolve_delay_ns` 1 h, `min_lifetime_ns` 600 s, token Circle testnet USDC |
| Verifier signer (Mode W owner key) | `2d10ebec1ec795cef82b8d357cc60d39d9119b99908741660b632fc5cf0d4e32` |
| Relayer | `zarf-near-relayer-1111.testnet`, function-call key `ed25519:69m6cJwr6KqXhLr58BAUKoTWbtX1oMPtf5daiUbgQ9mm`: receiver `zarf-near-1112.testnet`, methods `["claim"]` |
| Claim and send app | https://zarf-near-claim-testnet.sparkling-queen-5e77.workers.dev |
| Judges' page (1 test USDC to a Gmail) | https://zarf-near-faucet-testnet.sparkling-queen-5e77.workers.dev/try |
| Verifier | https://zarf-near-verifier-testnet.sparkling-queen-5e77.workers.dev (`GET /health`) |
| Relayer | https://zarf-near-relayer-testnet.sparkling-queen-5e77.workers.dev (`GET /health`) |
| NEAR RPC | https://test.rpc.fastnear.com |

The three Workers are deployed with `wrangler deploy --env testnet` from the committed release head. Secrets go in with `wrangler secret put`, piped from files on the deploy host;
their values are never printed or stored in the repo.

| Service | Version | From |
| --- | --- | --- |
| Web (create + claim) | `af1880dc` | `243ba1a` |
| Verifier | `6c6b4286` | `243ba1a` |
| Relayer | `eab5f60f-03e4-4ed4-9fc5-daf51d9561e5` | `29327b7` (unchanged since) |

Smoke against the public URLs:

| Check | Result |
| --- | --- |
| verifier `GET /health` | `{"contract_id":"zarf-near-1112.testnet","signer":"2d10ebec…4e32","google_client_id_set":false}` |
| relayer `GET /health` | `{"contract_id":"zarf-near-1112.testnet","allowance":null,"balance":"9997401738950342600000000","claim_only":true}` |
| verifier, 40 requests over one connection | 21 × `200`, then 19 × `429 {"error":"RATE_LIMITED"}` (the limit is approximate and per machine) |
| verifier `POST /claim` with a 20 KB body | `413 {"error":"TOO_LARGE"}` |
| CORS preflight from `http://localhost:5173` / the web origin | no `access-control-allow-origin` / the web origin |
| `/`, `/campaigns`, `/create`, `/privacy` | `200` |
| `/claim/999999/…` with a valid fragment (headless Chromium) | "This campaign does not exist", no form, no console errors |
| a spec vector link on campaign 0 | "This claim link does not match" (`LINK_MISMATCH`), no form |
| a missing or damaged fragment | "This claim link is incomplete", no form |
| claim form (RPC stubbed to a valid link) | Stellar and `0x` input refused; a missing named account blocks; "Account found" enables sign-in; "USDC on another chain" lists Base, Arbitrum, Ethereum as "mainnet only" |

Google sign-in stays off until the owner creates the OAuth client. Then add
`https://zarf-near-claim-testnet.sparkling-queen-5e77.workers.dev` as a JavaScript origin and
`…/auth/google` as a redirect URI, set `GOOGLE_CLIENT_ID` (verifier) and `PUBLIC_GOOGLE_CLIENT_ID`
(web) in the testnet env, and redeploy both.

## History: first deploy, `zarf-near-1111.testnet`

The first escrow, superseded by 1112 (new config, same verifier signer, new relayer key). Kept for
its transaction record.

### Accounts (created 2026-11-11 via the testnet faucet)

| Role | Account | Create tx |
| --- | --- | --- |
| Escrow contract | `zarf-near-1111.testnet` | `4d3iEWrRWFzwwD34oB3qv6piHYhgJKdvPZ1KGfmWzoNK` |
| Owner | `zarf-near-owner-1111.testnet` | `DQq2sZKJzvDVSMxHmn7J2dtLKtT5UakMXu1U6g2vw5Qx` |
| Relayer (claim-only key) | `zarf-near-relayer-1111.testnet` | `3JHXRbPG4A6toUVKMBLnR1kwwsXHyTquozwnm7fvYo5d` |
| Sender (funded with test USDC by the owner) | `zarf-near-sender-1111.testnet` | `FcjSH7apbGZ4V5zYSoFsbSFkVBtsE2WdJLzAk1xeHpy9` |

Token: Circle testnet USDC `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`
(verified on chain, see `docs/spikes/S1.md`).

### Deploy (2026-11-11)

```bash
CONTRACT_ID=zarf-near-1111.testnet OWNER_ID=zarf-near-owner-1111.testnet \
RELAYER_ID=zarf-near-relayer-1111.testnet scripts/deploy-testnet.sh   # since renamed scripts/deploy.sh
```

Built from revision `48cda04` (contract code = revision `5342b35`), Rust 1.86.0,
cargo-near 0.23.0, `cargo near build non-reproducible-wasm --no-abi`.

| Step | Transaction |
| --- | --- |
| deploy + `new` (one transaction) | `AgWzntX4mtvT6JUVLYcA3qk7MJZuM1VPP9F94nwheeYZ` |
| `refresh_token_storage` (owner) | `Bnk4kCygSeYtTZ7MB9aLTwRuSY6a3FAFxezhY1udxGWp` |
| `add_owner_key` (owner) | `Fs8qxfY8WBf4WkmFfPk39DLc3P6SDGh8ESWwKUyRcjcU` |
| relayer claim-only key | `5FtyojtzFy79dX5XJpn8ehHoYdx9XTaaXTuKQpy3Lr4g` |

- Code hash on chain: `8PGsest9Y4DRnZyC2CKd11tdmkoFzb4PRThPXXP7BSSu`, equal to the base58 sha256 of the
  local `contract/target/near/release/zarf_near.wasm` (hex `6db688c8…bec292`).
- Verifier signer (Mode W owner key, testnet only): `2d10ebec1ec795cef82b8d357cc60d39d9119b99908741660b632fc5cf0d4e32`.
- Relayer function-call key: `ed25519:28QjUwJb6imTpgR2UHM4ijYNe7F6gaczoX6qBKLTwk9k`, receiver
  `zarf-near-1111.testnet`, methods `["claim"]`, allowance unlimited.

### Views after deploy (block ~277206411)

```text
get_config:         {"network":"testnet","min_lifetime_ns":"600000000000","agent_ttl_ns":"604800000000000","resolve_delay_ns":"3600000000000","token_ids":["3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af"],"storage_byte_cost":"10000000000000000000"}
storage_costs:      {"ft_storage_deposit":"1250000000000000000000","claim_entry_cost":"1060000000000000000000","per_claim_storage":"2310000000000000000000","campaign_bytes_cost":"7090000000000000000000"}
get_agent(signer):  {"kind":"owner","valid_until_ns":"1799578835000000000"}
required_claim_gas: "55000000000000"
```

`ft_storage_deposit` = 0.00125 NEAR, read from the token on chain (matches S1).

### Open

- First real claim with Circle USDC (reviewer m2): record `total_gas_burnt` and per-receipt gas,
  and confirm it passes at exactly 55 Tgas. Needs the sender funded with test USDC (owner).

### Local smoke (2026-11-11, `t8d-testnet-local`)

The verifier, relayer and apps run locally against the live testnet contract. Nothing is deployed
to Cloudflare; there is no domain and no Google client yet.

```bash
scripts/testnet-dev-vars.sh     # writes gitignored, mode-600 .dev.vars.testnet from ~/.config/zarf-near/
(cd verifier && npx wrangler dev --env testnet --port 8787 --inspector-port 9341)
(cd relayer  && npx wrangler dev --env testnet --port 8788)
(cd web && pnpm build && npx wrangler dev --env testnet --port 5173 --inspector-port 9342)
```

`scripts/testnet-dev-vars.sh` prints only the public signer derived from the seed:
`2d10ebec1ec795cef82b8d357cc60d39d9119b99908741660b632fc5cf0d4e32`, equal to the key registered with
`add_owner_key` above.

| Check | Result |
| --- | --- |
| relayer `GET /health` | `{"allowance":null,"balance":"9999957942264602800000000","claim_only":true}`: the key is claim-only for the contract, allowance unlimited, ~9.99996 NEAR for gas |
| verifier chain reader: `get_network` | `"testnet"` |
| verifier chain reader: `get_agent(2d10ebec…)` | `{"kind":"owner","valid_until_ns":"1799578835000000000"}`: registered, valid until 2027-01-10T11:00:35Z |
| verifier chain reader: `get_campaign(999999)`, `get_agent(<foreign key>)` | `null`, `null` |
| verifier `POST /claim` with no Google client configured | `500 {"error":"VERIFIER_MISCONFIGURED"}`: fails closed |
| verifier CORS preflight from `http://localhost:5173` | `204`, `Access-Control-Allow-Origin: http://localhost:5173` |
| claim page `/claim/999999/…#s=…` | one `get_campaign` call to testnet; shows "Claim before: this campaign does not exist" |
| `/create` | one `get_config` call; the USDC token is accepted, the deadline defaults to now + 7 d, Connect is enabled; no errors |
| `storage_costs(USDC)` (read by `/create` at funding time) | `{"ft_storage_deposit":"1250000000000000000000","claim_entry_cost":"1060000000000000000000","per_claim_storage":"2310000000000000000000","campaign_bytes_cost":"7090000000000000000000"}` |
| `campaigns_of(zarf-near-sender-1111.testnet)` | `[]` (no campaign yet) |
| `required_claim_gas` | `"55000000000000"` |

Note: the relayer's `GET /health` shares the per-IP limit (10 per minute); poll a different route
to wait for the server.

### Enabling Google sign-in (owner)

Once the owner creates the OAuth web client (docs/spikes/S4.md; `http://localhost` and
`http://localhost:5173` as JavaScript origins and `http://localhost:5173/auth/google` as redirect
URI are enough for a first real claim), set the client id in the two testnet envs:

- `verifier/wrangler.jsonc`, `env.testnet.vars`: `"GOOGLE_CLIENT_ID": "<client id>.apps.googleusercontent.com"`
- `web/wrangler.jsonc`, `env.testnet.vars`: `"PUBLIC_GOOGLE_CLIENT_ID": "<client id>.apps.googleusercontent.com"`

The client id is public. A real claim then also needs a funded campaign from the sender account
and the recipient's claim link (it carries the salt, amount and Merkle proof; nothing else is hosted).
