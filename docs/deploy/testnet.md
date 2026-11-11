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

## zarf-near-1112.testnet record: deploy, lock, two upgrades, evidence (2026-11-11/12)

The mainnet posture on testnet: **no full-access key**. Code changes only through
`propose_upgrade` → `upgrade_delay_ns` (10 min here) → `apply_upgrade`. `zarf-near-1111.testnet`
below predates the upgrade code and keeps its full-access key.

Built from the reviewed revision (Rust 1.86.0, cargo-near 0.23.0, `non-reproducible-wasm --no-abi`).

```bash
CREATE_ACCOUNTS=1 LOCK_CONTRACT=1 UPGRADE_DELAY_NS=600000000000 \
CONTRACT_ID=zarf-near-1112.testnet OWNER_ID=zarf-near-owner-1111.testnet \
RELAYER_ID=zarf-near-relayer-1111.testnet \
RELAYER_KEY_FILE=<relayer-key-file> \
scripts/deploy.sh
```

| Step | Transaction |
| --- | --- |
| create `zarf-near-1112.testnet` (faucet) | `3gmxoRk8keTzLzYJd2zoMmBxjDxQdUEWyw1XyyHBt8cv` |
| deploy + `new` (one transaction; initial signer = testnet verifier key) | `F7qfDSVT83Jkw9RgHaY7v9MUdN2XQ7fAxytZkxqQQXeD` |
| **lock: delete the only full-access key** | `7Qpr4hSe5PpMvaa6XhVuqMBsuhdvxhrhBaLhnURUC9Xj` |
| register the escrow on USDC (owner pays 0.00125 NEAR) | `7vd7oAohg7mbjhPwup9ibzaAU4KhD1wPKTDB2s87rTxD` |
| `refresh_token_storage` (owner) | `4V48Ap7QtWjyHDCMA978kvzEbwWpijtz1LmnCZDoe6co` |
| relayer claim-only key `ed25519:69m6cJwr6KqXhLr58BAUKoTWbtX1oMPtf5daiUbgQ9mm` | `GN84N2JCuzi8XrLWupsABwKes79Ho7dUpP7JFkpN8Sgw` |

After deploy: `view_access_key_list(zarf-near-1112.testnet)` = `[]`; code hash
`J1HmKYYY1WXNH2Q4Ye3GnJYki7omF8CUZAL2iHyb4zjD` = base58 sha256 of the local release wasm (316,376 B);
`contract_source_metadata.version` = `0.1.0`; `get_config.upgrade_delay_ns` = `600000000000`,
`guardian_id` = `null`.

### The upgrade

v2 = the same source with only `version` in `contract/Cargo.toml` bumped 0.1.0 → 0.1.1, built in a
throwaway worktree (not committed): 316,376 B, sha256 `e1438712…2a7036`, so no storage deposit.

| Step | Transaction | Result |
| --- | --- | --- |
| `propose_upgrade` (owner), source for 0.1.0 -> 0.1.1 | `BCbYmYST3c6zhVXVGtZZrkAvBg8JymCawnR4VkV56uyi` | `upgrade_proposed`, `ready_at_ns` 1794406398030794170 |
| `apply_upgrade` before `ready_at_ns` | `ALtDLJMMJK43P5gLJYHHxQxoyiGsvRKRa27xs8xicXy8` | refused, `E107_UNAUTHORIZED` |
| campaign 0 created under v1 (3 × 1 USDC; prepay `CJbXmMgsEQVPnEWoR7eiVk3DMKtXsv4t8TVakGEcZgcY`) | `DhNZapacaAQqwfR7Eghpvx6XSCfjshZPMtSkHCQk6zS1` | `campaign_created` |
| `apply_upgrade` after `ready_at_ns` (raw wasm via `file-args`, 300 Tgas) | `32iwv98Te8d6oSqECSbbGXDXYa9FNfJ3FucT49TjK5mu` | `upgrade_applied` |

Apply gas: `apply_upgrade` 16.35 Tgas; deploy + `migrate` (one batch) 22.15; `on_upgrade` 1.66;
total 56.23 Tgas.

After: code hash `GALTKUjiwqfbxkrwUtY7qwyryZJHk6FwrCYdQ5yGzfC9` = base58(sha256(v2));
`contract_source_metadata.version` = `0.1.1`; `watch().pending_upgrade` = null; campaign 0 unchanged
(amount and balance 3000000, in_flight 0).

### Evidence claim on 0.1.1 (contract-level test, as in the 1111 record below)

