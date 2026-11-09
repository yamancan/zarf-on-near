// Contract views and tx lookups the create app needs (spec/claim.md "Views").

import { nearView, postJson } from '../services';
import type { Outcome, StorageCosts } from './funding';

export interface ContractConfig {
  network: string;
  min_lifetime_ns: string;
  agent_ttl_ns: string;
  token_ids: string[];
  storage_byte_cost: string; // yoctoNEAR per byte
}

export const getConfig = (rpcUrl: string, contractId: string) => nearView<ContractConfig>(rpcUrl, contractId, 'get_config', {});
export const getStorageCosts = (rpcUrl: string, contractId: string, tokenId: string) =>
  nearView<StorageCosts>(rpcUrl, contractId, 'storage_costs', { token_id: tokenId });
export const getPrepayBalance = (rpcUrl: string, contractId: string, accountId: string) =>
  nearView<string>(rpcUrl, contractId, 'prepay_balance_of', { account_id: accountId });

/** spec: (sender, merkle_root) is an idempotency key; this finds the campaign that sender already funded with the root. */
export const getCampaignByRoot = (rpcUrl: string, contractId: string, sender: string, merkleRoot: string) =>
  nearView<string | null>(rpcUrl, contractId, 'campaign_by_root', { sender, merkle_root: merkleRoot });

export const getCampaignView = (rpcUrl: string, contractId: string, campaignId: string) =>
  nearView<{ merkle_root: string; amount: string; sender: string } | null>(rpcUrl, contractId, 'get_campaign', { campaign_id: campaignId });

/** The executed tx with all receipts (the wallet only returns the hash). */
export async function txOutcome(rpcUrl: string, hash: string, sender: string): Promise<Outcome> {
  const res = await postJson<{ result?: Outcome; error?: unknown }>(rpcUrl, {
    jsonrpc: '2.0', id: 'zarf', method: 'tx', params: { tx_hash: hash, sender_account_id: sender, wait_until: 'EXECUTED' },
  });
  if (!res.result) throw new Error('tx lookup failed');
  return res.result;
}
