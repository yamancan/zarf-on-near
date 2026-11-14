# Relayer

Submits verifier-signed `claim` calls to the escrow contract and pays their gas.
`POST /claim` takes exactly the verifier's 200 body. `GET /health` returns numbers only.

## Deploy notes

The relayer signs with **one function-call access key**, never a full-access key:

| field | value |
| --- | --- |
| account | `RELAYER_ACCOUNT_ID`, funded with NEAR for gas |
| receiver | `CONTRACT_ID` |
| method names | exactly `["claim"]` |
| allowance | `null` (unlimited): the key still can only call `claim` and can attach no deposit |

On every claim the relayer reads this key's permission on chain and refuses to sign
(`RELAYER_MISCONFIGURED`) unless it matches the table. A finite allowance would stop all
claims once the key's gas budget is spent, so watch `GET /health` instead.

Use the repository's file-based key generation; do not print a private key to the terminal.
For testnet, `scripts/deploy.sh` creates the claim-only relayer key in a mode-600
file outside the repository (`RELAYER_KEY_FILE`) and registers its public key when
`RELAYER_ID` is set. Follow [the deployment guide](../docs/deploy/testnet.md).
For mainnet, `scripts/mainnet-keys.mjs` creates new mode-600 key files without overwriting
existing ones; follow [the mainnet owner-kit procedure](../docs/deploy/mainnet.md) to register
the public key. Both scripts print public keys only.

After the testnet key has been registered, upload it through standard input from its saved
file, without copying its value into a command or a file in this repository:

```sh
key_file=${RELAYER_KEY_FILE:?set the mode-600 relayer key file}
tr -d '\n' <"$key_file" | (cd relayer && npx wrangler secret put RELAYER_KEY --env testnet)
```

Run this from the repository root with the correct Cloudflare account configured.
The [mainnet hosting script](../scripts/deploy-mainnet-hosting.sh) uses the same stdin
pattern for the mainnet key.

Set the vars in `wrangler.jsonc`: `CONTRACT_ID`, `RELAYER_ACCOUNT_ID`, `NEAR_RPC_URL`,
`VERIFIER_SIGNERS` (the verifier's `signer` hex) and `CLAIM_ORIGINS`.

## Monitoring

`GET /health` → `{ "allowance": null | "<yocto>", "balance": "<yocto>", "claim_only": true }`.
Alert when `balance` falls below a few claims' gas, or `claim_only` is false.

Logs are fixed tags only: `rpc_unavailable`, `nonce_retry`, `misconfigured`. They never
contain the request, the transaction or an error message.
