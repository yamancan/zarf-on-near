# T11 plan: the verifier as a Shade Agent (Mode T)

Run this the moment the owner approves (1) a Phala Cloud account with a card or top-up,
giving a `PHALA_API_KEY`, and (2) GHCR pushes from `yamancan/zarf-on-near` Actions.
Facts and sources are in `docs/spikes/S2.md`. Decisions from `zarf main` (2026-11-10):
the registry lives inside the escrow (agents keyed by pubkey hex, kind
`Owner | Attested{measurement}`, with expiry), campaigns snapshot the policy, the salt
travels in the claim-link `#fragment`, and the image is built by GitHub Actions and
pushed to GHCR. the deploy host needs no Docker.

## 0. Contract prerequisites (coding-agent, spec v2)

The escrow exposes the methods the Shade CLI calls, with the **same argument shapes**,
so `shade deploy` can drive it unchanged:

- `approve_measurements({measurements: FullMeasurementsHex})` / `remove_measurements`, owner only.
- `approve_ppids({ppids: Ppid[]})` / `remove_ppids`, owner only.
- `register_agent({attestation: DstackAttestation})`, payable at ≥ 0.00486 NEAR.
  It runs `shade_attestation::verify` with `report_data` = the caller's implicit
  account id bytes (32) padded to 64, and stores `Attested{measurement}` with
  `valid_until`.
- `get_agent({account_id})` view. `ShadeClient.register()` calls it to pick the deposit.
- `claim` keeps the spec's signed payload. It accepts the signature if
  `agents[hex(pk)]` passes the campaign's snapshotted policy, then
  `env::ed25519_verify`.

Storage: `storage_costs.campaign_bytes_cost` today bounds only owner-policy snapshots. The
attested path adds a `measurement_id` per approved measurement to each campaign snapshot, so
the bound must grow by 32 B × (number of approved measurements), or become a per-policy
value, before `policy: "attested"` campaigns are accepted.

Build: `cargo near build non-reproducible-wasm --no-abi`, with `shade-attestation =0.2.0`,
`near-sdk =5.26.1` and Rust 1.86.0, the pins from the framework. Local and whitelist mode
exists only under `cfg(test)` / a test feature, never in the release WASM.

## 1. Agent service `agent/` (orch → T11 implementer, about 2-3 h)

Same verifier code, a different host. Nothing in `verifier/src` changes.

```
agent/
  package.json      # deps pinned exactly: @neardefi/shade-agent-js 2.2.0, hono 4.12.16, @hono/node-server 2.0.1
  package-lock.json # npm ci in Docker, as the framework requires
  tsconfig.json
  src/main.ts
  Dockerfile        # copy of shade-agent-template/Dockerfile (node:22-alpine pinned by digest, SOURCE_DATE_EPOCH=0)
  docker-compose.yaml
```

`src/main.ts`, in order:

1. Read env `ESCROW_CONTRACT_ID`, `SPONSOR_ACCOUNT_ID`, `SPONSOR_PRIVATE_KEY`,
   `GOOGLE_CLIENT_ID` and `NETWORK`. Fail closed if any is missing.
2. `const agent = await ShadeClient.create({ networkId, agentContractId: ESCROW_CONTRACT_ID, sponsor, numKeys: 1 })`.
   **No `derivationPath`.** In a TEE it is ignored, and a path-derived key cannot attest.
3. `if (await agent.balance() < 0.2) await agent.fund(0.3)`.
4. `await agent.register()`, retried every 10 s until it succeeds. Then call
   `register()` again every 6 days (registration is valid for 7), copying the
   template's `setInterval`.
5. Signing key: `agent.getPrivateKeys({ acknowledgeRisk: true })[0]` is
   `ed25519:<base58 of 64 bytes>`. The first 32 bytes are the seed, which goes to
   `importVerifierKey(hex(seed))` from `verifier/src/claim.ts`. Assert that
   `hex(pubkey)` equals `agent.accountId()` at boot. Never log the key; wrap boot errors
   in `toThrowable`.
6. Serve the verifier's existing `fetch(req, env)` handler through
   `@hono/node-server`, passing an `env` built from step 1 and the in-TEE key. Add only
   `GET /api/agent-info` → `{ accountId }`.

Local test (no TEE, before the owner approves): `NETWORK=testnet` against the
near-workspaces sandbox. Use the escrow's test build with the mock attestation, and
check that register → sign → `claim` works end to end.

`docker-compose.yaml`:

```yaml
services:
  zarf-verifier:
    image: ghcr.io/yamancan/zarf-on-near-verifier@sha256:<digest from step 2>
    platform: linux/amd64
    environment: [ESCROW_CONTRACT_ID, SPONSOR_ACCOUNT_ID, SPONSOR_PRIVATE_KEY, GOOGLE_CLIENT_ID, NETWORK]
    ports: ["3000:3000"]
    volumes: ["/var/run/dstack.sock:/var/run/dstack.sock"]
    restart: always
```

The compose file is measured (App Compose Hash), so pin the image **by digest**.
A tag would let a push change the code without changing the measurement.

## 2. Image build `.github/workflows/agent-image.yml` (about 1 h)

- Trigger: `workflow_dispatch` plus pushes to `main` touching `agent/**` or `verifier/src/**`.
- `permissions: { contents: read, packages: write }`.
- Steps:
  - `actions/checkout`.
  - `docker/setup-buildx-action`.
  - `docker/login-action` with `registry: ghcr.io`, `username: ${{ github.actor }}` and
    `password: ${{ secrets.GITHUB_TOKEN }}`.
  - `docker/build-push-action` with `context: .`, `file: agent/Dockerfile`,
    `platforms: linux/amd64`, `push: true`,
    `tags: ghcr.io/yamancan/zarf-on-near-verifier:${{ github.sha }}`,
    `build-args: SOURCE_DATE_EPOCH=0` and `provenance: false`, so the digest is
    only the image.
- Output: write the image digest to the job summary. The operator copies it into
  `agent/docker-compose.yaml` in a commit, and that commit is what gets measured.
- Pin every action by commit SHA, never by tag.
- **Owner:** make the GHCR package readable by Phala. Either make the package public,
  or give Phala a read-only PAT under private registry credentials. A public package
  is simpler, and the repo goes public anyway.

## 3. Deploy (the deploy host, about 1 h + 3-5 h of first-run debugging)

1. `npm i -g @neardefi/shade-agent-cli@2.4.0` through personal-vps.
2. `shade auth set all testnet create-new` creates the testnet master account and
   sponsor, and asks for the Phala API key. The owner pastes the key; we never see it
   in chat.
3. `agent/deployment.yaml`, starting from the template:
   - `environment: TEE`, `network: testnet`, `docker_compose_path: ./docker-compose.yaml`.
   - `agent_contract.contract_id: <escrow testnet id>` and
     `deploy_custom.enabled: false`. T8 already deployed and initialised the escrow.
   - `approve_measurements.enabled: true` and `approve_ppids.enabled: true`, with
     method names as in §0.
   - **`build_docker_image.enabled: false`**. Actions built it. From reading
     `shade-agent-cli/src/commands/deploy/docker.js` and `utils/measurements.js`,
     the CLI calls Docker only on the build path; not run yet.
   - `tee_config`: `dstack_version: 0.5.8`, `instance_type: tdx.small`,
     `public_logs: true`, `public_sysinfo: true`, `phala.enabled: true`,
     `deploy.app_name: zarf-verifier` and `env_file_path: ./.env`. The `.env` stays
     on the deploy host and is gitignored.
4. Run `shade plan`, read it, then `shade deploy`. Expected: the measurements and Phala
   PPIDs are approved on the escrow, the CVM starts, the agent self-funds and
   registers. Check `get_agent(<accountId>)` on chain, and record the
   `register_agent` tx hash for the README.
5. Smoke test: one testnet claim signed by the agent and submitted by the relayer.
   Record its tx hash.
6. Teardown rule: delete the CVM after the judging window (16-18 Nov) to stop billing,
   about $0.06/h.

## 4. Done when

- `register_agent` succeeded on testnet with a real TDX quote (tx hash in the README).
- A claim signed by that agent was paid (tx hash), and a claim signed by a non-registered
  key fails with `E101_INVALID_SIGNATURE` (test).
- The README's trust sentence is the one in S2 §"Trust statement", including "the
  contract owner approves which code measurements are valid".

## Risks for the first run

- TCB status not `UpToDate` on the Phala host. `verify` rejects it, and only another
  Phala node fixes it.
- Compose-hash drift: any byte change to `docker-compose.yaml` after approval means
  re-approving measurements.
- The 300 TGas registration fails if `approved_measurements` grows (keep 1-2 entries).
- The CLI might still need Docker with `build_docker_image.enabled: false`; this was
  only read in code. Fallback: Docker on the deploy host through personal-vps.