Leaf 0 of campaign 0 → fresh, unregistered `zarf-near-dest-1112.testnet`
(created `CF7Pa5Vgf1pamG6FPXVcNtfcuunMSdYwvf6Y5Kn8dKhJ`), signed locally with the testnet
verifier seed, sent by the relayer's claim-only key with exactly 55 Tgas.

| Transaction | Result | Gas |
| --- | --- | --- |
| `BLjpF12EbZp77Xz8Wh6cqL1jnriM59MBccc62yE9tQMB` | `claim_paid`; `claim_state` = claimed; destination USDC 1000000 | claim 3.91, storage_deposit 2.04, ft_transfer 2.30, on_claim 2.14; total 11.62 Tgas |
| `FdUxYG5zYeNRPrAZPNEbpe7JxEq9AUesUkyD2zNietT2` (same commitment again) | refused, `E105_ALREADY_CLAIMED` | |

Campaign 0: merkle root `b16f95d49f920d41fbdffae49d1bb3929b2131f400ae7a34e48e8d428e8d3ad2`,
3 leaves of 1000000 (1 USDC) each. The leaf list is not published; it stays in the sender's
recovery file. Leaves 1 and 2 were made from placeholder emails, not Google accounts, so a
real login cannot claim them.

Sender USDC after: 14000000 (14 USDC).

### Second upgrade: 0.1.2 from a committed tree, NEP-330 link (2026-11-11)

The 0.1.1 above was built from an uncommitted tree, so no commit matched the live code, and
`contract_source_metadata.link` was null. 0.1.2 adds `repository` to `contract/Cargo.toml` (near-sdk
reads it as the NEP-330 `link`) and was built from a clean, pushed revision
(Rust 1.86.0, cargo-near 0.23.0, `cargo near build non-reproducible-wasm --no-abi`; unit tests
71/71). Wasm 316,408 B, sha256 `3f703dd7808b25b990dd8623f3603b47a5325ec139e5186344da00f308493bd5`
(base58 `5GdxDSB4sGW9Ewod4Q4Na613C2sLQjVfFjLbbZbKt6N8`). The code grew 32 B, so `apply_upgrade`
attached 0.0005 NEAR (0.00032 needed).

| Step | Transaction | Result |
| --- | --- | --- |
| `propose_upgrade` (owner), source revision (contract 0.1.2) | `649HPzKsSL2vkwv6yczQafnvu1Xtvxobm38eNgy5E4EF` | `upgrade_proposed`, `ready_at_ns` 1794435752196081943 |
| `apply_upgrade` after `ready_at_ns` (raw wasm via `file-args`, 300 Tgas, 0.0005 NEAR) | `CqM6U1reRwHUkKxhbELny2WgVvJEbz3SLT5Fy656dCfP` | `upgrade_applied` |

Apply gas: `apply_upgrade` 16.35 Tgas; deploy + `migrate` 22.15; `on_upgrade` 1.66.

After: code hash `5GdxDSB4sGW9Ewod4Q4Na613C2sLQjVfFjLbbZbKt6N8`; `view_access_key_list` = `[]`;
`pending_upgrade` = null; `get_config` unchanged (testnet, `upgrade_delay_ns` 600000000000,
`guardian_id` null, Circle testnet USDC); campaign 0 unchanged (balance 2000000, in_flight 0);
`contract_source_metadata` =
`{"version":"0.1.2","link":"https://github.com/yamancan/zarf-on-near","standards":[{"standard":"nep330","version":"1.3.0"}],"build_info":null}`.
`build_info` stays null: near-sdk fills it only for reproducible builds (cargo-near
`reproducible-wasm`, Docker), not for `non-reproducible-wasm`.

### Resume path on the live escrow: `SKIP_DEPLOY=1` (2026-11-11)

A real-chain check of the post-deploy steps that a failed mainnet run would repeat, run from
revision `1af355f` against the locked escrow, with the same env as its deploy:

```bash
SKIP_DEPLOY=1 LOCK_CONTRACT=1 CONTRACT_ID=zarf-near-1112.testnet OWNER_ID=zarf-near-owner-1111.testnet \
RELAYER_ID=zarf-near-relayer-1111.testnet \
RELAYER_KEY_FILE=<relayer-key-file> scripts/deploy.sh
```

| Step | Transaction | Result |
| --- | --- | --- |
| lock | none | no full-access key found, nothing to delete; verified |
| USDC `storage_deposit` (registration_only, owner) | `7AvhCmgos1f274cd6g3wXoAeASqNREzifugjAnA5Vnu4` | "The account is already registered, refunding the deposit": 0.00125 NEAR back to the owner; 3.18 Tgas |
| `refresh_token_storage` (owner) | `H13A8SscYqpHh6TB9ARC5EhbZppXx5V7rsms9F65HJkS` | success, no state change; 6.34 Tgas |
| relayer claim-only key | none | "relayer key already present (resumed run)" (`ed25519:69m6cJwr…`) |

