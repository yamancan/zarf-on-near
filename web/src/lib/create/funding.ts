// The two transactions that create a campaign, and reading campaign_id back from its event.

export interface StorageCosts {
  ft_storage_deposit: string;
  claim_entry_cost: string;
  per_claim_storage: string;
  campaign_bytes_cost: string;
}

/** spec: deposit only the shortfall, campaign_bytes_cost + leaf_count × per_claim_storage − free pre-pay. */
export function prepayShortfall(costs: StorageCosts, leafCount: number, freePrepay: string): bigint {
  if (costs.campaign_bytes_cost === undefined) throw new Error('storage_costs has no campaign_bytes_cost');
  const need = BigInt(costs.campaign_bytes_cost) + BigInt(leafCount) * BigInt(costs.per_claim_storage);
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

interface Outcome {
  receipts_outcome?: { outcome?: { logs?: string[]; executor_id?: string } }[];
}

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
