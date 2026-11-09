# Clean clone -> `make test` and `make demo`. No secrets, no Google login.
# Needs Node 24 and pnpm 10.30.3 (pinned per package); `pnpm install` needs network access.
.PHONY: test demo install verifier relayer web scripts contract

PNPM_INSTALL := pnpm install --frozen-lockfile

# Runs every suite, keeps going after a failure, and ends with one SUMMARY line.
# Exit 1 if anything that ran failed; a contract skipped for a missing toolchain is not a failure.
test:
	@status=""; fail=0; \
	for t in verifier relayer web scripts; do \
	  if $(MAKE) --no-print-directory $$t; then status="$$status $$t ✓"; else status="$$status $$t ✗"; fail=1; fi; \
	done; \
	if [ ! -d contract ]; then status="$$status contract NOT RUN (no contract/)"; \
	elif ! command -v cargo >/dev/null 2>&1; then status="$$status contract NOT RUN (cargo missing)"; \
	elif $(MAKE) --no-print-directory contract; then status="$$status contract ✓"; else status="$$status contract ✗"; fail=1; fi; \
	echo; echo "SUMMARY:$$status"; exit $$fail

install:
	cd verifier && $(PNPM_INSTALL)
	cd relayer && $(PNPM_INSTALL)
	cd web && $(PNPM_INSTALL)

verifier:
	cd verifier && $(PNPM_INSTALL) && pnpm test && pnpm typecheck

relayer:
	cd relayer && $(PNPM_INSTALL) && pnpm test && pnpm typecheck

web:
	cd web && $(PNPM_INSTALL) && pnpm test && pnpm check && pnpm build

# The demo harness's own tests (the --dry mock must refuse a tampered claim tx).
scripts:
	cd relayer && $(PNPM_INSTALL)
	node --test 'scripts/*.test.mjs'

# The contract's own tests (contract/Makefile: unit = cargo test, integration = wasm + near-workspaces);
# skipped with a reason when they cannot run here.
contract:
	@if [ ! -d contract ]; then echo "SKIP contract: contract/ is not in this tree yet"; \
	elif ! command -v cargo >/dev/null 2>&1; then echo "SKIP contract: cargo is not installed (see contract/README for the toolchain)"; \
	else $(MAKE) -C contract test; fi

# The claim flow end to end. With NEAR_RPC_URL (+ the seam in scripts/demo.mjs) it runs against a
# NEAR sandbox; without it, against a mocked NEAR RPC so the TypeScript path still runs.
demo:
	cd verifier && $(PNPM_INSTALL)
	cd relayer && $(PNPM_INSTALL)
	@if [ -n "$$NEAR_RPC_URL" ]; then node scripts/demo.mjs; \
	else echo "NEAR_RPC_URL is not set: running against a mocked NEAR RPC (--dry)"; node scripts/demo.mjs --dry; fi