Exit 0. Before and after, byte-identical: `view_access_key_list` = `[]`; `get_config`;
`contract_source_metadata` (0.1.2); campaign 0 (balance 2000000, in_flight 0) and campaign 1
(balance 1000000, in_flight 0); the escrow's USDC balance 3000000.

### Evidence on 0.1.2, the code that goes to mainnet (2026-11-12)

The claims above ran on 0.1.1. These ran on 0.1.2 (code hash `5GdxDSB4…`), contract-level as
before: signed locally with the testnet verifier seed, sent by the relayer's claim-only key with
exactly `required_claim_gas` = 55 Tgas, campaign 0. Leaves 1 and 2 were built from placeholder
emails (`@example.com`), so no Google login could ever claim them. Destination: fresh, unregistered
`zarf-near-dest3-1112.testnet` (created `FSju7xPHvzxP8bLyQuvC5d6HYhuUw1wGjs1gqBc1C1K6`,
`storage_balance_of` = null before).

| Claim | Transaction | Result | Gas burnt (Tgas) |
| --- | --- | --- | --- |
| leaf 1 → `zarf-near-dest3-1112.testnet` | `Cmi5X9XyiQjSfhJDahWz6TvZKSjkVX5MKjFqAYS7m7Zt` | `claim_started`, `ft_transfer` 1000000, `claim_paid` | tx 0.335; `claim` 3.920; `storage_deposit` 2.039; `ft_transfer` 2.299; `on_claim` 2.150; 4 refunds × 0.223; **total 11.64** |
| leaf 1 again (same commitment) | `FLmmkbCQckFQWK9CEKxmxrtMrf2XLB28qR2guPnk6RFL` | refused, `E105_ALREADY_CLAIMED` | total 2.14 |
| leaf 2 with amount 2000000 instead of 1000000 (signed over the wrong amount) | `7FcwE5qrzgKMtgHdgbgNHFSQ1MDRvFdhytgg941KhBPp` | refused, `E102_INVALID_MERKLE_PROOF` (check 7, before the signature) | total 2.16 |
| leaf 2, correct amount, one signature nibble flipped | `FFqKA2ZfHxAGBc9md2WmTRG9kUzDVPH3JT4Abnp2dkdd` | refused, `E101_INVALID_SIGNATURE` | total 2.49 |

After: `view_access_key_list` = `[]`; `get_config` unchanged; `claim_state` leaf 1 = claimed, leaf 2
= unclaimed; campaign 0 balance 1000000 (was 2000000), in_flight 0, storage_reserved 0.00231 NEAR (one
claim left); campaign 1 (faucet) unchanged at 1000000; escrow USDC 2000000 = the sum of both
campaigns; destination USDC 1000000.

### Check it yourself by RPC (no explorer needed)

nearblocks answers non-browser requests with 403. These lines ask FastNEAR's public testnet RPC
directly (`curl` and `jq`); each expected output is the line under it.

The 0.1.2 claim paid out (`Cmi5X9Xy…`):

```bash
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":"Cmi5X9XyiQjSfhJDahWz6TvZKSjkVX5MKjFqAYS7m7Zt","sender_account_id":"zarf-near-relayer-1111.testnet","wait_until":"FINAL"}}' | jq -c '[.result.receipts_outcome[].outcome.logs[] | select(test("claim_paid")) | ltrimstr("EVENT_JSON:") | fromjson | .data[0] | {campaign_id, amount, destination}]'
# [{"campaign_id":"0","amount":"1000000","destination":"zarf-near-dest3-1112.testnet"}]
```

The same claim again was refused (`FLmmkbCQ…`):

```bash
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":"FLmmkbCQckFQWK9CEKxmxrtMrf2XLB28qR2guPnk6RFL","sender_account_id":"zarf-near-relayer-1111.testnet","wait_until":"FINAL"}}' | jq -c '.result.status.Failure.ActionError.kind.FunctionCallError.ExecutionError'
# "Smart contract panicked: E105_ALREADY_CLAIMED"
```

The contract's view agrees (`claim_state` of that commitment; the args are base64 of
`{"campaign_id":"0","commitment":"80a0163b…f2d48a"}`):

