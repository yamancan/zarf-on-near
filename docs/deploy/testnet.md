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

## First real claim: contract-level gas measurement (2026-11-11)

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

Campaign 0, public leaf list (salts and the placeholder emails stay on the deploy host):

```json
{ "campaign_id": "0", "merkle_root": "cbad6057878de5892f1b6756e6860e0ca3438f7c07b9a0a38d4bc10775618417",
  "leaves": [
    { "commitment": "cde1b853a5295983f83b8af4fea3cb1e509c6644eef9bf6aaafc79ed3b8026fb", "amount": "1000000" },
    { "commitment": "063dbafc9ab3003bdabbecc8df07b69ab188cf655004b692274b3f1f272f3356", "amount": "1000000" },
    { "commitment": "a30ff9dae7a81834c7300caedc535a3f7f8edd10049ae09f692a1c7308526fe1", "amount": "1000000" } ] }
```

### The claim: leaf 0 → `zarf-near-dest-1111.testnet`, prepaid gas exactly 55 Tgas

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
in_flight 0, storage_reserved 0.00462 NEAR (two claims left). 55 Tgas holds a 4.8× margin
over the real total.

### Double claim on the same commitment

Transaction `GzLn6RuPQCn2kA7ERH1f5zWCfUHrFN4r3VmDySqJ7LEE`: refused with
`E105_ALREADY_CLAIMED`, 2.11 Tgas burnt; the destination balance stayed 1000000.

### Not observed

A failed-path observation with Circle's contract was skipped: its `storage_deposit` registers any
valid account id, and the sandbox already covers transfer and registration failures.

### Leaves 1 and 2

They are unclaimed, but their commitments were made from placeholder addresses
(`zarf-measure-N@example.com`), not Google accounts, so a real Google login cannot claim them.
The real Google flow needs a campaign built from the claimants' real emails.
