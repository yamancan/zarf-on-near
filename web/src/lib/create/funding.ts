// The two transactions that create a campaign, and reading campaign_id back from its event.

export interface StorageCosts {
  ft_storage_deposit: string;
  claim_entry_cost: string;
  per_claim_storage: string;
  campaign_bytes_cost: string;
}

/**
 * One owner key's worth of snapshot bytes: if the owner adds a key between our storage_costs read and
 * the ft_transfer_call, the snapshot grows by 32 B. `storageByteCost` is get_config().storage_byte_cost.
 */
export const ownerKeySlack = (storageByteCost: string): bigint => 32n * BigInt(storageByteCost);

/** spec: deposit only the shortfall, campaign_bytes_cost + leaf_count × per_claim_storage + slack − free pre-pay. */
export function prepayShortfall(costs: StorageCosts, leafCount: number, freePrepay: string, slack: bigint): bigint {
  if (costs.campaign_bytes_cost === undefined) throw new Error('storage_costs has no campaign_bytes_cost');
  const need = BigInt(costs.campaign_bytes_cost) + BigInt(leafCount) * BigInt(costs.per_claim_storage) + slack;
  const short = need - BigInt(freePrepay);
  return short > 0n ? short : 0n;
}

export interface FunctionCall {
  type: 'FunctionCall';
  params: { methodName: string; args: object; gas: string; deposit: string };
}
export interface Tx {
  signerId: string;
  receiverId: string;
  actions: FunctionCall[];
}

const TGAS = 1_000_000_000_000n;

export interface FundingParams {
  sender: string;
  contractId: string;
  tokenId: string;
  merkleRoot: string;
  deadlineNs: string;
  leafCount: number;
  total: string;
  shortfall: bigint;
}

/** prepay_deposit (only if short) then one ft_transfer_call of the exact total. */
export function fundingTxs(p: FundingParams): Tx[] {
  const txs: Tx[] = [];
  if (p.shortfall > 0n) {
    txs.push({
      signerId: p.sender,
      receiverId: p.contractId,
      actions: [{ type: 'FunctionCall', params: { methodName: 'prepay_deposit', args: {}, gas: (30n * TGAS).toString(), deposit: p.shortfall.toString() } }],
    });
  }
  const msg = { merkle_root: p.merkleRoot, deadline_ns: p.deadlineNs, policy: 'owner', leaf_count: p.leafCount };
  txs.push({
    signerId: p.sender,
    receiverId: p.tokenId,
    actions: [{
      type: 'FunctionCall',
      params: {
        methodName: 'ft_transfer_call',
        args: { receiver_id: p.contractId, amount: p.total, msg: JSON.stringify(msg) },
        gas: (200n * TGAS).toString(),
        deposit: '1', // NEP-141 requires exactly 1 yoctoNEAR
      },
    }],
  });
  return txs;
}

export interface Outcome {
  receipts_outcome?: { outcome?: { logs?: string[]; executor_id?: string; status?: { Failure?: unknown } } }[];
}

/** True if any receipt of the tx failed with `code` (e.g. ft_on_transfer's E128, after which NEP-141 refunds). */
export const failedWith = (o: Outcome, code: string): boolean =>
  (o.receipts_outcome ?? []).some((r) => r.outcome?.status?.Failure !== undefined && JSON.stringify(r.outcome.status.Failure).includes(code));

/**
 * campaign_id from our contract's `campaign_created` event (NEP-297), only if the event's merkle_root
 * and amount are the ones we sent: a mismatched event is not our campaign.
 */
export function campaignIdFrom(outcome: Outcome, contractId: string, expect: { merkleRoot: string; total: string }): string | null {
  for (const r of outcome.receipts_outcome ?? []) {
    if (r.outcome?.executor_id !== contractId) continue;
    for (const log of r.outcome.logs ?? []) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      try {
        const e = JSON.parse(log.slice('EVENT_JSON:'.length));
        const data = e.data?.[0];
        if (
          e.standard === 'zarf-near' && e.event === 'campaign_created' && /^\d+$/.test(String(data?.campaign_id)) &&
          data.merkle_root === expect.merkleRoot && String(data.amount) === expect.total
        ) {
          return String(data.campaign_id);
        }
      } catch {
        // not our event
      }
    }
  }
  return null;
}

/** Earliest allowed deadline, from get_config's min_lifetime_ns (E119 otherwise). */
export const minDeadlineMs = (nowMs: number, minLifetimeNs: string) => nowMs + Number(BigInt(minLifetimeNs) / 1_000_000n);