```bash
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"zarf-near-1112.testnet","method_name":"claim_state","args_base64":"eyJjYW1wYWlnbl9pZCI6IjAiLCJjb21taXRtZW50IjoiODBhMDE2M2JmYmIzZGE1OWNlNjY3YjZlZGE3M2QyZjM3NjY2OTQ2MmY2ZDQ4YmM5MTUyNzQ4OTg3OGYyZDQ4YSJ9"}}' | jq -r '.result.result | implode'
# "claimed"
```

Nobody holds a key to the escrow, and its code is 0.1.2:

```bash
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"zarf-near-1112.testnet"}}' | jq -c '.result.keys'
# []
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_code","finality":"final","account_id":"zarf-near-1112.testnet"}}' | jq -r '.result.hash'
# 5GdxDSB4sGW9Ewod4Q4Na613C2sLQjVfFjLbbZbKt6N8
```

## History: first deploy, `zarf-near-1111.testnet`

The first escrow, superseded by 1112 (new config, same verifier signer, new relayer key). It
predates the upgrade code and keeps its full-access key. Kept for its transaction record and the
first gas measurement.

### Accounts (created 2026-11-11 via the testnet faucet)

| Role | Account | Create tx |
| --- | --- | --- |
| Escrow contract | `zarf-near-1111.testnet` | `4d3iEWrRWFzwwD34oB3qv6piHYhgJKdvPZ1KGfmWzoNK` |
| Owner | `zarf-near-owner-1111.testnet` | `DQq2sZKJzvDVSMxHmn7J2dtLKtT5UakMXu1U6g2vw5Qx` |
| Relayer (claim-only key) | `zarf-near-relayer-1111.testnet` | `3JHXRbPG4A6toUVKMBLnR1kwwsXHyTquozwnm7fvYo5d` |
| Sender (funded with test USDC by the owner) | `zarf-near-sender-1111.testnet` | `FcjSH7apbGZ4V5zYSoFsbSFkVBtsE2WdJLzAk1xeHpy9` |

Token: Circle testnet USDC `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`, the id
Circle publishes for NEAR testnet (developers.circle.com/stablecoins/usdc-contract-addresses).
Verified on chain 2026-11-10: `ft_metadata` = USDC, 6 decimals; `storage_balance_bounds` min =
max = 0.00125 NEAR per registered account (`1250000000000000000000` yocto).

### Deploy (2026-11-11)

