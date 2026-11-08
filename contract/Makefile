# Contract and mock-ft build on rust-toolchain.toml (1.86.0); integration/ has its own (1.95.0).
# Wasm always lands in the explicit --out-dir below (read by the tests), whatever
# CARGO_TARGET_DIR says; that variable only moves intermediate artifacts.
BUILD = cargo near build non-reproducible-wasm --no-abi

# On a shared host with a build lock (the deploy host: ~/.cache/zarf-near/build.lock), build steps take
# it themselves with `flock -o`, so nothing they spawn inherits the lock fd. Screeners have no
# lock file and build unlocked. Long-running targets (demo-sandbox) lock only their builds, so
# do not wrap them in flock yourself.
BUILD_LOCK ?= $(wildcard $(HOME)/.cache/zarf-near/build.lock)
LOCKED = $(if $(BUILD_LOCK),flock -o $(BUILD_LOCK))

.PHONY: wasm test unit integration demo-sandbox
wasm:
	$(LOCKED) $(BUILD) --out-dir target/near/release
	$(LOCKED) $(BUILD) --features test-callback-panic --out-dir target/near/callback-panic
	$(LOCKED) $(BUILD) --features test-upgrade-v2 --out-dir target/near/upgrade-v2
	$(LOCKED) $(BUILD) --features test-migrate-panic --out-dir target/near/migrate-panic
	cd mock-ft && $(LOCKED) $(BUILD) --out-dir ../target/near/mock-ft

unit:
	$(LOCKED) cargo test

# integration/ is a 1.95 crate with its own cache: CARGO_TARGET_DIR_195, else integration/target
# (never the 1.86 CARGO_TARGET_DIR, which would thrash). Absolute, because cargo build runs in
# integration/ and the exec runs here.
INTEGRATION_TARGET = $(abspath $(or $(CARGO_TARGET_DIR_195),$(CURDIR)/integration/target))

integration: wasm
	cd integration && CARGO_TARGET_DIR=$(INTEGRATION_TARGET) $(LOCKED) cargo test -- --test-threads=2

test: unit integration

# Local sandbox seeded for `make demo` (test-only keys). Prints an env block, then blocks.
# Builds under the lock, then runs the binary outside it: a sandbox that lives for hours must
# never hold the build lock.
demo-sandbox: wasm
	cd integration && CARGO_TARGET_DIR=$(INTEGRATION_TARGET) $(LOCKED) cargo build --quiet --bin demo_sandbox
	exec $(INTEGRATION_TARGET)/debug/demo_sandbox
