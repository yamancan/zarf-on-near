/** What the verifier reads from the escrow contract (spec/claim.md "Views"). Never from the request. */
export interface Campaign {
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
