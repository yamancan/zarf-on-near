# Contract and mock-ft build on rust-toolchain.toml (1.86.0); integration/ has its own (1.95.0).
BUILD = cargo near build non-reproducible-wasm --no-abi

.PHONY: wasm test unit integration demo-sandbox
wasm:
	$(BUILD) --out-dir target/near/release
	$(BUILD) --features test-callback-panic --out-dir target/near/callback-panic
	cd mock-ft && $(BUILD) --out-dir ../target/near/mock-ft

unit:
	cargo test

integration: wasm
	cd integration && cargo test

test: unit integration

# Local sandbox seeded for `make demo` (test-only keys). Prints an env block, then blocks.
demo-sandbox: wasm
	cd integration && cargo run --quiet --bin demo_sandbox
