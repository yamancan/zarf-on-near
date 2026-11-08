# contract/

**Not yet compiled; its tests have not run.** (The toolchain wasn't available while it was written; see the root README.)

NEAR escrow for email-addressed claims. Byte formats, check order, errors, events and
views are defined in [`../spec/claim.md`](../spec/claim.md); the tests load
`../spec/vectors.json`.

## Two toolchains, on purpose

| Path | Rust | Why |
| --- | --- | --- |
| `contract/`, `contract/mock-ft/` | 1.86.0 | near-sdk 5.26.1 and shade-attestation 0.2.0 (Mode T) |
| `contract/integration/` | 1.95.0 | near-workspaces 0.24.0 needs ≥ 1.95; it only loads the built wasm |

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

If a claim's callback never completes, the claim stays `pending`. After one hour the
owner may call `resolve_pending` with the outcome read from the `ft_transfer` receipt.
A wrong answer can double-pay or block that **one** claim; it cannot touch any other
allocation. The callback is built so this should never be needed.
