# Upgrade watcher

A Cloudflare cron Worker that runs every 2 minutes and sends an alert to `ALERT_WEBHOOK_URL` when:

- **the escrow** (`watch()` and `get_owner` on `CONTRACT_ID`) shows
  - a proposed upgrade (`pending_upgrade`: code sha256, source, the time it can be applied, or "being applied now"),
  - a proposed owner change (`pending_owner`), or an owner other than `EXPECTED_OWNER`,
  - a verifier key added to or removed from `owner_keys`, compared with `EXPECTED_SIGNERS`;
- **the escrow account itself**, read from the protocol and not from the contract (`view_account`,
  `view_access_key_list`): a code hash other than `EXPECTED_CODE_HASH`, or any access key. This still pages
  when an applied upgrade makes `watch()` show the old values;
- **the live claim page** (`CLAIM_PAGE_URL`) differs from `expected/<network>.json`. That file holds the
  sha256 of its HTML (per-request CSP nonces removed) and of every same-origin script it loads, followed
  through static and dynamic imports, however many (recorded at deploy, under Node). Each run reads the HTML
  and re-hashes `SCRIPTS_PER_RUN` (40) of the recorded scripts: a scheduled slice of 30 that rotates, so every
  script is re-hashed within ceil(scripts / 30) runs (47 scripts: 2 runs, 4 min), plus 10 drawn at random from
  the rest, so an origin that knows the schedule cannot tell which skipped paths are safe in a given slot. A
  changed HTML, a changed, redirected or unserved script, or any script a fetched file names that is not
  recorded, is reported by path. This check catches drift and outsiders only: it fetches one fixed claim path, and a hostile
  claim Worker controls what it returns. A change reverted before a run looks is not seen either. Anyone
  holding the account's deploy token can also redeploy or delete the watcher itself;
- **it cannot check**: the RPC or the page cannot be read, or the config is empty. A run that executes and
  cannot check alerts, so silence from a run means "checked and clean". A watcher that does not run at all
  (cron off, Worker deleted, account or billing stopped, a run that throws, a webhook that fails) is silent
  too, and nothing here alerts on that.

An alert repeats on every run while its condition holds (a pending upgrade pages every 2 minutes until it is
applied or cancelled). The upgrade delay is 10 min on testnet and at most 1 h on mainnet, so somebody must
read these alerts within minutes, and somebody must be able to act on them.

**On mainnet a guardian is required.** The owner can cancel its own proposal, but if the owner key is the
stolen one, only a guardian can stop it: `cancel_upgrade`, `cancel_owner`, `freeze_proposals`, or `remove_agent` on a key not
active yet. `guardian_id` is set at `new` and cannot be added later. The testnet escrow
`zarf-near-1112.testnet` has none, so on testnet this watcher can warn but nobody can stop a hostile upgrade.

## Config (`wrangler.jsonc`, per env)

| Var | Testnet |
| --- | --- |
| `CONTRACT_ID` | `zarf-near-1112.testnet` |
| `NEAR_RPC_URL` | `https://test.rpc.fastnear.com` |
| `EXPECTED_OWNER` | `zarf-near-owner-1111.testnet` |
| `EXPECTED_SIGNERS` | the relayer's `VERIFIER_SIGNERS` (hex, comma-separated) |
| `EXPECTED_CODE_HASH` | `5GdxDSB4sGW9Ewod4Q4Na613C2sLQjVfFjLbbZbKt6N8` (`view_account`, base58). An honest upgrade changes it here too |
| `CLAIM_PAGE_URL` | `https://zarf-near-claim-testnet.sparkling-queen-5e77.workers.dev/claim/1/0` |
| `SCRIPTS_PER_RUN` | `40` (allowed 4-40; below 4 there is no random share): the free plan's 50 subrequests per run, less 4 RPC reads with one retry each, the page and the alert. Redirects are not followed |
| `ALERT_WEBHOOK_URL` | **secret, the owner sets it**: a Slack or Discord incoming-webhook URL. The body is `{"text": …, "content": …}` |

`env.mainnet` is empty until the mainnet escrow exists. `scripts/deploy-mainnet-hosting.sh` refuses to
deploy until it names the same contract and signers as the relayer and sets `EXPECTED_CODE_HASH`, and until
the mainnet watcher has its `ALERT_WEBHOOK_URL` secret.

## Honest deploys are not alerts

Every web deploy ends with `scripts/watcher-refresh.sh <network>` (`scripts/deploy-web.sh testnet`,
`scripts/deploy-mainnet-hosting.sh` and `scripts/enable-google-testnet.sh` call it). It works in four steps:

1. It fingerprints the live page.
2. It refuses the result unless every live script is byte-identical to the build just deployed. SvelteKit
   stamps each build with its own version id, so only that build can match.
3. It writes `expected/<network>.json` and deploys the watcher.
4. It commits the file.

A web deploy that skips the refresh shows up as an alert, which is the point.

## Commands

```sh
pnpm test                 # unit tests: recorded watch() outputs and bundle fixtures
pnpm typecheck
pnpm local-scheduled      # the real Worker under `wrangler dev --test-scheduled`, one cron run per fixture
pnpm fingerprint <url>    # print a page's fingerprint
```
