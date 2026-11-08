# Testnet deployment

Public data only. Keys live on the deploy host in mode-600 local key stores, never in this repo.

## Accounts (created 2026-11-11 via the testnet faucet)

| Role | Account | Create tx |
| --- | --- | --- |
| Escrow contract | `zarf-near-1111.testnet` | `4d3iEWrRWFzwwD34oB3qv6piHYhgJKdvPZ1KGfmWzoNK` |
| Owner | `zarf-near-owner-1111.testnet` | `DQq2sZKJzvDVSMxHmn7J2dtLKtT5UakMXu1U6g2vw5Qx` |
| Relayer (claim-only key) | `zarf-near-relayer-1111.testnet` | `3JHXRbPG4A6toUVKMBLnR1kwwsXHyTquozwnm7fvYo5d` |
| Sender (funded with test USDC by the owner) | `zarf-near-sender-1111.testnet` | `FcjSH7apbGZ4V5zYSoFsbSFkVBtsE2WdJLzAk1xeHpy9` |

Token: Circle testnet USDC `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`
(verified on chain, see `docs/spikes/S1.md`).

## Deploy (2026-11-11)

```bash
CONTRACT_ID=zarf-near-1111.testnet OWNER_ID=zarf-near-owner-1111.testnet \
RELAYER_ID=zarf-near-relayer-1111.testnet scripts/deploy-testnet.sh
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

## Trust: this contract is upgradeable

**This testnet contract is upgradeable by the deployer's full-access key.** Whoever holds that
key can redeploy the code and move every escrowed token. It is kept on purpose on testnet, where
we may still redeploy. `scripts/deploy-testnet.sh` has an opt-in `LOCK_CONTRACT=1` final step that
deletes every full-access key and verifies none remains; it was **not** run here. Whether mainnet
is made immutable is the owner's decision.

`view_access_key_list(zarf-near-1111.testnet)`, 2026-11-11:

| Public key | Permission |
| --- | --- |
| `ed25519:2ow2PJ1iYhtP4gqKtexdqgDpQkC7Q7VxrJXr8XDmNDZE` | FullAccess |

## Views after deploy (block ~277206411)

```text
get_config:         {"network":"testnet","min_lifetime_ns":"600000000000","agent_ttl_ns":"604800000000000","resolve_delay_ns":"3600000000000","token_ids":["3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af"],"storage_byte_cost":"10000000000000000000"}
storage_costs:      {"ft_storage_deposit":"1250000000000000000000","claim_entry_cost":"1060000000000000000000","per_claim_storage":"2310000000000000000000","campaign_bytes_cost":"7090000000000000000000"}
get_agent(signer):  {"kind":"owner","valid_until_ns":"1799578835000000000"}
required_claim_gas: "55000000000000"
```

`ft_storage_deposit` = 0.00125 NEAR, read from the token on chain (matches S1).

## Open

- First real claim with Circle USDC (reviewer m2): record `total_gas_burnt` and per-receipt gas,
  and confirm it passes at exactly 55 Tgas. Needs the sender funded with test USDC (owner).