```bash
CONTRACT_ID=zarf-near-1111.testnet OWNER_ID=zarf-near-owner-1111.testnet \
RELAYER_ID=zarf-near-relayer-1111.testnet scripts/deploy.sh   # then named deploy-testnet.sh
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

### Trust: 1111 is upgradeable by a full-access key

**This testnet contract is upgradeable by the deployer's full-access key.** Whoever holds that
key can redeploy the code and move every escrowed token. It is kept on purpose on testnet, where
we may still redeploy. `scripts/deploy.sh` has an opt-in `LOCK_CONTRACT=1` final step that
deletes every full-access key and verifies none remains; it was **not** run here. Whether mainnet
is made immutable is the owner's decision.

`view_access_key_list(zarf-near-1111.testnet)`, 2026-11-11:

| Public key | Permission |
| --- | --- |
| `ed25519:2ow2PJ1iYhtP4gqKtexdqgDpQkC7Q7VxrJXr8XDmNDZE` | FullAccess |

### Views after deploy (block ~277206411)

```text
get_config:         {"network":"testnet","min_lifetime_ns":"600000000000","agent_ttl_ns":"604800000000000","resolve_delay_ns":"3600000000000","token_ids":["3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af"],"storage_byte_cost":"10000000000000000000"}
storage_costs:      {"ft_storage_deposit":"1250000000000000000000","claim_entry_cost":"1060000000000000000000","per_claim_storage":"2310000000000000000000","campaign_bytes_cost":"7090000000000000000000"}
get_agent(signer):  {"kind":"owner","valid_until_ns":"1799578835000000000"}
required_claim_gas: "55000000000000"
```

`ft_storage_deposit` = 0.00125 NEAR, read from the token on chain (matches S1).

### First real claim: contract-level gas measurement (2026-11-11)

**This is a contract-level test, not the verifier flow.** The claim was signed locally with the
testnet verifier seed and submitted through the relayer's claim-only key. No Google login was
involved. It measures the contract against Circle's real USDC, which the sandbox can't.

Setup, from `zarf-near-sender-1111.testnet` (funded with 20 test USDC by the owner):

| Step | Transaction |
| --- | --- |
| register the escrow on USDC (`storage_deposit`, 0.00125 NEAR) | `CZJdpebFMcB6YF6wyeriyr13AxJnRLMtaVdP7EXxQ2yN` |
| `prepay_deposit` 0.02 NEAR | `47pdCeh8iJbRHVmq9iLH1ieWf2BbdzZr4M1QRZyLNC32` |
| `ft_transfer_call` 3 USDC → campaign 0 (3 leaves, 1 USDC each, deadline +1 day) | `E8WVuJ7dj4rUHaNQjYGAto5nRRQ1jDo6UvFSmKSWebzD` |
| fresh destination `zarf-near-dest-1111.testnet` (not registered on USDC) | `5M9843rKWAcptXKQZtSfJauSTfsfz7wDtXBgs4f4iWyU` |

The first `ft_transfer_call` attempt returned "Transaction has expired" from the RPC and had no
effect on chain (balances, `campaigns_of`, `campaign_by_root` unchanged), so it was sent once more.

Campaign 0: merkle root `cbad6057878de5892f1b6756e6860e0ca3438f7c07b9a0a38d4bc10775618417`,
3 leaves of 1000000 (1 USDC) each. The leaf list is not published (spec: it stays in the
sender's recovery file, with each leaf's email and salt).

#### The claim: leaf 0 → `zarf-near-dest-1111.testnet`, prepaid gas exactly 55 Tgas

Transaction `4B9wh1uKbDqM91F1pGrAXn5RqyhLotmwLzXXQFMwfg5g`: success. Events `claim_started`,
NEP-141 `ft_transfer` (escrow → destination, 1000000), `claim_paid`.

| Receipt | Executor | Gas burnt |
| --- | --- | --- |
| transaction (signer `zarf-near-relayer-1111.testnet`, function-call key) | – | 0.335 Tgas |
| `claim` | `zarf-near-1111.testnet` | 3.864 Tgas |
| `storage_deposit` (first-time registration) | Circle USDC | 2.037 Tgas |
| `ft_transfer` | Circle USDC | 2.289 Tgas |
| `on_claim` | `zarf-near-1111.testnet` | 2.093 Tgas |
| 4 gas refunds | relayer | 4 × 0.223 Tgas |
| **total** | | **11.51 Tgas** (sandbox: 10.1 Tgas) |

After: `claim_state` = `claimed`; destination USDC balance 1000000; campaign 0 balance 2000000,
in_flight 0, storage_reserved 0.00462 NEAR (two claims left).

Gas margin per receipt (static gas reserved by the contract vs burnt on chain): `claim` gets
the prepaid remainder after the three static reservations (55 − 40 = 15 Tgas) and burnt 3.864,
so **3.9×, the tightest**; `storage_deposit` 10 / 2.037 = 4.9×; `ft_transfer` 15 / 2.289 = 6.6×;
`on_claim` 15 / 2.093 = 7.2×. Over the whole claim, 55 / 11.51 = 4.8×.

#### Double claim on the same commitment

Transaction `GzLn6RuPQCn2kA7ERH1f5zWCfUHrFN4r3VmDySqJ7LEE`: refused with
`E105_ALREADY_CLAIMED`, 2.11 Tgas burnt; the destination balance stayed 1000000.

#### Not observed

A failed-path observation with Circle's contract was skipped: its `storage_deposit` registers any
valid account id, and the sandbox already covers transfer and registration failures.

#### Leaves 1 and 2

They are unclaimed, but their commitments were made from placeholder addresses
(`zarf-measure-N@example.com`), not Google accounts, so a real Google login cannot claim them.
The real Google flow needs a campaign built from the claimants' real emails.

### Local smoke against 1111 (2026-11-11)

The verifier, relayer and apps run locally against the live testnet contract. Nothing is deployed
to Cloudflare; there is no domain and no Google client yet.

```bash
scripts/testnet-dev-vars.sh     # writes gitignored, mode-600 .dev.vars.testnet from the deploy host's secrets
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

#### Enabling Google sign-in locally (owner)

Once the owner creates the OAuth web client (docs/spikes/S4.md; `http://localhost` and
`http://localhost:5173` as JavaScript origins and `http://localhost:5173/auth/google` as redirect
URI are enough for a first real claim), set the client id in the two testnet envs:

- `verifier/wrangler.jsonc`, `env.testnet.vars`: `"GOOGLE_CLIENT_ID": "<client id>.apps.googleusercontent.com"`
- `web/wrangler.jsonc`, `env.testnet.vars`: `"PUBLIC_GOOGLE_CLIENT_ID": "<client id>.apps.googleusercontent.com"`

The client id is public. A real claim then also needs a funded campaign from the sender account
and the recipient's claim link (it carries the salt, amount and Merkle proof; nothing else is hosted).
