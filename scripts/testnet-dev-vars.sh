#!/usr/bin/env bash
# Writes the gitignored .dev.vars.testnet files that `wrangler dev --env testnet` reads, from the
# secret files on this host. Prints only public facts (the signer's public key), never a secret.
#   ~/.config/zarf-near/testnet-verifier.seed   64 hex chars (ed25519 seed of the Mode W signer)
#   ~/.config/zarf-near/testnet-relayer.key     ed25519:<base58> (the relayer's claim-only key)
set -euo pipefail
umask 077
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
dir=${ZARF_NEAR_SECRETS:-$HOME/.config/zarf-near}
seed=$(tr -d '[:space:]' <"$dir/testnet-verifier.seed")
key=$(tr -d '[:space:]' <"$dir/testnet-relayer.key")
[[ $seed =~ ^[0-9a-f]{64}$ ]] || { echo "testnet-verifier.seed: expected 64 lowercase hex chars" >&2; exit 1; }
[[ $key =~ ^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$ ]] || { echo "testnet-relayer.key: expected ed25519:<base58>" >&2; exit 1; }
printf 'SIGNER_SEED=%s\n' "$seed" >"$root/verifier/.dev.vars.testnet"
printf 'RELAYER_KEY=%s\n' "$key" >"$root/relayer/.dev.vars.testnet"
chmod 600 "$root/verifier/.dev.vars.testnet" "$root/relayer/.dev.vars.testnet"
# The signer the verifier will use, so it can be compared with the contract's registered key.
signer=$(SEED="$seed" node -e '
  const c = require("node:crypto");
  const k = c.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(process.env.SEED, "hex")]), format: "der", type: "pkcs8" });
  console.log(c.createPublicKey(k).export({ format: "der", type: "spki" }).subarray(-32).toString("hex"));')
echo "wrote verifier/.dev.vars.testnet and relayer/.dev.vars.testnet (mode 600)"
echo "verifier signer (public): $signer"
