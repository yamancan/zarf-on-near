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
  nearView<{ merkle_root: string; amount: string; sender: string; deadline_ns: string } | null>(rpcUrl, contractId, 'get_campaign', { campaign_id: campaignId });

/** view_account: the account's NEAR balance and the bytes it stores (it must keep storage_usage × byte cost). */
export async function getAccount(rpcUrl: string, accountId: string): Promise<{ amount: string; storage_usage: number }> {
  const res = await postJson<{ result?: { amount: string; storage_usage: number } }>(rpcUrl, {
    jsonrpc: '2.0', id: 'zarf', method: 'query', params: { request_type: 'view_account', finality: 'optimistic', account_id: accountId },
  });
  if (!res.result) throw new Error('view_account failed');
  return res.result;
}

/** The network's current gas price, yoctoNEAR per gas. */
export async function getGasPrice(rpcUrl: string): Promise<bigint> {
  const res = await postJson<{ result?: { gas_price: string } }>(rpcUrl, { jsonrpc: '2.0', id: 'zarf', method: 'gas_price', params: [null] });
  if (!res.result) throw new Error('gas_price failed');
  return BigInt(res.result.gas_price);
}

/** The final block's height: a lost send's expiry is counted in blocks (funding.ts TX_VALIDITY_BLOCKS). */
export async function getHeight(rpcUrl: string): Promise<number> {
  const res = await postJson<{ result?: { header?: { height?: number } } }>(rpcUrl, { jsonrpc: '2.0', id: 'zarf', method: 'block', params: { finality: 'final' } });
  const h = res.result?.header?.height;
  if (!Number.isSafeInteger(h)) throw new Error('block failed');
  return h!;
}

/** The executed tx with all receipts (the wallet only returns the hash). */
export async function txOutcome(rpcUrl: string, hash: string, sender: string): Promise<Outcome> {
  const res = await postJson<{ result?: Outcome; error?: unknown }>(rpcUrl, {
    jsonrpc: '2.0', id: 'zarf', method: 'tx', params: { tx_hash: hash, sender_account_id: sender, wait_until: 'EXECUTED' },
  });
  if (!res.result) throw new Error('tx lookup failed');
  return res.result;
}
