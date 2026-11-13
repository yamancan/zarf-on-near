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

/** Out of escrow so far: what was funded minus what is left or still in flight (claims, plus any reclaim). */
export const claimedAmount = (c: CampaignView): bigint => BigInt(c.amount) - BigInt(c.balance) - BigInt(c.in_flight);

/**
 * The word for claimedAmount (red team #6). A reclaim needs now > deadline (spec), so before the deadline only claims
 * moved funds out: "claimed". After it a reclaim may be part of it, and the view does not split the two: "left escrow".
 */
export const outLabel = (c: CampaignView, nowMs: number): 'claimed' | 'left escrow' =>
  BigInt(Math.floor(nowMs)) * 1_000_000n <= BigInt(c.deadline_ns) ? 'claimed' : 'left escrow';

/** The Zarf balance row: once the list is read, with campaigns or with NEAR to withdraw (red team #9: an aborted first send leaves NEAR and no campaign). */
export const showPrepay = (rows: readonly unknown[] | null, freePrepay: string): boolean => rows !== null && (rows.length > 0 || BigInt(freePrepay) > 0n);

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

/**
 * Display only (design spec G6f): yoctoNEAR as NEAR to 3 significant digits, 4.99818 → "5.00", 0.01434 → "0.0143";
 * `up` rounds up, so a need is never shown smaller than it is. 1000 and above: whole NEAR.
 */
export function sig3(yocto: bigint, up = false): string {
  const v = Number(yocto) / 1e24;
  if (v === 0) return '0';
  if (v >= 1000) return (up ? Math.ceil(v) : Math.round(v)).toLocaleString('en-US');
  const step = 10 ** (Math.floor(Math.log10(v)) - 2);
  const r = (up ? Math.ceil(v / step - 1e-9) : Math.round(v / step)) * step;
  return r >= 1000 ? Math.round(r).toLocaleString('en-US') : r.toPrecision(3);
}

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

/** What this browser remembers about a send, for the /campaigns label (T-024): never sent anywhere. */
export interface SentRecord {
  campaignId: string;
  firstEmail: string;
  count: number;
  createdAt: number; // ms
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const sentKey = (contractId: string) => `zarf-near:sent:${contractId}`; // campaign ids are per contract

function readAll(store: Store, contractId: string): Record<string, SentRecord> {
  try {
    const v = JSON.parse(store.getItem(sentKey(contractId)) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Saved at send time; best effort (a blocked or full storage only loses the label). */
export function saveSent(store: Store, contractId: string, r: SentRecord): void {
  try {
    store.setItem(sentKey(contractId), JSON.stringify({ ...readAll(store, contractId), [r.campaignId]: r }));
  } catch {
    // the amount line stays
  }
}

/** The well-formed records by campaign id; anything else is skipped, so /campaigns falls back to the amount line. */
export function readSent(store: Store, contractId: string): Map<string, SentRecord> {
  const out = new Map<string, SentRecord>();
  for (const [id, r] of Object.entries(readAll(store, contractId))) {
    if (r && r.campaignId === id && typeof r.firstEmail === 'string' && r.firstEmail && Number.isSafeInteger(r.count) && r.count > 0 && Number.isFinite(r.createdAt)) out.set(id, r);
  }
  return out;
}

/** "ana@gmail.com + 4 others · 14 Nov 2026"; null without a record (the amount line shows instead). */
export function sentLabel(r: SentRecord | undefined): string | null {
  if (!r) return null;
  const others = r.count - 1;
  const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(r.createdAt);
  return `${r.firstEmail}${others ? ` + ${others} ${others === 1 ? 'other' : 'others'}` : ''} · ${date}`;
}
