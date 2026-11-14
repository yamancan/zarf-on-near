import type { QuotaNamespace } from './quota';
import { canonicalizeEmail, claimLink, commitment, hex, leaf } from './claim';
import { CreateError, type CampaignCreator } from './creator';
import { readLink, saveLink, takeQuota, type KvLike, type Limits } from './limits';

export interface FaucetDeps {
  claimHost: string; // https://<claim-host>
  amount: string; // u128 decimal
  lifetimeS: number; // claim window
  limits: Limits;
  limitKey: string; // secret: keys the hashed rate-limit counters
  kv: KvLike;
  quota: QuotaNamespace;
  quotaStartDate?: string; // UTC activation date; recovery of existing links remains available before it
  creator: CampaignCreator;
  nowMs?: number;
  randomSalt?: () => Uint8Array<ArrayBuffer>; // tests only
}

export type FaucetResult = { status: number; body: Record<string, unknown> };

const MAX_EMAIL = 254;
const sha256hex = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

/**
 * POST /faucet { email } → a fresh 1-leaf campaign for that email and its claim link.
 * The link goes back to whoever asked; only the Google account behind `email` can claim it.
 * The email is never stored or logged: the counters hold an HMAC of it, the chain holds the commitment.
 * With the link comes a random `recovery_token` (the page keeps it in localStorage). Asked again for the same
 * email, the link is shown only to a request carrying that token; anyone else gets `{ reshown: true }`, so the
 * email cannot be looked up to find its public claim (red team #1).
 */
export async function handleFaucet(input: unknown, ip: string, d: FaucetDeps): Promise<FaucetResult> {
  const email = (input as { email?: unknown } | null)?.email;
  if (typeof email !== 'string' || email.length > MAX_EMAIL) return { status: 400, body: { error: 'BAD_EMAIL' } };
  const canonical = canonicalizeEmail(email);
  if (!canonical || !/^[^@]+@[^@]+\.[^@]+$/.test(canonical)) return { status: 400, body: { error: 'BAD_EMAIL' } };

  const nowMs = d.nowMs ?? Date.now();
  // Asked again today (Turnstile already passed): no new campaign, no quota spent. The link itself only for the
  // browser that holds the first answer's recovery token; everyone else learns only that it was issued.
  const earlier = await readLink(d.kv, d.limitKey, canonical, nowMs);
  if (earlier) {
    const { recovery_hash, ...link } = earlier;
    const token = (input as { recovery?: unknown }).recovery;
    const mine = typeof token === 'string' && token.length <= 128 && typeof recovery_hash === 'string' && (await sha256hex(token)) === recovery_hash;
    return { status: 200, body: mine ? { ...link, reshown: true } : { reshown: true } };
  }
  if (d.quotaStartDate && nowMs < Date.parse(`${d.quotaStartDate}T00:00:00Z`)) {
    return { status: 503, body: { error: 'QUOTA_UNAVAILABLE' } };
  }
  // Reserve before creating; only a definitive failure may release the email's slot.
  const quota = await takeQuota(d.quota, d.limitKey, d.limits, ip, canonical, nowMs).catch(() => null);
  if (!quota) return { status: 503, body: { error: 'QUOTA_UNAVAILABLE' } };
  if (!quota.ok) return { status: 429, body: { error: quota.code } };

  const salt = d.randomSalt?.() ?? crypto.getRandomValues(new Uint8Array(32));
  const c = await commitment(salt, canonical);
  const root = await leaf(c, d.amount); // one leaf: root = leaf, proof = []
  const deadlineNs = ((BigInt(nowMs) + BigInt(d.lifetimeS) * 1000n) * 1_000_000n).toString();

  let created;
  try {
    created = await d.creator.create({ merkleRoot: root, amount: d.amount, deadlineNs });
  } catch (e) {
    // An RPC timeout may follow a successful broadcast. Keep its reservation; do not allow another create.
    if (e instanceof CreateError && e.definitive) await quota.cancelEmail().catch(() => console.log('faucet_quota_cancel_failed'));
    if (e instanceof CreateError) return { status: 503, body: { error: e.code } };
    console.log('faucet_create_failed'); // fixed tag: never the error, which could carry request data
    return { status: 503, body: { error: 'CREATE_FAILED' } };
  }

  const body = {
    // Amount and the (empty) proof travel in the link; no leaf list is published (spec).
    claim_url: claimLink(d.claimHost, created.campaignId, c, hex(salt), d.amount),
    campaign_id: created.campaignId,
    commitment: c,
    amount: d.amount,
    deadline_ns: deadlineNs,
    tx_hash: created.txHash,
    ...(d.creator.live ? {} : { stub: true }),
  };
  const recovery = hex(crypto.getRandomValues(new Uint8Array(16)));
  // Pending email quota already prevents another create, even if either persistence step exhausts retries.
  // Only the token's hash is kept (sealed with the link).
  await saveLink(d.kv, d.limitKey, canonical, nowMs, { ...body, recovery_hash: await sha256hex(recovery) });
  await quota.commitEmail().catch(() => console.log('faucet_quota_commit_failed'));
  return { status: 200, body: { ...body, recovery_token: recovery } };
}
