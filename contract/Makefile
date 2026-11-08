# Contract and mock-ft build on rust-toolchain.toml (1.86.0); integration/ has its own (1.95.0).
# Wasm always lands in the explicit --out-dir below (read by the tests), whatever
# CARGO_TARGET_DIR says; that variable only moves intermediate artifacts.
BUILD = cargo near build non-reproducible-wasm --no-abi

.PHONY: wasm test unit integration
wasm:
	$(BUILD) --out-dir target/near/release
	$(BUILD) --features test-callback-panic --out-dir target/near/callback-panic
	cd mock-ft && $(BUILD) --out-dir ../target/near/mock-ft

unit:
	cargo test

# integration/ is a 1.95 crate: when the shared-dir rule sets both, it gets its own target dir.
INTEGRATION_ENV = $(if $(CARGO_TARGET_DIR_195),CARGO_TARGET_DIR=$(CARGO_TARGET_DIR_195))

integration: wasm
	cd integration && $(INTEGRATION_ENV) cargo test -- --test-threads=2

test: unit integration
