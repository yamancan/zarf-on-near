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

/** campaign_id from the contract's `campaign_created` event (NEP-297) in an executed tx. */
export function campaignIdFrom(outcome: Outcome, contractId: string): string | null {
  for (const r of outcome.receipts_outcome ?? []) {
    if (r.outcome?.executor_id !== contractId) continue;
    for (const log of r.outcome.logs ?? []) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      try {
        const e = JSON.parse(log.slice('EVENT_JSON:'.length));
        if (e.standard === 'zarf-near' && e.event === 'campaign_created' && /^\d+$/.test(String(e.data?.[0]?.campaign_id))) {
          return String(e.data[0].campaign_id);
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
}

/** First contract error code (E1xx_*) among the tx's failed receipts, if any. */
const failureCode = (o: Outcome): string | null => {
  for (const r of o.receipts_outcome ?? []) {
    const m = r.outcome?.status?.Failure !== undefined ? /E1\d\d_[A-Z_]+/.exec(JSON.stringify(r.outcome.status.Failure)) : null;
    if (m) return m[0];
  }
  return null;
};

/**
 * Pre-pays the storage shortfall and sends the tokens; returns the new campaign id.
 * On E128 (the snapshot grew after our read; NEP-141 already refunded the tokens) it re-reads
 * the costs and tries once more.
 */
export async function fundCampaign(
  d: FundDeps,
  p: { merkleRoot: string; deadlineNs: string; leafCount: number; total: string },
): Promise<{ campaignId: string; txHash: string }> {
  for (let attempt = 0; ; attempt++) {
    const [costs, free] = await Promise.all([d.costs(), d.freePrepay()]);
    const shortfall = prepayShortfall(costs, p.leafCount, free, ownerKeySlack(d.storageByteCost));
    const hashes = await d.send(fundingTxs({ ...p, sender: d.sender, contractId: d.contractId, tokenId: d.tokenId, shortfall }));
    const txHash = hashes[hashes.length - 1]; // ft_transfer_call is always last
    if (!txHash) throw new Error('the wallet returned no transaction');
    const outcome = await d.outcome(txHash);
    const campaignId = campaignIdFrom(outcome, d.contractId);
    if (campaignId) return { campaignId, txHash };
    if (attempt === 0 && failedWith(outcome, 'E128')) continue;
    throw new Error(failureCode(outcome) ?? 'CAMPAIGN_NOT_CREATED');
  }
}
