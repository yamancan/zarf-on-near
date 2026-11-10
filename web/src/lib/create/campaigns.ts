// The sender's campaigns (/campaigns): list via campaigns_of, reclaim after the deadline, withdraw free pre-pay.

import type { Tx } from './funding';

export interface CampaignView {
  sender: string;
  token: string;
  amount: string;
  merkle_root: string;
  deadline_ns: string;
  balance: string; // excludes in-flight
  in_flight: string;
  policy: string;
  snapshot: string[];
  storage_reserved: string; // yoctoNEAR
}

export type View = <T>(method: string, args: object) => Promise<T>;

const PAGE = 100; // campaigns_of caps limit at 100
export const RPC_CONCURRENCY = 8; // stay under public-RPC rate limits

/** Promise.all with at most `limit` calls in flight; results keep the input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Every campaign id of `sender`, in creation order (campaigns_of pages of 100). */
export async function listCampaignIds(view: View, sender: string): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = await view<string[]>('campaigns_of', { sender, from_index: from, limit: PAGE });
    ids.push(...page);
    if (page.length < PAGE) return ids;
  }
}

export async function listCampaigns(view: View, sender: string): Promise<{ id: string; c: CampaignView }[]> {
  const ids = await listCampaignIds(view, sender);
  const views = await mapLimit(ids, RPC_CONCURRENCY, (id) => view<CampaignView | null>('get_campaign', { campaign_id: id }));
  // Newest first; a campaign the view no longer returns is skipped, never shown as empty.
  return ids.map((id, i) => ({ id, c: views[i]! })).filter((r) => r.c && r.c.sender === sender).reverse();
}

export const COUNT_CAP = 200;
export type Counts = { claimed: number; pending: number; unclaimed: number } | null;

/** Claimed/pending/unclaimed from the published leaf list; null ("n/a") above COUNT_CAP leaves. */
export async function claimCounts(commitments: string[], state: (commitment: string) => Promise<string>): Promise<Counts> {
  if (commitments.length > COUNT_CAP) return null;
  const states = await mapLimit(commitments, RPC_CONCURRENCY, state);
  const n = (s: string) => states.filter((x) => x === s).length;
  return { claimed: n('claimed'), pending: n('pending'), unclaimed: n('unclaimed') };
}

/** spec: reclaim iff now > deadline_ns, and there is a balance or a reservation left (else E117/E118). */
export function reclaimable(c: CampaignView, nowMs: number): { ok: true } | { ok: false; reason: string } {
  if (BigInt(Math.floor(nowMs)) * 1_000_000n <= BigInt(c.deadline_ns)) {
    return { ok: false, reason: `Claims are open until ${new Date(Number(BigInt(c.deadline_ns) / 1_000_000n)).toLocaleString()}.` };
  }
  if (BigInt(c.balance) === 0n && BigInt(c.storage_reserved) === 0n) return { ok: false, reason: 'Nothing left to reclaim.' };
  return { ok: true };
}

const TGAS = 1_000_000_000_000n;

export const reclaimTx = (sender: string, contractId: string, campaignId: string): Tx => ({
  signerId: sender,
  receiverId: contractId,
  actions: [{ type: 'FunctionCall', params: { methodName: 'reclaim', args: { campaign_id: campaignId }, gas: (100n * TGAS).toString(), deposit: '0' } }],
});

/** prepay_withdraw with no amount withdraws all free pre-pay. */
export const withdrawTx = (sender: string, contractId: string): Tx => ({
  signerId: sender,
  receiverId: contractId,
  actions: [{ type: 'FunctionCall', params: { methodName: 'prepay_withdraw', args: {}, gas: (30n * TGAS).toString(), deposit: '0' } }],
});

/** yoctoNEAR as NEAR with up to 5 decimals (display only). */
export function formatNear(yocto: string): string {
  const v = BigInt(yocto);
  const whole = v / 10n ** 24n;
  const frac = ((v % 10n ** 24n) / 10n ** 19n).toString().padStart(5, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}`;
}

interface Outcome {
  receipts_outcome?: { outcome?: { executor_id?: string; logs?: string[]; status?: { Failure?: unknown } } }[];
}

/** What a reclaim tx did, from our contract's NEP-297 events (spec: reclaimed / reclaim_reverted). */
export function reclaimOutcome(
  o: Outcome,
  contractId: string,
  campaignId: string,
): { kind: 'reclaimed'; amount: string } | { kind: 'reverted' } | { kind: 'failed'; code: string } | { kind: 'released' } {
  for (const r of o.receipts_outcome ?? []) {
    if (r.outcome?.executor_id !== contractId) continue;
    for (const log of r.outcome.logs ?? []) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      try {
        const e = JSON.parse(log.slice('EVENT_JSON:'.length));
        if (e.standard !== 'zarf-near' || String(e.data?.[0]?.campaign_id) !== campaignId) continue;
        if (e.event === 'reclaim_reverted') return { kind: 'reverted' };
        if (e.event === 'reclaimed') return { kind: 'reclaimed', amount: String(e.data[0].amount) };
      } catch {
        // not our event
      }
    }
  }
  const failure = (o.receipts_outcome ?? []).find((r) => r.outcome?.status?.Failure !== undefined)?.outcome?.status?.Failure;
  if (failure) return { kind: 'failed', code: /E1\d\d_[A-Z_]+/.exec(JSON.stringify(failure))?.[0] ?? 'FAILED' };
  return { kind: 'released' }; // no transfer: only the storage reservation went back to the free pre-pay
}
