/** What the verifier reads from the escrow contract (spec/claim.md "Views"). Never from the request. */
export interface Campaign {
  merkle_root: string; // hex32
  deadline_ns: string; // u64, decimal
}

export interface ChainReader {
  getNetwork(): Promise<string>;
  getCampaign(campaignId: string): Promise<Campaign | null>;
}

// shortcut: the contract is not deployed yet; replace with NEAR RPC view calls (get_network, get_campaign) at T8.
export const undeployedChain: ChainReader = {
  getNetwork: () => Promise.reject(new Error('chain reader not wired: contract not deployed')),
  getCampaign: () => Promise.reject(new Error('chain reader not wired: contract not deployed')),
};
