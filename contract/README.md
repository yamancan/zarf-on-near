# contract/

NEAR escrow for email-addressed claims. Byte formats, check order, errors, events and
views are defined in [`../spec/claim.md`](../spec/claim.md); the tests load
`../spec/vectors.json`.

## Two toolchains, on purpose

| Path | Rust | Why |
| --- | --- | --- |
| `contract/`, `contract/mock-ft/` | 1.86.0 | near-sdk 5.26.1, the only dependency. No attestation crate: the `"attested"` policy path is inert (such a campaign is refused with `E127_NO_VERIFIER`); Mode T, a TEE-attested verifier, is roadmap |
| `contract/integration/` | 1.95.0 | near-workspaces 0.24.0 needs ≥ 1.95; it only loads the built wasm. OpenSSL is vendored (built from source: needs a C compiler and perl, not libssl-dev) |

Each directory's `rust-toolchain.toml` selects its toolchain automatically.

```bash
make unit          # unit tests, including every spec vector
make integration   # builds three wasm files, then runs the near-workspaces sandbox tests
make test          # both
```

`make wasm` builds the release contract, a `test-callback-panic` variant used only to
test the stranded-claim exit, and the test-only `mock-ft` token. A test asserts that the
release wasm does not contain the test panic.

## Owner exit for a stranded claim

If a claim's callback never completes, the claim stays `pending`. After `resolve_delay_ns`
(1 h on testnet and mainnet) the owner may call `resolve_pending` with the outcome read from
the `ft_transfer` receipt. A wrong `paid: false` on a claim that was in fact paid reopens it,
so the recipient can be paid **twice, out of the token balance every campaign shares**; a
wrong `paid: true` blocks that claim. The callback is built so this should never be needed.
