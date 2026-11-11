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

Adding the key with near-cli-rs. This is the expected command shape, **not yet checked on
this machine** (near-cli-rs is not installed here); confirm it with `near account add-key --help`:

```sh
near account add-key <RELAYER_ACCOUNT_ID> grant-function-call-access \
  --allowance unlimited --contract-account-id <CONTRACT_ID> --function-names claim \
  autogenerate-new-keypair print-to-terminal network-config testnet sign-with-keychain send
```

Then store the new private key as the secret (it never goes in a file in this repo):

```sh
npx wrangler secret put RELAYER_KEY   # ed25519:<base58>
```

Set the vars in `wrangler.jsonc`: `CONTRACT_ID`, `RELAYER_ACCOUNT_ID`, `NEAR_RPC_URL`,
`VERIFIER_SIGNERS` (the verifier's `signer` hex) and `CLAIM_ORIGINS`.

## Monitoring

`GET /health` → `{ "allowance": null | "<yocto>", "balance": "<yocto>", "claim_only": true }`.
Alert when `balance` falls below a few claims' gas, or `claim_only` is false.

Logs are fixed tags only: `rpc_unavailable`, `nonce_retry`, `misconfigured`. They never
contain the request, the transaction or an error message.
