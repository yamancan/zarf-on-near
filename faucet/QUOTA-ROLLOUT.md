# Atomic daily quota rollout

This change is prepared only; it has not been deployed. It adds the `QUOTA`
binding and SQLite Durable Object `FaucetQuota` with migration tag
`faucet-quota-v1`. Keep that migration and class name on subsequent deployments.
The KV namespace and its encrypted recovery records are retained unchanged.

## Counter continuity and activation

Old KV counters cannot be reliably imported while the old worker accepts writes:
KV is eventually consistent and previous failed writes already lost counts. Do
not activate an empty Durable Object mid-day or run a gradual split deployment.

The checked-in `QUOTA_START_DATE` is deliberately empty and fails closed. For a
conservative mid-day rollout, set it to the **next UTC calendar date** (`YYYY-MM-DD`)
and deploy the new worker to 100% before that date. For example, a rollout during
November 14 uses `2026-11-15`; issuance resumes at 00:00 UTC / 03:00 Turkey time.
This gives no additional allowance on the cutover day, equivalent to consuming
that day's entire remaining global quota. Existing encrypted links can still be
recovered. This loses remaining capacity for that partial day intentionally.

For a fresh-day cutover, stop old issuance and let in-flight requests finish before
the UTC boundary, then deploy/configure this worker for that new date before
reopening. Do not leave an old version receiving new requests in the new UTC day.
If the planned date passes before deployment, choose the next date instead.
The activation date can remain unchanged after a successful rollout.

Before any authorized deploy, use the project account token and verify that
`wrangler whoami` shows account `f0b938c1641f5223c48199ec45751913`. No token files
need to be changed. A deployment requires separate owner approval.

## Reservation and failure behavior

One object per UTC day serializes all three counters in a storage transaction.
Reserve spends IP/day attempts and holds email quota. Commit keeps the email
spent; cancellation releases only email. Each call uses a stable UUID and is
idempotent. A delayed cancellation cannot release a committed campaign.

Storage calls make at most three application attempts with 100/200 ms backoff, obtaining a fresh
stub each time; overloaded objects fail immediately. Cloudflare may also retry
transient transport failures internally. KV recovery writes retry
at most three attempts with 1100/2200 ms backoff. Only the storage operations repeat:
the on-chain create is never retried here. Exhausted reserve retries return 503
without creating a campaign. Exhausted commit retries return the created link and
leave its pending reservation counted. A fixed log tag records commit/link errors.

Only a definitive create failure releases email quota: preparation failures before
broadcast, or a confirmed not-prepaid failure. Ambiguous broadcast outcomes retain it until the next UTC
day. This conservatively denies another attempt rather than creating twice. An
operator must reconcile the chain separately if that first result was lost.
A cleanup alarm deletes each daily ledger at least 48 hours after its first use;
pending reservations never expire during their quota day. Alarms do not create
campaigns or release current-day allowance.

## Rollback

Do not send traffic back to the KV limiter after this version has issued links:
its counters no longer include those attempts. A rollback version may use the
activation date to pause issuance only if it retains this activation guard and the
new binding/storage. The legacy worker ignores `QUOTA_START_DATE`: before restoring
it, externally pause issuance until a fresh UTC day. Never delete the quota
namespace as part of rollback. A safe same-day rollback to code retaining the guard
may intentionally keep issuance disabled while preserving existing link recovery.