export interface FundDeps {
  sender: string;
  contractId: string;
  tokenId: string;
  storageByteCost: string;
  costs(): Promise<StorageCosts>;
  freePrepay(): Promise<string>;
  send(txs: Tx[]): Promise<string[]>;
  outcome(hash: string): Promise<Outcome>;
  /** Called right before the wallet is asked to send: persist the draft, since the send may land unseen. */
  beforeSend?(): void;
  /** Called as soon as the wallet returns the funding tx hash, before anything else can fail. */
  onSent?(txHash: string): void;
  campaignByRoot(sender: string, merkleRoot: string): Promise<string | null>;
  campaign(campaignId: string): Promise<{ merkle_root: string; amount: string; sender: string } | null>;
  /** Lookup retries before giving up with LookupPending (the tx is never re-sent). */
  lookupRetries?: number;
  sleep?(ms: number): Promise<void>;
}

/** First contract error code (E1xx_*) among the tx's failed receipts, if any. */
const failureCode = (o: Outcome): string | null => {
  for (const r of o.receipts_outcome ?? []) {
    const m = r.outcome?.status?.Failure !== undefined ? /E1\d\d_[A-Z_]+/.exec(JSON.stringify(r.outcome.status.Failure)) : null;
    if (m) return m[0];
  }
  return null;
};

/** The funding tx was sent but its outcome could not be read yet. Check again; never send again. */
export class LookupPending extends Error {
  constructor(readonly txHash: string) {
    super('LOOKUP_PENDING');
  }
}

/** The tx ran but neither created our campaign nor provably returned the tokens: do not send again. */
export class OutcomeUnclear extends Error {
  constructor(readonly txHash: string) {
    super('OUTCOME_UNCLEAR');
  }
}

/** The draft could not be persisted before sending, so nothing was sent (send() was never called). */
export class NotSent extends Error {
  constructor(reason: string) {
    super(`NOT_SENT: ${reason}`);
  }
}

/** The wallet call failed, so we do not know whether it broadcast. Resolve with resolveByRoot; never assume nothing was sent. */
export class SendUncertain extends Error {
  constructor() {
    super('SEND_UNCERTAIN');
  }
}

/**
 * The campaign this draft's merkle_root already funded, if any, checked against the contract's own
 * record (root, amount, sender). null: no campaign exists for these links, so sending is safe; if an
 * earlier tx lands later after all, the contract refunds the duplicate (E132).
 */
export async function resolveByRoot(
  d: Pick<FundDeps, 'campaignByRoot' | 'campaign' | 'sender'>,
  expect: { merkleRoot: string; total: string },
): Promise<string | null> {
  const id = await d.campaignByRoot(d.sender, expect.merkleRoot); // per sender: a front-runner cannot occupy our root
  if (id === null) return null;
  const c = await d.campaign(id);
  // Keyed by (sender, root), so a mismatch means a contract or RPC fault: never adopt that campaign.
  if (!c || c.merkle_root !== expect.merkleRoot || c.amount !== expect.total || c.sender !== d.sender) throw new Error('CAMPAIGN_MISMATCH');
  return id;
}

/** The tokens did not stay with the contract (refunded or never moved); safe to try again. */
export class NotCreated extends Error {
  constructor(readonly code: string, readonly txHash: string) {
    super(code);
  }
}

export type Creation =
  | { kind: 'created'; campaignId: string; txHash: string }
  | { kind: 'refunded'; code: string; txHash: string }
  | { kind: 'unclear'; txHash: string };

/**
 * What a funding tx did. "refunded" needs proof: our contract's ft_on_transfer receipt failed (NEP-141
 * then returns the full amount), or the token refused ft_transfer_call before calling the contract.
 */
