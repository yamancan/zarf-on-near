# Faucet (`/try`) go-live and rollback

Worker `zarf-near-faucet-testnet` on Cloudflare account `f0b938c1641f5223c48199ec45751913`
(operator@example.invalid), URL https://zarf-near-faucet-testnet.sparkling-queen-5e77.workers.dev.
Testnet only. Rehearsed 2026-11-12 from a detached checkout at 99777d2;
nothing was deployed.

## Today's live version (the rollback target)

| | |
| --- | --- |
| Version id | `e733e5cd-27b8-4776-a0e7-c9f32776886f` (100%, deployed 2026-11-12 02:06 UTC) |
| Built from | revision 0bd7bbc |
| Secrets | `FAUCET_SENDER_KEY`, `LIMIT_KEY`, `TURNSTILE_SECRET` (from `~/.config/zarf-near/`) |
| KV | `FAUCET_KV` = `4c8e6091866e45239c9de5144c334a3f` |

## Rehearsal of 99777d2 (2026-11-12)

- Contains 0bd7bbc (`git merge-base --is-ancestor`). The built bundle contains `floatCache`,
  `cachedFloat`, `FLOAT_TTL_MS` and the failure delete.
- `pnpm test`: 85/85. `pnpm typecheck`: clean.
- `faucet/wrangler.jsonc` is identical to 0bd7bbc. The dry run binds `FAUCET_KV` (same id) and
  the same 13 vars, and the code reads only the three secrets the live Worker has.
- Bundle: 87.08 KiB, 48.49 KiB gzip. Was 22 KiB: the self-hosted Saira woff2 and favicon add
  about 65 KiB.
- `CLAIM_HOST` = `https://zarf-near-claim-testnet.sparkling-queen-5e77.workers.dev`. It stays
  correct as long as the claim app deploys with `--env testnet`: `web/wrangler.jsonc` has no
  `name` in that env, so wrangler names it `zarf-near-claim-testnet`. The footer links `/`,
  `/create`, `/campaigns` and `/privacy` there; all four answered 200 on 2026-11-12.

## Go-live (after the owner approves the design)

Run from a checkout of the approved commit, in `faucet/`:

```bash
pnpm install --frozen-lockfile && pnpm test && pnpm typecheck           # expect 85 passed
export CLOUDFLARE_API_TOKEN="$(cat ~/.config/cloudflare/api-token)"
npx wrangler whoami                       # must show f0b938c1641f5223c48199ec45751913, else STOP
npx wrangler deploy --dry-run             # FAUCET_KV 4c8e6091…, 13 vars, CREATOR testnet
npx wrangler deploy                       # no --env; write down the new version id
```

Then check:

1. `GET /try` → 200 with the CSP (`script-src 'self' https://challenges.cloudflare.com`).
2. `GET /saira.woff2` and `GET /favicon.svg` → 200; `GET /x.svg` → 404.
3. `GET /health` → `ok: true`, with `links_left` as before.
4. A `POST /faucet` with a forged Turnstile token → 403 `TURNSTILE_FAILED`. That means the
   config, the chain_id check and the float check all passed.
5. A browser pass at 390 and 1280 px: no console errors from our code, and the widget
   renders. A full link needs one human Turnstile click.

No secret or KV change is needed: the design touches only the page and its assets.

## Rollback

```bash
export CLOUDFLARE_API_TOKEN="$(cat ~/.config/cloudflare/api-token)"
npx wrangler whoami                       # f0b938…, else STOP
npx wrangler rollback e733e5cd-27b8-4776-a0e7-c9f32776886f -m "back to pre-design /try" -y
```

Rerun checks 1, 3 and 4 above. Check 2 returns 404 for the font after a rollback, as expected.
Rollback changes only the code version: secrets, vars, KV contents and on-chain state
(campaigns, float, prepay) are untouched. Campaigns created in between remain claimable,
because the link format is the same in both versions.
