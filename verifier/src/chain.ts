/** What the verifier reads from the escrow contract (spec/claim.md "Views"). Never from the request. */
export interface Campaign {
  sender: string; // the funder: a failed cross-chain payout is refunded to it
  merkle_root: string; // hex32
  deadline_ns: string; // u64, decimal
  balance: string; // u128, decimal; excludes in-flight
  policy: 'owner' | 'attested';
  snapshot: string[]; // owner signers (hex32) or measurement ids (hex32)
}

export type ClaimState = 'unclaimed' | 'pending' | 'claimed';

export interface ChainReader {
  getNetwork(): Promise<string>;
  getCampaign(campaignId: string): Promise<Campaign | null>;
  claimState(campaignId: string, commitment: string): Promise<ClaimState>;
  getAgent(accountId: string): Promise<{ valid_until_ns: string } | null>;
}

// shortcut: the contract is not deployed yet; replace with NEAR RPC view calls at T8.
const notDeployed = () => Promise.reject(new Error('chain reader not wired: contract not deployed'));
export const undeployedChain: ChainReader = { getNetwork: notDeployed, getCampaign: notDeployed, claimState: notDeployed, getAgent: notDeployed };

/** The contract's views over NEAR JSON-RPC (`query` / `call_function`, optimistic finality). */
export function rpcChain(rpcUrl: string, contractId: string, fetchFn: typeof fetch = (u, i) => fetch(u, i)): ChainReader {
  const view = async <T>(method: string, args: object): Promise<T> => {
    const res = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'zarf', method: 'query',
        params: { request_type: 'call_function', finality: 'optimistic', account_id: contractId, method_name: method, args_base64: btoa(JSON.stringify(args)) },
      }),
    });
    const body = (await res.json().catch(() => null)) as { result?: { result?: number[] }; error?: unknown } | null;
    if (!res.ok || !body || body.error || !body.result?.result) throw new Error(`rpc view ${method} failed`);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(body.result.result)));
  };
  return {
    getNetwork: () => view('get_network', {}),
    getCampaign: (campaignId) => view('get_campaign', { campaign_id: campaignId }),
    claimState: (campaignId, commitment) => view('claim_state', { campaign_id: campaignId, commitment }),
    getAgent: (accountId) => view('get_agent', { account_id: accountId }),
  };
}