export function classifyCreation(o: Outcome, txHash: string, d: Pick<FundDeps, 'contractId' | 'tokenId'>, expect: { merkleRoot: string; total: string }): Creation {
  const campaignId = campaignIdFrom(o, d.contractId, expect);
  if (campaignId) return { kind: 'created', campaignId, txHash };
  const receipts = o.receipts_outcome ?? [];
  const failed = (by: string) => receipts.some((r) => r.outcome?.executor_id === by && r.outcome.status?.Failure !== undefined);
  const contractRan = receipts.some((r) => r.outcome?.executor_id === d.contractId);
  if (failed(d.contractId) || (!contractRan && failed(d.tokenId))) {
    return { kind: 'refunded', code: failureCode(o) ?? 'CAMPAIGN_NOT_CREATED', txHash };
  }
  return { kind: 'unclear', txHash };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Reads the executed tx, retrying the lookup only (1, 2, 4, 8, 15 s...). */
export async function lookupOutcome(d: Pick<FundDeps, 'outcome' | 'lookupRetries' | 'sleep'>, txHash: string): Promise<Outcome> {
  for (let i = 0; ; i++) {
    try {
      return await d.outcome(txHash);
    } catch {
      if (i >= (d.lookupRetries ?? 6)) throw new LookupPending(txHash);
      await (d.sleep ?? defaultSleep)(Math.min(1000 * 2 ** i, 15_000));
    }
  }
}

/** For a funding tx already sent (e.g. after a reload): look it up and classify it. Never sends. */
export const checkCreation = async (
  d: Pick<FundDeps, 'outcome' | 'lookupRetries' | 'sleep' | 'contractId' | 'tokenId'>,
  txHash: string,
  expect: { merkleRoot: string; total: string },
): Promise<Creation> => classifyCreation(await lookupOutcome(d, txHash), txHash, d, expect);

/**
 * Pre-pays the storage shortfall and sends the tokens; returns the new campaign id.
 * - After send, only the lookup is retried; a lost outcome throws LookupPending, never a re-send.
 * - On a proven E128 refund (the snapshot grew after our read) it re-reads the costs and sends once more.
 * - Another proven refund throws NotCreated; an unproven one throws OutcomeUnclear.
 */
export async function fundCampaign(
  d: FundDeps,
  p: { merkleRoot: string; deadlineNs: string; leafCount: number; total: string },
): Promise<{ campaignId: string; txHash: string }> {
  for (let attempt = 0; ; attempt++) {
    const [costs, free] = await Promise.all([d.costs(), d.freePrepay()]);
    const shortfall = prepayShortfall(costs, p.leafCount, free, ownerKeySlack(d.storageByteCost));
    try {
      d.beforeSend?.(); // must persist the draft; if it cannot, do not send at all
    } catch (e) {
      throw new NotSent((e as Error).message);
    }
    let hashes: string[];
    try {
      hashes = await d.send(fundingTxs({ ...p, sender: d.sender, contractId: d.contractId, tokenId: d.tokenId, shortfall }));
    } catch {
      throw new SendUncertain(); // the wallet may have broadcast before failing
    }
    const txHash = hashes[hashes.length - 1]; // ft_transfer_call is always last
    if (!txHash) throw new SendUncertain();
    d.onSent?.(txHash);
    const expect = { merkleRoot: p.merkleRoot, total: p.total };
    const c = await checkCreation(d, txHash, expect);
    if (c.kind === 'created') return { campaignId: c.campaignId, txHash };
    if (c.kind === 'unclear') throw new OutcomeUnclear(txHash);
    if (c.code.startsWith('E132')) {
      // This root already funded a campaign (an earlier send landed): that one is ours.
      const existing = await resolveByRoot(d, expect);
      if (existing) return { campaignId: existing, txHash };
      throw new OutcomeUnclear(txHash);
    }
    if (attempt === 0 && c.code.startsWith('E128')) continue;
    throw new NotCreated(c.code, txHash);
  }
}

/**
 * After a send whose outcome was lost, a later proven refund says nothing about that earlier tx: it
 * may still land. Look again by (sender, root) after `waitMs` before letting the draft go.
 */
export async function settleAfterUncertain(
  d: Pick<FundDeps, 'campaignByRoot' | 'campaign' | 'sender'>,
  expect: { merkleRoot: string; total: string },
  { waitMs = 90_000, sleep = defaultSleep }: { waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string | null> {
  await sleep(waitMs);
  return resolveByRoot(d, expect);
}

/**
 * Whether the connected account may send this draft. Once a draft is pinned (a send may have gone
 * out), only the account that sent it may send it again: another account would fund it twice.
 */
export function mayCreate(o: { pinned: boolean; sentFrom: string | null; account: string | null }): { ok: true } | { ok: false; reason: string } {
  if (!o.account) return { ok: false, reason: 'Connect a wallet first.' };
  if (o.pinned && o.sentFrom && o.account !== o.sentFrom) return { ok: false, reason: `This draft belongs to ${o.sentFrom}: reconnect ${o.sentFrom} to continue.` };
  return { ok: true };
}

/** A send in some tab whose outcome is not resolved yet (mirrored to localStorage for other tabs). */
export interface UnresolvedMarker {
  root: string;
  sender: string;
  total: string;
  at: number; // ms
}

export const MARKER_TTL_MS = 24 * 60 * 60 * 1000;

/** The marker if present, well-formed and younger than 24 h; an expired or broken one is removed. */
export function readMarker(store: Pick<Storage, 'getItem' | 'removeItem'>, key: string, nowMs: number): UnresolvedMarker | null {
  let m: UnresolvedMarker | null = null;
  try {
    m = JSON.parse(store.getItem(key) ?? 'null');
  } catch {
    m = null;
  }
  const ok = !!m && typeof m.root === 'string' && typeof m.sender === 'string' && typeof m.total === 'string' && typeof m.at === 'number';
  if (!ok || nowMs - m!.at > MARKER_TTL_MS) {
    if (store.getItem(key) !== null) store.removeItem(key);
    return null;
  }
  return m;
}

/**
 * USDC the sender is short of for this campaign (0n if enough). null balance (the read failed) never
 * blocks: the wallet still shows a shortfall before signing.
 */
export const fundsShort = (balance: string | null, total: bigint): bigint =>
  balance === null || !/^\d+$/.test(balance) || BigInt(balance) >= total ? 0n : total - BigInt(balance);
